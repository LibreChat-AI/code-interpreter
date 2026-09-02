import * as path from 'path';
import { config } from './config';

export const DIRKEEP = '.dirkeep';

/**
 * Sandbox directories are owned by a per-job outside UID/GID and are not
 * readable by sibling jobs in the runner namespace.
 */
export const SANDBOX_DIR_MODE = 0o700;

/**
 * Normal sandbox-staged files are owned by the per-job outside UID/GID.
 * Read-only inputs use a separate root-owned 0444 mode in job.ts.
 */
export const SANDBOX_FILE_MODE = 0o600;

/** True when `name`'s basename is the .dirkeep sentinel used for empty-directory preservation. */
export function isDirkeep(name: string): boolean {
  return path.basename(name) === DIRKEEP;
}

/**
 * Whether a request carries something the runtime can actually run: a utf8
 * source file that is not the .dirkeep sentinel. `file` runtimes are exempt —
 * they take arbitrary inputs.
 *
 * Single source of truth on purpose. The request gate and `Job.execute` used to
 * ask this question differently (the gate accepted a lone `.dirkeep` as a utf8
 * file), so a request with only `.dirkeep` plus binary inputs passed the gate,
 * primed its files into the session workspace, and only then failed in
 * execute — leaving the rejected request's writes behind.
 */
export function hasRunnableSource(
  files: Array<{ name?: string; encoding?: string }>,
  language: string,
): boolean {
  if (language === 'file') return true;
  return files.some(
    /* Request files may omit `name`; Job normalizes those to `file${i}.code`,
     * which is runnable and cannot be the .dirkeep sentinel. */
    (file) => (file.name === undefined || !isDirkeep(file.name))
      && (!file.encoding || file.encoding === 'utf8'),
  );
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Returns a specific error message if `name` violates length/depth constraints, else null. */
export function checkPathShape(name: string): string | null {
  if (name.length > config.max_path_length) {
    return `File path exceeds maximum length of ${config.max_path_length}`;
  }
  const depth = name.split('/').filter(Boolean).length;
  if (depth > config.max_nesting_depth) {
    return `File path exceeds maximum nesting depth of ${config.max_nesting_depth}`;
  }
  return null;
}

/** Predicate form of checkPathShape for silent skipping in scan paths. */
export function isValidPathShape(name: string): boolean {
  return checkPathShape(name) === null;
}

export function validateFilePath(name: string, submissionDir: string): void {
  if (!name || name === '.') {
    throw new ValidationError('File path must not be empty');
  }
  /* Reject absolute paths up front. `path.resolve(submissionDir, name)`
   * ignores `submissionDir` when `name` is absolute, so an absolute path
   * that happens to point inside `submissionDir` (e.g. the exact on-disk
   * location) would silently pass the traversal check below. Its raw
   * string would then be stored as the map key in inputByName /
   * inputFileHashes, while walkDir later keys by the relative form —
   * causing unchanged inputs to be misclassified as generated outputs. */
  if (path.isAbsolute(name)) {
    throw new ValidationError(`File path "${name}" must be relative`);
  }
  const shapeError = checkPathShape(name);
  if (shapeError) throw new ValidationError(shapeError);
  /* Reject non-canonical paths outright. Names like "a/../a/file.txt",
   * "dir/./file.txt", or "dir//file.txt" are normalized away when written
   * to / read from disk, but the raw string stays as the key in
   * inputByName / inputFileHashes. walkDir then looks up by path.relative()
   * output (which IS normalized), so lookups miss and unchanged inputs get
   * re-emitted as new generated outputs. Forcing a canonical name up-front
   * guarantees the maps and disk always agree. */
  if (path.posix.normalize(name) !== name) {
    throw new ValidationError(`File path "${name}" must be in canonical form (no "..", "./", or "//" segments)`);
  }
  /* path.posix.normalize preserves a trailing slash, so "dir/" still equals
   * its normalized form and slips through the check above. Reject it
   * explicitly — a directory path has no valid interpretation as a file
   * name and would later blow up inside createWriteStream / writeFile. */
  if (name.endsWith('/')) {
    throw new ValidationError(`File path "${name}" must not end with "/" (directory paths are not valid file names)`);
  }
  const resolved = path.resolve(submissionDir, name);
  const rel = path.relative(submissionDir, resolved);
  if (rel === '..' || rel.startsWith('..' + path.sep)) {
    throw new ValidationError(`File path "${name}" escapes parent directory`);
  }
}

/** Predicate form of validateFilePath for skip-don't-throw callsites. */
export function isValidFilePath(name: string, submissionDir: string): boolean {
  try {
    validateFilePath(name, submissionDir);
    return true;
  } catch {
    return false;
  }
}
