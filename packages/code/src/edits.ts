import { BRIDGE_WORKSPACE_WRITE_MAX_BYTES } from './protocol.js';

import type {
  WorkspaceEditMatch,
  WorkspaceEditMatching,
  WorkspaceEditMatchStrategy,
  WorkspaceTextEdit,
} from './protocol.js';

/**
 * The Code API rejects a settlement whose error exceeds 4096 characters, and
 * callers prefix their own context, so diagnostics stay well below that.
 */
export const EDIT_DIAGNOSTIC_MAX_CHARS = 3000;
const MAX_REPORTED_LINES = 5;
const MAX_SNIPPET_CHARS = 120;
/** A highly repetitive indentation candidate must not monopolize the worker. */
const MAX_LINE_WINDOW_VERIFICATIONS = 100_000;

interface MatchedRange {
  start: number;
  end: number;
  /** Replacement for this range, already adapted to its indentation and line endings. */
  replacement: string;
}

type MatchOutcome =
  | { status: 'matched'; strategy: WorkspaceEditMatchStrategy; ranges: MatchedRange[] }
  | { status: 'ambiguous'; strategy: WorkspaceEditMatchStrategy; count: number; starts: number[] }
  | { status: 'limit' }
  | { status: 'none' };

interface CollectedMatches {
  count: number;
  sourceLength: number;
  projectedLength: number;
  /** Keep every range only when the caller will actually replace every occurrence. */
  ranges: MatchedRange[];
  starts: number[];
}

export interface EditFailure {
  /** Zero-based position of the edit in the request. */
  index: number;
  reason: string;
}

export class WorkspaceEditMatchError extends Error {
  constructor(
    readonly failures: EditFailure[],
    readonly editCount: number,
  ) {
    super(formatEditFailures(failures, editCount));
    this.name = 'WorkspaceEditMatchError';
  }
}

export class WorkspaceEditOutputLimitError extends Error {
  constructor() {
    super('Workspace file exceeds write limit');
    this.name = 'WorkspaceEditOutputLimitError';
  }
}

export interface AppliedEdits {
  text: string;
  matches: WorkspaceEditMatch[];
}

/**
 * Applies ordered replacements to `text`. Each edit sees the result of the
 * edits before it. Every edit is attempted even after a failure, so a caller
 * learns about all unmatched or ambiguous edits from one rejection; nothing is
 * returned unless every edit applied.
 */
export function applyTextEdits(
  text: string,
  edits: readonly WorkspaceTextEdit[],
  matching: WorkspaceEditMatching = 'exact',
): AppliedEdits {
  let working = text;
  const matches: WorkspaceEditMatch[] = [];
  const failures: EditFailure[] = [];
  edits.forEach((edit, index) => {
    const outcome = findEditMatch(working, edit, matching);
    if (outcome.status === 'matched') {
      working = replaceRanges(working, outcome.ranges);
      matches.push({ strategy: outcome.strategy, occurrences: outcome.ranges.length });
      return;
    }
    failures.push({
      index,
      reason:
        outcome.status === 'ambiguous'
          ? describeAmbiguous(working, outcome.strategy, outcome.count, outcome.starts)
          : outcome.status === 'limit'
            ? 'old_text has too many repetitive line-window candidates; include more surrounding lines or use an exact match'
            : describeMissing(working, edit.oldText, matching),
    });
  });
  if (failures.length > 0) {
    throw new WorkspaceEditMatchError(failures, edits.length);
  }
  return { text: working, matches };
}

function findEditMatch(
  text: string,
  edit: WorkspaceTextEdit,
  matching: WorkspaceEditMatching,
): MatchOutcome {
  const strategies = matching === 'tolerant' ? TOLERANT_STRATEGIES : EXACT_STRATEGIES;
  for (const find of strategies) {
    const outcome = find(text, edit);
    if (outcome.status !== 'none') return outcome;
  }
  return { status: 'none' };
}

