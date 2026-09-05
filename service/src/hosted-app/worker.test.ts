import { describe, expect, test } from 'bun:test';
import { HostedAppControlPlaneError } from './control-plane';
import { HostedAppMicrovmError } from './microvm-runtime';
import { serializedHostedAppFailure } from './worker';

function wire(error: unknown): Record<string, unknown> {
  return JSON.parse(serializedHostedAppFailure(error).message) as Record<string, unknown>;
}

describe('hosted app worker error boundary', () => {
  test('preserves safe control-plane and runner validation classifications', () => {
    expect(wire(new HostedAppControlPlaneError('busy', 'Try later', 409, true)))
      .toEqual({ code: 'busy', status: 409, message: 'Try later', transient: true });
    expect(wire(new HostedAppMicrovmError(
      'hosted_app_start_failed',
      'runtime node@99 is not installed',
      false,
      undefined,
      400,
    ))).toEqual({
      code: 'hosted_app_start_failed',
      status: 400,
      message: 'runtime node@99 is not installed',
      transient: false,
    });
  });

  test('redacts provider details while preserving retryability', () => {
    const result = wire(new HostedAppMicrovmError(
      'hosted_app_launch_failed',
      'AWS arn:secret leaked detail',
      true,
    ));
    expect(result).toEqual({
      code: 'hosted_app_launch_failed',
      status: 503,
      message: 'Hosted app infrastructure operation failed',
      transient: true,
    });
    expect(JSON.stringify(result)).not.toContain('arn:secret');
  });
});
