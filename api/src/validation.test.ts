import { describe, it, expect } from 'bun:test';
import { safeInt, config } from './config';
import {
  checkPathShape,
  isValidPathShape,
  validateFilePath,
  isValidFilePath,
  isDirkeep,
  ValidationError,
} from './validation';

/* Boundary assertions below are derived from the live `config` object so they
 * track SANDBOX_MAX_* env overrides at test time. */
const MAX_DEPTH = config.max_nesting_depth;
const MAX_LEN = config.max_path_length;

describe('safeInt', () => {
  it('returns fallback for undefined input', () => {
    expect(safeInt(undefined, 42)).toBe(42);
  });

  it('returns fallback for non-numeric input (would be NaN)', () => {
    expect(safeInt('not-a-number', 42)).toBe(42);
    expect(safeInt('', 42)).toBe(42);
  });

  it('returns fallback for values below min', () => {
    expect(safeInt('0', 42, 1)).toBe(42);
    expect(safeInt('-5', 42, 1)).toBe(42);
  });

  it('returns fallback for Infinity', () => {
    expect(safeInt('Infinity', 42)).toBe(42);
  });

  it('returns fallback for -Infinity and NaN literal strings', () => {
    expect(safeInt('-Infinity', 42)).toBe(42);
    expect(safeInt('NaN', 42)).toBe(42);
  });

  it('parses valid integers', () => {
    expect(safeInt('123', 42)).toBe(123);
    expect(safeInt('1', 42, 1)).toBe(1);
  });

  it('floors fractional values', () => {
    expect(safeInt('3.7', 42)).toBe(3);
  });
});

describe('isDirkeep', () => {
  it('matches exact basename', () => {
    expect(isDirkeep('.dirkeep')).toBe(true);
    expect(isDirkeep('a/.dirkeep')).toBe(true);
    expect(isDirkeep('a/b/c/.dirkeep')).toBe(true);
  });

  it('rejects user files whose names merely end with .dirkeep', () => {
    expect(isDirkeep('notes.dirkeep')).toBe(false);
    expect(isDirkeep('dir/notes.dirkeep')).toBe(false);
    expect(isDirkeep('dir/my.dirkeep')).toBe(false);
  });

  it('rejects unrelated names', () => {
    expect(isDirkeep('file.txt')).toBe(false);
    expect(isDirkeep('dirkeep')).toBe(false);
    expect(isDirkeep('')).toBe(false);
  });
});

describe('checkPathShape / isValidPathShape', () => {
  it('accepts flat filenames', () => {
    expect(checkPathShape('file.txt')).toBeNull();
    expect(isValidPathShape('file.txt')).toBe(true);
  });

  it('accepts nested paths up to max_nesting_depth', () => {
    const atLimit = Array(MAX_DEPTH - 1).fill('x').join('/') + '/file.txt';
    expect(isValidPathShape(atLimit)).toBe(true);
  });

  it('rejects paths at exactly max_nesting_depth + 1 segments (boundary)', () => {
    const exactBoundary = Array(MAX_DEPTH).fill('x').join('/') + '/file.txt';
    expect(isValidPathShape(exactBoundary)).toBe(false);
    expect(checkPathShape(exactBoundary)).toMatch(/nesting depth/);
  });

  it('rejects paths well beyond max_nesting_depth', () => {
    const tooDeep = Array(MAX_DEPTH + 1).fill('x').join('/') + '/file.txt';
    expect(isValidPathShape(tooDeep)).toBe(false);
    expect(checkPathShape(tooDeep)).toMatch(/nesting depth/);
  });

  it('rejects paths exceeding max_path_length', () => {
    const tooLong = 'a'.repeat(MAX_LEN + 10);
    expect(isValidPathShape(tooLong)).toBe(false);
    expect(checkPathShape(tooLong)).toMatch(/maximum length/);
  });

  it('ignores empty components produced by leading/doubled slashes', () => {
    expect(isValidPathShape('//a//b//c')).toBe(true);
  });
});

