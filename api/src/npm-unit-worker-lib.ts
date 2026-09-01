import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

export interface NpmUnitWorkerLimits {
  maxUnpackedBytes: number;
  maxKeptBytes: number;
  maxFileBytes: number;
  maxEntries: number;
}

export interface NpmUnitWorkerRequest {
  name: string;
  version: string;
  integrity: string;
  keep: ['**/*.d.ts', 'package.json'];
  limits: NpmUnitWorkerLimits;
}

export interface RejectedCounts {
  link: number;
  device: number;
  unsafePath: number;
  oversize: number;
  other: number;
}

export interface KeptTarFile {
  path: string;
  content: Buffer;
  bytes: number;
  sha1: string;
}

export class NpmUnitWorkerError extends Error {
  constructor(
    public readonly code:
      | 'integrity_mismatch'
      | 'too_large'
      | 'decompression_limit'
      | 'unsafe_entry'
      | 'parse_failed',
    message: string,
    public readonly rejected?: RejectedCounts,
    public readonly unpackedBytes = 0,
  ) {
    super(message);
    this.name = 'NpmUnitWorkerError';
  }
}

function emptyRejected(): RejectedCounts {
  return { link: 0, device: 0, unsafePath: 0, oversize: 0, other: 0 };
}

function gitBlobSha1(content: Buffer): string {
  return crypto
    .createHash('sha1')
    .update(`blob ${content.length}\0`, 'utf8')
    .update(content)
    .digest('hex');
}

function readTarString(block: Buffer, start: number, length: number): string {
  const end = block.indexOf(0, start);
  const sliceEnd = end >= start && end < start + length ? end : start + length;
  const value = block.subarray(start, sliceEnd).toString('utf8');
  if (value.includes('\uFFFD')) throw new NpmUnitWorkerError('unsafe_entry', 'Tar header contains invalid UTF-8');
  return value;
}

function readTarNumber(block: Buffer, start: number, length: number): number {
  const bytes = block.subarray(start, start + length);
  if ((bytes[0] & 0x80) !== 0) {
    const copy = Buffer.from(bytes);
    copy[0] &= 0x7f;
    let value = 0;
    for (const byte of copy) {
      value = value * 256 + byte;
      if (!Number.isSafeInteger(value)) throw new NpmUnitWorkerError('too_large', 'Tar numeric field is too large');
    }
    return value;
  }
  const raw = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) throw new NpmUnitWorkerError('unsafe_entry', 'Tar numeric field is invalid');
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new NpmUnitWorkerError('too_large', 'Tar numeric field is too large');
  return value;
}

function tarChecksumValid(header: Buffer): boolean {
  const expected = readTarNumber(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < 512; index++) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  return actual === expected;
}

function normalizeTarPath(raw: string): string | undefined {
  if (!raw || raw.includes('\0') || raw.includes('\\') || path.posix.isAbsolute(raw)) return undefined;
  const withoutPackage = raw.startsWith('package/') ? raw.slice('package/'.length) : raw;
  if (!withoutPackage || withoutPackage.length > 1024 || withoutPackage.endsWith('/')) return undefined;
  const parts = withoutPackage.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) return undefined;
  if (path.posix.normalize(withoutPackage) !== withoutPackage) return undefined;
  return withoutPackage;
}

function parsePaxPath(content: Buffer): string | undefined {
  let offset = 0;
  let found: string | undefined;
  while (offset < content.length) {
    const space = content.indexOf(32, offset);
    if (space < 0) return undefined;
    const length = Number(content.subarray(offset, space).toString('ascii'));
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > content.length) return undefined;
    const record = content.subarray(space + 1, offset + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0 && record.slice(0, eq) === 'path') found = record.slice(eq + 1);
    offset += length;
  }
  return found;
}

function shouldKeep(filePath: string): boolean {
  return filePath === 'package.json' || filePath.endsWith('.d.ts');
}

