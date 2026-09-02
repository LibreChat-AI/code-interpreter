import crypto from 'crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { nanoid } from 'nanoid';
import path from 'path';
import { Readable } from 'stream';
import { env } from './config';
import {
  EGRESS_GRANT_HEADER,
  EgressGrantError,
  egressGrantFromExecutionClaims,
  openEgressGrant,
  openPtcCallbackToken,
  prepareSandboxEgress,
  restoreSandboxExecuteResult,
  sealEgressHandle,
  sealPtcCallbackToken,
  type EgressGrantClaims,
} from './egress-grant';
import type { ExecutionManifestClaims } from './execution-manifest';
import { openEgressRouteHandle } from './egress-route-params';
import { internalServiceHeaders, requireConfiguredInternalServiceAuth } from './internal-service-auth';
import { isSyntheticPrincipalSource } from './auth/synthetic';
import {
  CODEAPI_SYNTHETIC_INTERNAL_REQUEST_HEADER,
  isSyntheticInternalRequestHeader,
} from './internal-synthetic';
import {
  assertEgressGrantActive,
  createEgressLedger,
  ensureEgressLedger,
  pingEgressLedger,
  recordEgressRead,
  recordEgressToolCall,
  releaseEgressUpload,
  reserveEgressUpload,
  revokeEgressLedger,
} from './egress-ledger';
import { metricsHandler } from './metrics';
import { httpMetricsMiddleware } from './middleware/httpMetrics';
import { injectTraceHeaders, shutdownTelemetry, traceHttpRequest } from './telemetry';
import { isValidId } from './utils';
import logger from './logger';
import { parseBoundedContentLength } from './http-limits';
import { validateEgressGatewayHardenedConfig } from './secure-startup';
import { isOpaqueObjectContentDisposition } from './file-metadata';

export const app: Express = express();
app.disable('x-powered-by');
validateEgressGatewayHardenedConfig();
app.use(traceHttpRequest('codeapi.egress_gateway.request'));
app.use(httpMetricsMiddleware);

const SUPPORTED_OUTPUT_EXTENSIONS = new Set([
  '.c', '.cs', '.cpp', '.go', '.java', '.js', '.kt', '.kts', '.lua',
  '.php', '.pl', '.ps1', '.py', '.r', '.rb', '.rs', '.scala', '.sh',
  '.sql', '.swift', '.ts', '.jsx', '.tsx', '.groovy',
  '.css', '.htm', '.html', '.less', '.sass', '.scss', '.svg', '.svelte', '.vue',
  '.adoc', '.asciidoc', '.md', '.rst', '.tex', '.txt', '.wiki',
  '.csv', '.json', '.bson', '.json5', '.jsonl', '.parquet', '.tsv',
  '.xml', '.yaml', '.yml',
  '.ics', '.ical', '.ifb', '.icalendar',
  '.conf', '.env', '.gitignore', '.ini', '.properties', '.toml',
  '.doc', '.docx', '.pdf', '.ppt', '.pptx', '.xls', '.xlsx',
  '.odt', '.ods', '.odp', '.rtf',
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png',
  '.tif', '.tiff', '.webp',
  '.eot', '.ttf', '.woff', '.woff2',
  '.7z', '.bz2', '.gz', '.gzip', '.rar', '.tar', '.zip',
  '.tf', '.tfvars', '.tfstate', '.hcl',
  '.dockerfile', '.Dockerfile', '.dockerignore',
  '.helmignore', '.helmfile', '.jenkinsfile', '.vagrantfile',
  '.eslintrc', '.prettierrc', '.editorconfig', '.nomad',
  '.bat', '.cmd', '.deb', '.log', '.rpm', '.vbs',
]);

type EgressAuditFields = {
  execHash?: string;
  requestExecHash?: string;
  tenantHash?: string;
  userHash?: string;
  authContextHash?: string;
  principalSource?: string;
};

