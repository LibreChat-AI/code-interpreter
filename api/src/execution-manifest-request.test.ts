import { describe, expect, test } from 'bun:test';
import {
    EXECUTION_MANIFEST_VERSION,
    ExecutionManifestError,
    executionManifestBodySha256,
    type ExecutionManifestClaims,
    type ExecutionManifestErrorReason,
    signExecutionManifest,
    signExecutionManifestWithPrivateKey,
    verifyExecutionManifest,
} from './execution-manifest';
import {
    collectExecuteRequestInputFiles,
    verifyExecuteRequestManifest,
} from './execution-manifest-request';

const SECRET = 'test-secret';
const PRIVATE_KEY =
    'MC4CAQAwBQYDK2VwBCIEIBoxzSJjQ5jTVyuohHtlD+uDGqv/tZ6hQS2CmxuOg2Wn';
const PUBLIC_KEY =
    'MCowBQYDK2VwAyEAeY3PRoTS3adfU6E3gQUB5hSZdrdMSw6OrKkH4UhYh0U=';

function claims(
    overrides: Partial<ExecutionManifestClaims> = {},
): ExecutionManifestClaims {
    return {
        v: EXECUTION_MANIFEST_VERSION,
        exec_id: 'exec_123',
        tenant_id: 'tenant_abc',
        user_id: 'user_123',
        session_key: 'tenant:tenant_abc:user:user_123',
        input_files: [
            {
                id: 'file_123',
                session_id: 'sess_input',
                name: 'inputs/data.csv',
            },
        ],
        read_sessions: ['sess_input'],
        output_session_id: 'sess_output',
        max_upload_bytes: 1024,
        max_output_files: 10,
        max_requests: 50,
        iat: 100,
        exp: 200,
        principal_source: 'librechat',
        ...overrides,
    };
}

const body = {
    session_id: 'sess_output',
    files: [
        { name: 'main.py', content: 'print(1)' },
        {
            id: 'file_123',
            storage_session_id: 'sess_input',
            name: 'inputs/data.csv',
        },
    ],
};

function claimsForBody(
    requestBody: unknown,
    overrides: Partial<ExecutionManifestClaims> = {},
): ExecutionManifestClaims {
    return claims({
        execute_body_sha256: executionManifestBodySha256(requestBody),
        ...overrides,
    });
}

function signedBody<T extends Record<string, unknown>>(
    requestBody: T,
    overrides: Partial<ExecutionManifestClaims> = {},
): { bodyWithManifest: T & { execution_manifest: string }; token: string } {
    const token = signExecutionManifest(
        claimsForBody(requestBody, overrides),
        SECRET,
    );
    return {
        bodyWithManifest: { ...requestBody, execution_manifest: token },
        token,
    };
}

function expectManifestError(
    fn: () => unknown,
    reason: ExecutionManifestErrorReason,
): void {
    try {
        fn();
        throw new Error('expected manifest error');
    } catch (error) {
        expect(error).toBeInstanceOf(ExecutionManifestError);
        expect((error as ExecutionManifestError).reason).toBe(reason);
    }
}