export function verifyIntegrity(tarball: Buffer, integrity: string): void {
  const match = integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new NpmUnitWorkerError('integrity_mismatch', 'Integrity is not a sha512 SRI digest');
  const expected = Buffer.from(match[1], 'base64');
  const actual = crypto.createHash('sha512').update(tarball).digest();
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new NpmUnitWorkerError('integrity_mismatch', 'Package tarball integrity did not match');
  }
}

export function extractDeclarationFiles(
  tarball: Buffer,
  limits: NpmUnitWorkerLimits,
): { files: KeptTarFile[]; rejected: RejectedCounts; unpackedBytes: number } {
  let archive: Buffer;
  try {
    archive = zlib.gunzipSync(tarball, { maxOutputLength: limits.maxUnpackedBytes + 1 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ERR_BUFFER_TOO_LARGE' || /larger than/i.test((error as Error).message)) {
      throw new NpmUnitWorkerError(
        'decompression_limit',
        'Package exceeded the decompressed byte limit',
        emptyRejected(),
        limits.maxUnpackedBytes,
      );
    }
    throw new NpmUnitWorkerError('parse_failed', 'Package gzip stream is invalid');
  }
  if (archive.length > limits.maxUnpackedBytes) {
    throw new NpmUnitWorkerError(
      'decompression_limit',
      'Package exceeded the decompressed byte limit',
      emptyRejected(),
      archive.length,
    );
  }

  const rejected = emptyRejected();
  const files: KeptTarFile[] = [];
  const seenPaths = new Set<string>();
  let offset = 0;
  let entries = 0;
  let keptBytes = 0;
  let nextPath: string | undefined;
  let sawEndMarker = false;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      sawEndMarker = true;
      offset += 512;
      break;
    }
    entries += 1;
    if (entries > limits.maxEntries) {
      rejected.oversize += 1;
      throw new NpmUnitWorkerError('too_large', 'Package exceeded the tar entry limit', rejected, archive.length);
    }
    if (!tarChecksumValid(header)) {
      throw new NpmUnitWorkerError('unsafe_entry', 'Tar header checksum is invalid', rejected, archive.length);
    }
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const size = readTarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const paddedSize = Math.ceil(size / 512) * 512;
    const nextOffset = dataStart + paddedSize;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > archive.length || dataStart + size > archive.length) {
      throw new NpmUnitWorkerError('unsafe_entry', 'Tar entry extends past the archive', rejected, archive.length);
    }
    const content = archive.subarray(dataStart, dataStart + size);
    offset = nextOffset;

    if (type === 'x' || type === 'g') {
      rejected.other += 1;
      nextPath = parsePaxPath(content) ?? nextPath;
      continue;
    }
    if (type === 'L') {
      rejected.other += 1;
      nextPath = readTarString(content, 0, content.length);
      continue;
    }

    const rawPath = nextPath ?? headerPath;
    nextPath = undefined;
    if (type === '5') {
      const directoryPath = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
      if (!normalizeTarPath(directoryPath)) rejected.unsafePath += 1;
      continue;
    }
    const normalized = normalizeTarPath(rawPath);
    if (!normalized) {
      rejected.unsafePath += 1;
      continue;
    }
    if (type === '1' || type === '2') {
      rejected.link += 1;
      continue;
    }
    if (type === '3' || type === '4' || type === '6') {
      rejected.device += 1;
      continue;
    }
    if (type !== '0' && type !== '\0') {
      rejected.other += 1;
      continue;
    }
    if (!shouldKeep(normalized)) continue;
    if (size > limits.maxFileBytes || keptBytes + size > limits.maxKeptBytes) {
      rejected.oversize += 1;
      continue;
    }
    if (seenPaths.has(normalized)) {
      rejected.other += 1;
      continue;
    }
    seenPaths.add(normalized);
    keptBytes += size;
    files.push({
      path: normalized,
      content,
      bytes: size,
      sha1: gitBlobSha1(content),
    });
  }

  if (!sawEndMarker || archive.subarray(offset).some(byte => byte !== 0)) {
    throw new NpmUnitWorkerError('unsafe_entry', 'Tar archive has a missing or invalid end marker', rejected, archive.length);
  }

  return { files, rejected, unpackedBytes: archive.length };
}