function routeFamily(req: Request): string {
  if (req.path === '/live' || req.path === '/health' || req.path === '/ready' || req.path === '/metrics') return req.path.slice(1);
  if (req.path.startsWith('/internal/')) return 'internal';
  if (req.path === '/tool-call') return 'ptc-tool-call';
  if (req.path.startsWith('/sessions/')) {
    if (req.method === 'PUT') return 'file-upload';
    if (req.method === 'GET' && req.path.includes('/objects/')) return 'file-download';
    if (req.method === 'GET' && req.path.endsWith('/objects')) return 'file-list';
    return 'file-unknown';
  }
  return 'unknown';
}

function requestId(res: Response): string | undefined {
  return res.locals.egressRequestId as string | undefined;
}

function hashLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(value, 'utf8').digest('base64url').slice(0, 16);
}

function auditFields(res: Response): EgressAuditFields {
  return (res.locals.egressAuditFields as EgressAuditFields | undefined) ?? {};
}

function isSyntheticEgressRequest(res: Response): boolean {
  return res.locals.syntheticInternalRequest === true
    || isSyntheticPrincipalSource(auditFields(res).principalSource);
}

function setGrantAudit(res: Response, grant: EgressGrantClaims): void {
  res.locals.egressAuditFields = {
    execHash: hashLabel(grant.exec_id),
    tenantHash: hashLabel(grant.tenant_id),
    userHash: hashLabel(grant.user_id),
    authContextHash: hashLabel(grant.auth_context_hash),
    ...(grant.principal_source ? { principalSource: grant.principal_source } : {}),
  };
}

function setPtcAudit(res: Response, args: { callbackExecId: string; requestExecId: string }): void {
  res.locals.egressAuditFields = {
    execHash: hashLabel(args.callbackExecId),
    requestExecHash: hashLabel(args.requestExecId),
  };
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const started = Date.now();
  const id = req.header('x-request-id') ?? crypto.randomUUID();
  res.locals.syntheticInternalRequest = req.path.startsWith('/internal/')
    && isSyntheticInternalRequestHeader(req.header(CODEAPI_SYNTHETIC_INTERNAL_REQUEST_HEADER));
  res.locals.egressRequestId = id;
  res.setHeader('X-Request-ID', id);

  res.on('finish', () => {
    if (req.path === '/live' || req.path === '/health' || req.path === '/ready' || req.path === '/metrics') return;
    if (res.statusCode < 400 && isSyntheticEgressRequest(res)) return;
    logger.info('Egress gateway request completed', {
      requestId: id,
      method: req.method,
      route: routeFamily(req),
      statusCode: res.statusCode,
      durationMs: Date.now() - started,
      contentLength: req.header('content-length'),
      ...auditFields(res),
    });
  });

  next();
});

function errorStatus(error: EgressGrantError): number {
  if (error.reason === 'missing_secret' || error.reason === 'weak_secret') return 500;
  if (error.reason === 'malformed') return 400;
  if (error.reason === 'expired') return 401;
  return 403;
}

function sendEgressError(req: Request, res: Response, error: unknown): Response {
  if (error instanceof EgressGrantError) {
    const statusCode = errorStatus(error);
    logger.warn('Rejected egress gateway request', {
      requestId: requestId(res),
      reason: error.reason,
      method: req.method,
      route: routeFamily(req),
      statusCode,
      ...auditFields(res),
    });
    return res.status(statusCode).json({ error: error.message });
  }
  logger.error('Egress gateway request failed', {
    requestId: requestId(res),
    method: req.method,
    route: routeFamily(req),
    error,
    ...auditFields(res),
  });
  return res.status(500).json({ error: 'Internal server error' });
}

async function getGrant(req: Request, res: Response): Promise<EgressGrantClaims> {
  const token = req.header(EGRESS_GRANT_HEADER);
  if (!token) {
    throw new EgressGrantError('malformed', `${EGRESS_GRANT_HEADER} is required`);
  }
  const grant = openEgressGrant(token, env.EGRESS_GRANT_SECRET);
  setGrantAudit(res, grant);
  if (grant.legacy_grant) {
    await ensureEgressLedger(grant);
  }
  await assertEgressGrantActive(grant);
  return grant;
}

function isDirkeepName(name: string): boolean {
  return name === '.dirkeep' || name.endsWith('/.dirkeep');
}