describe('execute request manifest validation', () => {
    test('accepts a signed manifest whose file and output-session scope matches the request', () => {
        const matchingClaims = claimsForBody(body);
        const token = signExecutionManifest(matchingClaims, SECRET);

        expect(collectExecuteRequestInputFiles(body)).toEqual([
            {
                id: 'file_123',
                session_id: 'sess_input',
                name: 'inputs/data.csv',
            },
        ]);
        expect(
            verifyExecuteRequestManifest({
                headerValue: token,
                secret: SECRET,
                body,
                nowSeconds: 150,
            }),
        ).toEqual(matchingClaims);
    });

    test('accepts an asymmetric manifest with only the public verifier key', () => {
        const matchingClaims = claimsForBody(body);
        const token = signExecutionManifestWithPrivateKey(
            matchingClaims,
            PRIVATE_KEY,
        );

        expect(
            verifyExecuteRequestManifest({
                headerValue: token,
                publicKey: PUBLIC_KEY,
                body,
                nowSeconds: 150,
            }),
        ).toEqual(matchingClaims);
    });

    test('preserves the legacy HMAC verifier fallback when no public key is configured', () => {
        const matchingClaims = claimsForBody(body);
        const token = signExecutionManifest(matchingClaims, SECRET);

        expect(
            verifyExecuteRequestManifest({
                headerValue: token,
                publicKey: '',
                secret: SECRET,
                body,
                nowSeconds: 150,
            }),
        ).toEqual(matchingClaims);
    });

    test('falls back to legacy HMAC when both verifier modes are configured during rollout', () => {
        const matchingClaims = claimsForBody(body);
        const token = signExecutionManifest(matchingClaims, SECRET);

        expect(
            verifyExecuteRequestManifest({
                headerValue: token,
                publicKey: PUBLIC_KEY,
                secret: SECRET,
                body,
                nowSeconds: 150,
            }),
        ).toEqual(matchingClaims);
    });

    test('includes id refs that rely on runtime defaults in the signed scope check', () => {
        const bodyWithDefaultedRefs = {
            session_id: 'sess_output',
            files: [
                { name: 'main.py', content: 'print(1)' },
                { id: 'file_same_session', name: 'inputs/current.csv' },
                { id: 'file_default_name' },
            ],
        } as unknown as Parameters<typeof collectExecuteRequestInputFiles>[0];

        expect(collectExecuteRequestInputFiles(bodyWithDefaultedRefs)).toEqual([
            {
                id: 'file_default_name',
                session_id: 'sess_output',
                name: 'file2.code',
            },
            {
                id: 'file_same_session',
                session_id: 'sess_output',
                name: 'inputs/current.csv',
            },
        ]);

        expectManifestError(
            () =>
                verifyExecuteRequestManifest({
                    headerValue: signExecutionManifest(
                        claimsForBody(bodyWithDefaultedRefs, {
                            input_files: [],
                            read_sessions: [],
                        }),
                        SECRET,
                    ),
                    secret: SECRET,
                    body: bodyWithDefaultedRefs,
                    nowSeconds: 150,
                }),
            'scope_mismatch',
        );

        const matchingClaims = claimsForBody(bodyWithDefaultedRefs, {
            input_files: [
                {
                    id: 'file_same_session',
                    session_id: 'sess_output',
                    name: 'inputs/current.csv',
                },
                {
                    id: 'file_default_name',
                    session_id: 'sess_output',
                    name: 'file2.code',
                },
            ],
            read_sessions: ['sess_output'],
        });

        expect(
            verifyExecuteRequestManifest({
                headerValue: signExecutionManifest(matchingClaims, SECRET),
                secret: SECRET,
                body: bodyWithDefaultedRefs,
                nowSeconds: 150,
            }),
        ).toEqual(matchingClaims);
    });

    test('rejects missing, wrong-session, wrong-file, and expired manifests', () => {
        expectManifestError(
            () =>
                verifyExecuteRequestManifest({
                    headerValue: undefined,
                    secret: SECRET,
                    body,
                    nowSeconds: 150,
                }),
            'missing_header',
        );

        expectManifestError(
            () =>
                verifyExecuteRequestManifest({
                    headerValue: signExecutionManifest(
                        claimsForBody(body, {
                            output_session_id: 'other_output',
                        }),
                        SECRET,
                    ),
                    secret: SECRET,
                    body,
                    nowSeconds: 150,
                }),
            'scope_mismatch',
        );

        expectManifestError(
            () =>
                verifyExecuteRequestManifest({
                    headerValue: signExecutionManifest(
                        claimsForBody(body, {
                            input_files: [
                                {
                                    id: 'file_other',
                                    session_id: 'sess_input',
                                    name: 'inputs/data.csv',
                                },
                            ],
                        }),
                        SECRET,
                    ),
                    secret: SECRET,
                    body,
                    nowSeconds: 150,
                }),
            'scope_mismatch',
        );

        expectManifestError(
            () =>
                verifyExecuteRequestManifest({
                    headerValue: signExecutionManifest(
                        claimsForBody(body),
                        SECRET,
                    ),
                    secret: SECRET,
                    body,
                    nowSeconds: 1000,
                }),
            'expired',
        );
    });

    test('rejects duplicated request files that do not exactly match manifest multiplicity', () => {
        const duplicateBody = {
            session_id: 'sess_output',
            files: [
                {
                    id: 'file_123',
                    storage_session_id: 'sess_input',
                    name: 'inputs/data.csv',
                },
                {
                    id: 'file_123',
                    storage_session_id: 'sess_input',
                    name: 'inputs/data.csv',
                },
            ],
        };
        const token = signExecutionManifest(
            claims({
                execute_body_sha256: executionManifestBodySha256(duplicateBody),
                input_files: [
                    {
                        id: 'file_123',
                        session_id: 'sess_input',
                        name: 'inputs/data.csv',
                    },
                    {
                        id: 'file_other',
                        session_id: 'sess_input',
                        name: 'inputs/other.csv',
                    },
                ],
            }),
            SECRET,
        );

        expectManifestError(
            () =>
                verifyExecuteRequestManifest({
                    headerValue: token,
                    secret: SECRET,
                    body: duplicateBody,
                    nowSeconds: 150,
                }),
            'scope_mismatch',
        );
    });

    test('rejects extra manifest read sessions beyond the request file scope', () => {
        const token = signExecutionManifest(
            claimsForBody(body, {
                read_sessions: ['sess_input', 'sess_extra'],
            }),
            SECRET,
        );

        expectManifestError(
            () =>
                verifyExecuteRequestManifest({
                    headerValue: token,
                    secret: SECRET,
                    body,
                    nowSeconds: 150,
                }),
            'scope_mismatch',
        );
    });

    test('accepts scoped legacy manifests during the body-hash rollout grace window', () => {
        const legacyClaims = claims();
        const token = signExecutionManifest(legacyClaims, SECRET);

        expect(
            verifyExecuteRequestManifest({
                headerValue: token,
                secret: SECRET,
                body,
                nowSeconds: 150,
                bodyHashRequiredAfterSeconds: 200,
            }),
        ).toEqual(legacyClaims);
    });

    test('never admits input cache selectors through the legacy no-body-hash grace', () => {
        const cachedBody = {
            ...body,
            files: [
                body.files[0],
                { ...body.files[1], input_cache_key: 'a'.repeat(64) },
            ],
        };
        expectManifestError(
            () =>
                verifyExecuteRequestManifest({
                    headerValue: signExecutionManifest(claims(), SECRET),
                    secret: SECRET,
                    body: cachedBody,
                    nowSeconds: 150,
                    bodyHashRequiredAfterSeconds: 200,
                }),
            'scope_mismatch',
        );
    });

    test('rejects scoped legacy manifests after the body-hash rollout grace window', () => {
        expectManifestError(
            () =>
                verifyExecuteRequestManifest({
                    headerValue: signExecutionManifest(claims(), SECRET),
                    secret: SECRET,
                    body,
                    nowSeconds: 200,
                    bodyHashRequiredAfterSeconds: 200,
                }),
            'scope_mismatch',
        );
    });

    test('rejects manifests that do not bind the request body', () => {
        expectManifestError(
            () =>
                verifyExecuteRequestManifest({
                    headerValue: signExecutionManifest(claims(), SECRET),
                    secret: SECRET,
                    body,
                    nowSeconds: 150,
                }),
            'scope_mismatch',
        );
    });

    test('rejects replayed inline-only manifests with substituted executable payloads', () => {
        const originalBody = {
            session_id: 'sess_output',
            language: 'python',
            version: '3.12.0',
            files: [{ name: 'main.py', content: 'print("authorized")' }],
        };
        const { bodyWithManifest, token } = signedBody(originalBody, {
            input_files: [],
            read_sessions: [],
        });

        expect(
            verifyExecuteRequestManifest({
                headerValue: token,
                secret: SECRET,
                body: bodyWithManifest,
                nowSeconds: 150,
            }),
        ).toEqual(
            claimsForBody(originalBody, {
                input_files: [],
                read_sessions: [],
            }),
        );

        const substitutedBody = {
            ...originalBody,
            execution_manifest: token,
            language: 'bash',
            version: '5.2.0',
            args: ['--changed'],
            stdin: 'attacker controlled stdin',
            env_vars: { EXFIL_TARGET: 'https://example.invalid' },
            files: [{ name: 'main.sh', content: 'cat /mnt/data/*' }],
        };

        expectManifestError(
            () =>
                verifyExecuteRequestManifest({
                    headerValue: token,
                    secret: SECRET,
                    body: substitutedBody,
                    nowSeconds: 150,
                }),
            'scope_mismatch',
        );
    });

    test('rejects replayed manifests when file references match but code changes', () => {
        const { bodyWithManifest, token } = signedBody(body);
        const substitutedBody = {
            ...body,
            execution_manifest: token,
            language: 'bash',
            version: '5.2.0',
            args: ['changed'],
            stdin: 'changed stdin',
            env_vars: { CHANGED: '1' },
            files: [
                { name: 'main.py', content: 'print(2)' },
                {
                    id: 'file_123',
                    storage_session_id: 'sess_input',
                    name: 'inputs/data.csv',
                },
            ],
        };

        expect(
            verifyExecuteRequestManifest({
                headerValue: token,
                secret: SECRET,
                body: bodyWithManifest,
                nowSeconds: 150,
            }),
        ).toEqual(claimsForBody(body));

        expectManifestError(
            () =>
                verifyExecuteRequestManifest({
                    headerValue: token,
                    secret: SECRET,
                    body: substitutedBody,
                    nowSeconds: 150,
                }),
            'scope_mismatch',
        );
    });

    test('rejects non-base64url manifest parts as malformed', () => {
        const token = signExecutionManifest(claims(), SECRET);
        const [payload, signature] = token.split('.') as [string, string];

        expectManifestError(
            () =>
                verifyExecutionManifest(
                    `${payload}!comment.${signature}`,
                    SECRET,
                    {
                        nowSeconds: 150,
                    },
                ),
            'malformed',
        );
    });
});
