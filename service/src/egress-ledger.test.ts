import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { startTestRedis } from './test/redis';
import { env } from './config';
import type { EgressGrantClaims } from './egress-grant';
import { EgressGrantError } from './egress-grant';
import {
  assertEgressGrantActive,
  createEgressLedger,
  ensureEgressLedger,
  releaseEgressUpload,
  reserveEgressUpload,
  recordEgressRead,
  recordEgressToolCall,
  checkEgressGrantActive,
  revokeEgressLedger,
  setEgressLedgerRedisForTest,
} from './egress-ledger';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function grant(overrides: Partial<EgressGrantClaims> = {}): EgressGrantClaims {
  const now = nowSeconds();
  return {
    v: 1,
    typ: 'grant',
    grant_id: 'grant_123',
    exec_id: 'exec_123',
    tenant_id: 'tenant_abc',
    user_id: 'user_123',
    session_key: 'session_key',
    input_files: [{ id: 'file_123', session_id: 'sess_input', name: 'inputs/data.csv' }],
    read_sessions: ['sess_input'],
    output_session_id: 'sess_output',
    max_upload_bytes: 10,
    max_output_files: 1,
    max_requests: 3,
    iat: now - 10,
    exp: now + 300,
    ...overrides,
  };
}

function expectEgressError(fn: () => Promise<unknown>, reason: EgressGrantError['reason']): Promise<void> {
  return fn().then(
    () => { throw new Error('expected egress error'); },
    error => {
      expect(error).toBeInstanceOf(EgressGrantError);
      expect((error as EgressGrantError).reason).toBe(reason);
    },
  );
}