function decodeOriginalFilename(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new EgressGrantError('malformed', 'X-Original-Filename is not valid percent-encoding');
  }
}

function normalizePtcCallbackTimeoutSeconds(rawTimeoutSeconds: unknown): number {
  const raw = rawTimeoutSeconds === undefined ? env.EGRESS_GRANT_TTL_SECONDS : rawTimeoutSeconds;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new EgressGrantError('malformed', 'timeoutSeconds must be a finite positive number');
  }
  return Math.max(1, Math.floor(raw));
}

function assertOutputFilenameAllowed(name: string): void {
  if (!name || name === '.') {
    throw new EgressGrantError('malformed', 'Output filename must not be empty');
  }
  if (name.includes('\0') || name.includes('\\') || path.posix.isAbsolute(name)) {
    throw new EgressGrantError('malformed', 'Output filename must be a relative POSIX path');
  }
  if (name.length > env.EGRESS_GATEWAY_MAX_PATH_LENGTH) {
    throw new EgressGrantError('malformed', 'Output filename exceeds gateway path length limit');
  }
  const parts = name.split('/').filter(Boolean);
  if (parts.some(part => part === '..' || part === '.')) {
    throw new EgressGrantError('malformed', 'Output filename must not contain traversal segments');
  }
  const depth = parts.length;
  if (depth > env.EGRESS_GATEWAY_MAX_NESTING_DEPTH) {
    throw new EgressGrantError('malformed', 'Output filename exceeds gateway nesting depth limit');
  }
  if (path.posix.normalize(name) !== name || name.endsWith('/')) {
    throw new EgressGrantError('malformed', 'Output filename must be canonical');
  }
  if (!isDirkeepName(name)) {
    const basename = path.posix.basename(name);
    const ext = path.posix.extname(basename).toLowerCase();
    const dottedBasename = `.${basename}`;
    const allowed =
      (ext !== '' && SUPPORTED_OUTPUT_EXTENSIONS.has(ext)) ||
      SUPPORTED_OUTPUT_EXTENSIONS.has(basename) ||
      SUPPORTED_OUTPUT_EXTENSIONS.has(basename.toLowerCase()) ||
      (ext === '' && (
        SUPPORTED_OUTPUT_EXTENSIONS.has(dottedBasename) ||
        SUPPORTED_OUTPUT_EXTENSIONS.has(dottedBasename.toLowerCase())
      ));
    if (!allowed) {
      throw new EgressGrantError('scope_mismatch', 'Output filename extension is not supported');
    }
  }
}

function inputFileKey(args: { session_id: string; id: string; name: string }): string {
  return `${args.session_id}\0${args.id}\0${args.name}`;
}

function assertGrantSession(grant: EgressGrantClaims, sessionId: string, direction: 'read' | 'write'): void {
  if (direction === 'read') {
    if (!grant.read_sessions.includes(sessionId)) {
      throw new EgressGrantError('scope_mismatch', 'Read session is outside the egress grant scope');
    }
    return;
  }
  if (grant.output_session_id !== sessionId) {
    throw new EgressGrantError('scope_mismatch', 'Write session is outside the egress grant scope');
  }
}

function openSessionParam(raw: string, grant: EgressGrantClaims, direction: 'read' | 'write'): string {
  const handle = openEgressRouteHandle(raw, env.EGRESS_GRANT_SECRET);
  if (handle.typ !== 'session' || handle.dir !== direction) {
    throw new EgressGrantError('wrong_type', `Expected an egress ${direction} session handle`);
  }
  if (handle.exec_id !== grant.exec_id) {
    throw new EgressGrantError('scope_mismatch', 'Session handle execution does not match grant');
  }
  if (env.EGRESS_LEDGER_REQUIRED && handle.grant_id !== grant.grant_id && !(grant.legacy_grant && handle.grant_id === undefined)) {
    throw new EgressGrantError('scope_mismatch', 'Session handle grant does not match request grant');
  }
  assertGrantSession(grant, handle.session_id, direction);
  return handle.session_id;
}

function inputFileSet(grant: EgressGrantClaims): Set<string> {
  return new Set(grant.input_files.map(inputFileKey));
}

