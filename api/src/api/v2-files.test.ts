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

  test('deduplicateFilesByDestination keeps the latest occurrence in surviving order', () => {
    const files: TFile[] = [
      { name: 'data.csv', content: 'first' },
      { name: 'data.csv', content: 'second' },
      { name: 'other.csv', content: 'unique' },
      { name: 'data.csv', content: 'third' },
    ];
    const result = deduplicateFilesByDestination(files);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('other.csv');
    expect(result[1].name).toBe('data.csv');
    expect(result[1].content).toBe('third');
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
      { name: 'data.csv', content: 'old' },
      { name: 'data.csv', content: 'new' },
      { id: 'file-ref', storage_session_id: 'storage-session' } as TFile,
    ];
    const deduped = deduplicateFilesByDestination(files);
    expect(deduped.map(file => file.name)).toEqual(['main.py', 'data.csv', 'file3.code']);
    expect(deduped[1].content).toBe('new');
    expect(collectExecuteRequestInputFiles({ files: deduped })).toEqual(
      collectExecuteRequestInputFiles({ files }),
    );
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

  test('deduplicateFilesByDestination allows validateExecuteFiles to accept previously-duplicate input', () => {
    const files: TFile[] = [
      { name: 'data.csv', content: 'first' },
      { name: 'data.csv', content: 'second' },
    ];
    const deduped = deduplicateFilesByDestination(files);
    expect(() => validateExecuteFiles(deduped)).not.toThrow();
  });
});
