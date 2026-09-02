import path from 'path';

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

export function contentDispositionForOriginalFilename(
  originalFilename: string | undefined,
): string {
  if (!originalFilename) return 'attachment';
  return `attachment; filename*=UTF-8''${encodeURIComponent(originalFilename)}`;
}

function filenameFromContentDisposition(contentDisposition: string | null): string | undefined {
  if (!contentDisposition) return undefined;
  const star = contentDisposition.match(/filename\*=(?:UTF-8'[^']*')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // A valid legacy filename may still follow a malformed extended value.
    }
  }
  const legacy = contentDisposition.match(/filename="([^"]+)"/i)
    ?? contentDisposition.match(/filename=([^\s;]+)/i);
  return legacy?.[1];
}

/**
 * Detects the legacy file-server fallback `<object id><extension>`. The egress
 * gateway has the unsealed object id, so it can remove this unverified name
 * before forwarding the response to a runner that only sees sealed handles.
 */
export function isOpaqueObjectContentDisposition(
  contentDisposition: string | null,
  objectId: string,
): boolean {
  const candidate = filenameFromContentDisposition(contentDisposition);
  if (!candidate || candidate !== path.basename(candidate)) return false;
  return path.basename(candidate, path.extname(candidate)) === objectId;
}