function collectedMatches(text: string): CollectedMatches {
  return { count: 0, sourceLength: text.length, projectedLength: text.length, starts: [], ranges: [] };
}

function collectMatch(
  matches: CollectedMatches,
  start: number,
  end: number,
  replacement: string,
  replaceAll?: boolean,
): void {
  if (replaceAll === true) {
    matches.projectedLength += replacement.length - (end - start);
    // Even deleting every remaining source character cannot bring this
    // intermediate below the 1 MiB limit. Do not retain more ranges.
    if (matches.projectedLength - (matches.sourceLength - end) > BRIDGE_WORKSPACE_WRITE_MAX_BYTES) {
      throw new WorkspaceEditOutputLimitError();
    }
  }
  matches.count++;
  if (matches.starts.length < MAX_REPORTED_LINES) matches.starts.push(start);
  if (replaceAll === true || matches.count === 1) matches.ranges.push({ start, end, replacement });
}

function resolve(
  strategy: WorkspaceEditMatchStrategy,
  matches: CollectedMatches,
  replaceAll: boolean | undefined,
): MatchOutcome {
  if (matches.count === 0) return { status: 'none' };
  if (matches.count === 1 || replaceAll === true) {
    return { status: 'matched', strategy, ranges: matches.ranges };
  }
  return { status: 'ambiguous', strategy, count: matches.count, starts: matches.starts };
}

/**
 * Overlapping occurrences count toward ambiguity (`aa` in `aaa` is two
 * locations), while `replaceAll` replaces non-overlapping occurrences.
 */
function findExact(text: string, edit: WorkspaceTextEdit): MatchOutcome {
  if (edit.oldText.length === 0) return { status: 'none' };
  const matches = collectedMatches(text);
  const step = edit.replaceAll === true ? edit.oldText.length : 1;
  for (
    let start = text.indexOf(edit.oldText);
    start >= 0;
    start = text.indexOf(edit.oldText, start + step)
  ) {
    collectMatch(matches, start, start + edit.oldText.length, edit.newText, edit.replaceAll);
  }
  return resolve('exact', matches, edit.replaceAll);
}

interface Line {
  /** Offset of the first character of the line. */
  start: number;
  /** Offset just past the line's content, excluding `\r\n` or `\n`. */
  end: number;
  /** Offset just past the line terminator, or `undefined` for an unterminated last line. */
  next: number | undefined;
  text: string;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const lineEnd = newline < 0 ? text.length : newline;
    const end = lineEnd > start && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    lines.push({ start, end, next: newline < 0 ? undefined : newline + 1, text: text.slice(start, end) });
    if (newline < 0) break;
    start = newline + 1;
  }
  return lines;
}

/**
 * Lines a line-window strategy must match. A trailing line break means "through
 * the end of the last line", not "followed by an empty line".
 */
function neededLines(oldText: string): { lines: string[]; throughTerminator: boolean } {
  const normalized = oldText.replace(/\r\n/g, '\n');
  const throughTerminator = normalized.endsWith('\n');
  return {
    lines: (throughTerminator ? normalized.slice(0, -1) : normalized).split('\n'),
    throughTerminator,
  };
}