type Point = { row: number; column: number };
type SyntaxNode = {
  type: string;
  text: string;
  startPosition: Point;
  endPosition: Point;
  namedChildren: SyntaxNode[];
  parent?: SyntaxNode | null;
  hasError?: boolean;
  childForFieldName(name: string): SyntaxNode | null;
};

type Tree = { rootNode: SyntaxNode; delete?: () => void };
type ParserLike = { setLanguage(language: unknown): void; parse(source: string): Tree; delete?: () => void };

interface ParserBundle {
  parser: ParserLike;
  dispose(): void;
}

async function loadTypeScriptParser(): Promise<ParserBundle> {
  // Dynamic require keeps the sandbox API itself independent of the parser.
  // The module and the three pinned grammar files live only in the read-only
  // Node runtime package mounted into NsJail.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const imported = require('web-tree-sitter') as Record<string, unknown>;
  const Parser = (imported.Parser ?? imported.default ?? imported) as {
    new(): ParserLike;
    init(): Promise<void>;
    Language: { load(path: string): Promise<unknown> };
  };
  await Parser.init();
  const grammarPath = '/mnt/data/node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm';
  if (!fs.existsSync(grammarPath)) throw new Error('Pinned TypeScript grammar is missing');
  const language = await Parser.Language.load(grammarPath);
  const parser = new Parser();
  parser.setLanguage(language);
  return {
    parser,
    dispose: () => parser.delete?.(),
  };
}

const SYMBOL_LABELS: Record<string, string> = {
  interface_declaration: 'Interface',
  type_alias_declaration: 'TypeAlias',
  class_declaration: 'Class',
  abstract_class_declaration: 'Class',
  function_declaration: 'Function',
  generator_function_declaration: 'Function',
  enum_declaration: 'Enum',
  internal_module: 'Namespace',
  module: 'Module',
  method_signature: 'Method',
  abstract_method_signature: 'Method',
  method_definition: 'Method',
  property_signature: 'Property',
  public_field_definition: 'Property',
  call_signature: 'CallSignature',
  construct_signature: 'ConstructSignature',
};

function declarationName(node: SyntaxNode, label: string): string | undefined {
  const named = node.childForFieldName('name');
  if (named?.text) return named.text;
  if (label === 'CallSignature') return '<call>';
  if (label === 'ConstructSignature') return '<new>';
  return undefined;
}

function compactSignature(node: SyntaxNode): string {
  let text = node.text.replace(/\s+/g, ' ').trim();
  if (['Interface', 'Class', 'Namespace', 'Module', 'Enum'].includes(SYMBOL_LABELS[node.type] ?? '')) {
    const body = text.indexOf('{');
    if (body >= 0) text = `${text.slice(0, body).trim()} { ... }`;
  }
  return text.length <= 8192 ? text : `${text.slice(0, 8189)}...`;
}

function symbolTokens(name: string, label: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  words.push(['Function', 'Method', 'CallSignature', 'ConstructSignature'].includes(label) ? 'functions' : 'types');
  return Array.from(new Set(words)).join(' ');
}

function isNodeExported(node: SyntaxNode, inherited: boolean): boolean {
  if (inherited) return true;
  let cursor: SyntaxNode | null | undefined = node;
  while (cursor) {
    if (cursor.type === 'export_statement') return true;
    cursor = cursor.parent;
  }
  return /^(?:export\s+)?declare\s+global\b/.test(node.text.trim()) || /^export\b/.test(node.text.trim());
}

function importSpec(node: SyntaxNode): string | undefined {
  const source = node.childForFieldName('source');
  const raw = source?.text;
  if (!raw || raw.length < 2) return undefined;
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote) return undefined;
  return raw.slice(1, -1);
}

