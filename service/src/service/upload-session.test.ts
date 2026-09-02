import { describe, expect, test } from 'bun:test';
import { createUploadSessionRegistrar } from './upload-session';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('createUploadSessionRegistrar', () => {
  test('waits for session registration before forwarding a file', async () => {
    const registration = deferred();
    const events: string[] = [];
    const ensureSessionRegistered = createUploadSessionRegistrar((sessionKey) => {
      events.push(`session:set:start:${sessionKey}`);
      return registration.promise.then(() => {
        events.push('session:set:done');
      });
    });

    const result = ensureSessionRegistered('user:user-1').then(async () => {
      events.push('file:put');
      return 'uploaded';
    });

    await Promise.resolve();
    expect(events).toEqual(['session:set:start:user:user-1']);

    registration.resolve();
    expect(await result).toBe('uploaded');
    expect(events).toEqual(['session:set:start:user:user-1', 'session:set:done', 'file:put']);
  });

  test('shares one pending registration across every file in a batch', async () => {
    const registration = deferred();
    let registrations = 0;
    const forwarded: string[] = [];
    const ensureSessionRegistered = createUploadSessionRegistrar(() => {
      registrations += 1;
      return registration.promise;
    });

    const uploads = [
      ensureSessionRegistered('user:user-1').then(async () => {
        forwarded.push('first');
        return 'first';
      }),
      ensureSessionRegistered('user:user-1').then(async () => {
        forwarded.push('second');
        return 'second';
      }),
    ];

    await Promise.resolve();
    expect(registrations).toBe(1);
    expect(forwarded).toEqual([]);

    registration.resolve();
    expect(await Promise.all(uploads)).toEqual(['first', 'second']);
    expect(forwarded).toEqual(['first', 'second']);
  });

  test('does not forward files when session registration fails', async () => {
    const registration = deferred();
    let forwarded = false;
    const ensureSessionRegistered = createUploadSessionRegistrar(() => registration.promise);
    const result = ensureSessionRegistered('user:user-1').then(async () => {
      forwarded = true;
      return 'uploaded';
    });

    registration.reject(new Error('Redis unavailable'));

    await expect(result).rejects.toThrow('Redis unavailable');
    expect(forwarded).toBe(false);
  });

  test('keeps a pending registration timeout terminal when Redis rejects later', async () => {
    const registration = deferred();
    let forwarded = false;
    const ensureSessionRegistered = createUploadSessionRegistrar(() => registration.promise);
    const result = ensureSessionRegistered('user:user-1').then(async () => {
      forwarded = true;
      return 'uploaded';
    });

    expect(ensureSessionRegistered.rejectPending(
      new Error('Upload session registration timed out'),
    )).toBe(true);
    await expect(result).rejects.toThrow('Upload session registration timed out');
    expect(forwarded).toBe(false);

    registration.reject(new Error('Redis unavailable after timeout'));
    await Promise.resolve();

    expect(forwarded).toBe(false);
    expect(ensureSessionRegistered.rejectPending(new Error('too late'))).toBe(false);
  });
});
