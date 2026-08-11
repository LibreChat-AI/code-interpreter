import type { LCTool } from './preamble';
import {
  buildScopedSentinel,
  PTC_HISTORY_SANDBOX_PATH,
} from './ptc-constants';

export interface BashReplayPreambleConfig {
  executionId: string;
  tools: LCTool[];
}

/** Detect tools whose names normalize to the same bash function
 * identifier. Returns the first colliding pair, or null if none.
 * Used by the router to surface a 400 before the job is enqueued
 * rather than letting the preamble generator throw mid-run. */
export function findBashToolNameCollision(
  tools: readonly LCTool[],
): { firstName: string; secondName: string; normalized: string } | null {
  const seen = new Map<string, string>();
  for (const tool of tools) {
    const normalized = normalizeBashFunctionName(tool.name);
    const prior = seen.get(normalized);
    if (prior !== undefined && prior !== tool.name) {
      return { firstName: prior, secondName: tool.name, normalized };
    }
    seen.set(normalized, tool.name);
  }
  return null;
}

export class BashToolNameCollisionError extends Error {
  constructor(
    public readonly firstName: string,
    public readonly secondName: string,
    public readonly normalized: string,
  ) {
    super(
      `Bash tool names "${firstName}" and "${secondName}" both normalize to the same function identifier "${normalized}"; rename one to avoid collision`,
    );
    this.name = 'BashToolNameCollisionError';
  }
}

const BASH_RESERVED = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select',
  'while', 'until', 'do', 'done', 'in', 'function', 'time', 'coproc',
  'return', 'exit', 'break', 'continue', 'shift', 'export', 'readonly',
  'local', 'declare', 'typeset', 'unset', 'alias', 'unalias', 'source',
  'echo', 'printf', 'read', 'cd', 'pwd', 'kill', 'trap', 'wait', 'eval',
  'exec', 'jobs', 'bg', 'fg', 'set', 'let', 'test', 'true', 'false',
]);

