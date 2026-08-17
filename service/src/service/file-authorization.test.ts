import { describe, expect, test } from 'bun:test';
import type * as t from '../types';
import {
    resolveSessionKey,
    resolveOutputBucketSessionKey,
    SessionKeyResolutionError,
} from '../session-key';
import {
    FileRefAuthorizationError,
    authorizeRequestedFiles,
    validateRequestedFiles,
} from './file-authorization';

const USER_ID = 'user_123';
const TENANT_ID = 'tenant_abc';
const SESSION_ID = 'sess_1234567890123456';
const FILE_ID = 'file_1234567890123456';
const RESOURCE_ID = 'rsrc_1234567890123456';
const SKILL_ID = 'skill_123456789012345';
const AGENT_ID = 'agent_123456789012345';

class FakeStore {
    private values = new Map<string, string>();

    set(key: string, value: string): void {
        this.values.set(key, value);
    }

    async get(key: string): Promise<string | null> {
        return this.values.get(key) ?? null;
    }

    async exists(key: string): Promise<number> {
        return this.values.has(key) ? 1 : 0;
    }
}

function request(authContext?: t.CodeApiAuthContext): t.AuthenticatedRequest {
    return { codeApiAuthContext: authContext } as t.AuthenticatedRequest;
}

/* `kind: 'user'` is the most permissive default — for tests that
 * aren't specifically about sharing semantics, we don't want the
 * fixture to trigger version requirements. Tests targeting skill or
 * agent semantics override `kind` (and `version` for skill). */
function validFile(overrides: Partial<t.RequestFile> = {}): t.RequestFile {
    return {
        id: FILE_ID,
        resource_id: RESOURCE_ID,
        storage_session_id: SESSION_ID,
        name: 'inputs/data.csv',
        kind: 'user',
        ...overrides,
    };
}

function ownedStore(sessionKey: string, file = validFile()): FakeStore {
    const store = new FakeStore();
    store.set(`session:${file.storage_session_id}`, sessionKey);
    store.set(
        `upload:${sessionKey}${file.storage_session_id}${file.id}`,
        'true',
    );
    return store;
}

async function expectAuthError(
    promise: Promise<unknown>,
    status: 400 | 403,
): Promise<void> {
    try {
        await promise;
        throw new Error('expected authorization error');
    } catch (err) {
        expect(err).toBeInstanceOf(FileRefAuthorizationError);
        expect((err as FileRefAuthorizationError).status).toBe(status);
    }
}

