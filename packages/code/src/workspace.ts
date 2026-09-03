import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { FileHandle } from 'node:fs/promises';

import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_WORKSPACE_READ_MAX_BYTES,
  BRIDGE_WORKSPACE_READ_MAX_LINES,
  BRIDGE_WORKSPACE_WRITE_MAX_BYTES,
  BRIDGE_WORKSPACE_LIST_MAX_RESULTS,
  BRIDGE_WORKSPACE_SEARCH_MAX_RESULTS,
  BRIDGE_WORKSPACE_SEARCH_TEXT_MAX_LENGTH,
  isSafePortableRelativePath,
  isValidBridgeWorkspaceToolCapabilities,
  isWorkspaceToolRequest,
  isWorkspaceToolResult,
} from './protocol.js';

import type {
  BridgeWorkspaceDescriptor,
  BridgeWorkspaceToolCapabilities,
  WorkspaceReadFileRequest,
  WorkspaceReadFileResult,
  WorkspaceEditFileRequest,
  WorkspaceEditFileResult,
  WorkspaceListFilesRequest,
  WorkspaceListFilesResult,
  WorkspaceSearchMatch,
  WorkspaceSearchTextRequest,
  WorkspaceSearchTextResult,
  WorkspaceWriteFileRequest,
  WorkspaceWriteFileResult,
  WorkspaceToolRequest,
  WorkspaceToolErrorCode,
  WorkspaceToolResult,
} from './protocol.js';

export { isWorkspaceToolRequest, isWorkspaceToolResult };
export type {
  WorkspaceReadFileRequest,
  WorkspaceReadFileResult,
  WorkspaceEditFileRequest,
  WorkspaceEditFileResult,
  WorkspaceListFilesRequest,
  WorkspaceListFilesResult,
  WorkspaceSearchMatch,
  WorkspaceSearchTextRequest,
  WorkspaceSearchTextResult,
  WorkspaceWriteFileRequest,
  WorkspaceWriteFileResult,
  WorkspaceToolRequest,
  WorkspaceToolResult,
};

export interface LocalWorkspaceConfig {
  id: string;
  name?: string;
  root: string;
  /** Mutating operations are never advertised unless explicitly enabled. */
  writable?: boolean;
}

export interface LocalWorkspaceToolsOptions {
  workspaces: LocalWorkspaceConfig[];
}

