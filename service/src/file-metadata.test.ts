import { describe, expect, it } from 'bun:test';
import {
  contentDispositionForOriginalFilename,
  decodeOriginalFilename,
  isOpaqueObjectContentDisposition,
  originalFilenameFromMetadata,
} from './file-metadata';

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

describe('contentDispositionForOriginalFilename', () => {
  it('preserves attachment semantics when filename metadata is unavailable', () => {
    expect(contentDispositionForOriginalFilename(undefined)).toBe('attachment');
  });

  it('encodes a verified original filename', () => {
    expect(contentDispositionForOriginalFilename('reports/收益.csv'))
      .toBe("attachment; filename*=UTF-8''reports%2F%E6%94%B6%E7%9B%8A.csv");
  });
});

describe('isOpaqueObjectContentDisposition', () => {
  it('recognizes extended and legacy storage-id basenames', () => {
    expect(isOpaqueObjectContentDisposition(
      "attachment; filename*=UTF-8''raw-object-id.xlsx",
      'raw-object-id',
    )).toBe(true);
    expect(isOpaqueObjectContentDisposition(
      'attachment; filename="raw-object-id.csv"',
      'raw-object-id',
    )).toBe(true);
  });

  it('does not replace verified or nested filenames', () => {
    expect(isOpaqueObjectContentDisposition(
      'attachment; filename="report.csv"',
      'raw-object-id',
    )).toBe(false);
    expect(isOpaqueObjectContentDisposition(
      "attachment; filename*=UTF-8''exports%2Fraw-object-id.csv",
      'raw-object-id',
    )).toBe(false);
  });
});