/** Fallback when neither the matched line nor its neighbors have a terminator. */
function fileLineEnding(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function lineEndingAt(text: string, newline: number): '\r\n' | '\n' {
  return newline > 0 && text[newline - 1] === '\r' ? '\r\n' : '\n';
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

function commonIndent(lines: readonly string[]): string {
  let common: string | undefined;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indent = leadingWhitespace(line);
    if (common === undefined) {
      common = indent;
      continue;
    }
    let shared = 0;
    while (shared < common.length && shared < indent.length && common[shared] === indent[shared]) {
      shared++;
    }
    common = common.slice(0, shared);
  }
  return common ?? '';
}

function withLineEnding(value: string, ending: '\r\n' | '\n'): string {
  const normalized = value.replace(/\r\n/g, '\n');
  return ending === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

function prefixTable<T>(values: readonly T[]): Uint32Array {
  const prefix = new Uint32Array(values.length);
  for (let index = 1, matched = 0; index < values.length; index++) {
    while (matched > 0 && values[index] !== values[matched]) matched = prefix[matched - 1];
    if (values[index] === values[matched]) matched++;
    prefix[index] = matched;
  }
  return prefix;
}

/**
 * Line-window strategies compare whole lines, so a match always spans from the
 * start of its first line to the end of its last line's content. The file's
 * own line terminators are kept, and the replacement adopts them.
 */
function findLineWindows(
  text: string,
  edit: WorkspaceTextEdit,
  strategy: 'line-trimmed' | 'indentation-flexible',
): MatchOutcome {
  const { lines: needle, throughTerminator } = neededLines(edit.oldText);
  if (needle.every((line) => line.trim().length === 0)) return { status: 'none' };
  const lines = splitLines(text);
  const ending = fileLineEnding(text);
  const needleIndent = strategy === 'indentation-flexible' ? commonIndent(needle) : '';
  const normalizedNeedle = needle.map((line) =>
    (strategy === 'indentation-flexible' ? stripIndent(line, needleIndent) : line).trimEnd(),
  );
  if (needle.length > lines.length) return { status: 'none' };
  // For line-trimmed matching, the normalized lines are the complete comparison.
  // For indentation-flexible matching, whole-line content is a linear-time
  // prefilter; only complete candidates need their relative indent verified.
  const sought = strategy === 'line-trimmed'
    ? normalizedNeedle
    : normalizedNeedle.map((line) => line.trimStart());
  const prefix = prefixTable(sought);
  const collected = collectedMatches(text);
  let matched = 0;
  let verifications = 0;
  for (let index = 0; index < lines.length; index++) {
    const value = strategy === 'line-trimmed' ? lines[index].text.trimEnd() : lines[index].text.trim();
    while (matched > 0 && value !== sought[matched]) matched = prefix[matched - 1];
    if (value === sought[matched]) matched++;
    if (matched !== sought.length) continue;

    const first = index - sought.length + 1;
    const end = throughTerminator ? lines[index].next : lines[index].end;
    let windowIndent = '';
    let valid = end !== undefined;
    if (valid && strategy === 'indentation-flexible') {
      if (verifications + needle.length > MAX_LINE_WINDOW_VERIFICATIONS) return { status: 'limit' };
      const window = lines.slice(first, index + 1);
      verifications += needle.length;
      windowIndent = commonIndent(window.map((line) => line.text));
      valid = window.every((line, offset) =>
        stripIndent(line.text, windowIndent).trimEnd() === normalizedNeedle[offset],
      );
    }
    if (valid) {
      const replacement = strategy === 'indentation-flexible'
        ? reindent(edit.newText, needleIndent, windowIndent)
        : edit.newText;
      const lineFeed = lines[first].next ?? lines[first - 1]?.next;
      const localEnding = lineFeed === undefined ? ending : lineEndingAt(text, lineFeed - 1);
      collectMatch(collected, lines[first].start, end!, withLineEnding(replacement, localEnding), edit.replaceAll);
    }
    // A replacement cannot consume overlapping lines; ambiguity still counts them.
    matched = valid && edit.replaceAll === true ? 0 : prefix[matched - 1];
  }
  return resolve(strategy, collected, edit.replaceAll);
}

function stripIndent(line: string, indent: string): string {
  return line.startsWith(indent) ? line.slice(indent.length) : line.trimStart();
}

/**
 * Moves `value` from the indentation the caller wrote to the file's own. Lines
 * the caller indented less than its `old_text` keep their indentation as written.
 */
function reindent(value: string, from: string, to: string): string {
  if (from === to) return value;
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) =>
      line.trim().length > 0 && line.startsWith(from) ? to + line.slice(from.length) : line,
    )
    .join('\n');
}

