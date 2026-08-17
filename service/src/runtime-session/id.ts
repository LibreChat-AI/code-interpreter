import { createHash } from 'crypto';

export const RUNTIME_SESSION_HINT_MAX_LENGTH = 128;
const RUNTIME_SESSION_HINT_PATTERN = /^[A-Za-z0-9._:-]+$/;
const DEFAULT_HINT = 'default';

export class RuntimeSessionHintError extends Error {
    readonly status = 400;
    constructor(message: string) {
        super(message);
        this.name = 'RuntimeSessionHintError';
    }
}

/** Normalizes the client-supplied hint: absent/empty ⇒ undefined, malformed ⇒ 400. */
export function validateRuntimeSessionHint(hint: unknown): string | undefined {
    if (hint == null) return undefined;
    if (typeof hint !== 'string') {
        throw new RuntimeSessionHintError(
            'runtime_session_hint must be a string',
        );
    }
    if (hint.length === 0) return undefined;
    if (hint.length > RUNTIME_SESSION_HINT_MAX_LENGTH) {
        throw new RuntimeSessionHintError(
            `runtime_session_hint must be at most ${RUNTIME_SESSION_HINT_MAX_LENGTH} characters`,
        );
    }
    if (!RUNTIME_SESSION_HINT_PATTERN.test(hint)) {
        throw new RuntimeSessionHintError(
            'runtime_session_hint may only contain letters, digits, ".", "_", ":", and "-"',
        );
    }
    return hint;
}

/**
 * Server-derived runtime session identity. The namespace and user come from
 * `getExecutionIdentity(req)` — never the client — so a hint can never
 * collide across tenants or users. The hint only partitions sessions within
 * one (tenant, user) scope.
 */
export function deriveRuntimeSessionId(args: {
    storageNamespace: string;
    canonicalUserId: string;
    hint?: string;
}): string {
    const fields = [
        args.storageNamespace,
        args.canonicalUserId,
        args.hint ?? DEFAULT_HINT,
    ];
    /* Preserve the established IDs for ordinary principals so a rolling deploy
     * does not abandon their warm VMs/checkpoints. If an authenticated identity
     * contains the legacy NUL delimiter, switch that identity to an injective
     * encoding. JSON escapes NUL, so the v2 material cannot equal legacy
     * material (which always contains two raw NUL bytes). */
    const material = fields.some(field => field.includes('\u0000'))
        ? `v2:${JSON.stringify(fields)}`
        : fields.join('\u0000');
    return `rt_${createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 40)}`;
}

/**
 * Router-side gate: stateless mode never derives a runtime session, and a
 * request WITHOUT a hint never lands on a session either — deriving from the
 * default hint would silently share one persistent per-user workspace across
 * every hintless conversation, contradicting the caller's toggle-off
 * expectation. Affinity degrades the hintless request to a stateless one-shot;
 * strict mode rejects it, since the caller asked for guaranteed session
 * semantics it failed to identify.
 */
export function resolveRuntimeSessionIdForRequest(args: {
    mode: 'stateless' | 'affinity' | 'strict';
    storageNamespace: string;
    canonicalUserId: string;
    hint?: string;
}): string | undefined {
    if (args.mode === 'stateless') return undefined;
    if (args.hint == null || args.hint === '') {
        if (args.mode === 'strict') {
            throw new RuntimeSessionHintError(
                'runtime_session_hint is required in strict mode',
            );
        }
        return undefined;
    }
    return deriveRuntimeSessionId(args);
}

/**
 * `/exec`-specific resolution boundary. Synthetic probes are deliberately
 * sessionless, so they must bypass both strict-mode hint requirements and
 * validation of a hint that will never be consumed. Stateless mode has the
 * same ignore-don't-validate contract.
 */
export function resolveRuntimeSessionIdForExecRequest(args: {
    mode: 'stateless' | 'affinity' | 'strict';
    storageNamespace: string;
    canonicalUserId: string;
    runtimeSessionHint: unknown;
    isSynthetic: boolean;
}): string | undefined {
    if (args.isSynthetic || args.mode === 'stateless') return undefined;
    return resolveRuntimeSessionIdForRequest({
        mode: args.mode,
        storageNamespace: args.storageNamespace,
        canonicalUserId: args.canonicalUserId,
        hint: validateRuntimeSessionHint(args.runtimeSessionHint),
    });
}