describe('validateRequestedFiles', () => {
    test('accepts canonical kind: user', () => {
        expect(validateRequestedFiles([validFile()])).toEqual([validFile()]);
    });

    test('accepts canonical kind: agent', () => {
        const f = validFile({ kind: 'agent', id: AGENT_ID });
        expect(validateRequestedFiles([f])).toEqual([f]);
    });

    test('accepts canonical kind: skill with version', () => {
        const f = validFile({ kind: 'skill', id: SKILL_ID, version: 7 });
        expect(validateRequestedFiles([f])).toEqual([f]);
    });

    test('rejects malformed ids', () => {
        expect(() =>
            validateRequestedFiles([validFile({ id: '../bad' })]),
        ).toThrow(FileRefAuthorizationError);
    });

    test('rejects path-like traversal names', () => {
        expect(() =>
            validateRequestedFiles([validFile({ name: '../secrets.txt' })]),
        ).toThrow(FileRefAuthorizationError);
        expect(() =>
            validateRequestedFiles([validFile({ name: 'dir//file.txt' })]),
        ).toThrow(FileRefAuthorizationError);
        expect(() =>
            validateRequestedFiles([validFile({ name: '/abs/file.txt' })]),
        ).toThrow(FileRefAuthorizationError);
    });

    test('rejects missing kind as 400', () => {
        const broken = {
            id: FILE_ID,
            resource_id: RESOURCE_ID,
            storage_session_id: SESSION_ID,
            name: 'x.csv',
        };
        expect(() => validateRequestedFiles([broken])).toThrow(
            /kind must be one of/,
        );
    });

    test('rejects unknown kind as 400', () => {
        const broken = {
            id: FILE_ID,
            resource_id: RESOURCE_ID,
            storage_session_id: SESSION_ID,
            name: 'x.csv',
            kind: 'system',
        };
        expect(() => validateRequestedFiles([broken])).toThrow(
            /kind must be one of/,
        );
    });

    test('rejects missing resource_id as 400', () => {
        /* Locks in the id-vs-resource_id split — the validator must
         * surface the missing field rather than letting it default to
         * the storage `id`. Pre-fix this would have collapsed both
         * fields onto a single value and silently broken sessionKey
         * resolution. */
        const broken = {
            id: FILE_ID,
            storage_session_id: SESSION_ID,
            name: 'x.csv',
            kind: 'user',
        };
        expect(() => validateRequestedFiles([broken])).toThrow(
            /resource_id is invalid/,
        );
    });

    test('accepts a 24-char Mongo ObjectId as resource_id (LibreChat skill _id shape)', () => {
        /* Regression: `isValidId` is the 21-char nanoid regex and rejects
         * Mongo ObjectIds (24-char hex). Skill `_id` flows through
         * `resource_id` from LC's primeInvokedSkills; rejecting it here
         * 400'd every shared-kind /exec authorization. `resource_id`
         * uses the looser `isValidResourceId` shape that admits the
         * heterogeneous upstream identity formats. */
        const skillObjectId = '69dcf561f37f717858d4d072'; // 24-char hex
        const file = validFile({
            kind: 'skill',
            resource_id: skillObjectId,
            version: 7,
        });
        expect(() => validateRequestedFiles([file])).not.toThrow();
    });

    test('accepts an agent slug (`agent_<nanoid>`) as resource_id', () => {
        const agentSlug = 'agent_abc12345678'; // 17-char with separator
        const file = validFile({ kind: 'agent', resource_id: agentSlug });
        expect(() => validateRequestedFiles([file])).not.toThrow();
    });

    test('still rejects whitespace / control chars in resource_id', () => {
        /* Loose ≠ none. The validator's job is to reject obvious garbage
         * before sessionKey resolution attempts to inject the value. */
        const whitespace = validFile({ resource_id: 'has space' });
        expect(() => validateRequestedFiles([whitespace])).toThrow(
            /resource_id is invalid/,
        );
    });

    test('rejects kind: skill without version as 400', () => {
        const broken = validFile({ kind: 'skill', id: SKILL_ID });
        expect(() => validateRequestedFiles([broken])).toThrow(
            /version is required/,
        );
    });

    test('rejects version on kind: agent as 400', () => {
        const broken = validFile({ kind: 'agent', id: AGENT_ID, version: 1 });
        expect(() => validateRequestedFiles([broken])).toThrow(
            /version is only valid/,
        );
    });

    test('rejects version on kind: user as 400', () => {
        const broken = validFile({ kind: 'user', version: 1 });
        expect(() => validateRequestedFiles([broken])).toThrow(
            /version is only valid/,
        );
    });

    /* Diagnostic context — the warn log lives or dies by `error.context`.
     * Pre-fix the validator threw context-free 400s, so log lines like
     * "files[0].resource_id is invalid" gave operators no offending value
     * to act on. These lock the contract. */
    test('attaches index, field, type, length, value to the rejection context', () => {
        const broken = validFile({ resource_id: 'has space' });
        try {
            validateRequestedFiles([broken]);
            throw new Error('expected rejection');
        } catch (err) {
            expect(err).toBeInstanceOf(FileRefAuthorizationError);
            const e = err as FileRefAuthorizationError;
            expect(e.context).toMatchObject({
                index: 0,
                field: 'resource_id',
                type: 'string',
                length: 9,
                value: 'has space',
            });
        }
    });

    test('non-string resource_id reports type only (no `value` leakage)', () => {
        const broken = { ...validFile(), resource_id: 123 } as unknown;
        try {
            validateRequestedFiles([broken]);
            throw new Error('expected rejection');
        } catch (err) {
            const e = err as FileRefAuthorizationError;
            expect(e.context.field).toBe('resource_id');
            expect(e.context.type).toBe('number');
            expect(e.context).not.toHaveProperty('value');
            expect(e.context).not.toHaveProperty('length');
        }
    });

    test('overlong string is sampled head…tail rather than dumped whole', () => {
        const longBad = `${'a'.repeat(100)} ${'b'.repeat(100)}`; // space → fails regex
        const broken = validFile({ resource_id: longBad });
        try {
            validateRequestedFiles([broken]);
            throw new Error('expected rejection');
        } catch (err) {
            const e = err as FileRefAuthorizationError;
            expect(e.context).not.toHaveProperty('value');
            expect(e.context.length).toBe(longBad.length);
            expect(typeof e.context.sample).toBe('string');
            expect((e.context.sample as string).length).toBeLessThan(
                longBad.length,
            );
        }
    });
});