function findLineTrimmed(text: string, edit: WorkspaceTextEdit): MatchOutcome {
  return findLineWindows(text, edit, 'line-trimmed');
}

function findIndentationFlexible(text: string, edit: WorkspaceTextEdit): MatchOutcome {
  return findLineWindows(text, edit, 'indentation-flexible');
}

function newlineCount(text: string): number {
  let count = 0;
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) count++;
  return count;
}

/** A boundary supplied by oldText must exist beside the candidate tokens. */
function hasBoundaryWhitespace(
  text: string,
  position: number,
  direction: -1 | 1,
  requiredNewlines: number,
): boolean {
  for (let index = position; index >= 0 && index < text.length; index += direction) {
    const char = text[index];
    if (!/\s/.test(char)) break;
    if (char === '\n') requiredNewlines--;
    if (requiredNewlines <= 0) return true;
  }
  return false;
}

/**
 * Tolerates any run of whitespace, including line breaks, between tokens. The
 * match starts and ends on a token, so whitespace the caller wrapped around
 * `old_text` is also peeled off `new_text` rather than inserted twice.
 */
function findWhitespaceNormalized(text: string, edit: WorkspaceTextEdit): MatchOutcome {
  const oldText = edit.oldText.replace(/\r\n/g, '\n');
  const tokens = oldText.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return { status: 'none' };
  // The matched range contains tokens only; leave the file's boundary whitespace
  // outside it. Normalize the caller's line endings *before* peeling equivalent
  // wrappers, otherwise CRLF/LF differences insert a second line break.
  const leading = /^\s*/.exec(oldText)?.[0] ?? '';
  const trailing = /\s*$/.exec(oldText)?.[0] ?? '';
  const leadingNewlines = newlineCount(leading);
  const trailingNewlines = newlineCount(trailing);
  let newText = edit.newText.replace(/\r\n/g, '\n');
  if (leading.length > 0 && newText.startsWith(leading)) {
    newText = newText.slice(leading.length);
  } else if (leadingNewlines === 1 && newText.startsWith('\n')) {
    // Keep the source's indentation when the caller used different spaces.
    newText = newText.slice(1);
  } else if (leading.length > 0) {
    // A token-only replacement cannot remove the source's leading whitespace.
    return { status: 'none' };
  }
  if (trailing.length > 0 && newText.endsWith(trailing)) {
    newText = newText.slice(0, -trailing.length);
  } else if (trailingNewlines === 1 && newText.endsWith('\n')) {
    // The source terminator is outside the token range. Preserve any extra
    // caller-requested line breaks by peeling only the shared one.
    newText = newText.slice(0, -1);
  } else if (trailing.length > 0) {
    // Likewise do not claim success if the caller meant to remove an ending.
    return { status: 'none' };
  }
  const lfReplacement = newText;
  const crlfReplacement = withLineEnding(newText, '\r\n');
  // Match entire whitespace-delimited tokens, never an identifier prefix or
  // suffix. A fixed-size regex tokenizes the file; KMP keeps repetitive input
  // linear without compiling user-provided text as a regular expression.
  const prefix = prefixTable(tokens);
  const tokenStarts = new Uint32Array(tokens.length);
  const collected = collectedMatches(text);
  const words = /\S+/g;
  let matched = 0;
  let tokenIndex = 0;
  // Advance the newline cursor only forwards. replaceAll may encounter many
  // matches on one long line, so searching from each match would be quadratic.
  let nextNewline = text.indexOf('\n');
  let previousNewline = -1;
  for (let word = words.exec(text); word != null; word = words.exec(text)) {
    tokenStarts[tokenIndex % tokens.length] = word.index;
    while (matched > 0 && word[0] !== tokens[matched]) matched = prefix[matched - 1];
    if (word[0] === tokens[matched]) matched++;
    if (matched === tokens.length) {
      const start = tokenStarts[(tokenIndex + 1) % tokens.length];
      const end = word.index + word[0].length;
      const boundariesMatch =
        (leading.length === 0 || hasBoundaryWhitespace(text, start - 1, -1, leadingNewlines)) &&
        (trailing.length === 0 || hasBoundaryWhitespace(text, end, 1, trailingNewlines));
      if (boundariesMatch) {
        while (nextNewline >= 0 && nextNewline < start) {
          previousNewline = nextNewline;
          nextNewline = text.indexOf('\n', nextNewline + 1);
        }
        const nearestNewline = nextNewline >= 0 ? nextNewline : previousNewline;
        const replacement = nearestNewline >= 0 && lineEndingAt(text, nearestNewline) === '\r\n'
          ? crlfReplacement
          : lfReplacement;
        collectMatch(collected, start, end, replacement, edit.replaceAll);
      }
      matched = boundariesMatch && edit.replaceAll === true ? 0 : prefix[matched - 1];
    }
    tokenIndex++;
  }
  return resolve('whitespace-normalized', collected, edit.replaceAll);
}

