import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import { env } from './config';
import type { EgressGrantClaims } from './egress-grant';
import { EgressGrantError } from './egress-grant';
import {
    assertEgressGrantActive,
    createEgressLedger,
    ensureEgressLedger,
    releaseEgressUpload,
    reserveEgressUpload,
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
        input_files: [
            {
                id: 'file_123',
                session_id: 'sess_input',
                name: 'inputs/data.csv',
            },
        ],
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

function expectEgressError(
    fn: () => Promise<unknown>,
    reason: EgressGrantError['reason'],
): Promise<void> {
    return fn().then(
        () => {
            throw new Error('expected egress error');
        },
        error => {
            expect(error).toBeInstanceOf(EgressGrantError);
            expect((error as EgressGrantError).reason).toBe(reason);
        },
    );
}

describe('egress Redis ledger', () => {
    let redis: InstanceType<typeof RedisMock>;
    let previousRequired: boolean;
    let previousMaxFileBytes: number;
    let previousTtlGraceSeconds: number;

    beforeEach(() => {
        previousRequired = env.EGRESS_LEDGER_REQUIRED;
        previousMaxFileBytes = env.EGRESS_GATEWAY_MAX_FILE_BYTES;
        previousTtlGraceSeconds = env.EGRESS_LEDGER_TTL_GRACE_SECONDS;
        env.EGRESS_LEDGER_REQUIRED = true;
        env.EGRESS_GATEWAY_MAX_FILE_BYTES = 10;
        redis = new RedisMock();
        setEgressLedgerRedisForTest(
            redis as unknown as Parameters<
                typeof setEgressLedgerRedisForTest
            >[0],
        );
    });

    afterEach(async () => {
        await redis.disconnect();
        setEgressLedgerRedisForTest(null);
        env.EGRESS_LEDGER_REQUIRED = previousRequired;
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

        await reserveEgressUpload({
            grant: claims,
            fileId: 'file_a',
            bytes: 5,
        });
        await expectEgressError(
            () =>
                reserveEgressUpload({
                    grant: claims,
                    fileId: 'file_a',
                    bytes: 1,
                }),
            'scope_mismatch',
        );
        await releaseEgressUpload({
            grant: claims,
            fileId: 'file_a',
            bytes: 5,
        });
        await reserveEgressUpload({
            grant: claims,
            fileId: 'file_a',
            bytes: 5,
        });

        await revokeEgressLedger(claims.grant_id, 'completed');
        await expectEgressError(
            () => assertEgressGrantActive(claims),
            'scope_mismatch',
        );
    });

    test('rejects upload budgets before forwarding', async () => {
        const claims = grant();
        await createEgressLedger(claims);

        await expectEgressError(
            () =>
                reserveEgressUpload({
                    grant: claims,
                    fileId: 'too_big',
                    bytes: 11,
                }),
            'scope_mismatch',
        );
    });

    test('clears Redis WATCH after rejected mutations so later valid updates can proceed', async () => {
        const claims = grant({ max_output_files: 2, max_requests: 5 });
        await createEgressLedger(claims);

        await reserveEgressUpload({
            grant: claims,
            fileId: 'file_a',
            bytes: 5,
        });
        await expectEgressError(
            () =>
                reserveEgressUpload({
                    grant: claims,
                    fileId: 'file_a',
                    bytes: 1,
                }),
            'scope_mismatch',
        );

        await expect(
            reserveEgressUpload({ grant: claims, fileId: 'file_b', bytes: 5 }),
        ).resolves.toBeUndefined();
    });

    test('does not reset an existing ledger when ensuring lazy rollout state', async () => {
        const claims = grant({ max_output_files: 2, max_requests: 5 });
        await createEgressLedger(claims);
        await reserveEgressUpload({
            grant: claims,
            fileId: 'file_a',
            bytes: 5,
        });

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

        const revokedTtl = await redis.ttl(
            `codeapi:egress:grant:${claims.grant_id}`,
        );
        expect(revokedTtl).toBeGreaterThan(30);

        await ensureEgressLedger(claims);
        await expectEgressError(
            () => assertEgressGrantActive(claims),
            'scope_mismatch',
        );
    });

    test('keeps concurrent WATCH mutations isolated on dedicated Redis connections', async () => {
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
                Array.from({ length: 8 }, (_, i) =>
                    reserveEgressUpload({
                        grant: claims,
                        fileId: `file_${i}`,
                        bytes: 1,
                    }),
                ),
            );
            await Promise.all(
                Array.from({ length: 4 }, (_, i) =>
                    reserveEgressUpload({
                        grant: claims,
                        fileId: `reuse_${i}`,
                        bytes: 1,
                    }),
                ),
            );

            const record = await assertEgressGrantActive(claims);
            expect(duplicateCount).toBe(8);
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
});
