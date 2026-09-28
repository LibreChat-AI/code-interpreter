import { describe, expect, test } from 'bun:test';
import { config } from '../config';
import { collectExecuteRequestInputFiles } from '../execution-manifest-request';
import type { TFile } from '../job';
import { validateExecuteArguments, validateExecuteFiles, deduplicateFilesByDestination } from './v2';

function messageOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return (error as { message?: string }).message ?? String(error);
  }
  return '';
}

describe('execute file validation', () => {
  test('rejects duplicate and ancestor-conflicting destinations before priming', () => {
    expect(messageOf(() => validateExecuteFiles([
      { name: 'data.csv', content: 'a' },
      { name: 'data.csv', content: 'b' },
    ]))).toContain('duplicate destination');

    expect(messageOf(() => validateExecuteFiles([
      { name: 'results', content: 'file' },
      { name: 'results/out.csv', content: 'nested' },
    ]))).toContain('conflicting destinations');
  });

  test('rejects malformed stable cache identities', () => {
    expect(messageOf(() => validateExecuteFiles([{
      id: 'masked',
      storage_session_id: 'masked-session',
      name: 'data.csv',
      input_cache_key: '../not-a-key',
    }]))).toContain('64-character lowercase hex digest');
  });

  test('rejects ambiguous and type-confused inline/reference shapes', () => {
    expect(messageOf(() => validateExecuteFiles([null as unknown as TFile])))
      .toContain('must be an object');
    expect(messageOf(() => validateExecuteFiles([{
      name: 'data.csv',
      content: 'inline',
      id: 'masked',
      storage_session_id: 'masked-session',
    }]))).toContain('exactly one');
    expect(messageOf(() => validateExecuteFiles([{
      name: 'data.csv',
      content: 'inline',
      id: 123,
      storage_session_id: {} as string,
      input_cache_key: 'a'.repeat(64),
    } as unknown as TFile]))).toContain('id must be a non-empty string');
    expect(messageOf(() => validateExecuteFiles([{
      name: 'data.csv',
      id: 'masked',
    }]))).toContain('storage_session_id');
    expect(messageOf(() => validateExecuteFiles([{
      name: 'data.csv',
      content: 'inline',
      input_cache_key: 'a'.repeat(64),
    }]))).toContain('inline content cannot include');
  });

  test('validates args and stdin before any workspace priming', () => {
    expect(messageOf(() => validateExecuteArguments(123, ''))).toContain('args');
    expect(messageOf(() => validateExecuteArguments(['ok', 123], ''))).toContain('args');
    expect(messageOf(() => validateExecuteArguments([], 123))).toContain('stdin');
    expect(() => validateExecuteArguments(['--flag'], 'input')).not.toThrow();
  });

  test('caps total destinations even when they all reference one object', () => {
    const files = Array.from({ length: config.max_input_files + 1 }, (_, i) => ({
      id: 'masked',
      storage_session_id: 'masked-session',
      name: `copy-${i}.csv`,
    }));
    expect(messageOf(() => validateExecuteFiles(files))).toContain('cannot contain more than');
  });

  test('accepts one object at several independent destinations', () => {
    const key = 'a'.repeat(64);
    const files: TFile[] = [
      { id: 'masked', storage_session_id: 'masked-session', name: 'a.csv', input_cache_key: key },
      { id: 'masked', storage_session_id: 'masked-session', name: 'copy/a.csv', input_cache_key: key },
    ];
    expect(() => validateExecuteFiles(files)).not.toThrow();
  });

  test('deduplicateFilesByDestination keeps the latest upload in the original destination order', () => {
    const files: TFile[] = [
      { name: 'data.csv', id: 'first', storage_session_id: 'uploads' },
      { name: 'data.csv', id: 'second', storage_session_id: 'uploads' },
      { name: 'other.csv', id: 'unique', storage_session_id: 'uploads' },
      { name: 'data.csv', id: 'third', storage_session_id: 'latest-uploads' },
    ];
    const result = deduplicateFilesByDestination(files);
    expect(result.map(file => file.name)).toEqual(['data.csv', 'other.csv']);
    expect(result[0].id).toBe('third');
    expect(result[0].storage_session_id).toBe('latest-uploads');
  });

  test('keeps a by-reference program in the entrypoint position when its upload is refreshed', () => {
    const files: TFile[] = [
      { name: 'run.py', id: 'old-script', storage_session_id: 'uploads' },
      { name: 'data.csv', id: 'data', storage_session_id: 'uploads' },
      { name: 'run.py', id: 'new-script', storage_session_id: 'uploads' },
    ];
    const result = deduplicateFilesByDestination(files);
    expect(result.map(file => file.name)).toEqual(['run.py', 'data.csv']);
    expect(result[0].id).toBe('new-script');
    expect(() => validateExecuteFiles(result)).not.toThrow();
  });

  test('rejects an upload that targets inline source, regardless of file order', () => {
    const source: TFile = { name: 'main.py', content: 'print("submitted program")' };
    const upload: TFile = { name: 'main.py', id: 'uploaded-source', storage_session_id: 'uploads' };
    for (const files of [[source, upload], [upload, source]]) {
      const message = messageOf(() => deduplicateFilesByDestination(files));
      expect(message).toContain('duplicate destination "main.py"');
      expect(message).toContain('inline content');
    }
    expect(messageOf(() => deduplicateFilesByDestination([
      { content: 'unnamed source' } as TFile,
      { name: 'file0.code', id: 'uploaded-source', storage_session_id: 'uploads' },
    ]))).toContain('duplicate destination "file0.code"');
    expect(messageOf(() => deduplicateFilesByDestination([
      source, { name: 'main.py', content: 'different source' },
    ]))).toContain('inline content');
  });

  test('deduplicateFilesByDestination returns the same array when there are no duplicates', () => {
    const files: TFile[] = [
      { name: 'a.csv', content: 'a' },
      { name: 'b.csv', content: 'b' },
    ];
    const result = deduplicateFilesByDestination(files);
    expect(result).toEqual(files);
  });

  test('preserves the original destination of an unnamed file reference after deduplication', () => {
    const files: TFile[] = [
      { name: 'main.py', content: 'print(1)' },
      { name: 'data.csv', id: 'old', storage_session_id: 'storage-session' },
      { name: 'data.csv', id: 'new', storage_session_id: 'storage-session' },
      { id: 'file-ref', storage_session_id: 'storage-session' } as TFile,
    ];
    const deduped = deduplicateFilesByDestination(files);
    expect(deduped.map(file => file.name)).toEqual(['main.py', 'data.csv', 'file3.code']);
    expect(deduped[1].id).toBe('new');
    const signedDestination = collectExecuteRequestInputFiles({ files })
      .find(file => file.id === 'file-ref');
    expect(collectExecuteRequestInputFiles({ files: deduped })
      .find(file => file.id === 'file-ref')).toEqual(signedDestination);
    expect(() => validateExecuteFiles(deduped)).not.toThrow();
  });

  test('rejects malformed files even if another entry owns their destination', () => {
    expect(messageOf(() => deduplicateFilesByDestination([
      { name: 'file1.code', content: 'source' },
      null as unknown as TFile,
    ]))).toContain('files[1] must be an object');
    expect(messageOf(() => deduplicateFilesByDestination([
      { name: 'data.csv', content: 'old', encoding: 'invalid' as TFile['encoding'] },
      { name: 'data.csv', content: 'new' },
    ]))).toContain('files[0].encoding');
    expect(messageOf(() => deduplicateFilesByDestination([
      { name: 'data.csv', content: 'old' },
      { name: 'data.csv', id: 'file-ref' },
    ]))).toContain('files[1].storage_session_id');
  });

  test('caps raw input count before dropping duplicates', () => {
    const files = Array.from({ length: config.max_input_files + 1 }, () => ({
      name: 'data.csv', content: 'duplicate',
    }));
    expect(messageOf(() => deduplicateFilesByDestination(files))).toContain('cannot contain more than');
  });

  test('deduplicateFilesByDestination allows validateExecuteFiles to accept duplicate uploads', () => {
    const files: TFile[] = [
      { name: 'data.csv', id: 'first', storage_session_id: 'uploads' },
      { name: 'data.csv', id: 'second', storage_session_id: 'uploads' },
    ];
    const deduped = deduplicateFilesByDestination(files);
    expect(deduped[0].id).toBe('second');
    expect(() => validateExecuteFiles(deduped)).not.toThrow();
  });
});
