import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createMinioClient } from './minio-client';

const MiB = 1024 * 1024;

// Exercise the real SDK against a local S3 HTTP fixture. No storage account,
// Redis, or file-server listener is needed to test the production client.
test.each([1024, 8 * MiB, 20 * MiB + 17])(
  'unknown-length upload of %i bytes uses bounded parts without losing bytes',
  async size => {
    const parts = new Map<number, Buffer>();
    const lengths: number[] = [];
    const uploaded: { body?: Buffer; contentType?: string | null; originalFilename?: string | null } = {};
    const xml = (body: string) => new Response(body, {
      headers: { 'Content-Type': 'application/xml' },
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'GET' && url.searchParams.has('uploads')) {
          return xml('<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>');
        }
        if (req.method === 'POST' && url.searchParams.has('uploads')) {
          uploaded.contentType = req.headers.get('content-type');
          uploaded.originalFilename = req.headers.get('x-amz-meta-original-filename');
          return xml('<InitiateMultipartUploadResult><UploadId>test-upload</UploadId></InitiateMultipartUploadResult>');
        }
        if (req.method === 'PUT' && url.searchParams.has('partNumber')) {
          const body = Buffer.from(await req.arrayBuffer());
          lengths.push(body.length);
          if (Number(req.headers.get('content-length')) !== body.length ||
              req.headers.get('content-md5') !== createHash('md5').update(body).digest('base64')) {
            return new Response('Invalid part length or checksum', { status: 400 });
          }
          parts.set(Number(url.searchParams.get('partNumber')), body);
          return new Response(null, {
            headers: { ETag: `"${createHash('md5').update(body).digest('hex')}"` },
          });
        }
        if (req.method === 'POST' && url.searchParams.has('uploadId')) {
          const manifest = await req.text();
          const ordered = [...manifest.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)]
            .map(match => parts.get(Number(match[1])));
          if (ordered.length !== parts.size || ordered.some(part => !part)) {
            return new Response('Invalid multipart completion', { status: 400 });
          }
          uploaded.body = Buffer.concat(ordered as Buffer[]);
          return xml('<CompleteMultipartUploadResult><Location>http://localhost/test-bucket/input.bin</Location><Bucket>test-bucket</Bucket><Key>input.bin</Key><ETag>"complete"</ETag></CompleteMultipartUploadResult>');
        }
        return new Response('Unexpected S3 request', { status: 400 });
      },
    });
    const settings: Record<string, string | undefined> = {
      MINIO_ENDPOINT: '127.0.0.1',
      MINIO_PORT: String(server.port),
      MINIO_NO_PORT: 'false',
      MINIO_USE_SSL: 'false',
      MINIO_REGION: 'us-east-1',
      MINIO_USE_IRSA: 'false',
      AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
      AWS_ROLE_ARN: undefined,
      MINIO_ACCESS_KEY: 'test-access',
      MINIO_SECRET_KEY: 'test-secret',
      MINIO_SESSION_TOKEN: undefined,
    };
    const saved = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
    try {
      for (const [key, value] of Object.entries(settings)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const client = await createMinioClient();
      const expected = Buffer.alloc(size);
      for (let i = 0; i < expected.length; i++) expected[i] = i % 251;
      function* chunks() {
        for (let offset = 0; offset < size; offset += 64 * 1024) {
          yield expected.subarray(offset, Math.min(size, offset + 64 * 1024));
        }
      }
      await client.putObject('test-bucket', 'input.bin', Readable.from(chunks()), undefined, {
        'Content-Type': 'application/octet-stream',
        'X-Amz-Meta-Original-Filename': 'input.bin',
      });
      expect(lengths.length).toBe(Math.ceil(size / (8 * MiB)));
      expect(lengths.every(length => length <= 8 * MiB)).toBe(true);
      expect(uploaded.body?.equals(expected)).toBe(true);
      expect(uploaded.contentType).toBe('application/octet-stream');
      expect(uploaded.originalFilename).toBe('input.bin');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await server.stop(true);
    }
  },
);