function requiredDirkeepSet(grant: EgressGrantClaims): Set<string> {
  const markers = new Set<string>();
  for (const file of grant.input_files) {
    const parts = file.name.split('/').filter(Boolean);
    if (parts.length <= 1) continue;
    let prefix = '';
    for (const part of parts.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${part}` : part;
      markers.add(`${file.session_id}\0${prefix}/.dirkeep`);
    }
  }
  return markers;
}

function isAllowedReadObject(
  grant: EgressGrantClaims,
  args: { session_id: string; id: string; name: string },
  allowedFiles = inputFileSet(grant),
  allowedDirkeeps = requiredDirkeepSet(grant),
): boolean {
  if (allowedFiles.has(inputFileKey(args))) return true;
  return isDirkeepName(args.name) && allowedDirkeeps.has(`${args.session_id}\0${args.name}`);
}

function openObjectParam(raw: string, grant: EgressGrantClaims, sessionId: string): { id: string; name: string } {
  const handle = openEgressRouteHandle(raw, env.EGRESS_GRANT_SECRET);
  if (handle.typ !== 'object') {
    throw new EgressGrantError('wrong_type', 'Expected an egress object handle');
  }
  if (handle.exec_id !== grant.exec_id || handle.session_id !== sessionId) {
    throw new EgressGrantError('scope_mismatch', 'Object handle does not match grant/session');
  }
  if (env.EGRESS_LEDGER_REQUIRED && handle.grant_id !== grant.grant_id && !(grant.legacy_grant && handle.grant_id === undefined)) {
    throw new EgressGrantError('scope_mismatch', 'Object handle grant does not match request grant');
  }
  const allowed = isAllowedReadObject(grant, {
    session_id: handle.session_id,
    id: handle.object_id,
    name: handle.name,
  });
  if (!allowed) {
    throw new EgressGrantError('scope_mismatch', 'Object handle is outside the egress grant file scope');
  }
  return { id: handle.object_id, name: handle.name };
}

function responseHeaders(fetchResponse: globalThis.Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of fetchResponse.headers.entries()) {
    if (['connection', 'keep-alive', 'transfer-encoding'].includes(key.toLowerCase())) continue;
    headers[key] = value;
  }
  return headers;
}

function pipeFetchResponse(
  fetchResponse: globalThis.Response,
  res: Response,
  headerOverrides: Record<string, string> = {},
): void {
  res.status(fetchResponse.status);
  res.set({ ...responseHeaders(fetchResponse), ...headerOverrides });
  if (!fetchResponse.body) {
    res.end();
    return;
  }
  Readable.fromWeb(fetchResponse.body as unknown as import('stream/web').ReadableStream).pipe(res);
}

async function readRequestBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function forwardUrl(base: string, path: string, search = ''): string {
  return `${base.replace(/\/+$/, '')}${path}${search}`;
}

async function readiness(_req: Request, res: Response): Promise<void> {
  try {
    await pingEgressLedger();
    res.sendStatus(200);
  } catch (error) {
    logger.error('Egress gateway readiness failed', { error });
    res.sendStatus(503);
  }
}

app.get('/live', (_req, res) => res.sendStatus(200));
app.get('/health', readiness);
app.get('/ready', readiness);
app.get('/metrics', metricsHandler);

app.post('/internal/egress-grants', express.json({ limit: env.HTTP_JSON_LIMIT }), requireConfiguredInternalServiceAuth, async (req, res) => {
  try {
    const body = req.body as { payload?: unknown; claims?: unknown };
    if (!body || typeof body !== 'object' || !body.payload || !body.claims) {
      return res.status(400).json({ error: 'payload and claims are required' });
    }
    const grantId = nanoid();
    const claims = body.claims as ExecutionManifestClaims;
    const prepared = prepareSandboxEgress({
      payload: body.payload as Parameters<typeof prepareSandboxEgress>[0]['payload'],
      claims,
      grantId,
      secret: env.EGRESS_GRANT_SECRET,
    });
    const grant = openEgressGrant(prepared.egressGrantToken, env.EGRESS_GRANT_SECRET);
    setGrantAudit(res, grant);
    await createEgressLedger(grant);
    if (!isSyntheticPrincipalSource(grant.principal_source)) {
      logger.info('Egress grant created', {
        grantHash: hashLabel(grant.grant_id),
        execHash: hashLabel(grant.exec_id),
        tenantHash: hashLabel(grant.tenant_id),
        userHash: hashLabel(grant.user_id),
      });
    }
    return res.status(201).json({ grant_id: grantId, ...prepared });
  } catch (error) {
    return sendEgressError(req, res, error);
  }
});

async function restoreInternalSandboxResult(args: {
  res: Response;
  result: unknown;
  egressGrantToken: string;
  expectedGrantId?: string;
}): Promise<Response> {
  const grant = openEgressGrant(args.egressGrantToken, env.EGRESS_GRANT_SECRET);
  setGrantAudit(args.res, grant);
  if (args.expectedGrantId && grant.grant_id !== args.expectedGrantId) {
    throw new EgressGrantError('scope_mismatch', 'Restore grant id does not match token');
  }
  if (grant.legacy_grant) {
    await ensureEgressLedger(grant);
  }
  await assertEgressGrantActive(grant);
  const restored = restoreSandboxExecuteResult(
    args.result as Parameters<typeof restoreSandboxExecuteResult>[0],
    args.egressGrantToken,
    env.EGRESS_GRANT_SECRET,
  );
  return args.res.status(200).json({ result: restored });
}

app.post('/internal/egress-grants/restore-result', express.json({ limit: env.HTTP_JSON_LIMIT }), requireConfiguredInternalServiceAuth, async (req, res) => {
  try {
    const body = req.body as { result?: unknown; egressGrantToken?: string };
    if (!body?.result || typeof body.egressGrantToken !== 'string') {
      return res.status(400).json({ error: 'result and egressGrantToken are required' });
    }
    return await restoreInternalSandboxResult({
      res,
      result: body.result,
      egressGrantToken: body.egressGrantToken,
    });
  } catch (error) {
    return sendEgressError(req, res, error);
  }
});

app.post('/internal/egress-grants/:grantId/restore-result', express.json({ limit: env.HTTP_JSON_LIMIT }), requireConfiguredInternalServiceAuth, async (req, res) => {
  try {
    const body = req.body as { result?: unknown; egressGrantToken?: string };
    if (!body?.result || typeof body.egressGrantToken !== 'string') {
      return res.status(400).json({ error: 'result and egressGrantToken are required' });
    }
    return await restoreInternalSandboxResult({
      res,
      result: body.result,
      egressGrantToken: body.egressGrantToken,
      expectedGrantId: req.params.grantId,
    });
  } catch (error) {
    return sendEgressError(req, res, error);
  }
});

app.post('/internal/egress-grants/revoke', express.json({ limit: env.HTTP_JSON_LIMIT }), requireConfiguredInternalServiceAuth, async (req, res) => {
  try {
    const body = req.body as { reason?: unknown; egressGrantToken?: unknown };
    if (typeof body?.egressGrantToken !== 'string') {
      return res.status(400).json({ error: 'egressGrantToken is required' });
    }
    const grant = openEgressGrant(body.egressGrantToken, env.EGRESS_GRANT_SECRET);
    setGrantAudit(res, grant);
    if (grant.legacy_grant) {
      await ensureEgressLedger(grant);
    }
    const reason = typeof body.reason === 'string' ? body.reason : 'completed';
    await revokeEgressLedger(grant.grant_id, reason);
    return res.status(204).end();
  } catch (error) {
    return sendEgressError(req, res, error);
  }
});

app.post('/internal/egress-grants/:grantId/revoke', express.json({ limit: '16kb' }), requireConfiguredInternalServiceAuth, async (req, res) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'completed';
    await revokeEgressLedger(req.params.grantId, reason);
    return res.status(204).end();
  } catch (error) {
    return sendEgressError(req, res, error);
  }
});

app.post('/internal/ptc-callback-token', express.json({ limit: '128kb' }), requireConfiguredInternalServiceAuth, async (req, res) => {
  try {
    const body = req.body as {
      executionId?: string;
      sessionId?: string;
      callbackToken?: string;
      timeoutSeconds?: number;
      allowedToolNames?: string[];
    };
    if (!body.executionId || !body.sessionId || !body.callbackToken) {
      return res.status(400).json({ error: 'executionId, sessionId, and callbackToken are required' });
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    const timeoutSeconds = normalizePtcCallbackTimeoutSeconds(body.timeoutSeconds);
    const expiresAt = issuedAt + Math.min(timeoutSeconds, env.EGRESS_GRANT_TTL_SECONDS);
    const grantId = nanoid();
    const token = sealPtcCallbackToken({
      grantId,
      executionId: body.executionId,
      sessionId: body.sessionId,
      callbackToken: body.callbackToken,
      allowedToolNames: body.allowedToolNames,
      issuedAt,
      expiresAt,
      secret: env.EGRESS_GRANT_SECRET,
    });
    await createEgressLedger({
      ...egressGrantFromExecutionClaims({
        v: 1,
        exec_id: body.executionId,
        tenant_id: 'ptc',
        user_id: 'ptc',
        session_key: body.sessionId,
        input_files: [],
        read_sessions: [],
        output_session_id: body.sessionId,
        max_upload_bytes: 0,
        max_output_files: 0,
        max_requests: env.EXECUTION_MANIFEST_MAX_REQUESTS,
        iat: issuedAt,
        exp: expiresAt,
      }, grantId),
      v: 1,
      typ: 'grant',
    });
    return res.status(201).json({ grant_id: grantId, callbackToken: token });
  } catch (error) {
    return sendEgressError(req, res, error);
  }
});

app.get('/sessions/:sessionHandle/objects', async (req, res) => {
  try {
    if (Object.keys(req.query).some(key => key !== 'detail') || req.query.detail !== 'normalized') {
      return res.status(400).json({ error: 'Only detail=normalized object listings are supported' });
    }
    const grant = await getGrant(req, res);
    const sessionId = openSessionParam(req.params.sessionHandle, grant, 'read');
    await recordEgressRead(grant);
    const upstream = await fetch(
      forwardUrl(
        env.EGRESS_GATEWAY_FILE_SERVER_URL,
        `/sessions/${encodeURIComponent(sessionId)}/objects`,
        '?detail=normalized',
      ),
      { headers: injectTraceHeaders(internalServiceHeaders({ Accept: 'application/json' })) },
    );
    if (!upstream.ok) {
      return pipeFetchResponse(upstream, res);
    }
    const data: unknown = await upstream.json();
    if (!Array.isArray(data)) {
      return res.status(502).json({ error: 'Invalid file-server object listing' });
    }

    const allowedFiles = inputFileSet(grant);
    const allowedDirkeeps = requiredDirkeepSet(grant);
    const now = Math.floor(Date.now() / 1000);
    const normalized = data
      .filter((obj): obj is { id: string; name: string; storage_session_id: string } => (
        obj != null &&
        typeof obj === 'object' &&
        typeof (obj as { id?: unknown }).id === 'string' &&
        typeof (obj as { name?: unknown }).name === 'string' &&
        typeof (obj as { storage_session_id?: unknown }).storage_session_id === 'string' &&
        (obj as { storage_session_id: string }).storage_session_id === sessionId
      ))
      .filter(obj => isAllowedReadObject(
        grant,
        { session_id: obj.storage_session_id, id: obj.id, name: obj.name },
        allowedFiles,
        allowedDirkeeps,
      ))
      .map(obj => ({
        ...obj,
        storage_session_id: req.params.sessionHandle,
        id: sealEgressHandle({
          typ: 'object',
          dir: 'read',
          grant_id: grant.grant_id,
          exec_id: grant.exec_id,
          session_id: obj.storage_session_id,
          object_id: obj.id,
          name: obj.name,
          iat: now,
          exp: grant.exp,
        }, env.EGRESS_GRANT_SECRET),
      }));

    return res.status(200).json(normalized);
  } catch (error) {
    return sendEgressError(req, res, error);
  }
});

app.get('/sessions/:sessionHandle/objects/:objectHandle', async (req, res) => {
  try {
    if (Object.keys(req.query).length > 0) {
      return res.status(400).json({ error: 'Object download query parameters are not supported' });
    }
    const grant = await getGrant(req, res);
    const sessionId = openSessionParam(req.params.sessionHandle, grant, 'read');
    const object = openObjectParam(req.params.objectHandle, grant, sessionId);
    await recordEgressRead(grant);
    const upstream = await fetch(
      forwardUrl(
        env.EGRESS_GATEWAY_FILE_SERVER_URL,
        `/sessions/${encodeURIComponent(sessionId)}/objects/${encodeURIComponent(object.id)}`,
      ),
      { headers: injectTraceHeaders(internalServiceHeaders()) },
    );
    const headerOverrides: Record<string, string> =
      isOpaqueObjectContentDisposition(
        upstream.headers.get('content-disposition'),
        object.id,
      )
        ? { 'content-disposition': 'attachment' }
        : {};
    return pipeFetchResponse(upstream, res, headerOverrides);
  } catch (error) {
    return sendEgressError(req, res, error);
  }
});

app.put('/sessions/:sessionHandle/objects/:fileId', async (req, res) => {
  let reservedUpload: { grant: EgressGrantClaims; fileId: string; bytes: number } | undefined;
  try {
    if (Object.keys(req.query).length > 0) {
      return res.status(400).json({ error: 'Object upload query parameters are not supported' });
    }
    const grant = await getGrant(req, res);
    const sessionId = openSessionParam(req.params.sessionHandle, grant, 'write');
    const fileId = req.params.fileId;
    if (!isValidId(fileId)) {
      return res.status(400).json({ error: 'Invalid output file id' });
    }
    const uploadByteLimit = Math.min(grant.max_upload_bytes, env.EGRESS_GATEWAY_MAX_FILE_BYTES);
    const parsedLength = parseBoundedContentLength(
      req.header('content-length'),
      uploadByteLimit,
      'Upload exceeds grant byte limit',
    );
    if (!parsedLength.ok) {
      return res.status(parsedLength.status).json({ error: parsedLength.error });
    }
    const contentLength = parsedLength.length;
    const originalFilename = req.header('x-original-filename');
    if (!originalFilename) {
      return res.status(400).json({ error: 'X-Original-Filename is required' });
    }
    assertOutputFilenameAllowed(decodeOriginalFilename(originalFilename));
    const uploadReservation = { grant, fileId, bytes: contentLength };
    await reserveEgressUpload(uploadReservation);
    reservedUpload = uploadReservation;
    const headers = injectTraceHeaders(internalServiceHeaders({
      'Content-Type': req.header('content-type') ?? 'application/octet-stream',
      'Content-Length': String(contentLength),
      'X-Original-Filename': originalFilename,
    }));
    const upstream = await fetch(
      forwardUrl(
        env.EGRESS_GATEWAY_FILE_SERVER_URL,
        `/sessions/${encodeURIComponent(sessionId)}/objects/${encodeURIComponent(fileId)}`,
      ),
      {
        method: 'PUT',
        headers,
        body: req as unknown as BodyInit,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' },
    );
    if (!upstream.ok) {
      await releaseEgressUpload(reservedUpload);
      reservedUpload = undefined;
    } else {
      reservedUpload = undefined;
    }
    return pipeFetchResponse(upstream, res);
  } catch (error) {
    if (reservedUpload) {
      await releaseEgressUpload(reservedUpload).catch(releaseError => {
        logger.error('Failed to release egress upload reservation after upstream failure', {
          error: releaseError,
          grantHash: hashLabel(reservedUpload?.grant.grant_id),
          fileId: reservedUpload?.fileId,
        });
      });
    }
    return sendEgressError(req, res, error);
  }
});

app.post('/tool-call', async (req, res) => {
  try {
    const executionId = req.header('x-execution-id') ?? '';
    const callId = req.header('x-tool-call-id') ?? '';
    const opaqueCallbackToken = req.header('x-callback-token') ?? '';
    if (!executionId || !callId || !opaqueCallbackToken) {
      /* Generic 404 so a sandbox attacker probing paths cannot tell that
       * `/tool-call` is the live route by reading the error body. The
       * body and headers must MATCH the tool-call socket proxy's own 404
       * for unknown paths (see api/src/tool-call-socket-proxy.ts) byte-
       * for-byte — case included — otherwise the sandbox can still
       * fingerprint the real route by comparing response shapes. */
      logger.warn(
        '/tool-call rejected: missing PTC headers',
        {
          executionIdPresent: !!executionId,
          callIdPresent: !!callId,
          callbackTokenPresent: !!opaqueCallbackToken,
          remoteAddress: req.socket.remoteAddress,
        },
      );
      res.setHeader('Connection', 'close');
      return res.status(404).type('text/plain').send('not found');
    }
    const parsedLength = parseBoundedContentLength(
      req.header('content-length'),
      env.EGRESS_GATEWAY_MAX_TOOL_CALL_BYTES,
      'Tool call body exceeds gateway limit',
    );
    if (!parsedLength.ok) {
      return res.status(parsedLength.status).json({ error: parsedLength.error });
    }
    const length = parsedLength.length;
    const callback = openPtcCallbackToken(opaqueCallbackToken, env.EGRESS_GRANT_SECRET);
    setPtcAudit(res, { callbackExecId: callback.exec_id, requestExecId: executionId });
    if (callback.exec_id !== executionId) {
      throw new EgressGrantError('scope_mismatch', 'PTC callback token execution does not match request');
    }
    const body = await readRequestBody(req);
    if (callback.allowed_tool_names !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        throw new EgressGrantError('malformed', 'Malformed PTC tool-call JSON');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new EgressGrantError('malformed', 'Malformed PTC tool-call JSON');
      }
      const toolName = (parsed as { tool_name?: unknown }).tool_name;
      if (typeof toolName !== 'string' || !callback.allowed_tool_names.includes(toolName)) {
        throw new EgressGrantError('scope_mismatch', 'PTC tool is outside callback token scope');
      }
      await recordEgressToolCall(callback.grant_id, executionId);
      const upstream = await fetch(forwardUrl(env.EGRESS_GATEWAY_TOOL_CALL_SERVER_URL, '/tool-call'), {
        method: 'POST',
        headers: {
          ...injectTraceHeaders(),
          'Content-Type': req.header('content-type') ?? 'application/json',
          'Content-Length': String(length),
          'X-Execution-ID': executionId,
          'X-Callback-Token': callback.callback_token,
          'X-Tool-Call-ID': callId,
        },
        body: body as unknown as BodyInit,
      });
      return pipeFetchResponse(upstream, res);
    }
    await recordEgressToolCall(callback.grant_id, executionId);
    const upstream = await fetch(forwardUrl(env.EGRESS_GATEWAY_TOOL_CALL_SERVER_URL, '/tool-call'), {
      method: 'POST',
      headers: {
        ...injectTraceHeaders(),
        'Content-Type': req.header('content-type') ?? 'application/json',
        'Content-Length': String(length),
        'X-Execution-ID': executionId,
        'X-Callback-Token': callback.callback_token,
        'X-Tool-Call-ID': callId,
      },
      body: body as unknown as BodyInit,
    });
    return pipeFetchResponse(upstream, res);
  } catch (error) {
    return sendEgressError(req, res, error);
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

let server: ReturnType<typeof app.listen> | undefined;
let shuttingDown = false;

function closeHttpServer(): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server?.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down egress gateway...');
  try {
    await closeHttpServer();
    try {
      await shutdownTelemetry();
    } catch (telemetryError) {
      logger.warn('OpenTelemetry shutdown failed', { error: telemetryError });
    }
    process.exit(0);
  } catch (error) {
    logger.error('Egress gateway shutdown failed', { error });
    try {
      await shutdownTelemetry();
    } catch (telemetryError) {
      logger.warn('OpenTelemetry shutdown failed', { error: telemetryError });
    }
    process.exit(1);
  }
}

if (process.env.CODEAPI_EGRESS_GATEWAY_AUTOSTART !== 'false') {
  server = app.listen(env.EGRESS_GATEWAY_PORT, () => {
    logger.info(`Egress gateway listening on port ${env.EGRESS_GATEWAY_PORT}`);
  });

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
