import { describe, expect, it } from 'bun:test';
import { decodeOriginalFilename, originalFilenameFromMetadata } from './file-metadata';

describe('originalFilenameFromMetadata', () => {
  it('returns undefined rather than treating an object-key basename as original metadata', () => {
    expect(originalFilenameFromMetadata(undefined)).toBeUndefined();
    expect(originalFilenameFromMetadata({ 'content-type': 'application/octet-stream' })).toBeUndefined();
  });

  it('decodes the base64 filename written by the file server', () => {
    expect(originalFilenameFromMetadata({
      'original-filename': Buffer.from('Sample_-_Superstore.xlsx').toString('base64'),
      'original-filename-encoded': 'base64',
    })).toBe('Sample_-_Superstore.xlsx');
  });

  it('supports legacy plain-text filename metadata', () => {
    expect(originalFilenameFromMetadata({
      'original-filename': 'report.csv',
    })).toBe('report.csv');
  });
});

describe('decodeOriginalFilename', () => {
  it('retains object-key fallback behavior for listing responses', () => {
    expect(decodeOriginalFilename(undefined, 'opaque-id.xlsx')).toBe('opaque-id.xlsx');
  });
});