export interface WorkspaceToolExecutor {
  capabilities: BridgeWorkspaceToolCapabilities;
  execute(
    request: WorkspaceToolRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceToolResult>;
}

const MAX_SEARCH_CANDIDATE_BYTES = 1024 * 1024;
const MAX_SEARCH_CANDIDATES = 20_000;
const SEARCH_TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 10_000;

const READ_OPERATIONS = [
  'read_file',
  'search_text',
  'list_files',
] as const;
const WRITE_OPERATIONS = ['write_file', 'edit_file'] as const;

function isUtf8ScalarString(value: string): boolean {
  return Buffer.from(value).toString('utf8') === value;
}

function decodeWorkspaceText(content: Buffer): string {
  if (content[0] === 0xff && content[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(content.subarray(2));
  }
  if (content[0] === 0xfe && content[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(content.subarray(2));
  }
  const utf8Start =
    content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf ? 3 : 0;
  return content.subarray(utf8Start).toString('utf8');
}

function sliceWithoutSplittingSurrogates(
  value: string,
  start: number,
  maxLength: number,
): string {
  let safeStart = start;
  if (
    safeStart > 0 &&
    safeStart < value.length &&
    value.charCodeAt(safeStart) >= 0xdc00 &&
    value.charCodeAt(safeStart) <= 0xdfff &&
    value.charCodeAt(safeStart - 1) >= 0xd800 &&
    value.charCodeAt(safeStart - 1) <= 0xdbff
  ) {
    safeStart += 1;
  }
  let safeEnd = Math.min(value.length, safeStart + maxLength);
  if (
    safeEnd < value.length &&
    value.charCodeAt(safeEnd - 1) >= 0xd800 &&
    value.charCodeAt(safeEnd - 1) <= 0xdbff &&
    value.charCodeAt(safeEnd) >= 0xdc00 &&
    value.charCodeAt(safeEnd) <= 0xdfff
  ) {
    safeEnd -= 1;
  }
  return value.slice(safeStart, safeEnd);
}

export class WorkspaceToolError extends Error {
  constructor(
    message: string,
    public readonly code: WorkspaceToolErrorCode,
  ) {
    super(message);
    this.name = 'WorkspaceToolError';
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return !(
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

function resolveWorkspacePath(root: string, requestedPath: string): string {
  if (
    !requestedPath ||
    requestedPath.includes('\0') ||
    !isUtf8ScalarString(requestedPath) ||
    isAbsolute(requestedPath)
  ) {
    throw new WorkspaceToolError('Invalid workspace path', 'INVALID_PATH');
  }
  const candidate = resolve(root, requestedPath);
  if (!isWithinRoot(root, candidate)) {
    throw new WorkspaceToolError('Invalid workspace path', 'INVALID_PATH');
  }
  return candidate;
}

async function readConfinedFileBuffer(
  root: string,
  requestedPath: string,
): Promise<Buffer> {
  const candidate = resolveWorkspacePath(root, requestedPath);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const [openedFile, canonicalPath] = await Promise.all([
      handle.stat(),
      realpath(candidate),
    ]);
    const canonicalFile = await stat(canonicalPath);
    if (
      !openedFile.isFile() ||
      !isWithinRoot(root, canonicalPath) ||
      openedFile.dev !== canonicalFile.dev ||
      openedFile.ino !== canonicalFile.ino
    ) {
      throw new Error('Invalid workspace path');
    }
    if (openedFile.size > BRIDGE_WORKSPACE_READ_MAX_BYTES) {
      throw new WorkspaceToolError(
        'Workspace file exceeds read limit',
        'READ_LIMIT_EXCEEDED',
      );
    }
    const buffer = Buffer.allocUnsafe(BRIDGE_WORKSPACE_READ_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead <= BRIDGE_WORKSPACE_READ_MAX_BYTES) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > BRIDGE_WORKSPACE_READ_MAX_BYTES) {
      throw new WorkspaceToolError(
        'Workspace file exceeds read limit',
        'READ_LIMIT_EXCEEDED',
      );
    }
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error;
    throw new WorkspaceToolError('Invalid workspace path', 'INVALID_PATH');
  } finally {
    await handle?.close();
  }
}

async function readConfinedFile(
  root: string,
  requestedPath: string,
): Promise<string> {
  const decoded = decodeWorkspaceText(
    await readConfinedFileBuffer(root, requestedPath),
  );
  if (Buffer.byteLength(decoded, 'utf8') > BRIDGE_WORKSPACE_READ_MAX_BYTES) {
    throw new WorkspaceToolError(
      'Workspace file exceeds read limit',
      'READ_LIMIT_EXCEEDED',
    );
  }
  return decoded;
}

interface WorkspaceRoot {
  root: string;
  writable: boolean;
}

async function verifyDirectoryPathHasNoSymlinks(
  root: string,
  directory: string,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  const relativeDirectory = relative(root, directory);
  let current = root;
  let currentIdentity = await lstat(root);
  for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    currentIdentity = await lstat(current);
    if (currentIdentity.isSymbolicLink() || !currentIdentity.isDirectory()) {
      throw new WorkspaceToolError('Invalid workspace path', 'INVALID_PATH');
    }
  }
  return currentIdentity;
}

function classifyWritePathValidationError(error: unknown): WorkspaceToolError {
  if (error instanceof WorkspaceToolError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
    return new WorkspaceToolError('Invalid workspace path', 'INVALID_PATH');
  }
  return new WorkspaceToolError(
    'Workspace storage is unavailable',
    'WRITE_UNAVAILABLE',
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new WorkspaceToolError(
    'Workspace tool execution aborted',
    'EXECUTION_ABORTED',
  );
}

async function readBoundedEditFile(handle: FileHandle): Promise<Buffer> {
  const content = Buffer.allocUnsafe(BRIDGE_WORKSPACE_WRITE_MAX_BYTES + 1);
  let bytesRead = 0;
  while (bytesRead < content.byteLength) {
    const result = await handle.read(
      content,
      bytesRead,
      content.byteLength - bytesRead,
      bytesRead,
    );
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  if (bytesRead > BRIDGE_WORKSPACE_WRITE_MAX_BYTES) {
    throw new WorkspaceToolError(
      'Workspace file exceeds write limit',
      'WRITE_LIMIT_EXCEEDED',
    );
  }
  return content.subarray(0, bytesRead);
}

async function verifyEditSource(
  root: string,
  candidate: string,
  expected: { dev: bigint | number; ino: bigint | number; content: Buffer },
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const [openedStat, canonicalPath] = await Promise.all([
      handle.stat(),
      realpath(candidate),
    ]);
    const canonicalStat = await stat(canonicalPath);
    if (
      !openedStat.isFile() ||
      !isWithinRoot(root, canonicalPath) ||
      openedStat.dev !== canonicalStat.dev ||
      openedStat.ino !== canonicalStat.ino ||
      openedStat.dev !== expected.dev ||
      openedStat.ino !== expected.ino
    ) {
      throw new WorkspaceToolError(
        'Workspace file changed before edit could be committed',
        'EDIT_CONFLICT',
      );
    }
    const current = await readBoundedEditFile(handle);
    if (!current.equals(expected.content)) {
      throw new WorkspaceToolError(
        'Workspace file changed before edit could be committed',
        'EDIT_CONFLICT',
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error;
    throw new WorkspaceToolError(
      'Workspace file changed before edit could be committed',
      'EDIT_CONFLICT',
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicWriteConfinedFile(
  root: string,
  requestedPath: string,
  content: Buffer,
  signal?: AbortSignal,
  expected?: { dev: bigint | number; ino: bigint | number; content: Buffer },
): Promise<{ created: boolean }> {
  throwIfAborted(signal);
  if (content.byteLength > BRIDGE_WORKSPACE_WRITE_MAX_BYTES) {
    throw new WorkspaceToolError(
      'Workspace file exceeds write limit',
      'WRITE_LIMIT_EXCEEDED',
    );
  }
  const candidate = resolveWorkspacePath(root, requestedPath);
  const parent = dirname(candidate);
  let canonicalParent: string;
  let parentIdentity: Awaited<ReturnType<typeof lstat>>;
  try {
    canonicalParent = await realpath(parent);
    parentIdentity = await verifyDirectoryPathHasNoSymlinks(root, parent);
    if (!isWithinRoot(root, canonicalParent) || !parentIdentity.isDirectory()) {
      throw new WorkspaceToolError('Invalid workspace path', 'INVALID_PATH');
    }
  } catch (error) {
    throw classifyWritePathValidationError(error);
  }

  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw classifyWritePathValidationError(error);
    }
  }
  if (existing?.isSymbolicLink() || (existing != null && !existing.isFile())) {
    throw new WorkspaceToolError('Invalid workspace path', 'INVALID_PATH');
  }
  if (
    expected != null &&
    (existing == null ||
      existing.dev !== expected.dev ||
      existing.ino !== expected.ino)
  ) {
    throw new WorkspaceToolError(
      'Workspace file changed before edit could be committed',
      'EDIT_CONFLICT',
    );
  }

  const temporary = resolve(
    canonicalParent,
    `.librechat-code-${randomBytes(18).toString('hex')}.tmp`,
  );
  const installTarget = resolve(canonicalParent, basename(candidate));
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    let offset = 0;
    while (offset < content.byteLength) {
      const { bytesWritten } = await handle.write(
        content,
        offset,
        content.byteLength - offset,
        offset,
      );
      if (bytesWritten < 1) throw new Error('short workspace write');
      offset += bytesWritten;
    }
    await handle.sync();
    if (existing != null) {
      if (process.platform !== 'win32') {
        await handle.chown(Number(existing.uid), Number(existing.gid));
      }
      await handle.chmod(Number(existing.mode) & 0o777);
      await handle.sync();
    }
    await handle.close();
    handle = undefined;

    let current: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      current = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      current?.isSymbolicLink() ||
      (expected == null
        ? existing == null
          ? current != null
          : current == null ||
            current.dev !== existing.dev ||
            current.ino !== existing.ino
        : current == null ||
          current.dev !== expected.dev ||
          current.ino !== expected.ino)
    ) {
      throw new WorkspaceToolError(
        'Workspace file changed before write could be committed',
        'EDIT_CONFLICT',
      );
    }
    if (expected != null) {
      await verifyEditSource(root, candidate, expected);
    }
    const [currentParent, currentParentIdentity] = await Promise.all([
      realpath(parent),
      verifyDirectoryPathHasNoSymlinks(root, parent),
    ]);
    if (
      currentParent !== canonicalParent ||
      currentParentIdentity.isSymbolicLink() ||
      !currentParentIdentity.isDirectory() ||
      currentParentIdentity.dev !== parentIdentity.dev ||
      currentParentIdentity.ino !== parentIdentity.ino
    ) {
      throw new WorkspaceToolError('Invalid workspace path', 'INVALID_PATH');
    }
    throwIfAborted(signal);
    await rename(temporary, installTarget);
    return { created: existing == null };
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error;
    throw new WorkspaceToolError(
      'Workspace storage is unavailable',
      'WRITE_UNAVAILABLE',
    );
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeWorkspaceFile(
  root: string,
  request: WorkspaceWriteFileRequest,
  signal?: AbortSignal,
): Promise<WorkspaceWriteFileResult> {
  const content = Buffer.from(request.content, 'utf8');
  const { created } = await atomicWriteConfinedFile(
    root,
    request.path,
    content,
    signal,
  );
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    operation: 'write_file',
    workspaceId: request.workspaceId,
    path: request.path,
    created,
    bytesWritten: content.byteLength,
  };
}

async function editWorkspaceFile(
  root: string,
  request: WorkspaceEditFileRequest,
  signal?: AbortSignal,
): Promise<WorkspaceEditFileResult> {
  const candidate = resolveWorkspacePath(root, request.path);
  let opened: FileHandle | undefined;
  try {
    opened = await open(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const [openedStat, canonicalPath] = await Promise.all([
      opened.stat(),
      realpath(candidate),
    ]);
    const canonicalStat = await stat(canonicalPath);
    if (
      !openedStat.isFile() ||
      !isWithinRoot(root, canonicalPath) ||
      openedStat.dev !== canonicalStat.dev ||
      openedStat.ino !== canonicalStat.ino
    ) {
      throw new WorkspaceToolError('Invalid workspace path', 'INVALID_PATH');
    }
    if (openedStat.size > BRIDGE_WORKSPACE_WRITE_MAX_BYTES) {
      throw new WorkspaceToolError(
        'Workspace file exceeds write limit',
        'WRITE_LIMIT_EXCEEDED',
      );
    }
    const original = await readBoundedEditFile(opened);
    const hasBom =
      original[0] === 0xef && original[1] === 0xbb && original[2] === 0xbf;
    const body = hasBom ? original.subarray(3) : original;
    const text = body.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(body)) {
      throw new WorkspaceToolError(
        'Workspace file is not UTF-8 text',
        'INVALID_REQUEST',
      );
    }
    const first = text.indexOf(request.oldText);
    if (
      first < 0 ||
      text.indexOf(request.oldText, first + 1) >= 0
    ) {
      throw new WorkspaceToolError(
        'Workspace edit must match exactly once',
        'EDIT_CONFLICT',
      );
    }
    const updatedText =
      text.slice(0, first) +
      request.newText +
      text.slice(first + request.oldText.length);
    const updatedBody = Buffer.from(updatedText, 'utf8');
    const updated = hasBom
      ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), updatedBody])
      : updatedBody;
    await atomicWriteConfinedFile(
      root,
      request.path,
      updated,
      signal,
      {
        dev: openedStat.dev,
        ino: openedStat.ino,
        content: original,
      },
    );
    return {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      operation: 'edit_file',
      workspaceId: request.workspaceId,
      path: request.path,
      replacements: 1,
      bytesWritten: updated.byteLength,
    };
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error;
    throw new WorkspaceToolError('Invalid workspace path', 'INVALID_PATH');
  } finally {
    await opened?.close().catch(() => undefined);
  }
}

interface SearchCandidates {
  paths: string[];
  truncated: boolean;
}

async function listSearchCandidates(
  root: string,
  searchPath: string,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<SearchCandidates> {
  return new Promise<SearchCandidates>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let stoppedForLimit = false;
    const child = spawn(
      'rg',
      [
        '--files',
        '--no-config',
        '--no-follow',
        '--path-separator',
        '/',
        '--null',
        '--max-filesize',
        '1M',
        '--',
        searchPath,
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let aborted = false;
    let timedOut = false;
    const abort = () => {
      aborted = true;
      child.kill();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(
      () => {
        timedOut = true;
        child.kill();
      },
      Math.max(0, deadline - Date.now()),
    );
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (stoppedForLimit) return;
      const remaining = MAX_SEARCH_CANDIDATE_BYTES - outputBytes;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        outputBytes = MAX_SEARCH_CANDIDATE_BYTES;
        stoppedForLimit = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
      outputBytes += chunk.length;
    });
    child.once('error', () => {
      cleanup();
      reject(
        new WorkspaceToolError(
          'Workspace search unavailable',
          'SEARCH_UNAVAILABLE',
        ),
      );
    });
    child.once('close', (code) => {
      cleanup();
      if (aborted) {
        reject(
          new WorkspaceToolError(
            'Workspace tool execution aborted',
            'EXECUTION_ABORTED',
          ),
        );
        return;
      }
      if (timedOut) {
        reject(
          new WorkspaceToolError(
            'Workspace search timed out',
            'SEARCH_TIMEOUT',
          ),
        );
        return;
      }
      if (!stoppedForLimit && code !== 0 && code !== 1) {
        reject(
          new WorkspaceToolError(
            'Workspace search unavailable',
            'SEARCH_UNAVAILABLE',
          ),
        );
        return;
      }

      const output = Buffer.concat(chunks);
      const paths: string[] = [];
      let start = 0;
      let end = output.indexOf(0, start);
      while (end >= 0 && paths.length <= MAX_SEARCH_CANDIDATES) {
        if (end > start)
          paths.push(output.subarray(start, end).toString('utf8'));
        start = end + 1;
        end = output.indexOf(0, start);
      }
      const exceededCandidateLimit = paths.length > MAX_SEARCH_CANDIDATES;
      if (exceededCandidateLimit) paths.pop();
      resolvePromise({
        paths,
        truncated:
          stoppedForLimit || exceededCandidateLimit || start < output.length,
      });
    });
  });
}

async function searchWorkspace(
  root: string,
  request: WorkspaceSearchTextRequest,
  signal?: AbortSignal,
): Promise<WorkspaceSearchTextResult> {
  const encodedQuery = Buffer.from(request.query);
  if (
    !request.query ||
    request.query.length > 4096 ||
    encodedQuery.length > BRIDGE_WORKSPACE_SEARCH_TEXT_MAX_LENGTH ||
    encodedQuery.toString('utf8') !== request.query ||
    request.query.includes('\0') ||
    request.query.includes('\n') ||
    request.query.includes('\r')
  ) {
    throw new WorkspaceToolError('Invalid workspace search', 'INVALID_REQUEST');
  }
  const maxResults = request.maxResults ?? 50;
  if (
    !Number.isSafeInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > BRIDGE_WORKSPACE_SEARCH_MAX_RESULTS
  ) {
    throw new WorkspaceToolError('Invalid workspace search', 'INVALID_REQUEST');
  }

  const searchPath = request.path ?? '.';
  const target = resolveWorkspacePath(root, searchPath);
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(target);
  } catch {
    throw new WorkspaceToolError('Invalid workspace path', 'INVALID_PATH');
  }
  if (!isWithinRoot(root, canonicalTarget))
    throw new WorkspaceToolError('Invalid workspace path', 'INVALID_PATH');
  const canonicalSearchPath = relative(root, canonicalTarget) || '.';
  const portableCanonicalSearchPath = canonicalSearchPath.split(sep).join('/');
  const normalizedRequestedResultPath = request.path
    ?.split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/');
  const requestedResultPath = normalizedRequestedResultPath || undefined;

  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  const candidates = await listSearchCandidates(
    root,
    canonicalSearchPath,
    signal,
    deadline,
  );
  const matches: WorkspaceSearchMatch[] = [];
  let truncated = candidates.truncated;
  for (const candidate of candidates.paths) {
    if (signal?.aborted) {
      throw new WorkspaceToolError(
        'Workspace tool execution aborted',
        'EXECUTION_ABORTED',
      );
    }
    if (Date.now() >= deadline) {
      throw new WorkspaceToolError(
        'Workspace search timed out',
        'SEARCH_TIMEOUT',
      );
    }
    const path = candidate.startsWith('./') ? candidate.slice(2) : candidate;
    const resultPath =
      requestedResultPath == null
        ? path
        : portableCanonicalSearchPath === '.'
          ? `${requestedResultPath}/${path}`
          : path === portableCanonicalSearchPath ||
              path.startsWith(`${portableCanonicalSearchPath}/`)
            ? `${requestedResultPath}${path.slice(portableCanonicalSearchPath.length)}`
            : path;
    let content: Buffer;
    try {
      content = await readConfinedFileBuffer(root, path);
    } catch (error) {
      if (
        error instanceof WorkspaceToolError &&
        (error.code === 'INVALID_PATH' || error.code === 'READ_LIMIT_EXCEEDED')
      ) {
        continue;
      }
      throw error;
    }
    if (signal?.aborted) {
      throw new WorkspaceToolError(
        'Workspace tool execution aborted',
        'EXECUTION_ABORTED',
      );
    }
    if (Date.now() >= deadline) {
      throw new WorkspaceToolError(
        'Workspace search timed out',
        'SEARCH_TIMEOUT',
      );
    }
    const decodedContent = decodeWorkspaceText(content);
    let lineStart = 0;
    let lineNumber = 1;
    while (lineStart <= decodedContent.length) {
      const newline = decodedContent.indexOf('\n', lineStart);
      const lineEnd = newline < 0 ? decodedContent.length : newline;
      const line = decodedContent.slice(
        lineStart,
        lineEnd > lineStart && decodedContent[lineEnd - 1] === '\r'
          ? lineEnd - 1
          : lineEnd,
      );
      const column = line.indexOf(request.query);
      if (column >= 0) {
        if (matches.length === maxResults) {
          truncated = true;
          break;
        }
        const previewStart = Math.min(
          Math.max(
            0,
            column -
              Math.floor(
                (BRIDGE_WORKSPACE_SEARCH_TEXT_MAX_LENGTH -
                  request.query.length) /
                  2,
              ),
          ),
          Math.max(
            0,
            line.length - BRIDGE_WORKSPACE_SEARCH_TEXT_MAX_LENGTH,
          ),
        );
        matches.push({
          path: resultPath,
          line: lineNumber,
          column: column + 1,
          text: sliceWithoutSplittingSurrogates(
            line,
            previewStart,
            BRIDGE_WORKSPACE_SEARCH_TEXT_MAX_LENGTH,
          ),
        });
      }
      if (newline < 0) break;
      lineStart = newline + 1;
      lineNumber += 1;
    }
    if (matches.length === maxResults && truncated) break;
  }

  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    operation: 'search_text',
    workspaceId: request.workspaceId,
    matches,
    truncated,
  };
}

async function listWorkspaceFiles(
  root: string,
  request: WorkspaceListFilesRequest,
  signal?: AbortSignal,
): Promise<WorkspaceListFilesResult> {
  const deadline = Date.now() + LIST_TIMEOUT_MS;
  const maxResults = request.maxResults ?? 100;
  if (
    !Number.isSafeInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > BRIDGE_WORKSPACE_LIST_MAX_RESULTS
  ) {
    throw new WorkspaceToolError(
      'Invalid workspace listing',
      'INVALID_REQUEST',
    );
  }

  const listPath = request.path ?? '.';
  const target = resolveWorkspacePath(root, listPath);
  let canonicalTarget: string;
  try {
    canonicalTarget = await withinListDeadline(
      realpath(target),
      signal,
      deadline,
    );
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error;
    throw new WorkspaceToolError('Invalid workspace path', 'INVALID_PATH');
  }
  if (!isWithinRoot(root, canonicalTarget)) {
    throw new WorkspaceToolError('Invalid workspace path', 'INVALID_PATH');
  }
  const canonicalListPath = relative(root, canonicalTarget) || '.';
  const portableCanonicalListPath = canonicalListPath.split(sep).join('/');
  let canonicalTargetIsDirectory = false;
  try {
    canonicalTargetIsDirectory = (
      await withinListDeadline(stat(canonicalTarget), signal, deadline)
    ).isDirectory();
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error;
    throw new WorkspaceToolError('Invalid workspace path', 'INVALID_PATH');
  }
  const normalizedRequestedResultPath = request.path
    ?.split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/');
  const requestedResultPath = normalizedRequestedResultPath || undefined;

  const candidates: Array<{ filesystemPath: string; resultPath: string }> = [];
  let truncated = false;
  let pending: Buffer = Buffer.alloc(0);
  let stoppedForLimit = false;
  await new Promise<void>((resolvePromise, reject) => {
    const args = [
      '--files',
      '--no-config',
      '--no-follow',
      '--no-messages',
      '--sort',
      'path',
      '--null',
    ];
    if (portableCanonicalListPath !== '.') {
      args.push(
        '--glob',
        canonicalTargetIsDirectory
          ? `${portableCanonicalListPath}/**`
          : portableCanonicalListPath,
      );
    }
    args.push('--', '.');
    const child = spawn(
      'rg',
      args,
      { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let aborted = false;
    let timedOut = false;
    const abort = () => {
      aborted = true;
      child.kill();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Math.max(0, deadline - Date.now()));
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    };
    const pathDecoder = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    });
    const consumePath = (rawPath: Buffer) => {
      if (rawPath.length === 0 || stoppedForLimit) return;
      let path: string;
      try {
        path = pathDecoder.decode(rawPath);
      } catch {
        return;
      }
      if (!Buffer.from(path).equals(rawPath)) return;
      if (candidates.length === maxResults + BRIDGE_WORKSPACE_LIST_MAX_RESULTS) {
        truncated = true;
        stoppedForLimit = true;
        child.kill();
        return;
      }
      const portablePath = sep === '\\' ? path.split(sep).join('/') : path;
      const normalizedPath = portablePath.startsWith('./')
        ? portablePath.slice(2)
        : portablePath;
      const resultPath =
        requestedResultPath == null
          ? normalizedPath
          : portableCanonicalListPath === '.'
            ? `${requestedResultPath}/${normalizedPath}`
            : normalizedPath === portableCanonicalListPath ||
                normalizedPath.startsWith(`${portableCanonicalListPath}/`)
              ? `${requestedResultPath}${normalizedPath.slice(portableCanonicalListPath.length)}`
              : normalizedPath;
      if (!isSafePortableRelativePath(resultPath)) return;
      candidates.push({ filesystemPath: normalizedPath, resultPath });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let delimiter = pending.indexOf(0);
      while (delimiter >= 0) {
        consumePath(pending.subarray(0, delimiter));
        pending = pending.subarray(delimiter + 1);
        delimiter = pending.indexOf(0);
      }
    });
    child.once('error', () => {
      cleanup();
      reject(
        new WorkspaceToolError(
          'Workspace listing unavailable',
          'LIST_UNAVAILABLE',
        ),
      );
    });
    child.once('close', (code) => {
      cleanup();
      consumePath(pending);
      if (aborted) {
        reject(
          new WorkspaceToolError(
            'Workspace tool execution aborted',
            'EXECUTION_ABORTED',
          ),
        );
      } else if (timedOut) {
        reject(
          new WorkspaceToolError('Workspace listing timed out', 'LIST_TIMEOUT'),
        );
      } else if (stoppedForLimit || code === 0 || code === 1) {
        resolvePromise();
      } else {
        reject(
          new WorkspaceToolError(
            'Workspace listing unavailable',
            'LIST_UNAVAILABLE',
          ),
        );
      }
    });
  });

  const paths: string[] = [];
  const seenPaths = new Set<string>();
  for (const candidate of candidates) {
    let canonicalPath: string;
    try {
      canonicalPath = await withinListDeadline(
        realpath(resolveWorkspacePath(root, candidate.filesystemPath)),
        signal,
        deadline,
      );
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error;
      continue;
    }
    if (!isWithinRoot(root, canonicalPath)) {
      continue;
    }
    const reportedPath = resolveWorkspacePath(root, candidate.resultPath);
    try {
      const reportedPathStat = await withinListDeadline(
        lstat(reportedPath),
        signal,
        deadline,
      );
      if (reportedPathStat.isSymbolicLink()) continue;
      const canonicalReportedPath = await withinListDeadline(
        realpath(reportedPath),
        signal,
        deadline,
      );
      if (canonicalReportedPath !== canonicalPath) continue;
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error;
      continue;
    }
    let regularFile = false;
    try {
      regularFile = (
        await withinListDeadline(stat(canonicalPath), signal, deadline)
      ).isFile();
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error;
      continue;
    }
    if (!regularFile || seenPaths.has(candidate.resultPath)) continue;
    if (paths.length === maxResults) {
      truncated = true;
      break;
    }
    seenPaths.add(candidate.resultPath);
    paths.push(candidate.resultPath);
  }

  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    operation: 'list_files',
    workspaceId: request.workspaceId,
    paths,
    truncated,
  };
}