describe('validateFilePath', () => {
  const submissionDir = '/tmp/submission';

  it('accepts well-formed relative paths', () => {
    expect(() => validateFilePath('file.txt', submissionDir)).not.toThrow();
    expect(() => validateFilePath('dir/file.txt', submissionDir)).not.toThrow();
  });

  it('rejects non-canonical paths (.., ./, //)', () => {
    expect(() => validateFilePath('a/../a/file.txt', submissionDir)).toThrow(ValidationError);
    expect(() => validateFilePath('dir/./file.txt', submissionDir)).toThrow(ValidationError);
    expect(() => validateFilePath('dir//file.txt', submissionDir)).toThrow(ValidationError);
  });

  it('rejects directory-style paths with a trailing slash', () => {
    expect(() => validateFilePath('dir/', submissionDir)).toThrow(/trailing|directory/);
    expect(() => validateFilePath('a/b/', submissionDir)).toThrow(/trailing|directory/);
  });

  it('rejects empty names and bare dot', () => {
    expect(() => validateFilePath('', submissionDir)).toThrow(ValidationError);
    expect(() => validateFilePath('.', submissionDir)).toThrow(ValidationError);
  });

  it('rejects NUL bytes in file names', () => {
    expect(() => validateFilePath('file\0.txt', submissionDir)).toThrow(/NUL/);
  });

  it('rejects path traversal with .. segments', () => {
    expect(() => validateFilePath('../etc/passwd', submissionDir)).toThrow(ValidationError);
    expect(() => validateFilePath('a/../../escape', submissionDir)).toThrow(ValidationError);
    expect(() => validateFilePath('a/b/../../../escape', submissionDir)).toThrow(ValidationError);
  });

  it('rejects absolute paths that escape the submission dir', () => {
    expect(() => validateFilePath('/etc/passwd', submissionDir)).toThrow(ValidationError);
  });

  it('rejects absolute paths even when they resolve inside the submission dir', () => {
    /* Regression: `path.resolve(submissionDir, absoluteName)` ignores
     * submissionDir when absoluteName is absolute, so the relative-form
     * check would pass. If validateFilePath accepted the absolute string,
     * walkDir's path.relative() output would diverge from the map key and
     * misclassify unchanged inputs as generated outputs. */
    expect(() =>
      validateFilePath(`${submissionDir}/file.txt`, submissionDir),
    ).toThrow(ValidationError);
    expect(() =>
      validateFilePath(`${submissionDir}/file.txt`, submissionDir),
    ).toThrow(/must be relative/);
  });

  it('rejects paths exceeding length limits with a specific message', () => {
    const tooLong = 'a'.repeat(MAX_LEN + 10);
    expect(() => validateFilePath(tooLong, submissionDir)).toThrow(/maximum length/);
  });

  it('rejects paths exceeding nesting depth with a specific message', () => {
    const tooDeep = Array(MAX_DEPTH + 1).fill('x').join('/') + '/file.txt';
    expect(() => validateFilePath(tooDeep, submissionDir)).toThrow(/nesting depth/);
  });

  it('throws a typed ValidationError (for instanceof checks in error handlers)', () => {
    try {
      validateFilePath('../escape', submissionDir);
      throw new Error('expected ValidationError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).name).toBe('ValidationError');
    }
  });
});

describe('isValidFilePath', () => {
  const submissionDir = '/tmp/submission';

  it('returns true for well-formed paths', () => {
    expect(isValidFilePath('file.txt', submissionDir)).toBe(true);
    expect(isValidFilePath('a/b/c/.dirkeep', submissionDir)).toBe(true);
  });

  it('returns false for traversing paths (no throw)', () => {
    expect(isValidFilePath('../etc/.dirkeep', submissionDir)).toBe(false);
    expect(isValidFilePath('a/../../.dirkeep', submissionDir)).toBe(false);
  });

  it('returns false for empty or shape-violating paths', () => {
    expect(isValidFilePath('', submissionDir)).toBe(false);
    expect(isValidFilePath('a'.repeat(MAX_LEN + 10), submissionDir)).toBe(false);
  });

  it('returns false for paths containing NUL bytes', () => {
    expect(isValidFilePath('file\0.txt', submissionDir)).toBe(false);
  });
});
