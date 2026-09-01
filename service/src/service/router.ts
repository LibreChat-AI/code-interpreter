import axios from 'axios';
import busboy from 'busboy';
import { nanoid } from 'nanoid';
import { Router } from 'express';
import type { Response } from 'express';
import type { Readable } from 'stream';
import type * as t from '../types';
import { checkServiceStartUp, checkServiceShutDown } from '../lifecycle';
import { sessionAuth } from '../middleware/auth';
import { executionLimiter, uploadLimiter, downloadLimiter, fetchLimiter } from '../middleware/limits';
import { internalServiceHeaders } from '../internal-service-auth';
import { resolveSessionKey, resolveOutputBucketSessionKey, SessionKeyResolutionError, parseUploadSessionKeyInput, type SessionKeyInput } from '../session-key';
import { pyQueue, otherQueue, pyQueueEvents, otherQueueEvents, queueNames, connection } from '../queue';
import { sleep, getAxiosErrorDetails, publicExecutionFailure } from '../utils';
import { env, jobCompletionWaitTimeoutMs, planLimits, resolveLanguage } from '../config';
import { createPayload } from '../payload';
import { summarizeRequestedFiles } from '../execution-log';
import { getCredentialId, getPrincipalOrReject } from '../auth/principal';
import { isSyntheticPrincipalSource } from '../auth/synthetic';
import { getExecutionIdentity } from '../execution-identity';
import { resolveRuntimeSessionIdForExecRequest, RuntimeSessionHintError } from '../runtime-session/id';
import { jobsSubmitted } from '../metrics';
import { captureTraceCarrier, withSpan } from '../telemetry';
import { Jobs, Languages } from '../enum';
import { FileRefAuthorizationError, authorizeRequestedFiles } from './file-authorization';
import { createUploadSessionRegistrar } from './upload-session';
import { prepareSandboxJobSecurity } from '../sandbox-egress';
import logger from '../logger';
import {
  resolveShellOutputFilter,
  ShellOutputFilterError,
} from '../../../shared/shell-output-filter';

const { INSTANCE_ID } = env;
const JOB_COMPLETION_WAIT_TIMEOUT_MS = jobCompletionWaitTimeoutMs(
  env.JOB_TIMEOUT,
  env.LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS,
  env.EGRESS_GATEWAY_REVOKE_TIMEOUT_MS,
);

const UPLOAD_TIMEOUT_MS = 30_000;
/* Batch cap sized for skill-priming uploads: a single skill (e.g. pptx)
 * can carry 60+ resource files including .xsd schemas, helper scripts,
 * docs, and Python __init__.py markers. The previous cap of 20 silently
 * dropped most files past the limit, surfacing as "missing files" in the
 * caller. */
const MAX_BATCH_FILES = 200;

function validateUploadRequest(req: t.AuthenticatedRequest, res: Response): string | null {
  const principal = getPrincipalOrReject(req, res);
  if (!principal) return null;
  if (req.headers['content-type']?.includes('multipart/form-data') !== true) {
    res.status(400).json({ error: 'Invalid content type. Must be multipart/form-data.' });
    return null;
  }
  if (checkServiceShutDown()) {
    res.status(503).json({ error: 'Service is shutting down' });
    return null;
  }
  if (checkServiceStartUp()) {
    res.status(503).json({ error: 'Service is starting up' });
    return null;
  }
  return principal.userId;
}

function sendFileRefAuthorizationError(
  error: unknown,
  res: Response,
  req?: t.AuthenticatedRequest,
): boolean {
  if (error instanceof FileRefAuthorizationError) {
    const queryEntityId = typeof req?.query?.entity_id === 'string' ? req.query.entity_id : undefined;
    logger.warn('File reference authorization rejected', {
      status: error.status,
      reason: error.reason,
      message: error.message,
      requestUserId: req?.codeApiAuthContext?.userId,
      requestApiKeyId: req ? getCredentialId(req) : undefined,
      requestEntityId: queryEntityId,
      tenantId: req?.codeApiAuthContext?.tenantId,
      ...error.context,
    });
    res.status(error.status).json({ error: error.message });
    return true;
  }
  return false;
}

