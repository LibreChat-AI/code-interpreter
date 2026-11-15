const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

// Exercise both published MinIO entry points under Node as well as Bun: Bun's
// ESM/CJS interop can otherwise conceal a broken require() in the Node service.
for (const format of ['main/notification.js', 'esm/notification.mjs']) {
  test(`MinIO ${format} decodes chunked UTF-8 JSONL notifications and forwards errors`, { timeout: 5000 }, async () => {
    const file = path.join(path.dirname(require.resolve('minio')), '..', format);
    const { NotificationPoller } = await import(pathToFileURL(file).href);
    const record = { eventName: 's3:ObjectCreated:Put', key: 'café.csv' };
    const bytes = Buffer.from(JSON.stringify({ Records: [record] }) + '\n');
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    const poller = new NotificationPoller({
      makeRequestAsync: async () => Readable.from([bytes.subarray(0, split), bytes.subarray(split)]),
    }, 'test-bucket');
    await new Promise((resolve, reject) => {
      poller.on('error', reject);
      poller.on('notification', value => {
        poller.stop();
        try {
          assert.deepEqual(value, record);
          resolve();
        } catch (error) { reject(error); }
      });
      poller.start();
    });
    const malformed = new NotificationPoller({
      makeRequestAsync: async () => Readable.from(['{invalid}\n']),
    }, 'test-bucket');
    await new Promise((resolve, reject) => {
      malformed.on('notification', () => reject(new Error('Invalid JSON must not emit a notification')));
      malformed.on('error', error => {
        malformed.stop();
        assert.ok(error instanceof Error);
        resolve();
      });
      malformed.start();
    });
  });
}