describe('resolveSessionKey', () => {
    test('skill: <tenant>:skill:<id>:v:<version>', () => {
        const req = request({ tenantId: TENANT_ID, userId: USER_ID });
        const key = resolveSessionKey(req, {
            kind: 'skill',
            id: SKILL_ID,
            version: 7,
        });
        expect(key).toBe(`${TENANT_ID}:skill:${SKILL_ID}:v:7`);
    });

    test('agent: <tenant>:agent:<id> omits the user dimension', () => {
        const req = request({ tenantId: TENANT_ID, userId: USER_ID });
        const key = resolveSessionKey(req, { kind: 'agent', id: AGENT_ID });
        expect(key).toBe(`${TENANT_ID}:agent:${AGENT_ID}`);
    });

    test('user: <tenant>:user:<authContext.userId> ignores file.id', () => {
        const req = request({ tenantId: TENANT_ID, userId: USER_ID });
        const key = resolveSessionKey(req, {
            kind: 'user',
            id: 'whatever-not-used',
        });
        expect(key).toBe(`${TENANT_ID}:user:${USER_ID}`);
    });

    test('cross-tenant isolation: same skill in different tenants gets different sessionKeys', () => {
        const a = request({ tenantId: 'tenant_a', userId: USER_ID });
        const b = request({ tenantId: 'tenant_b', userId: USER_ID });
        const file = { kind: 'skill' as const, id: 'shared_skill', version: 1 };
        expect(resolveSessionKey(a, file)).not.toBe(resolveSessionKey(b, file));
    });

    test('within-tenant sharing: same skill, same tenant, different users -> same sessionKey', () => {
        const a = request({ tenantId: TENANT_ID, userId: 'user_a' });
        const b = request({ tenantId: TENANT_ID, userId: 'user_b' });
        const file = { kind: 'skill' as const, id: 'shared_skill', version: 1 };
        expect(resolveSessionKey(a, file)).toBe(resolveSessionKey(b, file));
    });

    test('tenant fallback in non-strict mode: missing tenantId -> "legacy"', () => {
        const req = request({ userId: USER_ID });
        const key = resolveSessionKey(req, {
            kind: 'skill',
            id: SKILL_ID,
            version: 1,
        });
        expect(key).toBe(`legacy:skill:${SKILL_ID}:v:1`);
    });

    test('skill version in sessionKey rotates on edit (cache invalidation)', () => {
        const req = request({ tenantId: TENANT_ID, userId: USER_ID });
        const v1 = resolveSessionKey(req, {
            kind: 'skill',
            id: SKILL_ID,
            version: 1,
        });
        const v2 = resolveSessionKey(req, {
            kind: 'skill',
            id: SKILL_ID,
            version: 2,
        });
        expect(v1).not.toBe(v2);
    });

    test('kind: user requires authContext.userId - throws 400 when missing', () => {
        const req = request({ tenantId: TENANT_ID, userId: '' });
        expect(() =>
            resolveSessionKey(req, { kind: 'user', id: 'whatever' }),
        ).toThrow(SessionKeyResolutionError);
    });
});

describe('resolveOutputBucketSessionKey', () => {
    test('hardcoded user-private regardless of any input kinds', () => {
        const req = request({ tenantId: TENANT_ID, userId: USER_ID });
        expect(resolveOutputBucketSessionKey(req)).toBe(
            `${TENANT_ID}:user:${USER_ID}`,
        );
    });

    test('cross-user skill execution does NOT produce a skill-scoped output bucket', () => {
        /* Behavioral regression: pre-Phase C, an exec call with entity_id
         * scoped the output bucket to that entity (so cross-user skill
         * outputs would share). Post-Phase C, output buckets are
         * user-private regardless of input file kinds — outputs always
         * belong to the requesting user. */
        const userA = request({ tenantId: TENANT_ID, userId: 'user_a' });
        const userB = request({ tenantId: TENANT_ID, userId: 'user_b' });
        expect(resolveOutputBucketSessionKey(userA)).not.toBe(
            resolveOutputBucketSessionKey(userB),
        );
    });

    test('throws 500 when authContext.userId is missing', () => {
        const req = request({ tenantId: TENANT_ID, userId: '' });
        expect(() => resolveOutputBucketSessionKey(req)).toThrow(
            SessionKeyResolutionError,
        );
    });
});