function normalizeBashFunctionName(name: string): string {
  let normalized = name.replace(/[-\s.]/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
  if (/^[0-9]/.test(normalized)) normalized = '_' + normalized;
  /** Reserve the entire `_ptc_` / `_PTC_` helper namespace so user-supplied
   * tool names can never normalize onto an internal function or variable
   * identifier (e.g. `_ptc_maybe_emit_pending`, `_PTC_HISTORY_PATH`). A
   * colliding stub would otherwise overwrite the internal helper before
   * the end-of-preamble `readonly -f` lockdown runs. Compared case-
   * insensitively because the `_PTC_` prefix is used for variables and
   * `_ptc_` for functions, and both live in the same identifier space. */
  if (
    BASH_RESERVED.has(normalized) ||
    /^_ptc_/i.test(normalized)
  ) {
    normalized = normalized + '_tool';
  }
  if (normalized === '') normalized = 'tool';
  return normalized;
}

/** Escape a string so it is safe to embed inside a bash double-quoted literal. */
function escapeForBashDoubleQuote(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
}

/** Escape a string so it is safe inside a bash extended regular expression. */
function escapeForBashEre(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * Replay-mode bash preamble. The script reads the replay history from
 * `/mnt/data/_ptc_history.json`, dispatches each tool call through
 * `_ptc_call_tool`, and uses DEBUG + EXIT traps so that tool calls made
 * inside command substitution (e.g. `result=$(my_tool '{"x":1}')`) still
 * surface the sentinel on the main shell's stdout before the script exits.
 *
 * Caveat: bash is inherently sequential, so only one tool call per round trip.
 * Users capture results via command substitution; input is passed as a single
 * JSON object string argument (validated by jq).
 */
export function generateBashReplayPreamble(config: BashReplayPreambleConfig): string {
  const { executionId, tools } = config;
  const { start: scopedStart, end: scopedEnd } = buildScopedSentinel(executionId);

  let preamble = `#!/bin/bash
# ============================================================================
# PROGRAMMATIC TOOL CALLING INFRASTRUCTURE (bash, replay mode)
# Auto-generated - do not modify
# ============================================================================

_PTC_EXECUTION_ID="${executionId}"
_PTC_SENTINEL_START="${scopedStart}"
_PTC_SENTINEL_END="${scopedEnd}"
_PTC_HISTORY_PATH="\${PTC_HISTORY_PATH:-${PTC_HISTORY_SANDBOX_PATH}}"
_PTC_PENDING_FILE="$(mktemp -t _ptc_pending.XXXXXX 2>/dev/null || mktemp /tmp/_ptc_pending.XXXXXX)"
_PTC_ERROR_FILE="$(mktemp -t _ptc_error.XXXXXX 2>/dev/null || mktemp /tmp/_ptc_error.XXXXXX)"
_PTC_CONSUMED_FILE="$(mktemp -t _ptc_consumed.XXXXXX 2>/dev/null || mktemp /tmp/_ptc_consumed.XXXXXX)"
_PTC_SAW_BARE_TOOL_FILE="$(mktemp -t _ptc_saw_tool.XXXXXX 2>/dev/null || mktemp /tmp/_ptc_saw_tool.XXXXXX)"
_PTC_PRE_TOOL_JOBS_FILE="$(mktemp -t _ptc_pre_tool_jobs.XXXXXX 2>/dev/null || mktemp /tmp/_ptc_pre_tool_jobs.XXXXXX)"
_PTC_PRE_TOOL_JOBS_READY_FILE="$(mktemp -t _ptc_pre_tool_jobs_ready.XXXXXX 2>/dev/null || mktemp /tmp/_ptc_pre_tool_jobs_ready.XXXXXX)"
_PTC_TOOL_JOBS_FILE="$(mktemp -t _ptc_tool_jobs.XXXXXX 2>/dev/null || mktemp /tmp/_ptc_tool_jobs.XXXXXX)"
_PTC_WAIT_RAN_FILE="$(mktemp -t _ptc_wait_ran.XXXXXX 2>/dev/null || mktemp /tmp/_ptc_wait_ran.XXXXXX)"
_PTC_SUPPRESS_SUBSHELL_TOOL_FILE="$(mktemp -t _ptc_suppress_subshell_tool.XXXXXX 2>/dev/null || mktemp /tmp/_ptc_suppress_subshell_tool.XXXXXX)"
_PTC_SUPPRESS_SUBSHELL_TOOL_CLEAR_FILE="$(mktemp -t _ptc_suppress_subshell_tool_clear.XXXXXX 2>/dev/null || mktemp /tmp/_ptc_suppress_subshell_tool_clear.XXXXXX)"
# Counter must persist across subshells (command substitution) so call_ids
# stay deterministic across cached/uncached calls. Bash variables set in a
# subshell don't propagate back, so we use a file.
_PTC_COUNTER_FILE="$(mktemp -t _ptc_counter.XXXXXX 2>/dev/null || mktemp /tmp/_ptc_counter.XXXXXX)"
_PTC_LOCK_DIR="\${_PTC_PENDING_FILE}.lock"
printf '0' > "$_PTC_COUNTER_FILE"
: > "$_PTC_CONSUMED_FILE"
: > "$_PTC_PRE_TOOL_JOBS_FILE"
: > "$_PTC_PRE_TOOL_JOBS_READY_FILE"
: > "$_PTC_TOOL_JOBS_FILE"
: > "$_PTC_WAIT_RAN_FILE"
: > "$_PTC_SUPPRESS_SUBSHELL_TOOL_FILE"
: > "$_PTC_SUPPRESS_SUBSHELL_TOOL_CLEAR_FILE"

_ptc_cleanup_tempfiles() {
    rm -f "$_PTC_PENDING_FILE" "$_PTC_ERROR_FILE" "$_PTC_CONSUMED_FILE" "$_PTC_SAW_BARE_TOOL_FILE" "$_PTC_PRE_TOOL_JOBS_FILE" "$_PTC_PRE_TOOL_JOBS_READY_FILE" "$_PTC_TOOL_JOBS_FILE" "$_PTC_WAIT_RAN_FILE" "$_PTC_SUPPRESS_SUBSHELL_TOOL_FILE" "$_PTC_SUPPRESS_SUBSHELL_TOOL_CLEAR_FILE" "$_PTC_COUNTER_FILE" 2>/dev/null
    rmdir "$_PTC_LOCK_DIR" 2>/dev/null || true
}

_ptc_acquire_lock() {
    local _ptc_i=0
    while ! mkdir "$_PTC_LOCK_DIR" 2>/dev/null; do
        _ptc_i=$((_ptc_i + 1))
        if [ "$_ptc_i" -gt 1000 ]; then
            printf 'timed out waiting for PTC tool-call lock\\n' > "$_PTC_ERROR_FILE"
            return 1
        fi
        sleep 0.01
    done
    return 0
}

_ptc_release_lock() {
    rmdir "$_PTC_LOCK_DIR" 2>/dev/null || true
}

_ptc_write_error() {
    printf '%s\\n' "$1" > "$_PTC_ERROR_FILE"
}

_ptc_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum | awk '{print $1}'
        return $?
    fi
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 | awk '{print $1}'
        return $?
    fi
    if command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 -r | awk '{print $1}'
        return $?
    fi
    return 1
}

_ptc_hash_input() {
    local _ptc_canonical
    _ptc_canonical=$(printf '%s' "$1" | jq -cS . 2>/dev/null) || return 1
    printf '%s' "$_ptc_canonical" | _ptc_sha256
}

_ptc_contains_command_substitution() {
    local _ptc_cmd="$1"
    local _ptc_cmdsub_re='[$][(][^(]'
    if [[ "$_ptc_cmd" =~ $_ptc_cmdsub_re ]]; then
        return 0
    fi
    case "$_ptc_cmd" in
        *\\${'`'}*) return 0 ;;
    esac
    return 1
}

_ptc_record_tool_job_pid() {
    local _ptc_pid="$1"
    [ -n "$_ptc_pid" ] || return 0
    if ! grep -Fxq "$_ptc_pid" "$_PTC_TOOL_JOBS_FILE" 2>/dev/null; then
        printf '%s\\n' "$_ptc_pid" >> "$_PTC_TOOL_JOBS_FILE"
    fi
}

_ptc_record_matching_background_tool_jobs() {
    declare -F _ptc_contains_tool_command >/dev/null 2>&1 || return 0
    # Bash DEBUG traps do not fire before a background compound command like
    # \`(sleep 1; tool ... ) &\`, so inspect the job table after launch.
    jobs -l 2>/dev/null | while IFS= read -r _ptc_job; do
        [ -n "$_ptc_job" ] || continue
        _ptc_contains_tool_command "$_ptc_job" || continue
        local _ptc_pid
        _ptc_pid=$(printf '%s\\n' "$_ptc_job" | awk '{print $2}')
        [[ "$_ptc_pid" =~ ^[0-9]+$ ]] || continue
        _ptc_record_tool_job_pid "$_ptc_pid"
    done
}

_ptc_record_launched_tool_jobs() {
    _ptc_record_matching_background_tool_jobs
    if [ ! -s "$_PTC_PRE_TOOL_JOBS_READY_FILE" ]; then
        return 0
    fi
    local _ptc_last_bg_pid="$!"
    if [ -n "$_ptc_last_bg_pid" ] && ! grep -Fxq "$_ptc_last_bg_pid" "$_PTC_PRE_TOOL_JOBS_FILE" 2>/dev/null && ! grep -Fxq "$_ptc_last_bg_pid" "$_PTC_TOOL_JOBS_FILE" 2>/dev/null; then
        _ptc_record_tool_job_pid "$_ptc_last_bg_pid"
    fi
    local _ptc_current_jobs
    _ptc_current_jobs="$(jobs -p 2>/dev/null || true)"
    if [ -n "$_ptc_current_jobs" ]; then
        printf '%s\\n' "$_ptc_current_jobs" | while IFS= read -r _ptc_pid; do
            [ -n "$_ptc_pid" ] || continue
            if ! grep -Fxq "$_ptc_pid" "$_PTC_PRE_TOOL_JOBS_FILE" 2>/dev/null && ! grep -Fxq "$_ptc_pid" "$_PTC_TOOL_JOBS_FILE" 2>/dev/null; then
                _ptc_record_tool_job_pid "$_ptc_pid"
            fi
        done
    fi
    : > "$_PTC_PRE_TOOL_JOBS_FILE"
    : > "$_PTC_PRE_TOOL_JOBS_READY_FILE"
}

_ptc_prune_finished_tool_jobs() {
    if [ ! -s "$_PTC_TOOL_JOBS_FILE" ]; then
        return 0
    fi
    local _ptc_tmp_file
    _ptc_tmp_file="$(mktemp -t _ptc_tool_jobs_live.XXXXXX 2>/dev/null || mktemp /tmp/_ptc_tool_jobs_live.XXXXXX)"
    while IFS= read -r _ptc_pid; do
        [ -n "$_ptc_pid" ] || continue
        if kill -0 "$_ptc_pid" 2>/dev/null; then
            printf '%s\\n' "$_ptc_pid" >> "$_ptc_tmp_file"
        fi
    done < "$_PTC_TOOL_JOBS_FILE"
    mv "$_ptc_tmp_file" "$_PTC_TOOL_JOBS_FILE"
}

_ptc_wait_for_tracked_tool_jobs() {
    if [ ! -s "$_PTC_TOOL_JOBS_FILE" ]; then
        return 0
    fi
    while IFS= read -r _ptc_pid; do
        [ -n "$_ptc_pid" ] || continue
        wait "$_ptc_pid" 2>/dev/null || true
    done < "$_PTC_TOOL_JOBS_FILE"
    : > "$_PTC_TOOL_JOBS_FILE"
}

_ptc_note_bare_tool_command() {
    printf '1' > "$_PTC_SAW_BARE_TOOL_FILE"
    printf '1' > "$_PTC_PRE_TOOL_JOBS_READY_FILE"
    jobs -p > "$_PTC_PRE_TOOL_JOBS_FILE" 2>/dev/null || : > "$_PTC_PRE_TOOL_JOBS_FILE"
}

_ptc_note_subshell_tool_command() {
    if [ -s "$_PTC_SUPPRESS_SUBSHELL_TOOL_FILE" ]; then
        return 0
    fi
    printf '1' > "$_PTC_SAW_BARE_TOOL_FILE"
    _ptc_record_tool_job_pid "\${BASHPID:-$$}"
}

_ptc_maybe_emit_pending() {
    local _ptc_force_pending_emit=0
    # Command substitutions and background jobs run in deeper subshells.
    # They may record pending calls; the main user-code subshell exits
    # before side effects, and the parent emits the sentinel on stdout.
    if [ "\${BASH_SUBSHELL:-0}" -gt 1 ]; then
        if declare -F _ptc_is_bare_tool_command >/dev/null 2>&1 && _ptc_is_bare_tool_command "$BASH_COMMAND"; then
            _ptc_note_subshell_tool_command
        fi
        return 0
    fi
    if [ "\${BASH_SUBSHELL:-0}" -eq 1 ]; then
        if [ -s "$_PTC_SUPPRESS_SUBSHELL_TOOL_CLEAR_FILE" ]; then
            : > "$_PTC_SUPPRESS_SUBSHELL_TOOL_FILE"
            : > "$_PTC_SUPPRESS_SUBSHELL_TOOL_CLEAR_FILE"
            _ptc_force_pending_emit=1
        fi
        if _ptc_contains_command_substitution "$BASH_COMMAND"; then
            printf '1' > "$_PTC_SUPPRESS_SUBSHELL_TOOL_FILE"
            printf '1' > "$_PTC_SUPPRESS_SUBSHELL_TOOL_CLEAR_FILE"
        fi
        _ptc_record_launched_tool_jobs
        if [ -s "$_PTC_WAIT_RAN_FILE" ]; then
            _ptc_prune_finished_tool_jobs
            : > "$_PTC_WAIT_RAN_FILE"
        fi
    fi
    if declare -F _ptc_contains_tool_command >/dev/null 2>&1 && _ptc_contains_tool_command "$BASH_COMMAND"; then
        _ptc_note_bare_tool_command
    fi
    # While a background PTC batch is still being launched/joined, keep
    # collecting pending calls so tool_a & tool_b & wait becomes one
    # sentinel batch instead of exiting after whichever child records first.
    if [ "$_ptc_force_pending_emit" != "1" ] && declare -F _ptc_should_defer_pending_emit >/dev/null 2>&1 && _ptc_should_defer_pending_emit "$BASH_COMMAND"; then
        return 0
    fi
    if [ -s "$_PTC_ERROR_FILE" ]; then
        cat "$_PTC_ERROR_FILE" >&2
        _ptc_cleanup_tempfiles
        trap - DEBUG EXIT
        exit 1
    fi
    if [ ! -s "$_PTC_PENDING_FILE" ]; then
        return 0
    fi
    local _ptc_payload
    if ! _ptc_payload=$(jq -c -s '{pending:.}' "$_PTC_PENDING_FILE" 2>/dev/null); then
        printf 'failed to serialize pending PTC tool calls\\n' >&2
        _ptc_cleanup_tempfiles
        trap - DEBUG EXIT
        exit 1
    fi
    if [ "\${BASH_SUBSHELL:-0}" -eq 1 ]; then
        trap - DEBUG EXIT
        exit 0
    fi
    printf '\\n%s\\n' "$_PTC_SENTINEL_START"
    printf '%s\\n' "$_ptc_payload"
    printf '\\n%s\\n' "$_PTC_SENTINEL_END"
    _ptc_cleanup_tempfiles
    trap - DEBUG EXIT
    exit 0
}

_ptc_exit_handler() {
    _ptc_maybe_emit_pending
    if [ "\${BASH_SUBSHELL:-0}" -gt 1 ]; then
        return 0
    fi
    if declare -F _ptc_should_defer_pending_emit >/dev/null 2>&1 && _ptc_should_defer_pending_emit "$BASH_COMMAND"; then
        return 0
    fi
    _ptc_cleanup_tempfiles
}

# DEBUG/EXIT traps are installed INSIDE the user-code subshell (via
# \`builtin trap\`, which bypasses the wrapper below). The parent shell
# intentionally keeps no DEBUG/EXIT traps because user code can always
# override traps in its own subshell — the authoritative sentinel emission
# runs unconditionally in the parent after the subshell returns.

# Wrap the \`trap\` builtin with a function that silently drops attempts to
# modify DEBUG / EXIT / 0 and forwards every other signal spec to the real
# builtin. The wrapper alone is not a complete defence — \`builtin trap\` and
# \`command builtin trap\` bypass it — so the subshell model above is the
# real guard; the wrapper just keeps accidental user \`trap ... EXIT\` calls
# from taking effect in the subshell. We install our own DEBUG/EXIT traps
# via \`builtin trap\` directly inside the subshell so this wrapper never
# intercepts them.
trap() {
    if [ "$#" -eq 0 ]; then
        builtin trap
        return $?
    fi
    case "$1" in
        -l|-p)
            builtin trap "$@"
            return $?
            ;;
    esac
    local _ptc_action="$1"
    shift
    local _ptc_filtered=()
    local _ptc_sig
    for _ptc_sig in "$@"; do
        case "$_ptc_sig" in
            DEBUG|EXIT|0) ;;
            *) _ptc_filtered+=("$_ptc_sig") ;;
        esac
    done
    if [ "\${#_ptc_filtered[@]}" -gt 0 ]; then
        builtin trap "$_ptc_action" "\${_ptc_filtered[@]}"
    fi
    return 0
}

