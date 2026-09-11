import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import { contentDispositionForOriginalFilename, originalFilenameFromMetadata } from './file-metadata';

export async function sendFileDownload(dataStream: Readable, res: Response, expectedVersion?: string): Promise<void> {
  // MinIO returns the HTTP response stream. Read metadata from this exact GET,
  // avoiding both a redundant HEAD and metadata/content races on overwrite.
  const headers = (dataStream as Readable & { headers?: Record<string, string> }).headers ?? {};
  if (expectedVersion && headers['x-amz-meta-codeapi-version'] !== expectedVersion) {
    dataStream.destroy();
    res.status(409).json({ error: 'Input changed during preparation; retry with current metadata' });
    return;
  }
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith('x-amz-meta-')) metadata[key.slice(11)] = value;
  }
  res.setHeader('Content-Disposition', contentDispositionForOriginalFilename(originalFilenameFromMetadata(metadata)));
  if (headers['content-type']) res.setHeader('Content-Type', headers['content-type']);
  if (headers['content-length']) res.setHeader('Content-Length', headers['content-length']);
  if (metadata['read-only'] === 'true') res.setHeader('X-Read-Only', 'true');
  if (metadata['codeapi-version']) res.setHeader('X-CodeAPI-Input-Version', metadata['codeapi-version']);
  const cancel = (): void => { if (!res.writableFinished) dataStream.destroy(new Error('Download client disconnected')); };
  res.once('close', cancel);
  try { await pipeline(dataStream, res); } finally { res.off('close', cancel); }
}