/**
 * Mirrors `sendFileRefAuthorizationError`'s return-true-when-handled
 * shape and logs the rejection before responding. Without the log,
 * sessionKey misconfigurations (e.g. middleware not populating
 * `codeApiAuthContext`, malformed kind/version on uploads) would
 * surface as 500/400s in the response body with zero server-side
 * trail — silent in production logs and easy to miss until a user
 * reports it. Includes auth/request context so the failure mode is
 * traceable without correlating HTTP captures.
 */
function sendSessionKeyResolutionError(
  error: unknown,
  res: Response,
  req: t.AuthenticatedRequest,
  context: string,
): boolean {
  if (error instanceof SessionKeyResolutionError) {
    logger.error(`[${INSTANCE_ID}] sessionKey resolution failed (${context})`, {
      status: error.status,
      message: error.message,
      method: req.method,
      path: req.path,
      requestUserId: req.codeApiAuthContext?.userId,
      authContextUserId: req.codeApiAuthContext?.userId,
      tenantId: req.codeApiAuthContext?.tenantId,
    });
    res.status(error.status).json({ error: error.message });
    return true;
  }
  return false;
}

const router = Router();

router.post('/exec', executionLimiter, async (req: t.AuthenticatedRequest, res) => {
  const principal = getPrincipalOrReject(req, res);
  if (!principal) return;
  const apiKeyId = getCredentialId(req);
  const userId = principal.userId;
  const identity = getExecutionIdentity(req, userId);
  const isSyntheticRequest = isSyntheticPrincipalSource(identity.principalSource);

  if (checkServiceShutDown()) {
    return res.status(503).json({ error: 'Service is shutting down' });
  }

  if (checkServiceStartUp()) {
    return res.status(503).json({ error: 'Service is starting up' });
  }

  const body = req.body as t.RequestBody;
  const { user_id, lang: rawLang, code, files } = body;
  const language = resolveLanguage(rawLang);
  if (language == null) {
    return res.status(400).json({ error: `Unsupported language: ${rawLang}` });
  }
  try {
    body.shell_output_filter = resolveShellOutputFilter(body.shell_output_filter, language);
  } catch (error) {
    if (error instanceof ShellOutputFilterError) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }

  let runtimeSessionId: string | undefined;
  try {
    runtimeSessionId = resolveRuntimeSessionIdForExecRequest({
      mode: env.RUNTIME_SESSION_MODE,
      storageNamespace: identity.storageNamespace,
      canonicalUserId: identity.canonicalUserId,
      runtimeSessionHint: body.runtime_session_hint,
      isSynthetic: isSyntheticRequest,
    });
  } catch (error) {
    if (error instanceof RuntimeSessionHintError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
  const runtimeSessionMode: t.RuntimeSessionMode = runtimeSessionId == null
    ? 'stateless'
    : env.RUNTIME_SESSION_MODE;

  let authorizedFiles: t.RequestFile[];
  try {
    authorizedFiles = await authorizeRequestedFiles({
      req,
      files,
      store: connection,
    });
    body.files = authorizedFiles.length > 0 ? authorizedFiles : undefined;
  } catch (error) {
    if (sendFileRefAuthorizationError(error, res, req)) return;
    logger.error(`[${INSTANCE_ID}] Error authorizing file refs:`, error);
    return res.status(500).json({ error: 'Internal server error' });
  }

  /* Output bucket sessionKey is hardcoded user-private regardless of
   * input file kinds — outputs always belong to the requesting user.
   * Skill executions do NOT produce a skill-scoped output bucket; that's
   * a deliberate behavioral change from the legacy entity_id-driven
   * derivation. See codeapi #1455 / Phase C design. */
  let sessionKey: string;
  try {
    sessionKey = resolveOutputBucketSessionKey(req);
  } catch (error) {
    if (sendSessionKeyResolutionError(error, res, req, 'resolveOutputBucketSessionKey')) return;
    throw error;
  }

  /* The execute call generates a fresh session id used as both the
   * Job.uuid (top-level execution scope) and the storage prefix for any
   * output files this run produces (worker writes to `<uuid>/<file_id>`).
   * The two roles share the value by design — naming it
   * `session_id` since the primary semantic is "the running
   * sandbox invocation." */
  const session_id = nanoid();
  const execution_id = nanoid();
  await connection.set(`session:${session_id}`, sessionKey, 'EX', env.SESSION_CACHE_TTL);

  try {
    if (!isSyntheticRequest) {
      logger.info('Request received', {
        userId,
        apiKeyId,
        user: user_id,
        session_id,
        language,
        files: summarizeRequestedFiles(authorizedFiles),
        sessionKey,
      });
    }

    const isPyPlot = language === Languages.py && (code.includes('import matplotlib') || code.includes('import seaborn'));
    const rawPayload = createPayload({
      req,
      isPyPlot,
      session_id,
    });
    const sandboxSecurity = prepareSandboxJobSecurity({
      req,
      executionId: execution_id,
      userId,
      sessionKey,
      outputSessionId: session_id,
      payload: rawPayload,
    });

    const queue = language === Languages.py ? pyQueue : otherQueue;
    const queueEvents = language === Languages.py ? pyQueueEvents : otherQueueEvents;
    const queueName = language === Languages.py ? queueNames.python : queueNames.other;

    const job = await withSpan('codeapi.job.enqueue', {
      'messaging.system': 'bullmq',
      'messaging.destination.name': queueName,
      'codeapi.language': language,
      'codeapi.execution_profile': env.EXECUTION_PROFILE,
    }, () => {
      const traceCarrier = captureTraceCarrier();
      return queue.add(Jobs.execute, {
        code,
        userId,
        payload: sandboxSecurity.payload,
        apiKeyId,
        isSynthetic: isSyntheticRequest,
        isPyPlot,
        principalSource: identity.principalSource,
        executionId: execution_id,
        tenantId: identity.storageNamespace,
        canonicalUserId: identity.canonicalUserId,
        executionProfile: env.EXECUTION_PROFILE,
        ...(runtimeSessionId != null ? { runtimeSessionId } : {}),
        runtimeSessionMode,
        executionManifestClaims: sandboxSecurity.executionManifestClaims,
        egressGrantClaims: sandboxSecurity.egressGrantClaims,
        egressGrantToken: sandboxSecurity.egressGrantToken,
        _otel: traceCarrier,
      }, {
        removeOnComplete: {
          age: 60,
          count: 1,
        },
        removeOnFail: {
          age: 180,
          count: 1,
        },
        attempts: 1,
        jobId: session_id,
      });
    }, 'PRODUCER');
    jobsSubmitted.inc({ language });

    req.on('close', async () => {
      try {
        await job.remove();
        logger.info(`[${INSTANCE_ID}] Job ${job.id} removed due to client disconnect`);
      } catch (error) {
        logger.error(`[${INSTANCE_ID}] Error removing job ${job.id} on client disconnect:`, error);
      }
    });

    const result = await withSpan('codeapi.job.wait_until_finished', {
      'messaging.system': 'bullmq',
      'messaging.destination.name': queueName,
      'codeapi.language': language,
      'codeapi.execution_profile': env.EXECUTION_PROFILE,
    }, () => job.waitUntilFinished(queueEvents, JOB_COMPLETION_WAIT_TIMEOUT_MS), 'CONSUMER');

    if (!isSyntheticRequest) {
      logger.info('Execution completed', { session_id, user_id });
    }
    return res.status(200).json(result);
  } catch (error) {
    logger.error(`[${INSTANCE_ID}] Session ID: ${session_id} | User ID: ${user_id} | Error during execution:`, error);
    const publicFailure = publicExecutionFailure(error);
    if (publicFailure) {
      return res.status(publicFailure.status).json(publicFailure.body);
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/download/:session_id/:fileId', downloadLimiter, sessionAuth, async (req: t.AuthenticatedRequest, res: Response) => {
  const { session_id, fileId } = req.params;

  let exists = 0;
  const uploadKey = `upload:${req.sessionKey}${session_id}${fileId}`;
  for (let i = 0; i < env.MAX_UPLOAD_CHECKS; i++) {
    exists = await connection.exists(uploadKey);
    if (exists === 1) {
      break;
    }
    await sleep(env.MAX_UPLOAD_WAIT);
  }

  if (exists === 0) {
    logger.error(`[${INSTANCE_ID}] Session ID: ${session_id} | File ID: ${fileId} | File not found in cache`);
    return res.status(404).json({
      error: 'File not found',
      details: 'The file may have expired or does not exist'
    });
  }

  try {
    const response = await axios({
      method: 'get',
      url: `${env.FILE_SERVER_URL}/sessions/${session_id}/objects/${fileId}`,
      headers: internalServiceHeaders(),
      responseType: 'stream'
    });

    res.set(response.headers);
    response.data.pipe(res);
  } catch (error) {
    const errorDetails = getAxiosErrorDetails(error);
    logger.error(`[${INSTANCE_ID}] Session ID: ${session_id} | File ID: ${fileId} | Error downloading file:`, errorDetails);

    return res.status(500).json({
      error: 'Error downloading file',
      details: (error as Error).message
    });
  }
});

router.post('/upload', uploadLimiter, async (req: t.AuthenticatedRequest, res: Response) => {
  try {
    const userId = validateUploadRequest(req, res);
    if (userId == null) return;

    const session_id = nanoid();
    /* `kind`/`id`/`version?` form fields drive the upload-bucket
     * sessionKey via `resolveSessionKey`, replacing the legacy
     * `entity_id` form field. Same validation rules as /exec
     * `RequestFile`: kind is required, version is required for
     * `'skill'` and forbidden otherwise. */
    let uploadKind: string | undefined;
    let uploadId: string | undefined;
    let uploadVersionRaw: string | undefined;
    let readOnly = false;
    let hasResponded = false;

    const planFileSize = planLimits[req.planId ?? '']?.max_file_size ?? planLimits.default.max_file_size;
    /* preservePath keeps subdirectory components in the multipart filename
     * (e.g. `pptx/editing.md`). The busboy 1.x default strips to basename,
     * which collapses skill-file paths and breaks the caller's filename
     * lookups (skill files look "missing" even when uploaded). */
    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: planFileSize },
      preservePath: true,
    });

    const uploadPromises: Promise<t.UploadResult>[] = [];

    bb.on('field', (fieldname: string, val: string) => {
      if (fieldname === 'kind') {
        uploadKind = val;
      } else if (fieldname === 'id') {
        uploadId = val;
      } else if (fieldname === 'version') {
        uploadVersionRaw = val;
      } else if (fieldname === 'read_only') {
        /* `read_only=true` declares these uploads as infrastructure inputs
         * (e.g. skill files) — the sandbox API and downstream callers
         * MUST treat them as never-emit-back artifacts even if sandboxed
         * code modifies the bytes on disk. Persisted as MinIO object
         * metadata downstream so it travels with the file. */
        readOnly = val.toLowerCase() === 'true';
      }
    });

    bb.on('file', (_fieldname: string, file: Readable, info: busboy.FileInfo) => {
      const { filename, mimeType } = info;
      const fileId = nanoid();
      const abortController = new AbortController();

      file.on('limit', () => {
        if (hasResponded) {
          logger.warn(`[${INSTANCE_ID}] Post-process file size limit exceeded: ${filename} | Session: ${session_id}`);
          return;
        }
        hasResponded = true;
        logger.warn(`[${INSTANCE_ID}] File size limit exceeded: ${filename} | Session: ${session_id}`);
        abortController.abort();
        file.resume();
        res.status(413).json({ error: 'File size limit exceeded' });
      });

      const uploadPromise = new Promise<t.UploadResult>((resolve, reject) => {
        const uploadTimeout = setTimeout(() => {
          abortController.abort();
          file.resume();
          reject(new Error('Upload timeout'));
        }, UPLOAD_TIMEOUT_MS);

        let sessionKeyInput: SessionKeyInput;
        try {
          sessionKeyInput = parseUploadSessionKeyInput({
            kind: uploadKind,
            id: uploadId,
            version: uploadVersionRaw,
            authContextUserId: req.codeApiAuthContext?.userId ?? userId,
          });
        } catch (err) {
          clearTimeout(uploadTimeout);
          file.resume();
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }

        let sessionKey: string;
        try {
          sessionKey = resolveSessionKey(req, sessionKeyInput);
        } catch (err) {
          clearTimeout(uploadTimeout);
          file.resume();
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        const putHeaders: Record<string, string> = {
          'Content-Type': mimeType,
          /* file-server URL-decodes this header before storing metadata.
           * Encoding here preserves `/` as `%2F` in transit and keeps
           * non-ASCII filenames legal as HTTP header values. */
          'X-Original-Filename': encodeURIComponent(filename),
        };
        if (readOnly) {
          putHeaders['X-Read-Only'] = 'true';
        }
        connection.set(`session:${session_id}`, sessionKey, 'EX', env.SESSION_CACHE_TTL)
          .then(() => {
            logger.info(`[${INSTANCE_ID}] Upload: Session ID: ${session_id} | User ID: ${userId} | Session key: ${sessionKey}`);
            return axios.put<t.UploadResult>(
              `${env.FILE_SERVER_URL}/sessions/${session_id}/objects/${fileId}`,
              file,
              {
                headers: internalServiceHeaders(putHeaders),
                maxBodyLength: planFileSize,
                maxContentLength: planFileSize,
                signal: abortController.signal,
              },
            );
          })
          .then(response => {
            clearTimeout(uploadTimeout);
            resolve(response.data);
          })
          .catch(error => {
            clearTimeout(uploadTimeout);
            file.resume();
            reject(error);
          });
      });

      /* Busboy may take additional event-loop turns to drain the multipart
       * body before `finish` aggregates this promise. Mark early failures as
       * observed while preserving the original promise for Promise.all. */
      void uploadPromise.catch(() => undefined);
      uploadPromises.push(uploadPromise);
    });

    bb.on('error', (error) => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process busboy error for session ${session_id}:`, error);
        return;
      }
      hasResponded = true;
      logger.error(`[${INSTANCE_ID}] Busboy error for session ${session_id}:`, error);
      res.status(500).json({ error: 'Error processing upload' });
    });

    bb.on('finish', async () => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process upload already responded for session ${session_id}`);
        void Promise.allSettled(uploadPromises);
        return;
      }
      hasResponded = true;
      try {
        const results = await Promise.all(uploadPromises);
        const response: t.UploadResponse = {
          message: 'success',
          storage_session_id: session_id,
          files: results,
        };
        res.status(200).json(response);
      } catch (error) {
        logger.error(`[${INSTANCE_ID}] Error uploading files for session ${session_id}:`, error);
        if (!res.headersSent) {
          if (error instanceof Error) {
            if (error.message === 'Upload timeout') {
              res.status(504).json({ error: 'Upload timeout' });
            } else {
              res.status(500).json({ error: 'Error uploading files' });
            }
          } else {
            res.status(500).json({ error: 'Error uploading files' });
          }
        }
      }
    });

    req.pipe(bb);

    req.on('error', (error) => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process request error for session ${session_id}:`, error);
        return;
      }
      hasResponded = true;
      logger.error(`[${INSTANCE_ID}] Request error for session ${session_id}:`, error);
      res.status(500).json({ error: 'Error processing request' });
    });

  } catch (error) {
    logger.error(`[${INSTANCE_ID}] Unexpected upload error:`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  }
});

router.post('/upload/batch', uploadLimiter, async (req: t.AuthenticatedRequest, res: Response) => {
  try {
    const userId = validateUploadRequest(req, res);
    if (userId == null) return;

    const session_id = nanoid();
    /* `kind`/`id`/`version?` form fields drive the batch's sessionKey
     * — the same shape as `/upload`. See `/upload` for the full
     * rationale. */
    let uploadKind: string | undefined;
    let uploadId: string | undefined;
    let uploadVersionRaw: string | undefined;
    let readOnly = false;
    let hasResponded = false;
    let filesLimitReached = false;
    /* `SessionKeyResolutionError.status` spans 400 | 500 — 400 is a
     * client-input fault (per-file rejection is OK), 500 signals a
     * server misconfiguration (e.g. strict-mode tenantId gap) where
     * masking the failure as a per-file error string would hide an
     * operational breakage behind a 200/400 response. Latch the first
     * 500 we see and convert it into a single 500 batch response on
     * `bb.on('finish')`. */
    let serverError: SessionKeyResolutionError | undefined;
    /* Redis registration is also a batch-level dependency fault. Keep file
     * promises fulfilled while Busboy drains, then surface one 500. */
    let sessionRegistrationError: Error | undefined;

    const ensureSessionRegistered = createUploadSessionRegistrar((sessionKey) => {
      logger.info(`[${INSTANCE_ID}] Batch upload: Session ID: ${session_id} | User ID: ${userId} | Session key: ${sessionKey}`);
      return connection.set(`session:${session_id}`, sessionKey, 'EX', env.SESSION_CACHE_TTL);
    });

    const planFileSize = planLimits[req.planId ?? '']?.max_file_size ?? planLimits.default.max_file_size;
    /* See note on the single-upload busboy above for why preservePath is set. */
    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: planFileSize, files: MAX_BATCH_FILES },
      preservePath: true,
    });

    const uploadPromises: Promise<t.BatchUploadFileResult>[] = [];

    bb.on('field', (fieldname: string, val: string) => {
      if (fieldname === 'kind') {
        uploadKind = val;
      } else if (fieldname === 'id') {
        uploadId = val;
      } else if (fieldname === 'version') {
        uploadVersionRaw = val;
      } else if (fieldname === 'read_only') {
        /* See `/upload` for semantics. The flag applies to every file in
         * this batch — sized for skill priming where all files share the
         * same read-only intent. */
        readOnly = val.toLowerCase() === 'true';
      }
    });

    bb.on('filesLimit', () => {
      filesLimitReached = true;
      logger.warn(`[${INSTANCE_ID}] Batch upload files limit reached (${MAX_BATCH_FILES}) for session ${session_id}`);
    });

    bb.on('file', (_fieldname: string, file: Readable, info: busboy.FileInfo) => {
      const { filename, mimeType } = info;
      const fileId = nanoid();
      const abortController = new AbortController();

      file.on('limit', () => {
        logger.warn(`[${INSTANCE_ID}] Batch upload file size limit exceeded: ${filename} | Session: ${session_id}`);
        abortController.abort('size_limit');
        file.resume();
      });

      const uploadPromise = new Promise<t.BatchUploadFileResult>((resolve) => {
        /** If abort('size_limit') fires first, its microtask-queued .catch resolves the promise and clears this timeout before it can fire. */
        const uploadTimeout = setTimeout(() => {
          abortController.abort('timeout');
          file.resume();
          /* If Redis is still pending, make that shared registration barrier
           * fail before any file promise settles. This prevents Busboy from
           * finishing with a 400 while a later Redis rejection arrives too
           * late to be surfaced as the batch-level dependency failure. */
          if (ensureSessionRegistered.rejectPending(
            new Error('Upload session registration timed out'),
          )) return;
          resolve({ status: 'error', filename, error: 'Upload timeout' });
        }, UPLOAD_TIMEOUT_MS);

        let sessionKeyInput: SessionKeyInput;
        try {
          sessionKeyInput = parseUploadSessionKeyInput({
            kind: uploadKind,
            id: uploadId,
            version: uploadVersionRaw,
            authContextUserId: req.codeApiAuthContext?.userId ?? userId,
          });
        } catch (err) {
          clearTimeout(uploadTimeout);
          file.resume();
          const message = err instanceof Error ? err.message : 'Invalid upload identity';
          resolve({ status: 'error', filename, error: message });
          return;
        }

        let sessionKey: string;
        try {
          sessionKey = resolveSessionKey(req, sessionKeyInput);
        } catch (err) {
          clearTimeout(uploadTimeout);
          file.resume();
          /* Latch 500-class errors so `bb.on('finish')` can surface
           * them as a single batch-level 500. Per-file degradation is
           * the right call for 400-class faults but masks server
           * misconfiguration. */
          if (err instanceof SessionKeyResolutionError && err.status === 500 && !serverError) {
            serverError = err;
          }
          const message = err instanceof Error ? err.message : 'Failed to resolve sessionKey';
          resolve({ status: 'error', filename, error: message });
          return;
        }
        const putHeaders: Record<string, string> = {
          'Content-Type': mimeType,
          /* file-server URL-decodes this header before storing metadata.
           * Encoding here preserves `/` as `%2F` in transit and keeps
           * non-ASCII filenames legal as HTTP header values. */
          'X-Original-Filename': encodeURIComponent(filename),
        };
        if (readOnly) {
          putHeaders['X-Read-Only'] = 'true';
        }
        const failSessionRegistration = (error: unknown): void => {
          clearTimeout(uploadTimeout);
          file.resume();
          const normalizedError = error instanceof Error ? error : new Error(String(error));
          sessionRegistrationError ??= normalizedError;
          resolve({ status: 'error', filename, error: 'Failed to register upload session' });
        };
        const resolveUploadFailure = (error: unknown): void => {
          clearTimeout(uploadTimeout);
          if (abortController.signal.aborted) {
            const reason = abortController.signal.reason === 'timeout' ? 'Upload timeout' : 'File size limit exceeded';
            resolve({ status: 'error', filename, error: reason });
            return;
          }
          file.resume();
          const message = error instanceof Error ? error.message : 'Unknown upload error';
          logger.error(`[${INSTANCE_ID}] Batch upload file failed: ${filename} | Session: ${session_id}`, { error: message });
          resolve({ status: 'error', filename, error: message });
        };
        const forwardFile = (): Promise<void> => axios.put<t.UploadResult>(
          `${env.FILE_SERVER_URL}/sessions/${session_id}/objects/${fileId}`,
          file,
          {
            headers: internalServiceHeaders(putHeaders),
            maxBodyLength: planFileSize,
            maxContentLength: planFileSize,
            signal: abortController.signal,
          },
        ).then(response => {
          clearTimeout(uploadTimeout);
          resolve({ status: 'success', filename: response.data.filename, fileId: response.data.fileId });
        }, resolveUploadFailure);

        void ensureSessionRegistered(sessionKey)
          .then(forwardFile, failSessionRegistration)
          .catch(failSessionRegistration);
      });

      uploadPromises.push(uploadPromise);
    });

    bb.on('error', (error) => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process busboy error for batch session ${session_id}:`, error);
        return;
      }
      hasResponded = true;
      logger.error(`[${INSTANCE_ID}] Busboy error for batch session ${session_id}:`, error);
      res.status(500).json({ error: 'Error processing upload' });
    });

    bb.on('finish', async () => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process batch upload already responded for session ${session_id}`);
        return;
      }
      hasResponded = true;

      try {
        const results = await Promise.all(uploadPromises);

        if (sessionRegistrationError) {
          logger.error(
            `[${INSTANCE_ID}] Batch upload session registration failed for session ${session_id}:`,
            sessionRegistrationError,
          );
          res.status(500).json({ error: 'Error registering upload session' });
          return;
        }

        /* If sessionKey resolution faulted with a 500 status (server
         * misconfiguration — see `serverError` declaration above),
         * surface the fault as a single batch-level 500 instead of
         * per-file errors. This avoids quietly returning 200 with
         * `partial_success` when a tenantId gap or similar makes
         * EVERY upload structurally impossible. */
        if (serverError) {
          logger.error(
            `[${INSTANCE_ID}] Batch upload faulted on sessionKey resolution: ${serverError.message}`,
            { session_id, files: results.length },
          );
          res.status(500).json({ error: serverError.message });
          return;
        }

        if (results.length === 0) {
          res.status(400).json({ error: 'No files provided' });
          return;
        }

        /* SessionKey was set inline in the per-file handler through
         * `ensureSessionRegistered`. No batch-level fallback is needed when
         * no valid file reaches the forwarding step. */

        let succeeded = 0;
        let failed = 0;
        for (const r of results) {
          if (r.status === 'success') succeeded++;
          else failed++;
        }

        let message: t.BatchUploadResponse['message'];
        if (failed === 0) message = 'success';
        else if (succeeded === 0) message = 'error';
        else message = 'partial_success';

        const statusCode = message === 'error' ? 400 : 200;
        const response: t.BatchUploadResponse = {
          message,
          storage_session_id: session_id,
          files: results,
          succeeded,
          failed,
          ...(filesLimitReached ? { filesLimitReached: true, maxFiles: MAX_BATCH_FILES } : {}),
        };
        res.status(statusCode).json(response);
      } catch (error) {
        logger.error(`[${INSTANCE_ID}] Error in batch upload finish for session ${session_id}:`, error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Error processing batch upload' });
        }
      }
    });

    req.pipe(bb);

    req.on('error', (error) => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process request error for batch session ${session_id}:`, error);
        return;
      }
      hasResponded = true;
      logger.error(`[${INSTANCE_ID}] Request error for batch session ${session_id}:`, error);
      res.status(500).json({ error: 'Error processing request' });
    });

  } catch (error) {
    logger.error(`[${INSTANCE_ID}] Unexpected batch upload error:`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  }
});