_ptc_mark_counter_at_least() {
    local _ptc_call_id="$1"
    [[ "$_ptc_call_id" =~ ^call_[0-9]+$ ]] || return 0
    local _ptc_n="\${_ptc_call_id#call_}"
    local _ptc_cur
    _ptc_cur=$(cat "$_PTC_COUNTER_FILE" 2>/dev/null || printf '0')
    [[ "$_ptc_cur" =~ ^[0-9]+$ ]] || _ptc_cur=0
    _ptc_n=$((10#$_ptc_n))
    if [ "$_ptc_n" -gt "$_ptc_cur" ]; then
        printf '%s' "$_ptc_n" > "$_PTC_COUNTER_FILE"
    fi
}

_ptc_next_call_id() {
    local _ptc_cur
    _ptc_cur=$(cat "$_PTC_COUNTER_FILE" 2>/dev/null || printf '0')
    _ptc_cur=$((_ptc_cur + 1))
    printf '%s' "$_ptc_cur" > "$_PTC_COUNTER_FILE"
    printf "call_%03d" "$_ptc_cur"
}

_ptc_history_matches_by_signature() {
    local _ptc_name="$1"
    local _ptc_input_file="$2"
    local _ptc_input_hash="$3"
    local _ptc_call_site="$4"
    if [ ! -r "$_PTC_HISTORY_PATH" ]; then
        return 0
    fi
    # Path, not inline: large input can exceed ARG_MAX via --argjson.
    jq -c \\
        --arg nm "$_ptc_name" \\
        --arg site "$_ptc_call_site" \\
        --arg hash "$_ptc_input_hash" \\
        --slurpfile inp_arr "$_ptc_input_file" \\
        '($inp_arr[0]) as $inp
         | to_entries
         | map(select((.value | type) == "object"
             and .value.tool_name == $nm
             and ((.value.input_hash == $hash) or (.value.input == $inp))))
         | sort_by(
             if ((.value.call_site // "") == $site) then 0 else 1 end,
             (try (.key | capture("^call_(?<n>[0-9]+)$").n | tonumber) catch 1000000000000),
             .key
           )
         | .[]' "$_PTC_HISTORY_PATH" 2>/dev/null || printf ''
}

_ptc_first_unconsumed_history_match() {
    local _ptc_matches="$1"
    local _ptc_match
    local _ptc_key
    while IFS= read -r _ptc_match; do
        [ -n "$_ptc_match" ] || continue
        _ptc_key=$(printf '%s' "$_ptc_match" | jq -r '.key // empty' 2>/dev/null)
        if [ -n "$_ptc_key" ] && ! grep -Fxq "$_ptc_key" "$_PTC_CONSUMED_FILE" 2>/dev/null; then
            printf '%s' "$_ptc_match"
            return 0
        fi
    done <<< "$_ptc_matches"
    return 0
}

_ptc_print_history_entry() {
    local _ptc_entry="$1"
    local _ptc_is_err
    _ptc_is_err=$(printf '%s' "$_ptc_entry" | jq -r 'if type == "object" then (.is_error // false) else false end' 2>/dev/null)
    if [ "$_ptc_is_err" = "true" ]; then
        local _ptc_msg
        _ptc_msg=$(printf '%s' "$_ptc_entry" | jq -r '.error_message // "tool execution failed"' 2>/dev/null)
        _ptc_write_error "$_ptc_msg"
        exit 1
    fi
    local _ptc_result
    _ptc_result=$(printf '%s' "$_ptc_entry" | jq -c 'if type == "object" and has("result") then .result else . end' 2>/dev/null || printf 'null')
    printf '%s' "$_ptc_result"
    return 0
}

_ptc_history_entry_matches_current_call() {
    local _ptc_entry="$1"
    local _ptc_name="$2"
    local _ptc_input_file="$3"
    local _ptc_input_hash="$4"
    # Path, same ARG_MAX reason as above.
    printf '%s' "$_ptc_entry" | jq -e \\
        --arg nm "$_ptc_name" \\
        --arg hash "$_ptc_input_hash" \\
        --slurpfile inp_arr "$_ptc_input_file" \\
        '($inp_arr[0]) as $inp
         | if type != "object" then true
         elif (has("tool_name") and .tool_name != $nm) then false
         elif (has("input_hash") or has("input")) then
           ((.input_hash == $hash) or (.input == $inp))
         else true
         end' >/dev/null 2>&1
}

_ptc_call_tool() {
    local _ptc_name="$1"
    local _ptc_default_input='{}'
    local _ptc_input="\${2:-\$_ptc_default_input}"
    local _ptc_call_site="\${BASH_LINENO[1]:-\${BASH_LINENO[0]:-0}}"

    if ! printf '%s' "$_ptc_input" | jq -e 'type == "object"' >/dev/null 2>&1; then
        _ptc_write_error "tool input for $_ptc_name must be a JSON object, got: $_ptc_input"
        exit 1
    fi

    local _ptc_input_hash
    if ! _ptc_input_hash=$(_ptc_hash_input "$_ptc_input"); then
        _ptc_write_error "failed to canonicalize tool input for $_ptc_name"
        exit 1
    fi

    # Large input can exceed ARG_MAX via --argjson; write once, reuse path below.
    local _ptc_input_tmp
    _ptc_input_tmp="$(mktemp -t _ptc_input.XXXXXX 2>/dev/null || mktemp /tmp/_ptc_input.XXXXXX)"
    printf '%s' "$_ptc_input" > "$_ptc_input_tmp"

    local _ptc_matches
    _ptc_matches=$(_ptc_history_matches_by_signature "$_ptc_name" "$_ptc_input_tmp" "$_ptc_input_hash" "$_ptc_call_site")

    if ! _ptc_acquire_lock; then
        exit 1
    fi

    local _ptc_match
    _ptc_match=$(_ptc_first_unconsumed_history_match "$_ptc_matches")
    if [ -n "$_ptc_match" ] && [ "$_ptc_match" != "null" ]; then
        local _ptc_matched_call_id
        local _ptc_matched_entry
        _ptc_matched_call_id=$(printf '%s' "$_ptc_match" | jq -r '.key' 2>/dev/null)
        _ptc_matched_entry=$(printf '%s' "$_ptc_match" | jq -c '.value' 2>/dev/null)
        printf '%s\\n' "$_ptc_matched_call_id" >> "$_PTC_CONSUMED_FILE"
        _ptc_mark_counter_at_least "$_ptc_matched_call_id"
        _ptc_release_lock
        rm -f "$_ptc_input_tmp"
        _ptc_print_history_entry "$_ptc_matched_entry"
        return $?
    fi

    local _ptc_call_id
    local _ptc_entry
    while :; do
        _ptc_call_id=$(_ptc_next_call_id)
        if [ -r "$_PTC_HISTORY_PATH" ]; then
            _ptc_entry=$(jq -c --arg id "$_ptc_call_id" '.[$id] // empty' "$_PTC_HISTORY_PATH" 2>/dev/null || printf '')
        else
            _ptc_entry=""
        fi
        if [ -z "$_ptc_entry" ] || [ "$_ptc_entry" = "null" ]; then
            break
        fi
        if _ptc_history_entry_matches_current_call "$_ptc_entry" "$_ptc_name" "$_ptc_input_tmp" "$_ptc_input_hash"; then
            printf '%s\\n' "$_ptc_call_id" >> "$_PTC_CONSUMED_FILE"
            _ptc_release_lock
            rm -f "$_ptc_input_tmp"
            _ptc_print_history_entry "$_ptc_entry"
            return $?
        fi
    done

    if ! printf '%s' "$_ptc_input" | jq -c -n \\
        --arg cid "$_ptc_call_id" \\
        --arg nm "$_ptc_name" \\
        --arg hash "$_ptc_input_hash" \\
        --arg site "$_ptc_call_site" \\
        '{call_id:$cid,tool_name:$nm,input:input,input_hash:$hash,call_site:$site}' >> "$_PTC_PENDING_FILE"; then
        _ptc_write_error "failed to serialize pending tool call for $_ptc_name"
        _ptc_release_lock
        rm -f "$_ptc_input_tmp"
        exit 1
    fi
    _ptc_release_lock
    rm -f "$_ptc_input_tmp"
    exit 0
}

# ============================================================================
# TOOL DEFINITIONS
# ============================================================================

`;

  /** Defense-in-depth: the router rejects tool-name collisions up front
   * via `findBashToolNameCollision`, but throw here too so any future
   * caller that bypasses the router still fails loudly rather than
   * silently emitting stubs where one tool's function overwrites
   * another's. */
  const collision = findBashToolNameCollision(tools);
  if (collision) {
    throw new BashToolNameCollisionError(
      collision.firstName,
      collision.secondName,
      collision.normalized,
    );
  }
  for (const tool of tools) {
    preamble += generateBashToolStub(tool) + '\n';
  }

  preamble += generateBashPendingDeferHelper(tools);

  preamble += `# ============================================================================
# LOCK INTERNAL FUNCTIONS
# ============================================================================
# Prevent user code from redefining or unsetting the PTC infrastructure.
# Done at preamble end so every function referenced below already exists.
# \`|| true\` keeps the preamble robust if a future refactor renames one.
readonly -f trap _ptc_maybe_emit_pending _ptc_exit_handler _ptc_cleanup_tempfiles _ptc_acquire_lock _ptc_release_lock _ptc_write_error _ptc_sha256 _ptc_hash_input _ptc_contains_command_substitution _ptc_record_tool_job_pid _ptc_record_matching_background_tool_jobs _ptc_record_launched_tool_jobs _ptc_prune_finished_tool_jobs _ptc_wait_for_tracked_tool_jobs _ptc_note_bare_tool_command _ptc_note_subshell_tool_command _ptc_mark_counter_at_least _ptc_next_call_id _ptc_history_matches_by_signature _ptc_first_unconsumed_history_match _ptc_print_history_entry _ptc_history_entry_matches_current_call _ptc_call_tool _ptc_is_bare_tool_command _ptc_contains_tool_command _ptc_should_defer_pending_emit 2>/dev/null || true

# ============================================================================
# USER CODE EXECUTES INSIDE A SUBSHELL
# ============================================================================
# User code runs in \`(...)\` so any trap modifications it makes (via the
# wrapped \`trap\` function, the raw \`builtin trap\`, or \`command builtin
# trap\`) are scoped to the subshell and torn down on subshell exit. The
# parent shell then calls \`_ptc_maybe_emit_pending\` unconditionally so
# the pending-call sentinel is emitted from the pending file even if the
# subshell's DEBUG/EXIT traps were disabled by user code. Net effect:
# a sufficiently motivated user can still neutralise in-subshell trap
# firing, but they cannot prevent the parent from seeing the pending
# file and producing the sentinel.
(
    # Use \`builtin trap\` so the wrapper (which filters DEBUG/EXIT from user
    # calls) does not filter our own internal install.
    builtin trap _ptc_maybe_emit_pending DEBUG
    builtin trap _ptc_exit_handler EXIT
# ============================================================================
# USER CODE BEGINS BELOW
# ============================================================================

`;

  return preamble;
}

/** Emitted after user code to close the subshell opened by
 * {@link generateBashReplayPreamble} and run the parent-shell fallback
 * sentinel emitter. `buildBashPayload` is responsible for splicing this
 * in so the per-tool stubs never run in the parent but still inherit
 * into the subshell via function inheritance. */
export function generateBashReplayPostamble(): string {
  return `
# ============================================================================
# USER CODE ENDS
# ============================================================================
_PTC_POSTAMBLE_WAITING=1 _ptc_body_exit_code=$?
_ptc_record_launched_tool_jobs
if [ -s "$_PTC_TOOL_JOBS_FILE" ]; then
    _ptc_wait_for_tracked_tool_jobs
fi
_PTC_POSTAMBLE_WAITING=0
_ptc_maybe_emit_pending
exit $_ptc_body_exit_code
)
_ptc_user_exit_code=$?

# Parent shell fallback. If the subshell's DEBUG/EXIT traps were
# disabled by user code (\`builtin trap '' DEBUG\`, \`command builtin trap
# '' EXIT\`, or similar), the pending file may still be non-empty
# because \`_ptc_call_tool\` writes before exiting. Emit the sentinel
# from the parent so replay correctness does not depend on trap
# survivability in the subshell.
_ptc_maybe_emit_pending
_ptc_cleanup_tempfiles
exit $_ptc_user_exit_code
`;
}

function generateBashToolStub(tool: LCTool): string {
  const fnName = normalizeBashFunctionName(tool.name);
  const desc = (tool.description ?? '').split('\n').map(l => `# ${l}`).join('\n');
  const nameComment = fnName !== tool.name ? `# Original tool name: ${tool.name}\n` : '';
  const escapedToolName = escapeForBashDoubleQuote(tool.name);
  return `${nameComment}${desc ? desc + '\n' : ''}${fnName}() {
    local _default_input='{}'
    local _input="\${1:-\$_default_input}"
    if [ "\${BASH_SUBSHELL:-0}" -gt 1 ]; then
        _ptc_note_subshell_tool_command
    fi
    _ptc_call_tool "${escapedToolName}" "\$_input"
}
`;
}

function generateBashPendingDeferHelper(tools: readonly LCTool[]): string {
  const toolNamesPattern = tools
    .map(tool => normalizeBashFunctionName(tool.name))
    .map(escapeForBashEre)
    .join('|') || 'a^';
  const assignmentValuePattern = `([^[:space:]'"]*|'[^']*'|"([^"\\\\]|\\\\.)*")`;
  const assignmentPrefixPattern = `([[:space:]]*[A-Za-z_][A-Za-z0-9_]*=${assignmentValuePattern}[[:space:]]+)*`;
  const commandPrefixPattern = `[[:space:]]*${assignmentPrefixPattern}(time[[:space:]]+${assignmentPrefixPattern})?`;
  const commandPattern = `^${commandPrefixPattern}(${toolNamesPattern})([[:space:]]|$)`;
  const compoundCommandPattern = `(^|[;|&(){}][[:space:]]*)((then|do|else|elif)[[:space:]]+)?${commandPrefixPattern}(${toolNamesPattern})([[:space:];|&(){}]|$)`;

  return `
_PTC_TOOL_COMMAND_RE="${escapeForBashDoubleQuote(commandPattern)}"
_PTC_COMPOUND_TOOL_COMMAND_RE="${escapeForBashDoubleQuote(compoundCommandPattern)}"

_ptc_is_bare_tool_command() {
    local _ptc_cmd="$1"
    [[ "$_ptc_cmd" =~ $_PTC_TOOL_COMMAND_RE ]]
}

_ptc_contains_tool_command() {
    local _ptc_cmd="$1"
    [[ "$_ptc_cmd" =~ $_PTC_COMPOUND_TOOL_COMMAND_RE ]]
}

_ptc_should_defer_pending_emit() {
    local _ptc_cmd="$1"
    if [ "\${BASH_SUBSHELL:-0}" -ne 1 ]; then
        return 1
    fi
    if [ -z "$(jobs -p 2>/dev/null)" ]; then
        return 1
    fi
    if [ -s "$_PTC_SAW_BARE_TOOL_FILE" ]; then
        case "$_ptc_cmd" in
            _PTC_POSTAMBLE_WAITING=*) return 0 ;;
        esac
        if [ "\${_PTC_POSTAMBLE_WAITING:-0}" = "1" ]; then
            return 0
        fi
    fi
    case "$_ptc_cmd" in
        wait|wait\\ *)
            printf '1' > "$_PTC_WAIT_RAN_FILE"
            return 0
            ;;
    esac
    if [ -s "$_PTC_TOOL_JOBS_FILE" ]; then
        return 0
    fi
    _ptc_is_bare_tool_command "$_ptc_cmd" && return 0
    return 1
}

`;
}
