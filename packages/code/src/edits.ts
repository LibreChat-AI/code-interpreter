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
/**
 * Code API returns the message inside a JSON error body, and hosts read that
 * body through a bounded buffer (4096 bytes in LibreChat). Optional excerpts
 * are granted only while the JSON-encoded UTF-8 message stays within this size.
 */
export const EDIT_DIAGNOSTIC_MAX_BODY_BYTES = 3_800;
const MAX_REPORTED_LINES = 5;
const MAX_SNIPPET_CHARS = 120;
/** A missing edit's current-text excerpt: a few lines, each shortened, in one bounded hint. */
const MAX_EXCERPT_LINES = 8;
const MAX_EXCERPT_LINE_CHARS = 160;
/** Measured like the message bound: UTF-8 bytes once JSON-encoded into the error body. */
const MAX_EXCERPT_BYTES = 1_600;
/** Alignment votes cast while locating the region a missing edit most likely meant. */
const MAX_REGION_VOTES = 200_000;
/** Lines too generic to anchor a region on their own (`}`, `);`, blank lines). */
const ANCHOR_LINE = /[\p{L}\p{N}_]{2}/u;
const LINE_SEPARATORS = /[\u2028\u2029]/g;
/** A highly repetitive indentation candidate must not monopolize the worker. */
const MAX_LINE_WINDOW_VERIFICATIONS = 100_000;
const MAX_REPLACEMENT_CHUNK_CHARS = 16 * 1024;

interface MatchedRange {
  start: number;
  end: number;
  /** Replacement for this range, already adapted to its indentation and line endings. */
  replacement: string;
}

type MatchOutcome =
  | { status: 'matched'; strategy: WorkspaceEditMatchStrategy; ranges: MatchedRange[]; occurrences: number; updated?: string }
  | { status: 'ambiguous'; strategy: WorkspaceEditMatchStrategy; count: number; starts: number[] }
  | { status: 'limit' }
  | { status: 'none' };

interface CollectedMatches {
  count: number;
  source: string;
  projectedLength: number;
  /** Only the first range is needed for a unique edit or an exact-mode hint. */
  ranges: MatchedRange[];
  starts: number[];
  output?: { chunks: string[]; pending: string; cursor: number };
}