router.get('/files/:session_id', fetchLimiter, sessionAuth, async (req: t.AuthenticatedRequest, res: Response) => {
  const { session_id } = req.params;
  const { detail = 'simple' } = req.query;

  try {
    const response = await axios.get(`${env.FILE_SERVER_URL}/sessions/${session_id}/objects`, {
      params: { detail },
      headers: internalServiceHeaders({ 'Accept': 'application/json' })
    });

    return res.status(200).json(response.data);
  } catch (error) {
    const errorDetails = getAxiosErrorDetails(error);
    logger.error(`[${INSTANCE_ID}] Error fetching file info for session ${session_id}:`, errorDetails);
    return res.status(500).json({
      error: 'Error fetching file information',
    });
  }
});

/**
 * Single-file metadata lookup for caller-side freshness checks.
 * LibreChat's `primeSkillFiles` reads `lastModified` from this response
 * to decide whether a previously-uploaded skill bundle is still alive
 * in the sandbox or needs to be re-uploaded. Without this route on the
 * public service-api, that freshness GET 404s and every priming call
 * falls through to a fresh upload (massive egress at scale).
 *
 * Proxies the file-server's `/metadata` variant — which returns
 * `{ lastModified, size, etag, ... }` from `minioClient.statObject` —
 * authenticated by `sessionAuth` so the requester must own the
 * `(session_id, entity_id)` pair the file was stored under.
 */