describe('authorizeRequestedFiles', () => {
    test('allows files owned by the resolved user sessionKey', async () => {
        const req = request({ tenantId: TENANT_ID, userId: USER_ID });
        const sessionKey = resolveSessionKey(req, {
            kind: 'user',
            id: USER_ID,
        });
        const store = ownedStore(sessionKey);

        await expect(
            authorizeRequestedFiles({
                req,
                files: [validFile()],
                store,
            }),
        ).resolves.toEqual([validFile()]);
    });

    test('allows files owned by the resolved skill sessionKey (cross-user-within-tenant sharing)', async () => {
        const userA = request({ tenantId: TENANT_ID, userId: 'user_a' });
        const userB = request({ tenantId: TENANT_ID, userId: 'user_b' });
        /* `id` is the storage file_id (FILE_ID); `resource_id` is the
         * skill identity (SKILL_ID) that drives the sessionKey. Pre-split
         * these were the same field — the conflation is what produced the
         * 403 mismatch the user hit when codeapi computed the sessionKey
         * from the storage nanoid instead of the skill _id. */
        const skillFile = validFile({
            kind: 'skill',
            resource_id: SKILL_ID,
            version: 7,
        });
        const sessionKey = resolveSessionKey(userA, {
            kind: 'skill',
            id: SKILL_ID,
            version: 7,
        });
        const store = ownedStore(sessionKey, skillFile);

        /* Both users in the same tenant resolve the same sessionKey for
         * this skill — that's the within-tenant sharing contract. */
        await expect(
            authorizeRequestedFiles({
                req: userB,
                files: [skillFile],
                store,
            }),
        ).resolves.toEqual([skillFile]);
    });

    test('rejects a foreign session before enqueue', async () => {
        const req = request({ tenantId: TENANT_ID, userId: USER_ID });
        const store = new FakeStore();
        store.set(`session:${SESSION_ID}`, 'someone-else');

        await expectAuthError(
            authorizeRequestedFiles({
                req,
                files: [validFile()],
                store,
            }),
            403,
        );
    });

    test('rejects a missing upload marker before enqueue', async () => {
        const req = request({ tenantId: TENANT_ID, userId: USER_ID });
        const sessionKey = resolveSessionKey(req, {
            kind: 'user',
            id: USER_ID,
        });
        const store = new FakeStore();
        store.set(`session:${SESSION_ID}`, sessionKey);

        await expectAuthError(
            authorizeRequestedFiles({
                req,
                files: [validFile()],
                store,
            }),
            403,
        );
    });

    test('cross-tenant isolation regression: same skill in different tenants is NOT shared', async () => {
        const tenantA = request({ tenantId: 'tenant_a', userId: USER_ID });
        const tenantB = request({ tenantId: 'tenant_b', userId: USER_ID });
        const skillFile = validFile({
            kind: 'skill',
            id: SKILL_ID,
            version: 1,
        });
        const tenantASessionKey = resolveSessionKey(tenantA, skillFile);
        const store = ownedStore(tenantASessionKey, skillFile);

        /* Tenant A uploaded the file; Tenant B's request derives a
         * different sessionKey from its tenant prefix and is rejected. */
        await expectAuthError(
            authorizeRequestedFiles({
                req: tenantB,
                files: [skillFile],
                store,
            }),
            403,
        );
    });

    test('mixed-kind execute: skill file + user attachment both authorize against their own keys', async () => {
        const req = request({ tenantId: TENANT_ID, userId: USER_ID });
        const userSessionId = 'sess_aaaa1111aaaa1111';
        const skillSessionId = 'sess_bbbb2222bbbb2222';
        const userFileId = 'file_user1234567890ab';
        const skillFileId = 'file_skill1234567890a';
        /* The skill RESOURCE id (e.g. mongo `_id`) — distinct from the
         * skill FILE storage id. Pre-split conflation of these two
         * caused the sessionKey re-derivation on `/exec` to use the
         * storage nanoid as the resource id and produce a mismatched
         * key. The split is what makes shared-kind authorization work. */
        const skillResourceId = 'rsrc_skill1234567890a';

        /* For `kind: 'user'` the resource_id is informational only —
         * sessionKey derives from auth context. The validator still
         * requires the field to satisfy `isValidId` (21 chars), so use
         * a synthetic 21-char id rather than the 8-char USER_ID
         * constant. */
        const userResourceId = 'rsrc_user1234567890ab';
        const userFile: t.RequestFile = {
            id: userFileId,
            resource_id: userResourceId,
            storage_session_id: userSessionId,
            name: 'inputs/user.csv',
            kind: 'user',
        };
        const skillFile: t.RequestFile = {
            id: skillFileId,
            resource_id: skillResourceId,
            storage_session_id: skillSessionId,
            name: 'inputs/skill.json',
            kind: 'skill',
            version: 3,
        };

        const userSessionKey = resolveSessionKey(req, {
            kind: 'user',
            id: USER_ID,
        });
        const skillSessionKey = resolveSessionKey(req, {
            kind: 'skill',
            id: skillResourceId,
            version: 3,
        });

        const store = new FakeStore();
        store.set(`session:${userSessionId}`, userSessionKey);
        store.set(
            `upload:${userSessionKey}${userSessionId}${userFileId}`,
            'true',
        );
        store.set(`session:${skillSessionId}`, skillSessionKey);
        store.set(
            `upload:${skillSessionKey}${skillSessionId}${skillFileId}`,
            'true',
        );

        await expect(
            authorizeRequestedFiles({
                req,
                files: [userFile, skillFile],
                store,
            }),
        ).resolves.toEqual([userFile, skillFile]);
    });
});