export interface EditFailure {
  /** Zero-based position of the edit in the request. */
  index: number;
  reason: string;
  /**
   * A final `; the current text at ...` hint quoting the region the edit most
   * likely meant. It is appended to `reason` only while the whole message stays
   * within its bound, and is the first detail dropped when it would not.
   */
  excerpt?: string;
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
  let lineIndex: LineIndex | undefined;
  const lines = (): LineIndex => (lineIndex ??= new LineIndex(working));
  const matches: WorkspaceEditMatch[] = [];
  const failures: EditFailure[] = [];
  edits.forEach((edit, index) => {
    const outcome = findEditMatch(working, edit, matching, lines);
    if (outcome.status === 'matched') {
      working = outcome.updated ?? replaceRanges(working, outcome.ranges);
      lineIndex = undefined;
      matches.push({ strategy: outcome.strategy, occurrences: outcome.occurrences });
      return;
    }
    if (outcome.status === 'none') {
      failures.push({ index, ...describeMissing(working, edit.oldText, matching, lines) });
      return;
    }
    failures.push({
      index,
      reason:
        outcome.status === 'ambiguous'
          ? describeAmbiguous(working, outcome.strategy, outcome.count, outcome.starts)
          : 'old_text has too many repetitive line-window candidates; include more surrounding lines or use an exact match',
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
  lines: () => LineIndex,
): MatchOutcome {
  const strategies = matching === 'tolerant' ? TOLERANT_STRATEGIES : EXACT_STRATEGIES;
  for (const find of strategies) {
    const outcome = find(text, edit, lines);
    if (outcome.status !== 'none') return outcome;
  }
  return { status: 'none' };
}

function collectedMatches(text: string, replaceAll?: boolean): CollectedMatches {
  return {
    count: 0, source: text, projectedLength: text.length, starts: [], ranges: [],
    ...(replaceAll === true ? { output: { chunks: [], pending: '', cursor: 0 } } : {}),
  };
}

function appendReplacement(output: NonNullable<CollectedMatches['output']>, part: string): void {
  if (!part) return;
  output.pending += part;
  if (output.pending.length >= MAX_REPLACEMENT_CHUNK_CHARS) {
    output.chunks.push(output.pending);
    output.pending = '';
  }
}

function finishReplacement(matches: CollectedMatches): string {
  const output = matches.output!;
  if (output.cursor === 0) return matches.source;
  appendReplacement(output, matches.source.slice(output.cursor));
  return output.chunks.join('') + output.pending;
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
    // intermediate below the 1 MiB limit. Do not retain more matches.
    if (matches.projectedLength - (matches.source.length - end) > BRIDGE_WORKSPACE_WRITE_MAX_BYTES) {
      throw new WorkspaceEditOutputLimitError();
    }
    // Leave unchanged ranges in the source suffix rather than constructing a
    // million identical output pieces for a no-op replaceAll edit.
    if (replacement !== matches.source.slice(start, end)) {
      const output = matches.output!;
      appendReplacement(output, matches.source.slice(output.cursor, start));
      appendReplacement(output, replacement);
      output.cursor = end;
    }
  }
  matches.count++;
  if (matches.starts.length < MAX_REPORTED_LINES) matches.starts.push(start);
  if (matches.count === 1) matches.ranges.push({ start, end, replacement });
}

function resolve(
  strategy: WorkspaceEditMatchStrategy,
  matches: CollectedMatches,
  replaceAll: boolean | undefined,
): MatchOutcome {
  if (matches.count === 0) return { status: 'none' };
  if (matches.count === 1 || replaceAll === true) {
    return {
      status: 'matched', strategy, ranges: matches.ranges, occurrences: matches.count,
      ...(replaceAll === true ? { updated: finishReplacement(matches) } : {}),
    };
  }
  return { status: 'ambiguous', strategy, count: matches.count, starts: matches.starts };
}

/**
 * Overlapping occurrences count toward ambiguity (`aa` in `aaa` is two
 * locations), while `replaceAll` replaces non-overlapping occurrences.
 */
function findExact(text: string, edit: WorkspaceTextEdit): MatchOutcome {
  if (edit.oldText.length === 0) return { status: 'none' };
  const matches = collectedMatches(text, edit.replaceAll);
  const prefix = prefixTable(edit.oldText);
  let matched = 0;
  for (let index = 0; index < text.length; index++) {
    while (matched > 0 && text[index] !== edit.oldText[matched]) matched = prefix[matched - 1];
    if (text[index] === edit.oldText[matched]) matched++;
    if (matched !== edit.oldText.length) continue;
    collectMatch(matches, index - matched + 1, index + 1, edit.newText, edit.replaceAll);
    // Ambiguity counts overlaps, but replaceAll must consume disjoint ranges.
    matched = edit.replaceAll === true ? 0 : prefix[matched - 1];
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

/** One bounded index per source revision, shared by matching and diagnostics. */
class LineIndex {
  private readonly newlines: Uint32Array;
  readonly length: number;

  constructor(private readonly source: string) {
    this.newlines = new Uint32Array(newlineCount(source));
    let index = 0;
    for (let offset = source.indexOf('\n'); offset >= 0; offset = source.indexOf('\n', offset + 1)) {
      this.newlines[index++] = offset;
    }
    // A trailing terminator leaves an empty final line, just as before.
    this.length = this.newlines.length + 1;
  }

  start(index: number): number {
    return index === 0 ? 0 : this.newlines[index - 1] + 1;
  }

  next(index: number): number | undefined {
    return index < this.newlines.length ? this.newlines[index] + 1 : undefined;
  }

  end(index: number): number {
    const start = this.start(index);
    const end = index < this.newlines.length ? this.newlines[index] : this.source.length;
    return end > start && this.source[end - 1] === '\r' ? end - 1 : end;
  }

  text(index: number): string {
    return this.source.slice(this.start(index), this.end(index));
  }

  at(index: number): Line {
    return { start: this.start(index), end: this.end(index), next: this.next(index), text: this.text(index) };
  }
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

function commonIndent(lines: Iterable<string>): string {
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

function prefixTable<T>(values: ArrayLike<T>): Uint32Array {
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
  getLines: () => LineIndex,
): MatchOutcome {
  const { lines: needle, throughTerminator } = neededLines(edit.oldText);
  if (needle.every((line) => line.trim().length === 0)) return { status: 'none' };
  const lines = getLines();
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
  const collected = collectedMatches(text, edit.replaceAll);
  let matched = 0;
  let verifications = 0;
  // Allow one complete linear verification even for a large valid block.
  const verificationBudget = Math.max(MAX_LINE_WINDOW_VERIFICATIONS, needle.length);
  for (let index = 0; index < lines.length; index++) {
    const value = strategy === 'line-trimmed' ? lines.text(index).trimEnd() : lines.text(index).trim();
    while (matched > 0 && value !== sought[matched]) matched = prefix[matched - 1];
    if (value === sought[matched]) matched++;
    if (matched !== sought.length) continue;

    const first = index - sought.length + 1;
    const end = throughTerminator ? lines.next(index) : lines.end(index);
    let windowIndent = '';
    let valid = end !== undefined;
    if (valid && strategy === 'indentation-flexible') {
      if (verifications + needle.length > verificationBudget) return { status: 'limit' };
      verifications += needle.length;
      windowIndent = commonIndent((function* () {
        for (let offset = 0; offset < needle.length; offset++) yield lines.text(first + offset);
      })());
      valid = normalizedNeedle.every((expected, offset) =>
        stripIndent(lines.text(first + offset), windowIndent).trimEnd() === expected,
      );
    }
    if (valid) {
      const replacement = strategy === 'indentation-flexible'
        ? reindent(edit.newText, needleIndent, windowIndent)
        : edit.newText;
      const lineFeed = lines.next(first) ?? (first > 0 ? lines.next(first - 1) : undefined);
      const localEnding = lineFeed === undefined ? ending : lineEndingAt(text, lineFeed - 1);
      collectMatch(collected, lines.start(first), end!, withLineEnding(replacement, localEnding), edit.replaceAll);
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

function findLineTrimmed(text: string, edit: WorkspaceTextEdit, lines: () => LineIndex): MatchOutcome {
  return findLineWindows(text, edit, 'line-trimmed', lines);
}

function findIndentationFlexible(text: string, edit: WorkspaceTextEdit, lines: () => LineIndex): MatchOutcome {
  return findLineWindows(text, edit, 'indentation-flexible', lines);
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

/** A token-only match leaves the source's outer whitespace untouched. */
function peelBoundaryWhitespace(
  text: string,
  boundary: string,
  side: 'leading' | 'trailing',
): string | undefined {
  if (!boundary) return text;
  const whitespace = (side === 'leading' ? /^\s*/ : /\s*$/).exec(text)?.[0] ?? '';
  if (whitespace === boundary) {
    return side === 'leading' ? text.slice(boundary.length) : text.slice(0, -boundary.length);
  }

  const requiredNewlines = newlineCount(boundary);
  if (!requiredNewlines) return undefined;
  if (newlineCount(whitespace) < requiredNewlines) return undefined;

  if (side === 'leading') {
    let end = 0;
    for (let count = 0; count < requiredNewlines; count++) {
      end = whitespace.indexOf('\n', end) + 1;
    }
    // Consume the equivalent indentation, stopping before the first extra
    // newline. Extra blank lines belong to the replacement, not the wrapper.
    while (end < whitespace.length && whitespace[end] !== '\n') end++;
    return text.slice(end);
  }

  if (newlineCount(whitespace) === requiredNewlines) {
    return text.slice(0, text.length - whitespace.length);
  }
  let start = whitespace.length;
  for (let count = 0; count < requiredNewlines; count++) {
    start = whitespace.lastIndexOf('\n', start - 1);
  }
  // Indentation before this newline belongs to the extra blank line.
  return text.slice(0, text.length - (whitespace.length - start));
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
  const normalizedNewText = edit.newText.replace(/\r\n/g, '\n');
  const withoutLeading = peelBoundaryWhitespace(normalizedNewText, leading, 'leading');
  if (withoutLeading === undefined) return { status: 'none' };
  const newText = peelBoundaryWhitespace(withoutLeading, trailing, 'trailing');
  if (newText === undefined) return { status: 'none' };
  const lfReplacement = newText;
  const crlfReplacement = withLineEnding(newText, '\r\n');
  // Match entire whitespace-delimited tokens, never an identifier prefix or
  // suffix. A fixed-size regex tokenizes the file; KMP keeps repetitive input
  // linear without compiling user-provided text as a regular expression.
  const prefix = prefixTable(tokens);
  const tokenStarts = new Uint32Array(tokens.length);
  const collected = collectedMatches(text, edit.replaceAll);
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

type Strategy = (text: string, edit: WorkspaceTextEdit, lines: () => LineIndex) => MatchOutcome;

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

/**
 * JSON quoting that also escapes U+2028/U+2029, which JSON.stringify leaves
 * raw: hosts read a batch diagnostic one line per edit, and a regular
 * expression `.` stops at those separators.
 */
function quote(value: string): string {
  return JSON.stringify(value).replace(
    LINE_SEPARATORS,
    (separator) => `\\u${separator.charCodeAt(0).toString(16)}`,
  );
}

function snippet(line: string): string {
  const trimmed = line.trim();
  return quote(trimmed.length > MAX_SNIPPET_CHARS ? `${trimmed.slice(0, MAX_SNIPPET_CHARS)}…` : trimmed);
}

const ELISION_LINE = /^\s*(?:(?:\/\/|#|--|\/\*|\*|<!--)\s*)?(?:\.{3}|…)(?:.*(?:\.{3}|…|\*\/|-->))?\s*$/;
const LINE_NUMBER_PREFIX = /^\s*\d+\s*(?:\||:|\t)/;

function describeMissing(
  text: string,
  oldText: string,
  matching: WorkspaceEditMatching,
  lines: () => LineIndex,
): { reason: string; excerpt?: string } {
  const needle = neededLines(oldText).lines;
  const firstOffset = needle.findIndex((line) => line.trim().length > 0);
  const nearest = nearestLine(needle[firstOffset], lines);
  const reason = describeMissingReason(text, oldText, needle, matching, lines, nearest);
  // The anchor is the first non-blank line, so the region starts that many lines earlier.
  const anchor = nearest != null && (!nearest.exact || nearest.count === 1)
    ? Math.max(0, nearest.index - firstOffset)
    : undefined;
  const start = closestRegion(needle, lines()) ?? anchor;
  const excerpt = start == null ? undefined : currentTextExcerpt(needle, lines(), start);
  return excerpt == null ? { reason } : { reason, excerpt };
}

type ExcerptMark = ' ' | '~' | '!';

/**
 * Finds where a missing multi-line edit most likely belongs: the alignment on
 * which the most of its distinctive lines, compared without surrounding
 * whitespace, fall into place. One pass over the file with bounded votes.
 */
function closestRegion(needle: readonly string[], lines: LineIndex): number | undefined {
  const offsets = new Map<string, number[]>();
  let anchors = 0;
  needle.forEach((line, offset) => {
    const key = line.trim();
    if (!ANCHOR_LINE.test(key)) return;
    anchors++;
    const known = offsets.get(key);
    if (known) known.push(offset);
    else offsets.set(key, [offset]);
  });
  if (anchors < 2) return undefined;
  const votes = new Map<number, number>();
  let budget = MAX_REGION_VOTES;
  let best: number | undefined;
  let bestVotes = 0;
  for (let index = 0; index < lines.length && budget > 0; index++) {
    const hits = offsets.get(lines.text(index).trim());
    if (!hits) continue;
    // Offsets ascend, so every later one would start before the file too.
    for (const offset of hits) {
      if (budget-- <= 0) break;
      const start = index - offset;
      if (start < 0) break;
      const count = (votes.get(start) ?? 0) + 1;
      votes.set(start, count);
      if (count > bestVotes || (count === bestVotes && best !== undefined && start < best)) {
        best = start;
        bestVotes = count;
      }
    }
  }
  // One shared line is too weak to claim a region; the first-line anchor covers that case.
  return bestVotes >= 2 ? best : undefined;
}

function excerptMark(current: string, expected: string | undefined): ExcerptMark {
  if (expected === undefined) return '!';
  if (current === expected) return ' ';
  return current.trim() === expected.trim() ? '~' : '!';
}

function shortenLine(line: string): string {
  if (line.length <= MAX_EXCERPT_LINE_CHARS) return line;
  let end = MAX_EXCERPT_LINE_CHARS;
  if (/[\uD800-\uDBFF]/.test(line[end - 1]) && /[\uDC00-\uDFFF]/.test(line[end])) end--;
  return `${line.slice(0, end)}…`;
}

/**
 * Quotes the current text where a missing edit most likely belongs, so the next
 * attempt can copy it instead of re-reading the file. Each line is marked
 * against the `old_text` line at the same position: a space when identical,
 * `~` when only whitespace differs and `!` when the text differs. A region
 * longer than the excerpt is shown from just before its first difference.
 */
function currentTextExcerpt(needle: readonly string[], lines: LineIndex, start: number): string | undefined {
  const span = Math.max(1, Math.min(needle.length, lines.length - start));
  const marks = Array.from({ length: span }, (_, offset) =>
    excerptMark(lines.text(start + offset), needle[offset]),
  );
  const shown = Math.min(span, MAX_EXCERPT_LINES);
  const firstDifference = Math.max(0, marks.findIndex((mark) => mark !== ' '));
  const first = start + Math.min(Math.max(0, firstDifference - 1), span - shown);
  const rows = marks
    .slice(first - start, first - start + shown)
    .map((mark, offset) => `${first + offset + 1}|${mark}${shortenLine(lines.text(first + offset))}`);
  for (; rows.length > 0; rows.pop()) {
    const where = rows.length === 1 ? `line ${first + 1}` : `lines ${first + 1}-${first + rows.length}`;
    const excerpt = `the current text at ${where} (~ whitespace differs, ! text differs) is ${quote(rows.join('\n'))}`;
    if (encodedBytes(excerpt) <= MAX_EXCERPT_BYTES) return excerpt;
  }
  return undefined;
}

interface NearestLine {
  exact: boolean;
  count: number;
  /** Line index of the first exact candidate, or of the best token match. */
  index: number;
  starts: number[];
  text: string;
}

function describeMissingReason(
  text: string,
  oldText: string,
  needle: readonly string[],
  matching: WorkspaceEditMatching,
  lines: () => LineIndex,
  nearest: NearestLine | undefined,
): string {
  const hints: string[] = [];
  const nonBlank = needle.filter((line) => line.trim().length > 0);
  if (nonBlank.some((line) => ELISION_LINE.test(line))) {
    hints.push('it contains an elision placeholder ("..."); copy the exact lines instead of abbreviating');
  }
  if (nonBlank.length > 0 && nonBlank.every((line) => LINE_NUMBER_PREFIX.test(line))) {
    hints.push('it appears to include line-number prefixes from read_file output; remove them');
  }
  if (matching === 'exact') {
    let tolerant: MatchOutcome | undefined;
    for (const find of RELAXED_STRATEGIES) {
      // Diagnose match existence, not whether the requested replacement can
      // preserve its out-of-range wrappers. A no-op keeps those wrappers valid.
      tolerant = find(text, { oldText, newText: oldText }, lines);
      if (tolerant.status !== 'none') break;
    }
    if (tolerant?.status === 'matched') {
      hints.push(
        `the same text exists at ${formatLineList(text, [tolerant.ranges[0].start])} with different whitespace (${tolerant.strategy}); copy that whitespace exactly`,
      );
    } else if (text.includes('\r\n') && !oldText.includes('\r\n') && oldText.includes('\n')) {
      hints.push('the file uses CRLF line endings');
    }
  }
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
  firstLine: string | undefined,
  getLines: () => LineIndex,
): NearestLine | undefined {
  const target = firstLine?.trim();
  if (!target) return undefined;
  const lines = getLines();
  const starts: number[] = [];
  let count = 0;
  let first = 0;
  for (let index = 0; index < lines.length; index++) {
    if (lines.text(index).trim() !== target) continue;
    if (count++ === 0) first = index;
    if (starts.length < MAX_REPORTED_LINES) starts.push(lines.start(index));
  }
  if (count > 0) {
    return { exact: true, count, index: first, starts, text: lines.text(first) };
  }
  const tokens = new Set(target.split(/\W+/).filter((token) => token.length > 1));
  if (tokens.size < 2) return undefined;
  let best: number | undefined;
  let bestScore = 0;
  for (let index = 0; index < lines.length; index++) {
    let score = 0;
    for (const token of new Set(lines.text(index).split(/\W+/))) {
      if (tokens.has(token)) score++;
    }
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  }
  return best != null && bestScore / tokens.size >= 0.5
    ? { exact: false, count: 1, index: best, starts: [lines.start(best)], text: lines.text(best) }
    : undefined;
}

/** UTF-8 bytes `value` occupies once JSON-encoded as a string in an error body. */
function encodedBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value)) - 2;
}

/** A failure's reason, followed by its excerpt when the excerpt was granted room. */
function failureText(failure: EditFailure, withExcerpt: boolean): string {
  return withExcerpt && failure.excerpt ? `${failure.reason}; ${failure.excerpt}` : failure.reason;
}

/**
 * Grants excerpts in edit order while the message still fits. Excerpts are the
 * most expendable detail, so granting one never shortens another reason.
 */
function grantExcerpts(
  failures: readonly EditFailure[],
  availableChars: number,
  availableBytes: number,
): boolean[] {
  let chars = availableChars - failures.reduce((total, failure) => total + failure.reason.length, 0);
  let bytes = availableBytes - failures.reduce((total, failure) => total + encodedBytes(failure.reason), 0);
  return failures.map((failure) => {
    if (!failure.excerpt) return false;
    const addition = `; ${failure.excerpt}`;
    const byteCost = encodedBytes(addition);
    if (addition.length > chars || byteCost > bytes) return false;
    chars -= addition.length;
    bytes -= byteCost;
    return true;
  });
}

/**
 * The longest prefix of `reason` within both limits, ending in an ellipsis. It
 * never splits a surrogate pair in a shortened source excerpt.
 */
function shortenReason(reason: string, charLimit: number, byteLimit: number): string {
  if (reason.length <= charLimit && encodedBytes(reason) <= byteLimit) return reason;
  const budget = byteLimit - encodedBytes('…');
  let end = 0;
  let bytes = 0;
  while (end < reason.length) {
    const width = /[\uD800-\uDBFF]/.test(reason[end]) && /[\uDC00-\uDFFF]/.test(reason[end + 1] ?? '') ? 2 : 1;
    const cost = encodedBytes(reason.slice(end, end + width));
    if (end + width > charLimit - 1 || bytes + cost > budget) break;
    bytes += cost;
    end += width;
  }
  return `${reason.slice(0, end)}…`;
}

function fitsDiagnosticBounds(message: string): boolean {
  return message.length <= EDIT_DIAGNOSTIC_MAX_CHARS && encodedBytes(message) <= EDIT_DIAGNOSTIC_MAX_BODY_BYTES;
}

function formatEditFailures(failures: readonly EditFailure[], editCount: number): string {
  if (editCount === 1) {
    const prefix = 'Workspace edit did not apply and nothing was written: ';
    const detailed = `${prefix}${failures[0] ? failureText(failures[0], true) : 'no match'}.`;
    if (fitsDiagnosticBounds(detailed)) return detailed;
    const reason = shortenReason(
      failures[0]?.reason ?? 'no match',
      EDIT_DIAGNOSTIC_MAX_CHARS - prefix.length - 1,
      EDIT_DIAGNOSTIC_MAX_BODY_BYTES - encodedBytes(prefix) - 1,
    );
    return `${prefix}${reason}.`;
  }
  const header = `${failures.length} of ${editCount} workspace edits did not apply, so nothing was written. Every other edit matched.`;
  const footer = failures.some((failure) => failure.index > 0)
    ? '\nLine numbers account for the earlier edits in this batch.'
    : '';
  const prefixes = failures.map((failure) => `\nEdit ${failure.index + 1}: `);
  // Labels and punctuation for every failing position take priority over long
  // reasons or source excerpts. Never leave callers guessing which edits failed.
  const available = EDIT_DIAGNOSTIC_MAX_CHARS - header.length - footer.length -
    prefixes.reduce((total, prefix) => total + prefix.length + 1, 0);
  const frame = header + footer + prefixes.join('') + '.'.repeat(failures.length);
  const availableBytes = EDIT_DIAGNOSTIC_MAX_BODY_BYTES - encodedBytes(frame);
  const granted = grantExcerpts(failures, available, availableBytes);
  const reasons = failures.map((failure, index) => failureText(failure, granted[index]));
  const reasonLength = reasons.reduce((total, reason) => total + reason.length, 0);
  const reasonBytes = reasons.reduce((total, reason) => total + encodedBytes(reason), 0);
  const charLimit = reasonLength <= available ? Infinity : Math.floor(available / failures.length);
  const byteLimit = reasonBytes <= availableBytes ? Infinity : Math.floor(availableBytes / failures.length);
  const details = reasons.map((reason, index) =>
    `${prefixes[index]}${shortenReason(reason, charLimit, byteLimit)}.`,
  );
  return header + details.join('') + footer;
}