router.get('/sessions/:session_id/objects/:fileId', fetchLimiter, sessionAuth, async (req: t.AuthenticatedRequest, res: Response) => {
  const { session_id, fileId } = req.params;

  try {
    const response = await axios.get(
      `${env.FILE_SERVER_URL}/sessions/${session_id}/objects/${fileId}/metadata`,
      { headers: internalServiceHeaders({ Accept: 'application/json' }) },
    );

    return res.status(200).json(response.data);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return res.status(404).json({ error: 'File not found' });
    }
    const errorDetails = getAxiosErrorDetails(error);
    logger.error(
      `[${INSTANCE_ID}] Error fetching object metadata - Session ID: ${session_id} | File ID: ${fileId}:`,
      errorDetails,
    );
    return res.status(500).json({ error: 'Error fetching object metadata' });
  }
});

router.delete('/files/:session_id/:fileId', fetchLimiter, sessionAuth, async (req: t.AuthenticatedRequest, res: Response) => {
  const { session_id, fileId } = req.params;

  try {
    const response = await axios.delete(
      `${env.FILE_SERVER_URL}/sessions/${session_id}/objects/${fileId}`,
      { headers: internalServiceHeaders() }
    );

    await connection.del(`upload:${req.sessionKey}${session_id}${fileId}`);
    logger.info(`[${INSTANCE_ID}] File deleted: Session ID: ${session_id} | File ID: ${fileId}`);
    return res.status(200).json(response.data);
  } catch (error) {
    const errorDetails = getAxiosErrorDetails(error);
    logger.error(`[${INSTANCE_ID}] Error deleting file - Session ID: ${session_id} | File ID: ${fileId}:`, errorDetails);
    return res.status(500).json({
      error: 'Error deleting file',
    });
  }
});

export default router;
