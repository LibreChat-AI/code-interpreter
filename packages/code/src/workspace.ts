import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { FileHandle } from 'node:fs/promises';

import {
  BRIDGE_PROTOCOL_VERSION,
  isValidBridgeWorkerId,
  isValidBridgeWorkspaceToolCapabilities,
} from './protocol.js';

import type {
  BridgeProtocolVersion,
  BridgeWorkspaceDescriptor,
  BridgeWorkspaceToolCapabilities,
} from './protocol.js';

export interface LocalWorkspaceConfig {
  id: string;
  name?: string;
  root: string;
}

export interface LocalWorkspaceToolsOptions {
  workspaces: LocalWorkspaceConfig[];
}

export interface WorkspaceReadFileRequest {
  protocolVersion: BridgeProtocolVersion;
  operation: 'read_file';
  workspaceId: string;
  path: string;
  startLine?: number;
  maxLines?: number;
}

export interface WorkspaceReadFileResult {
  protocolVersion: BridgeProtocolVersion;
  operation: 'read_file';
  workspaceId: string;
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
  nextStartLine?: number;
}

export interface WorkspaceSearchTextRequest {
  protocolVersion: BridgeProtocolVersion;
  operation: 'search_text';
  workspaceId: string;
  query: string;
  path?: string;
  maxResults?: number;
}

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface WorkspaceSearchTextResult {
  protocolVersion: BridgeProtocolVersion;
  operation: 'search_text';
  workspaceId: string;
  matches: WorkspaceSearchMatch[];
  truncated: boolean;
}

export type WorkspaceToolRequest =
  WorkspaceReadFileRequest | WorkspaceSearchTextRequest;
export type WorkspaceToolResult =
  WorkspaceReadFileResult | WorkspaceSearchTextResult;

const MAX_READ_LINES = 500;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_SEARCH_PREVIEW_LENGTH = 2000;
const MAX_SEARCH_CANDIDATE_BYTES = 1024 * 1024;
const MAX_SEARCH_CANDIDATES = 20_000;
const SEARCH_TIMEOUT_MS = 10_000;

export class WorkspaceToolError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'INVALID_PATH'
      | 'INVALID_REQUEST'
      | 'READ_LIMIT_EXCEEDED'
      | 'REGISTRATION_INVALID'
      | 'EXECUTION_ABORTED'
      | 'SEARCH_TIMEOUT'
      | 'SEARCH_UNAVAILABLE',
  ) {
    super(message);
    this.name = 'WorkspaceToolError';
  }
}

export function isWorkspaceToolRequest(
  value: unknown,
): value is WorkspaceToolRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Record<string, unknown>;
  if (
    request.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
    typeof request.workspaceId !== 'string' ||
    !isValidBridgeWorkerId(request.workspaceId)
  ) {
    return false;
  }
  if (request.operation === 'read_file') {
    return (
      typeof request.path === 'string' &&
      request.path.length > 0 &&
      request.path.length <= 4096 &&
      (request.startLine === undefined ||
        Number.isSafeInteger(request.startLine)) &&
      (request.maxLines === undefined || Number.isSafeInteger(request.maxLines))
    );
  }
  if (request.operation === 'search_text') {
    return (
      typeof request.query === 'string' &&
      request.query.length > 0 &&
      request.query.length <= 4096 &&
      (request.path === undefined ||
        (typeof request.path === 'string' &&
          request.path.length > 0 &&
          request.path.length <= 4096)) &&
      (request.maxResults === undefined ||
        Number.isSafeInteger(request.maxResults))
    );
  }
  return false;
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
    if (openedFile.size > MAX_READ_BYTES) {
      throw new WorkspaceToolError(
        'Workspace file exceeds read limit',
        'READ_LIMIT_EXCEEDED',
      );
    }
    const buffer = Buffer.allocUnsafe(MAX_READ_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead <= MAX_READ_BYTES) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_READ_BYTES) {
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
  return (await readConfinedFileBuffer(root, requestedPath)).toString('utf8');
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
    encodedQuery.length > MAX_SEARCH_PREVIEW_LENGTH ||
    encodedQuery.toString('utf8') !== request.query ||
    request.query.includes('\0') ||
    request.query.includes('\n') ||
    request.query.includes('\r')
  ) {
    throw new WorkspaceToolError('Invalid workspace search', 'INVALID_REQUEST');
  }
  const maxResults = request.maxResults ?? 50;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 200) {
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
    const path = candidate.startsWith(`.${sep}`)
      ? candidate.slice(2)
      : candidate;
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
    const decodedContent =
      content[0] === 0xff && content[1] === 0xfe
        ? new TextDecoder('utf-16le').decode(content)
        : content[0] === 0xfe && content[1] === 0xff
          ? new TextDecoder('utf-16be').decode(content)
          : content.toString('utf8');
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
                (MAX_SEARCH_PREVIEW_LENGTH - request.query.length) / 2,
              ),
          ),
          Math.max(0, line.length - MAX_SEARCH_PREVIEW_LENGTH),
        );
        matches.push({
          path,
          line: lineNumber,
          column: column + 1,
          text: line.slice(
            previewStart,
            previewStart + MAX_SEARCH_PREVIEW_LENGTH,
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

export class LocalWorkspaceTools {
  readonly capabilities: BridgeWorkspaceToolCapabilities;

  private constructor(
    private readonly roots: ReadonlyMap<string, string>,
    workspaces: BridgeWorkspaceDescriptor[],
  ) {
    this.capabilities = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      operations: ['read_file', 'search_text'],
      workspaces,
    };
  }

  static async create(
    options: LocalWorkspaceToolsOptions,
  ): Promise<LocalWorkspaceTools> {
    const roots = new Map<string, string>();
    const workspaces: BridgeWorkspaceDescriptor[] = options.workspaces.map(
      (workspace) => ({
        id: workspace.id,
        ...(workspace.name !== undefined ? { name: workspace.name } : {}),
      }),
    );
    const capabilities: BridgeWorkspaceToolCapabilities = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      operations: ['read_file', 'search_text'],
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
      roots.set(workspace.id, canonicalRoot);
    }
    return new LocalWorkspaceTools(roots, workspaces);
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
    const root = this.roots.get(request.workspaceId);
    if (!root) {
      throw new WorkspaceToolError('Unknown workspace', 'INVALID_REQUEST');
    }

    if (request.operation === 'search_text') {
      return searchWorkspace(root, request, signal);
    }

    const startLine = request.startLine ?? 1;
    const maxLines = request.maxLines ?? 200;
    if (
      !Number.isSafeInteger(startLine) ||
      startLine < 1 ||
      !Number.isSafeInteger(maxLines) ||
      maxLines < 1 ||
      maxLines > MAX_READ_LINES
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
