/**
 * Shared PTC replay constants. Isolated in its own module so both
 * `preamble.ts` (Python) and `preamble-bash.ts` (bash) can import from a
 * single leaf, avoiding the circular dependency that would otherwise form
 * if `preamble-bash.ts` imported constants from `preamble.ts`.
 */

/** Relative filename of the replay history file written into the sandbox. */
export const PTC_HISTORY_FILENAME = '_ptc_history.json';

/** Absolute path inside the sandbox (`submissionDir` is bind-mounted at `/mnt/data`). */
export const PTC_HISTORY_SANDBOX_PATH = `/mnt/data/${PTC_HISTORY_FILENAME}`;

/**
 * Returns `true` for any filename the submission layer must refuse.
 *
 * Two things make a name "reserved":
 *   1. Its post-normalization basename is `_ptc_history.json` — the single
 *      runtime fixture the replay preamble injects into the submission dir.
 *      Any user-supplied file with that exact basename would shadow our
 *      injected history and silently corrupt replay correctness, so we
 *      reject it on the request path. The bash preamble's `_ptc_pending.*`
 *      and `_ptc_counter.*` tempfiles live in `/tmp` and never reach the
 *      submission dir, so the wider `_ptc_*` prefix the previous version
 *      rejected was overreach: it broke legitimate user inputs like
 *      `_ptc_data.csv` that don't conflict with anything we write.
 *   2. The path tries to escape the submission directory via leading `../`
 *      after normalization. Traversal rejection lives here because any
 *      file that resolves to `_ptc_history.json` post-traversal would
 *      still clobber the runtime fixture, and factoring the two checks
 *      apart would let a caller smuggle one past the other.
 *
 * Normalization folds backslashes to `/`, drops empty and `.` segments,
 * resolves `..` by popping the accumulated path, and flags the name as
 * escaping if any `..` is applied below the root. The comparison is
 * against the basename of the resulting path.
 *
 * Examples (all return `true`):
 *   `_ptc_history.json`, `sub/../_ptc_history.json`,
 *   `..\\etc\\passwd`, `../../x.txt`.
 *
 * Examples (all return `false`):
 *   `_ptc_data.csv`, `_ptc_counter.XXXXXX`, `notes_ptc_history.json`.
 */
export function isReservedPtcFilename(name: string): boolean {
    if (typeof name !== 'string' || name.length === 0) return false;
    const unified = name.replace(/\\/g, '/');
    const segments: string[] = [];
    let escapes = false;
    for (const seg of unified.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
            if (segments.length === 0) {
                escapes = true;
            } else {
                segments.pop();
            }
            continue;
        }
        segments.push(seg);
    }
    if (escapes) return true;
    const basename = segments.length > 0 ? segments[segments.length - 1] : '';
    return basename === PTC_HISTORY_FILENAME;
}

/**
 * Sentinel prefixes used by replay-mode preambles to emit pending tool calls on
 * stdout. The actual markers emitted at runtime include the execution id so
 * user code cannot forge a well-formed sentinel block by printing the raw
 * literals. Keep in sync with `extractPendingFromStdout`.
 */
export const PTC_SENTINEL_START_PREFIX = '__PTC_PENDING_V1_START__';
export const PTC_SENTINEL_END_PREFIX = '__PTC_PENDING_V1_END__';

/** Charset for execution ids. Enforced before interpolation into generated code. */
const EXECUTION_ID_CHARSET = /^[A-Za-z0-9_-]{1,128}$/;

/** Returns execution-scoped sentinel markers. Rejects invalid execution ids. */
export function buildScopedSentinel(executionId: string): {
    start: string;
    end: string;
} {
    if (!EXECUTION_ID_CHARSET.test(executionId)) {
        throw new Error(
            `executionId "${executionId}" contains invalid characters`,
        );
    }
    return {
        start: `${PTC_SENTINEL_START_PREFIX}__${executionId}`,
        end: `${PTC_SENTINEL_END_PREFIX}__${executionId}`,
    };
}