async function withinListDeadline<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<T> {
  if (signal?.aborted) {
    throw new WorkspaceToolError(
      'Workspace tool execution aborted',
      'EXECUTION_ABORTED',
    );
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new WorkspaceToolError('Workspace listing timed out', 'LIST_TIMEOUT');
  }
  return new Promise<T>((resolvePromise, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () =>
      settle(() =>
        reject(
          new WorkspaceToolError(
            'Workspace tool execution aborted',
            'EXECUTION_ABORTED',
          ),
        ),
      );
    const timeout = setTimeout(
      () =>
        settle(() =>
          reject(
            new WorkspaceToolError(
              'Workspace listing timed out',
              'LIST_TIMEOUT',
            ),
          ),
        ),
      remainingMs,
    );
    signal?.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => settle(() => resolvePromise(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

export class LocalWorkspaceTools implements WorkspaceToolExecutor {
  readonly capabilities: BridgeWorkspaceToolCapabilities;

  private constructor(
    private readonly roots: ReadonlyMap<string, WorkspaceRoot>,
    operations: BridgeWorkspaceToolCapabilities['operations'],
    workspaces: BridgeWorkspaceDescriptor[],
  ) {
    this.capabilities = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      operations,
      workspaces,
    };
  }

  static async create(
    options: LocalWorkspaceToolsOptions,
  ): Promise<LocalWorkspaceTools> {
    const roots = new Map<string, WorkspaceRoot>();
    const anyWritable = options.workspaces.some(
      (workspace) => workspace.writable === true,
    );
    const operations: BridgeWorkspaceToolCapabilities['operations'] = [
      ...READ_OPERATIONS,
      ...(anyWritable ? WRITE_OPERATIONS : []),
    ];
    const workspaces: BridgeWorkspaceDescriptor[] = options.workspaces.map(
      (workspace) => ({
        id: workspace.id,
        ...(workspace.name !== undefined ? { name: workspace.name } : {}),
        ...(anyWritable
          ? {
              operations: [
                ...READ_OPERATIONS,
                ...(workspace.writable === true ? WRITE_OPERATIONS : []),
              ],
            }
          : {}),
      }),
    );
    const capabilities: BridgeWorkspaceToolCapabilities = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      operations,
      workspaces,
    };
    if (!isValidBridgeWorkspaceToolCapabilities(capabilities)) {
      throw new WorkspaceToolError(
        'Invalid workspace registration',
        'REGISTRATION_INVALID',
      );
    }
    for (const workspace of options.workspaces) {
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(workspace.root);
        if (!(await stat(canonicalRoot)).isDirectory()) throw new Error();
      } catch {
        throw new WorkspaceToolError(
          'Invalid workspace registration',
          'REGISTRATION_INVALID',
        );
      }
      roots.set(workspace.id, {
        root: canonicalRoot,
        writable: workspace.writable === true,
      });
    }
    return new LocalWorkspaceTools(roots, operations, workspaces);
  }

  async execute(
    request: WorkspaceToolRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceToolResult> {
    if (signal?.aborted) {
      throw new WorkspaceToolError(
        'Workspace tool execution aborted',
        'EXECUTION_ABORTED',
      );
    }
    if (!isWorkspaceToolRequest(request)) {
      throw new WorkspaceToolError(
        'Invalid workspace tool request',
        'INVALID_REQUEST',
      );
    }
    const workspace = this.roots.get(request.workspaceId);
    if (!workspace) {
      throw new WorkspaceToolError('Unknown workspace', 'INVALID_REQUEST');
    }
    const { root } = workspace;

    if (request.operation === 'write_file' || request.operation === 'edit_file') {
      if (!workspace.writable) {
        throw new WorkspaceToolError(
          'Workspace mutations are disabled by the worker',
          'WRITE_DISABLED',
        );
      }
      if (signal?.aborted) {
        throw new WorkspaceToolError(
          'Workspace tool execution aborted',
          'EXECUTION_ABORTED',
        );
      }
      return request.operation === 'write_file'
        ? writeWorkspaceFile(root, request, signal)
        : editWorkspaceFile(root, request, signal);
    }

    if (request.operation === 'search_text') {
      return searchWorkspace(root, request, signal);
    }
    if (request.operation === 'list_files') {
      return listWorkspaceFiles(root, request, signal);
    }

    const startLine = request.startLine ?? 1;
    const maxLines = request.maxLines ?? 200;
    if (
      !Number.isSafeInteger(startLine) ||
      startLine < 1 ||
      !Number.isSafeInteger(maxLines) ||
      maxLines < 1 ||
      maxLines > BRIDGE_WORKSPACE_READ_MAX_LINES
    ) {
      throw new WorkspaceToolError('Invalid workspace read', 'INVALID_REQUEST');
    }
    const content = await readConfinedFile(root, request.path);
    if (signal?.aborted) {
      throw new WorkspaceToolError(
        'Workspace tool execution aborted',
        'EXECUTION_ABORTED',
      );
    }
    const lines = content.endsWith('\n')
      ? content.slice(0, -1).split('\n')
      : content.split('\n');
    const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
    const endLine = startLine + selected.length - 1;
    const truncated = endLine < lines.length;

    return {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      operation: 'read_file',
      workspaceId: request.workspaceId,
      path: request.path,
      content: selected.join('\n'),
      startLine,
      endLine,
      truncated,
      ...(truncated ? { nextStartLine: endLine + 1 } : {}),
    };
  }
}
