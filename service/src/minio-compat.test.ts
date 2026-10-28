import { expect, test } from 'bun:test';
import { Client } from 'minio';

test('patched MinIO preserves S3 object-list XML decoding', async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      expect(url.pathname).toBe('/testbucket');
      expect(url.searchParams.get('list-type')).toBe('2');
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>testbucket</Name><Prefix>inputs/</Prefix><KeyCount>1</KeyCount>
  <MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>
  <Contents><Key>inputs/a&amp;b.csv</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified>
    <ETag>&quot;test-etag&quot;</ETag><Size>12</Size><StorageClass>STANDARD</StorageClass>
  </Contents>
</ListBucketResult>`, { headers: { 'Content-Type': 'application/xml' } });
    },
  });
  try {
    const client = new Client({
      endPoint: '127.0.0.1',
      port: server.port,
      useSSL: false,
      region: 'us-east-1',
      accessKey: 'test-access-key',
      secretKey: 'test-secret-key',
    });
    const objects = [];
    for await (const object of client.listObjectsV2('testbucket', 'inputs/', true)) {
      objects.push(object);
    }
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ name: 'inputs/a&b.csv', size: 12, etag: 'test-etag' });
  } finally {
    server.stop(true);
  }
});
