/**
 * Reads a verified original filename from S3 user metadata. Absence remains
 * distinct from the object's opaque storage-key basename so callers can avoid
 * advertising the latter as an authoritative filename.
 */
export function originalFilenameFromMetadata(
  metadata: Record<string, string> | undefined,
): string | undefined {
  const encodedFilename = metadata?.['original-filename'];
  if (!encodedFilename) return undefined;

  if (metadata?.['original-filename-encoded'] === 'base64') {
    return Buffer.from(encodedFilename, 'base64').toString('utf8');
  }

  return encodedFilename;
}

export function decodeOriginalFilename(
  metadata: Record<string, string> | undefined,
  fallbackName: string,
): string {
  return originalFilenameFromMetadata(metadata) ?? fallbackName;
}
