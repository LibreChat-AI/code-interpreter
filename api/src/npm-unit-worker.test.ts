import crypto from 'crypto';
import zlib from 'zlib';
import { describe, expect, test } from 'bun:test';
import {
  NpmUnitWorkerError,
  extractDeclarationFiles,
  parseDeclarationSource,
  verifyIntegrity,
  type NpmUnitWorkerLimits,
} from './npm-unit-worker-lib';

const LIMITS: NpmUnitWorkerLimits = {
  maxUnpackedBytes: 1024 * 1024,
  maxKeptBytes: 256 * 1024,
  maxFileBytes: 128 * 1024,
  maxEntries: 100,
};

type Entry = { name: string; body?: Buffer | string; type?: string; link?: string };

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, '0')}\0`, 'ascii');
}

function tar(entries: Entry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    octal(0o644, 8).copy(header, 100);
    octal(0, 8).copy(header, 108);
    octal(0, 8).copy(header, 116);
    octal(body.length, 12).copy(header, 124);
    octal(0, 12).copy(header, 136);
    header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156, 1, 'ascii');
    if (entry.link) header.write(entry.link, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(header, 148);
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks));
}

function sri(value: Buffer): string {
  return `sha512-${crypto.createHash('sha512').update(value).digest('base64')}`;
}

describe('npm unit worker archive boundary', () => {
  test('keeps only declarations and root package metadata with git blob hashes', () => {
    const archive = tar([
      { name: 'package/', type: '5' },
      { name: 'package/index.js', body: 'module.exports = 1' },
      { name: 'package/index.d.ts', body: 'export interface Query { id: string }' },
      { name: 'package/package.json', body: '{"name":"demo"}' },
    ]);
    const result = extractDeclarationFiles(archive, LIMITS);

    expect(result.files.map(file => file.path)).toEqual(['index.d.ts', 'package.json']);
    expect(result.files[0].sha1).toBe(
      crypto.createHash('sha1')
        .update(`blob ${result.files[0].bytes}\0`)
        .update(result.files[0].content)
        .digest('hex'),
    );
    expect(result.rejected).toEqual({ link: 0, device: 0, unsafePath: 0, oversize: 0, other: 0 });
  });

  test('counts traversal, absolute paths, links, devices, duplicates, and oversized declarations', () => {
    const archive = tar([
      { name: 'package/../../etc/x', body: 'x' },
      { name: '/etc/y', body: 'y' },
      { name: 'package/link.d.ts', type: '2', link: '../../etc/passwd' },
      { name: 'package/device.d.ts', type: '3' },
      { name: 'package/huge.d.ts', body: Buffer.alloc(32) },
      { name: 'package/ok.d.ts', body: 'type X = 1' },
      { name: 'package/ok.d.ts', body: 'type X = 2' },
    ]);
    const result = extractDeclarationFiles(archive, { ...LIMITS, maxFileBytes: 16 });

    expect(result.files.map(file => file.path)).toEqual(['ok.d.ts']);
    expect(result.rejected).toEqual({ link: 1, device: 1, unsafePath: 2, oversize: 1, other: 1 });
  });

  test('rejects integrity mismatches before decompression', () => {
    const archive = tar([{ name: 'package/index.d.ts', body: 'type X = 1' }]);
    expect(() => verifyIntegrity(archive, sri(Buffer.from('different')))).toThrow(NpmUnitWorkerError);
    try {
      verifyIntegrity(archive, sri(Buffer.from('different')));
    } catch (error) {
      expect((error as NpmUnitWorkerError).code).toBe('integrity_mismatch');
    }
  });

  test('caps gzip output and tar entry count before archive-wide work grows unbounded', () => {
    const bomb = tar([{ name: 'package/ignored.bin', body: Buffer.alloc(128 * 1024) }]);
    expect(() => extractDeclarationFiles(bomb, { ...LIMITS, maxUnpackedBytes: 16 * 1024 })).toThrow();
    try {
      extractDeclarationFiles(bomb, { ...LIMITS, maxUnpackedBytes: 16 * 1024 });
    } catch (error) {
      expect((error as NpmUnitWorkerError).code).toBe('decompression_limit');
    }

    const many = tar(Array.from({ length: 4 }, (_, index) => ({
      name: `package/${index}.d.ts`,
      body: `type T${index} = ${index}`,
    })));
    try {
      extractDeclarationFiles(many, { ...LIMITS, maxEntries: 3 });
    } catch (error) {
      expect((error as NpmUnitWorkerError).code).toBe('too_large');
      expect((error as NpmUnitWorkerError).rejected?.oversize).toBe(1);
    }
  });

  test('rejects a truncated tar that omits its end marker', () => {
    const archive = tar([{ name: 'package/index.d.ts', body: 'type X = 1' }]);
    const unpacked = zlib.gunzipSync(archive);
    const truncated = zlib.gzipSync(unpacked.subarray(0, unpacked.length - 1024));

    try {
      extractDeclarationFiles(truncated, LIMITS);
      throw new Error('expected truncated tar to fail');
    } catch (error) {
      expect((error as NpmUnitWorkerError).code).toBe('unsafe_entry');
    }
  });

  test('emits deterministic symbols in declaration order and import specifiers', () => {
    type FakeNode = {
      type: string;
      text: string;
      startPosition: { row: number; column: number };
      endPosition: { row: number; column: number };
      namedChildren: FakeNode[];
      parent?: FakeNode;
      hasError?: boolean;
      fields?: Record<string, FakeNode>;
      childForFieldName(name: string): FakeNode | null;
    };
    const node = (type: string, text: string, row: number, children: FakeNode[] = []): FakeNode => {
      const value: FakeNode = {
        type,
        text,
        startPosition: { row, column: 0 },
        endPosition: { row: row + text.split('\n').length - 1, column: 0 },
        namedChildren: children,
        childForFieldName(name: string) { return this.fields?.[name] ?? null; },
      };
      for (const child of children) child.parent = value;
      return value;
    };
    const source = node('string', `'./queryClient'`, 0);
    const importNode = node('import_statement', `import type { QueryClient } from './queryClient'`, 0, [source]);
    importNode.fields = { source };
    const interfaceName = node('type_identifier', 'UseQueryOptions', 1);
    const interfaceNode = node(
      'interface_declaration',
      'interface UseQueryOptions { queryClient: QueryClient }',
      1,
      [interfaceName],
    );
    interfaceNode.fields = { name: interfaceName };
    const exported = node('export_statement', `export ${interfaceNode.text}`, 1, [interfaceNode]);
    const aliasName = node('type_identifier', 'QueryKey', 2);
    const aliasNode = node('type_alias_declaration', 'type QueryKey = readonly unknown[]', 2, [aliasName]);
    aliasNode.fields = { name: aliasName };
    const root = node('program', '', 0, [importNode, exported, aliasNode]);
    const parser = {
      setLanguage() {},
      parse: () => ({ rootNode: root }),
    };

    const parsed = parseDeclarationSource(parser, 'index.d.ts', 'ignored');

    expect(parsed.imports).toEqual([{ file: 'index.d.ts', spec: './queryClient' }]);
    expect(parsed.symbols.map(symbol => ({
      ordinal: symbol.ordinal,
      label: symbol.label,
      name: symbol.name,
      isExported: symbol.isExported,
    }))).toEqual([
      { ordinal: 0, label: 'Interface', name: 'UseQueryOptions', isExported: true },
      { ordinal: 1, label: 'TypeAlias', name: 'QueryKey', isExported: false },
    ]);
  });
});