type Strategy = (text: string, edit: WorkspaceTextEdit) => MatchOutcome;

/**
 * Loosest last. Line-window strategies run before whitespace normalization
 * because they can carry `new_text` over to the file's indentation; a
 * whitespace-normalized match would insert it exactly as written.
 */
const RELAXED_STRATEGIES: readonly Strategy[] = [
  findLineTrimmed,
  findIndentationFlexible,
  findWhitespaceNormalized,
];
const EXACT_STRATEGIES: readonly Strategy[] = [findExact];
const TOLERANT_STRATEGIES: readonly Strategy[] = [findExact, ...RELAXED_STRATEGIES];

function replaceRanges(text: string, ranges: readonly MatchedRange[]): string {
  const length = ranges.reduce(
    (total, range) => total + range.replacement.length - (range.end - range.start),
    text.length,
  );
  // Every valid UTF-8 string has at least this many encoded bytes. Reject a
  // pathological replaceAll before allocating an unbounded intermediate string.
  if (length > BRIDGE_WORKSPACE_WRITE_MAX_BYTES) throw new WorkspaceEditOutputLimitError();
  let result = '';
  let cursor = 0;
  for (const range of ranges) {
    result += text.slice(cursor, range.start) + range.replacement;
    cursor = range.end;
  }
  return result + text.slice(cursor);
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let index = text.indexOf('\n'); index >= 0 && index < offset; index = text.indexOf('\n', index + 1)) {
    line++;
  }
  return line;
}