export function parseDeclarationSource(parser: ParserLike, file: string, source: string): {
  symbols: Array<Record<string, unknown>>;
  imports: Array<{ file: string; spec: string }>;
  hasError: boolean;
} {
  const tree = parser.parse(source);
  const symbols: Array<Record<string, unknown>> = [];
  const imports: Array<{ file: string; spec: string }> = [];
  let ordinal = 0;
  const visit = (node: SyntaxNode, inheritedExported = false): void => {
    const exported = isNodeExported(node, inheritedExported);
    const label = SYMBOL_LABELS[node.type];
    if (label) {
      const name = declarationName(node, label);
      if (name) {
        symbols.push({
          file,
          ordinal: ordinal++,
          label,
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: exported,
          signature: compactSignature(node),
          tokens: symbolTokens(name, label),
        });
      }
    }
    if (node.type === 'import_statement' || node.type === 'export_statement') {
      const spec = importSpec(node);
      if (spec) imports.push({ file, spec });
    }
    for (const child of node.namedChildren) visit(child, exported);
  };
  visit(tree.rootNode);
  const hasError = tree.rootNode.hasError === true;
  tree.delete?.();
  return { symbols, imports, hasError };
}

export async function buildNpmUnitResult(
  request: NpmUnitWorkerRequest,
  tarball: Buffer,
  parserLoader: () => Promise<ParserBundle> = loadTypeScriptParser,
): Promise<Record<string, unknown>> {
  const started = performance.now();
  verifyIntegrity(tarball, request.integrity);
  const extracted = extractDeclarationFiles(tarball, request.limits);
  const files = extracted.files.map(file => ({ path: file.path, sha1: file.sha1, bytes: file.bytes }));
  const symbols: Array<Record<string, unknown>> = [];
  const imports: Array<{ file: string; spec: string }> = [];
  const errors: Array<{ file?: string; code: 'parse_failed'; message: string }> = [];
  const declarationFiles = extracted.files.filter(file => file.path.endsWith('.d.ts'));

  let parserBundle: ParserBundle | undefined;
  try {
    parserBundle = await parserLoader();
    for (const file of declarationFiles) {
      try {
        const parsed = parseDeclarationSource(parserBundle.parser, file.path, file.content.toString('utf8'));
        symbols.push(...parsed.symbols);
        imports.push(...parsed.imports);
        if (parsed.hasError) {
          errors.push({ file: file.path, code: 'parse_failed', message: 'Tree-sitter reported syntax errors' });
        }
      } catch {
        errors.push({ file: file.path, code: 'parse_failed', message: 'Declaration file could not be parsed' });
      }
    }
  } catch {
    throw new NpmUnitWorkerError('parse_failed', 'TypeScript parser could not be initialized', extracted.rejected, extracted.unpackedBytes);
  } finally {
    parserBundle?.dispose();
  }

  const rejectedTotal = Object.values(extracted.rejected).reduce((sum, value) => sum + value, 0);
  return {
    status: errors.length > 0 || rejectedTotal > 0 ? 'partial' : 'complete',
    name: request.name,
    version: request.version,
    integrityVerified: true,
    files,
    symbols,
    imports,
    rejected: extracted.rejected,
    usage: {
      tarballBytes: tarball.length,
      unpackedBytes: extracted.unpackedBytes,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      wallMs: Math.round(performance.now() - started),
    },
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export function npmWorkerFailure(error: unknown, tarballBytes: number, started: number): Record<string, unknown> {
  const typed = error instanceof NpmUnitWorkerError
    ? error
    : new NpmUnitWorkerError('parse_failed', 'Package surface could not be parsed');
  return {
    error: typed.code,
    message: typed.message,
    retryable: false,
    rejected: typed.rejected ?? emptyRejected(),
    usage: {
      tarballBytes,
      unpackedBytes: typed.unpackedBytes,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      wallMs: Math.round(performance.now() - started),
    },
  };
}