describe.each([false, true])('egress Redis ledger compact=%s', compact => {
  let redis: Awaited<ReturnType<typeof startTestRedis>>;
  let previousRequired: boolean;
  let previousCompact: boolean;
  let previousMaxFileBytes: number;
  let previousTtlGraceSeconds: number;

  beforeEach(async () => {
    previousRequired = env.EGRESS_LEDGER_REQUIRED;
    previousCompact = env.EGRESS_LEDGER_COMPACT;
    env.EGRESS_LEDGER_COMPACT = compact;
    previousMaxFileBytes = env.EGRESS_GATEWAY_MAX_FILE_BYTES;
    previousTtlGraceSeconds = env.EGRESS_LEDGER_TTL_GRACE_SECONDS;
    env.EGRESS_LEDGER_REQUIRED = true;
    env.EGRESS_GATEWAY_MAX_FILE_BYTES = 10;
    redis = await startTestRedis();
    setEgressLedgerRedisForTest(redis as unknown as Parameters<typeof setEgressLedgerRedisForTest>[0]);
  });

  afterEach(async () => {
    await redis.closeTestServer();
    setEgressLedgerRedisForTest(null);
    env.EGRESS_LEDGER_REQUIRED = previousRequired;
    env.EGRESS_LEDGER_COMPACT = previousCompact;
    env.EGRESS_GATEWAY_MAX_FILE_BYTES = previousMaxFileBytes;
    env.EGRESS_LEDGER_TTL_GRACE_SECONDS = previousTtlGraceSeconds;
  });

  test('tracks active, revoked, duplicate, and released upload state', async () => {
    const claims = grant();
    await createEgressLedger(claims);
    await expect(assertEgressGrantActive(claims)).resolves.toMatchObject({
      grant_id: 'grant_123',
      status: 'active',
    });

    await reserveEgressUpload({ grant: claims, fileId: 'file_a', bytes: 5 });
    await expectEgressError(
      () => reserveEgressUpload({ grant: claims, fileId: 'file_a', bytes: 1 }),
      'scope_mismatch',
    );
    await releaseEgressUpload({ grant: claims, fileId: 'file_a', bytes: 5 });
    await reserveEgressUpload({ grant: claims, fileId: 'file_a', bytes: 5 });

    await revokeEgressLedger(claims.grant_id, 'completed');
    await expectEgressError(() => assertEgressGrantActive(claims), 'scope_mismatch');
  });

  test('rejects upload budgets before forwarding', async () => {
    const claims = grant();
    await createEgressLedger(claims);

    await expectEgressError(
      () => reserveEgressUpload({ grant: claims, fileId: 'too_big', bytes: 11 }),
      'scope_mismatch',
    );
  });

  test('leaves counters unchanged after a rejected mutation', async () => {
    const claims = grant({ max_output_files: 2, max_requests: 5 });
    await createEgressLedger(claims);

    await reserveEgressUpload({ grant: claims, fileId: 'file_a', bytes: 5 });
    await expectEgressError(
      () => reserveEgressUpload({ grant: claims, fileId: 'file_a', bytes: 1 }),
      'scope_mismatch',
    );

    await expect(reserveEgressUpload({ grant: claims, fileId: 'file_b', bytes: 5 })).resolves.toBeUndefined();
  });

  test('does not reset an existing ledger when ensuring lazy rollout state', async () => {
    const claims = grant({ max_output_files: 2, max_requests: 5 });
    await createEgressLedger(claims);
    await reserveEgressUpload({ grant: claims, fileId: 'file_a', bytes: 5 });

    await ensureEgressLedger(claims);

    const record = await assertEgressGrantActive(claims);
    expect(record.request_count).toBe(1);
    expect(record.upload_count).toBe(1);
    expect(record.uploaded_bytes).toBe(5);
    expect(record.output_file_ids).toEqual(['file_a']);
  });

  test('keeps revoked records through grant expiry so lazy legacy ensure cannot reactivate them', async () => {
    env.EGRESS_LEDGER_TTL_GRACE_SECONDS = 1;
    const claims = grant({ exp: nowSeconds() + 60 });
    await createEgressLedger(claims);
    await revokeEgressLedger(claims.grant_id, 'completed');

    const revokedTtl = await redis.ttl(`codeapi:egress:grant:${claims.grant_id}`);
    expect(revokedTtl).toBeGreaterThan(30);

    await ensureEgressLedger(claims);
    await expectEgressError(() => assertEgressGrantActive(claims), 'scope_mismatch');
  });

  test('accounts concurrent operations without WATCH connections', async () => {
    const claims = grant({
      max_output_files: 16,
      max_requests: 16,
      max_upload_bytes: 10,
    });
    let duplicateCount = 0;
    const duplicate = redis.duplicate.bind(redis);
    redis.duplicate = ((...args: Parameters<typeof redis.duplicate>) => {
      duplicateCount += 1;
      return duplicate(...args);
    }) as typeof redis.duplicate;

    try {
      await createEgressLedger(claims);
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => (
          reserveEgressUpload({ grant: claims, fileId: `file_${i}`, bytes: 1 })
        )),
      );
      await Promise.all(
        Array.from({ length: 4 }, (_, i) => (
          reserveEgressUpload({ grant: claims, fileId: `reuse_${i}`, bytes: 1 })
        )),
      );

      const record = await assertEgressGrantActive(claims);
      expect(duplicateCount).toBe(0);
      expect(record.request_count).toBe(12);
      expect(record.upload_count).toBe(12);
      expect(record.uploaded_bytes).toBe(12);
      expect(record.output_file_ids.sort()).toEqual(
        [
          ...Array.from({ length: 8 }, (_, i) => `file_${i}`),
          ...Array.from({ length: 4 }, (_, i) => `reuse_${i}`),
        ].sort(),
      );
    } finally {
      redis.duplicate = duplicate as typeof redis.duplicate;
    }
  });
  test('admits exactly the request budget under a 240-file burst', async () => {
    const claims = grant({ max_requests: 100, input_files: Array.from({ length: 240 }, (_, i) => ({
      id: `file_${i}`, session_id: 'inputs', name: `${i}.txt`,
    })) });
    await createEgressLedger(claims);
    const results = await Promise.allSettled(Array.from({ length: 240 }, () => recordEgressRead(claims)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(100);
    expect((await assertEgressGrantActive(claims)).request_count).toBe(100);
    expect((await assertEgressGrantActive(claims)).read_count).toBe(100);
  });

  test('rejects wrong execution, expired grants and mutations after revocation', async () => {
    const claims = grant({ max_requests: 1000 });
    await createEgressLedger(claims);
    await expectEgressError(() => recordEgressRead({ ...claims, exec_id: 'wrong' }), 'scope_mismatch');
    await recordEgressToolCall(claims.grant_id, claims.exec_id);
    await Promise.all([
      ...Array.from({ length: 40 }, () => recordEgressRead(claims).catch(() => {})),
      revokeEgressLedger(claims.grant_id, 'done'),
    ]);
    await createEgressLedger(claims);
    await expectEgressError(() => checkEgressGrantActive(claims), 'scope_mismatch');
    await expectEgressError(() => recordEgressRead(claims), 'scope_mismatch');
    const expired = grant({ grant_id: 'expired', exp: nowSeconds() - 1 });
    await createEgressLedger(expired);
    await expectEgressError(() => checkEgressGrantActive(expired), 'expired');
  });

  test('duplicate releases cannot refund another upload or read', async () => {
    const claims = grant({ max_requests: 10, max_output_files: 2 });
    await createEgressLedger(claims);
    await recordEgressRead(claims);
    await reserveEgressUpload({ grant: claims, fileId: 'a', bytes: 3 });
    await reserveEgressUpload({ grant: claims, fileId: 'b', bytes: 4 });
    await Promise.all(Array.from({ length: 10 }, () => releaseEgressUpload({ grant: claims, fileId: 'a', bytes: 3 })));
    expect(await assertEgressGrantActive(claims)).toMatchObject({
      request_count: 2, upload_count: 1, uploaded_bytes: 4, output_file_ids: ['b'],
    });
  });

  test('format selection affects new grants only and never resets existing state', async () => {
    const claims = grant();
    await createEgressLedger(claims);
    await recordEgressRead(claims);
    env.EGRESS_LEDGER_COMPACT = !compact;
    await ensureEgressLedger(claims);
    await recordEgressRead(claims);
    expect(await redis.type(`codeapi:egress:grant:${claims.grant_id}`)).toBe(compact ? 'hash' : 'string');
    expect((await assertEgressGrantActive(claims)).request_count).toBe(2);
    if (!compact) {
      const legacy = JSON.parse((await redis.get(`codeapi:egress:grant:${claims.grant_id}`))!);
      expect(legacy.output_file_ids).toEqual([]);
      expect(Array.isArray(legacy.input_files)).toBe(true);
    }
  });

});