function formatLineList(text: string, starts: readonly number[], count = starts.length): string {
  const shown = starts.slice(0, MAX_REPORTED_LINES).map((start) => lineNumberAt(text, start));
  const more = count - shown.length;
  return `line${shown.length === 1 ? '' : 's'} ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

function describeAmbiguous(
  text: string,
  strategy: WorkspaceEditMatchStrategy,
  count: number,
  starts: readonly number[],
): string {
  const how = strategy === 'exact' ? '' : ` (${strategy})`;
  return `old_text matched ${count} locations${how} at ${formatLineList(text, starts, count)}; include more surrounding lines so it matches exactly one`;
}

function snippet(line: string): string {
  const trimmed = line.trim();
  return JSON.stringify(
    trimmed.length > MAX_SNIPPET_CHARS ? `${trimmed.slice(0, MAX_SNIPPET_CHARS)}…` : trimmed,
  );
}

const ELISION_LINE = /^\s*(?:(?:\/\/|#|--|\/\*|\*|<!--)\s*)?(?:\.{3}|…)(?:.*(?:\.{3}|…|\*\/|-->))?\s*$/;
const LINE_NUMBER_PREFIX = /^\s*\d+\s*(?:\||:|\t)/;

function describeMissing(
  text: string,
  oldText: string,
  matching: WorkspaceEditMatching,
): string {
  const hints: string[] = [];
  const nonBlank = neededLines(oldText).lines.filter((line) => line.trim().length > 0);
  if (nonBlank.some((line) => ELISION_LINE.test(line))) {
    hints.push('it contains an elision placeholder ("..."); copy the exact lines instead of abbreviating');
  }
  if (nonBlank.length > 0 && nonBlank.every((line) => LINE_NUMBER_PREFIX.test(line))) {
    hints.push('it appears to include line-number prefixes from read_file output; remove them');
  }
  if (matching === 'exact') {
    const tolerant = RELAXED_STRATEGIES.map((find) => find(text, { oldText, newText: '' })).find(
      (outcome) => outcome.status !== 'none',
    );
    if (tolerant?.status === 'matched') {
      hints.push(
        `the same text exists at ${formatLineList(text, [tolerant.ranges[0].start])} with different whitespace (${tolerant.strategy}); copy that whitespace exactly`,
      );
    } else if (text.includes('\r\n') && !oldText.includes('\r\n') && oldText.includes('\n')) {
      hints.push('the file uses CRLF line endings');
    }
  }
  const nearest = nearestLine(text, nonBlank[0]);
  if (nearest != null && hints.length === 0) {
    hints.push(
      nearest.exact
        ? `its first line appears at ${formatLineList(text, nearest.starts, nearest.count)}, but the lines after it differ`
        : `the closest line is ${formatLineList(text, nearest.starts)}: ${snippet(nearest.text)}`,
    );
  }
  return `old_text was not found${hints.length > 0 ? `; ${hints.join('; ')}` : ''}`;
}

/** Finds where the first line of a failed edit most likely belongs. */
function nearestLine(
  text: string,
  firstLine: string | undefined,
): { exact: boolean; count: number; starts: number[]; text: string } | undefined {
  const target = firstLine?.trim();
  if (!target) return undefined;
  const lines = splitLines(text);
  const starts: number[] = [];
  let count = 0;
  let firstMatch = '';
  for (const line of lines) {
    if (line.text.trim() !== target) continue;
    if (count++ === 0) firstMatch = line.text;
    if (starts.length < MAX_REPORTED_LINES) starts.push(line.start);
  }
  if (count > 0) {
    return { exact: true, count, starts, text: firstMatch };
  }
  const tokens = new Set(target.split(/\W+/).filter((token) => token.length > 1));
  if (tokens.size < 2) return undefined;
  let best: Line | undefined;
  let bestScore = 0;
  for (const line of lines) {
    let score = 0;
    for (const token of new Set(line.text.split(/\W+/))) {
      if (tokens.has(token)) score++;
    }
    if (score > bestScore) {
      best = line;
      bestScore = score;
    }
  }
  return best != null && bestScore / tokens.size >= 0.5
    ? { exact: false, count: 1, starts: [best.start], text: best.text }
    : undefined;
}

function formatEditFailures(failures: readonly EditFailure[], editCount: number): string {
  if (editCount === 1) {
    return `Workspace edit did not apply and nothing was written: ${failures[0]?.reason ?? 'no match'}.`.slice(
      0,
      EDIT_DIAGNOSTIC_MAX_CHARS,
    );
  }
  let message = `${failures.length} of ${editCount} workspace edits did not apply, so nothing was written. Every other edit matched.`;
  let shown = 0;
  for (const failure of failures) {
    const line = `\nEdit ${failure.index + 1}: ${failure.reason}.`;
    if (message.length + line.length > EDIT_DIAGNOSTIC_MAX_CHARS - 120) break;
    message += line;
    shown++;
  }
  const hidden = failures.length - shown;
  if (hidden > 0) {
    message += `\n${hidden} more failing edit${hidden === 1 ? '' : 's'} not shown.`;
  }
  if (failures.some((failure) => failure.index > 0)) {
    message += '\nLine numbers account for the earlier edits in this batch.';
  }
  return message.slice(0, EDIT_DIAGNOSTIC_MAX_CHARS);
}
