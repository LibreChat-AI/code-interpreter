import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import type { AuthenticatedRequest } from './types';
import { CLIENT_DISCONNECT_REASON } from './job-cancellation';
import { observeRequestDisconnect } from './request-disconnect';

function requestAndResponse(options: {
  requestAborted?: boolean;
  requestDestroyed?: boolean;
  responseDestroyed?: boolean;
} = {}): {
  req: AuthenticatedRequest & EventEmitter;
  res: Response & EventEmitter;
} {
  const req = Object.assign(new EventEmitter(), {
    aborted: options.requestAborted ?? false,
    destroyed: options.requestDestroyed ?? false,
  }) as AuthenticatedRequest & EventEmitter;
  const res = Object.assign(new EventEmitter(), {
    destroyed: options.responseDestroyed ?? false,
    writableFinished: false,
  }) as Response & EventEmitter;
  return { req, res };
}

test('a consumed Bun request stream is not mistaken for a disconnect', () => {
  const { req, res } = requestAndResponse({ requestDestroyed: true });
  const observer = observeRequestDisconnect(req, res);

  expect(observer.isDisconnected()).toBe(false);
  expect(observer.signal.aborted).toBe(false);
  observer.dispose();
});

test('current and future transport abandonment abort exactly once', () => {
  const current = requestAndResponse({ requestAborted: true });
  const currentObserver = observeRequestDisconnect(current.req, current.res);
  expect(currentObserver.signal.reason).toBe(CLIENT_DISCONNECT_REASON);

  const future = requestAndResponse();
  const futureObserver = observeRequestDisconnect(future.req, future.res);
  future.res.emit('close');
  future.req.emit('aborted');
  expect(futureObserver.signal.reason).toBe(CLIENT_DISCONNECT_REASON);
  expect(future.req.listenerCount('aborted')).toBe(0);
  expect(future.res.listenerCount('close')).toBe(0);
});

test('a completed response disposes listeners without aborting', () => {
  const { req, res } = requestAndResponse();
  const observer = observeRequestDisconnect(req, res);
  (res as unknown as { writableFinished: boolean }).writableFinished = true;
  res.emit('finish');
  res.emit('close');

  expect(observer.isDisconnected()).toBe(false);
  expect(req.listenerCount('aborted')).toBe(0);
  expect(res.listenerCount('close')).toBe(0);
});
