import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyTextEdits,
  EDIT_DIAGNOSTIC_MAX_CHARS,
  WorkspaceEditMatchError,
  WorkspaceEditOutputLimitError,
} from './edits.js';

function rejection(run: () => unknown): WorkspaceEditMatchError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof WorkspaceEditMatchError);
    return error;
  }
  assert.fail('expected the edits to be rejected');
}

test('exact matching keeps its single-location contract', () => {
  const applied = applyTextEdits('alpha\nbeta\n', [{ oldText: 'beta', newText: 'gamma' }]);
  assert.deepEqual(applied, {
    text: 'alpha\ngamma\n',
    matches: [{ strategy: 'exact', occurrences: 1 }],
  });
});

test('overlapping occurrences make an exact edit ambiguous', () => {
  const error = rejection(() => applyTextEdits('aaa', [{ oldText: 'aa', newText: 'b' }]));
  assert.match(error.message, /matched 2 locations/);
  const applied = applyTextEdits('aaaa', [{ oldText: 'aa', newText: 'b', replaceAll: true }]);
  assert.deepEqual(applied, { text: 'bb', matches: [{ strategy: 'exact', occurrences: 2 }] });
});

test('later edits see the result of earlier ones', () => {
  const applied = applyTextEdits('one', [
    { oldText: 'one', newText: 'two' },
    { oldText: 'two', newText: 'three' },
  ]);
  assert.equal(applied.text, 'three');
});

test('an ambiguous edit names every location instead of a bare conflict', () => {
  const text = 'const a = 1;\nreturn a;\nconst b = 2;\nreturn a;\n';
  const error = rejection(() =>
    applyTextEdits(text, [{ oldText: 'return a;', newText: 'return b;' }]),
  );
  assert.match(error.message, /matched 2 locations at lines 2, 4/);
  assert.match(error.message, /include more surrounding lines/);
  assert.match(error.message, /nothing was written/);
});

test('a batch reports every failing edit with its position in one rejection', () => {
  const text = 'a\nb\nc\nb\n';
  const error = rejection(() =>
    applyTextEdits(text, [
      { oldText: 'a', newText: 'A' },
      { oldText: 'missing', newText: 'x' },
      { oldText: 'c', newText: 'C' },
      { oldText: 'b', newText: 'B' },
    ]),
  );
  assert.deepEqual(
    error.failures.map((failure) => failure.index),
    [1, 3],
  );
  assert.match(error.message, /^2 of 4 workspace edits did not apply/);
  assert.match(error.message, /\nEdit 2: old_text was not found/);
  assert.match(error.message, /\nEdit 4: old_text matched 2 locations at lines 2, 4/);
});

test('a missing edit points at the line it most likely meant', () => {
  const text = 'function load(user) {\n  return fetchUser(user.id);\n}\n';
  const error = rejection(() =>
    applyTextEdits(text, [
      { oldText: 'function load(user) {\n  return fetchUser(user);\n}', newText: 'x' },
    ]),
  );
  assert.match(error.message, /its first line appears at line 1, but the lines after it differ/);
});

test('a missing edit explains elided and line-numbered old_text', () => {
  const text = 'start\nmiddle\nend\n';
  const elided = rejection(() =>
    applyTextEdits(text, [{ oldText: 'start\n// ...\nend', newText: 'x' }]),
  );
  assert.match(elided.message, /elision placeholder/);
  const numbered = rejection(() =>
    applyTextEdits(text, [{ oldText: '1 | start\n2 | middle', newText: 'x' }]),
  );
  assert.match(numbered.message, /line-number prefixes/);
});

test('exact mode says when only the whitespace differs', () => {
  const shifted = rejection(() =>
    applyTextEdits('class A {\n    a();\n    b();\n}\n', [{ oldText: 'a();\nb();', newText: 'x' }]),
  );
  assert.match(shifted.message, /exists at line 2 with different whitespace \(indentation-flexible\)/);
  const reflowed = rejection(() =>
    applyTextEdits('if (ready) {\n    run();\n}\n', [
      { oldText: 'if (ready) {\n  run();\n}', newText: 'x' },
    ]),
  );
  assert.match(reflowed.message, /exists at line 1 with different whitespace \(whitespace-normalized\)/);
});

test('tolerant matching ignores trailing whitespace and keeps CRLF line endings', () => {
  const text = 'first  \r\nsecond\t\r\nthird\r\n';
  const applied = applyTextEdits(
    text,
    [{ oldText: 'first\nsecond', newText: 'one\ntwo' }],
    'tolerant',
  );
  assert.equal(applied.text, 'one\r\ntwo\r\nthird\r\n');
  assert.deepEqual(applied.matches, [{ strategy: 'line-trimmed', occurrences: 1 }]);
});

test('a trailing newline in old_text matches through the line terminator', () => {
  const text = 'keep\ndrop\nkeep too\n';
  const applied = applyTextEdits(text, [{ oldText: 'drop  \n', newText: '' }], 'tolerant');
  assert.equal(applied.text, 'keep\nkeep too\n');
});

test('indentation-flexible matches move new_text to the file indentation', () => {
  const text = 'class A {\n    method() {\n        return 1;\n    }\n}\n';
  const applied = applyTextEdits(
    text,
    [
      {
        oldText: 'method() {\n    return 1;\n}',
        newText: 'method() {\n    const value = 2;\n    return value;\n}',
      },
    ],
    'tolerant',
  );
  assert.equal(
    applied.text,
    'class A {\n    method() {\n        const value = 2;\n        return value;\n    }\n}\n',
  );
  assert.deepEqual(applied.matches, [{ strategy: 'indentation-flexible', occurrences: 1 }]);
});

test('whitespace-normalized matches do not splice prefixes or suffixes of tokens', () => {
  for (const [source, oldText] of [
    ['prereturn   value;\n', 'return value;'],
    ['return   valueSuffix\n', 'return value'],
    ['return   value;postfix\n', 'return value;'],
  ]) {
    const error = rejection(() => applyTextEdits(source, [{ oldText, newText: 'changed' }], 'tolerant'));
    assert.match(error.message, /old_text was not found/);
  }
  const valid = applyTextEdits('return   value;\n', [
    { oldText: 'return value;', newText: 'return changed;' },
  ], 'tolerant');
  assert.equal(valid.text, 'return changed;\n');
  assert.deepEqual(valid.matches, [{ strategy: 'whitespace-normalized', occurrences: 1 }]);
});

test('large whitespace-normalized edits match without compiling a request-sized regular expression', () => {
  const oldText = `head ${'part '.repeat(16_000)}tail`;
  const source = `before ${oldText.replace(/ /g, '\t')} after`;
  const applied = applyTextEdits(source, [{ oldText, newText: 'result' }], 'tolerant');
  assert.equal(applied.text, 'before result after');
  assert.deepEqual(applied.matches, [{ strategy: 'whitespace-normalized', occurrences: 1 }]);
});

test('whitespace-normalized matches count overlapping token sequences but replaceAll does not overlap', () => {
  const source = 'a  b   a\tb  a';
  const edit = { oldText: 'a b a', newText: 'x' };
  const error = rejection(() => applyTextEdits(source, [edit], 'tolerant'));
  assert.match(error.message, /matched 2 locations/);
  const replaced = applyTextEdits(source, [{ ...edit, replaceAll: true }], 'tolerant');
  assert.equal(replaced.text, 'x\tb  a');
  assert.deepEqual(replaced.matches, [{ strategy: 'whitespace-normalized', occurrences: 1 }]);
});

for (const fileEnding of ['\n', '\r\n'] as const) {
  for (const [oldEnding, newEnding] of [['\r\n', '\n'], ['\n', '\r\n']] as const) {
    test(`whitespace-normalized matching peels ${JSON.stringify(oldEnding)} to ${JSON.stringify(newEnding)} in ${JSON.stringify(fileEnding)} files`, () => {
      const source = `foo   bar${fileEnding}next`;
      const result = applyTextEdits(source, [{
        oldText: `foo bar${oldEnding}`,
        newText: `baz qux${newEnding}`,
      }], 'tolerant');
      assert.equal(result.text, `baz qux${fileEnding}next`);
      assert.deepEqual(result.matches, [{ strategy: 'whitespace-normalized', occurrences: 1 }]);
    });
  }
}

test('whitespace-normalized matching peels leading and trailing CRLF/LF wrappers in a batch', () => {
  const result = applyTextEdits('header\r\n \tfoo   bar\r\nnext\r\n', [
    { oldText: '\n  foo bar\r\n', newText: '\r\n  baz qux\n' },
    { oldText: 'next', newText: 'done' },
  ], 'tolerant');
  assert.equal(result.text, 'header\r\n \tbaz qux\r\ndone\r\n');
  assert.deepEqual(result.matches, [
    { strategy: 'whitespace-normalized', occurrences: 1 },
    { strategy: 'exact', occurrences: 1 },
  ]);
});

test('whitespace-normalized matching peels a trailing newline even if adjacent spaces differ', () => {
  const result = applyTextEdits('foo   bar  \r\nnext', [{
    oldText: 'foo bar  \r\n', newText: 'baz qux\n',
  }], 'tolerant');
  assert.equal(result.text, 'baz qux  \r\nnext');
});

test('whitespace-normalized matching does not prepend new indentation beside preserved source indentation', () => {
  const source = 'header\n  foo   bar\n';
  const result = applyTextEdits(source, [{
    oldText: '\n  foo bar', newText: '\n\tbaz qux',
  }], 'tolerant');
  assert.equal(result.text, 'header\n  baz qux\n');
  assert.deepEqual(result.matches, [{ strategy: 'whitespace-normalized', occurrences: 1 }]);
});

test('whitespace-normalized matching does not duplicate differing trailing spaces', () => {
  const result = applyTextEdits('foo   bar  \nnext', [{
    oldText: 'foo bar  \n', newText: 'baz qux\t\n',
  }], 'tolerant');
  assert.equal(result.text, 'baz qux  \nnext');
});

test('whitespace-normalized matching peels a leading newline even if adjacent spaces differ', () => {
  const result = applyTextEdits('header\r\n  foo   bar\r\nnext', [{
    oldText: '\n  foo bar', newText: '\nchanged',
  }], 'tolerant');
  assert.equal(result.text, 'header\r\n  changed\r\nnext');
});

test('whitespace-normalized matching rejects absent required boundary whitespace', () => {
  const cases = [
    { source: 'foo   bar', oldText: 'foo bar\r\n', newText: 'baz qux\n' },
    { source: 'foo   bar next', oldText: 'foo bar\n', newText: 'baz qux\n' },
    { source: 'previous foo   bar', oldText: '\nfoo bar', newText: '\nbaz qux' },
    { source: 'foo   bar', oldText: ' foo bar', newText: ' baz qux' },
    { source: 'foo   bar', oldText: 'foo bar ', newText: 'baz qux ' },
    { source: 'foo   bar\nnext', oldText: 'foo bar\n\n', newText: 'baz qux\n\n' },
    { source: 'header\nfoo   bar\nnext', oldText: '\n\nfoo bar', newText: '\n\nbaz qux' },
  ];
  for (const edit of cases) {
    const { source, ...request } = edit;
    const error = rejection(() => applyTextEdits(source, [request], 'tolerant'));
    assert.match(error.message, /old_text was not found/, `unmatched boundary: ${JSON.stringify(edit)}`);
  }
});

test('whitespace-normalized scanning skips boundary-invalid matches and keeps later valid ones', () => {
  const source = 'header foo   bar header\nfoo   bar\nend';
  const result = applyTextEdits(source, [{
    oldText: '\nfoo bar\n', newText: '\nbaz qux\n', replaceAll: true,
  }], 'tolerant');
  assert.equal(result.text, 'header foo   bar header\nbaz qux\nend');
  assert.deepEqual(result.matches, [{ strategy: 'whitespace-normalized', occurrences: 1 }]);
});

test('whitespace-normalized matching rejects boundary removal outside its token range', () => {
  const cases = [
    { source: 'foo   bar\r\nnext', oldText: 'foo bar\r\n', newText: 'baz qux' },
    { source: 'header\r\n  foo   bar', oldText: '\n  foo bar', newText: 'baz qux' },
    { source: '  foo   bar', oldText: '  foo bar', newText: 'baz qux' },
    { source: 'foo   bar ', oldText: 'foo bar ', newText: 'baz qux' },
    { source: 'header\nfoo   bar\nnext', oldText: '\nfoo bar\n', newText: '\n' },
    { source: 'foo   bar\n\nnext', oldText: 'foo bar\n\n', newText: 'baz qux\n' },
  ];
  for (const edit of cases) {
    const { source, ...request } = edit;
    const error = rejection(() => applyTextEdits(source, [request], 'tolerant'));
    assert.match(error.message, /old_text was not found/, `unremovable boundary: ${JSON.stringify(edit)}`);
  }
  const exact = applyTextEdits('foo bar\r\nnext', [{
    oldText: 'foo bar\r\n', newText: 'baz qux',
  }], 'tolerant');
  assert.equal(exact.text, 'baz quxnext');
  assert.deepEqual(exact.matches, [{ strategy: 'exact', occurrences: 1 }]);
});

test('whitespace-normalized matching preserves two present boundary line breaks', () => {
  const result = applyTextEdits('foo   bar\n\nnext', [{
    oldText: 'foo bar\r\n\r\n', newText: 'baz qux\n\n',
  }], 'tolerant');
  assert.equal(result.text, 'baz qux\n\nnext');
});

test('whitespace-normalized matching preserves an intentional extra line break', () => {
  const result = applyTextEdits('foo   bar\r\nnext', [{
    oldText: 'foo bar\r\n', newText: 'baz qux\n\n',
  }], 'tolerant');
  assert.equal(result.text, 'baz qux\r\n\r\nnext');
});

test('line-trimmed replacements adopt the matched line ending in mixed files', () => {
  const source = 'header\r\nfoo  \nbar  \nnext\n';
  const result = applyTextEdits(source, [{ oldText: 'foo\nbar', newText: 'baz\nqux' }], 'tolerant');
  assert.equal(result.text, 'header\r\nbaz\nqux\nnext\n');
  assert.deepEqual(result.matches, [{ strategy: 'line-trimmed', occurrences: 1 }]);
});

test('indentation-flexible replacements keep the selected line ending in mixed files', () => {
  const source = 'header\r\n    method() {\n        return 1;\n    }\nend\n';
  const result = applyTextEdits(source, [{
    oldText: 'method() {\n    return 1;\n}',
    newText: 'method() {\r\n    return 2;\r\n}',
  }], 'tolerant');
  assert.equal(result.text, 'header\r\n    method() {\n        return 2;\n    }\nend\n');
  assert.deepEqual(result.matches, [{ strategy: 'indentation-flexible', occurrences: 1 }]);
});

test('line-trimmed replaceAll keeps each local ending in mixed files', () => {
  const source = 'foo  \r\nbar  \r\nfoo  \nbar  \nend';
  const result = applyTextEdits(source, [{
    oldText: 'foo\nbar', newText: 'baz\nqux', replaceAll: true,
  }], 'tolerant');
  assert.equal(result.text, 'baz\r\nqux\r\nbaz\nqux\nend');
  assert.deepEqual(result.matches, [{ strategy: 'line-trimmed', occurrences: 2 }]);
});

test('exact replacements preserve caller line endings rather than normalizing them', () => {
  const source = 'foo bar\r\nnext\r\n';
  const result = applyTextEdits(source, [{ oldText: 'foo bar\r\n', newText: 'baz qux\n' }], 'tolerant');
  assert.equal(result.text, 'baz qux\nnext\r\n');
  assert.deepEqual(result.matches, [{ strategy: 'exact', occurrences: 1 }]);
});

test('whitespace-normalized replacement adopts the matched line ending in mixed files', () => {
  const original = 'header\r\nfoo   bar\nnext\n';
  const result = applyTextEdits(original, [{
    oldText: 'foo bar\n', newText: 'baz\nqux\n',
  }], 'tolerant');
  assert.equal(result.text, 'header\r\nbaz\nqux\nnext\n');
});

test('whitespace-normalized replaceAll peels boundary newlines on every mixed-ending match', () => {
  const source = 'foo   bar\r\nfoo   bar\nend';
  const result = applyTextEdits(source, [{
    oldText: 'foo bar\r\n', newText: 'baz qux\n', replaceAll: true,
  }], 'tolerant');
  assert.equal(result.text, 'baz qux\r\nbaz qux\nend');
  assert.deepEqual(result.matches, [{ strategy: 'whitespace-normalized', occurrences: 2 }]);
});

test('whitespace-normalized replaceAll uses each matched line ending in mixed files', () => {
  const source = 'foo   bar\r\nfoo   bar\nend';
  const result = applyTextEdits(source, [{
    oldText: 'foo bar', newText: 'baz\nqux', replaceAll: true,
  }], 'tolerant');
  assert.equal(result.text, 'baz\r\nqux\r\nbaz\nqux\nend');
  assert.deepEqual(result.matches, [{ strategy: 'whitespace-normalized', occurrences: 2 }]);
});

test('whitespace-normalized replaceAll finds many same-line matches without rescanning newline tails', () => {
  const source = 'foo   bar '.repeat(16_000);
  const start = performance.now();
  const result = applyTextEdits(source, [{
    oldText: 'foo bar', newText: 'baz\nqux', replaceAll: true,
  }], 'tolerant');
  assert.equal(result.text, 'baz\nqux '.repeat(16_000));
  assert.deepEqual(result.matches, [{ strategy: 'whitespace-normalized', occurrences: 16_000 }]);
  assert.ok(performance.now() - start < 2_000, 'line endings must not be searched from each match');
});

test('whitespace-normalized matches do not indent new_text twice', () => {
  const text = '    total =   price *\n        quantity;\n';
  const applied = applyTextEdits(
    text,
    [{ oldText: '  total = price * quantity;', newText: '  total = price * quantity * rate;' }],
    'tolerant',
  );
  assert.equal(applied.text, '    total = price * quantity * rate;\n');
  assert.deepEqual(applied.matches, [{ strategy: 'whitespace-normalized', occurrences: 1 }]);
});

test('tolerant matching still refuses an ambiguous edit', () => {
  const error = rejection(() =>
    applyTextEdits('x = 1  \ny = 2\nx = 1\n', [{ oldText: 'x = 1', newText: 'x = 3' }], 'tolerant'),
  );
  assert.match(error.message, /matched 2 locations at lines 1, 3/);
});

test('exact overlap counts UTF-16 offsets while replaceAll consumes whole characters', () => {
  const error = rejection(() => applyTextEdits('😀😀😀', [
    { oldText: '😀😀', newText: 'x' },
  ]));
  assert.match(error.message, /matched 2 locations/);
  const result = applyTextEdits('😀😀😀', [{ oldText: '😀😀', newText: 'x', replaceAll: true }]);
  assert.equal(result.text, 'x😀');
  assert.deepEqual(result.matches, [{ strategy: 'exact', occurrences: 1 }]);
});

test('long overlapping exact matches are counted without repeatedly rescanning the input', () => {
  const text = 'a'.repeat(450_000);
  const oldText = 'a'.repeat(220_000);
  const started = performance.now();
  const error = rejection(() => applyTextEdits(text, [{ oldText, newText: 'b' }]));
  assert.match(error.message, /matched 230001 locations/);
  assert.ok(performance.now() - started < 3_000, 'overlapping ambiguity must be counted in linear time');
});

test('highly repeated exact matches report the count with bounded line samples', () => {
  const error = rejection(() => applyTextEdits('z'.repeat(200_000), [
    { oldText: 'z', newText: 'y' },
  ]));
  assert.match(error.message, /matched 200000 locations at lines 1, 1, 1, 1, 1 and 199995 more/);
});

test('replaceAll replaces every location and reports the count', () => {
  const applied = applyTextEdits('foo(); bar(); foo();', [
    { oldText: 'foo()', newText: 'baz()', replaceAll: true },
  ]);
  assert.equal(applied.text, 'baz(); bar(); baz();');
  assert.deepEqual(applied.matches, [{ strategy: 'exact', occurrences: 2 }]);
});

test('replaceAll over line windows never overlaps its own matches', () => {
  const applied = applyTextEdits(
    'a\na\na\na\n',
    [{ oldText: 'a\na', newText: 'b', replaceAll: true }],
    'tolerant',
  );
  assert.equal(applied.text, 'b\nb\n');
  assert.deepEqual(applied.matches, [{ strategy: 'exact', occurrences: 2 }]);
});

test('replaceAll bounds memory for a million identical and changed matches', () => {
  const source = 'x'.repeat(1024 * 1024);
  const noop = applyTextEdits(source, [
    { oldText: 'x', newText: 'x', replaceAll: true },
    { oldText: 'x', newText: 'y', replaceAll: true },
  ]);
  assert.equal(noop.text, 'y'.repeat(source.length));
  assert.deepEqual(noop.matches, [
    { strategy: 'exact', occurrences: source.length },
    { strategy: 'exact', occurrences: source.length },
  ]);
});

test('replaceAll preserves non-overlapping literal edits when identical hits precede changed hits', () => {
  for (const [source, oldText, newText] of [
    ['aaaaa', 'aa', 'a'],
    ['foo foo foo', 'foo', 'bar'],
    ['😀😀😀', '😀😀', 'x'],
    ['x\nx\nx', 'x', ''],
    ['aba aba', 'aba', 'aba'],
  ]) {
    const result = applyTextEdits(source, [{ oldText, newText, replaceAll: true }]);
    assert.equal(result.text, source.split(oldText).join(newText));
    assert.deepEqual(result.matches, [{ strategy: 'exact', occurrences: source.split(oldText).length - 1 }]);
  }
  const source = 'foo\tbar foo  bar';
  const tolerant = applyTextEdits(source, [{
    oldText: 'foo bar', newText: 'foo\tbar', replaceAll: true,
  }], 'tolerant');
  assert.equal(tolerant.text, 'foo\tbar foo\tbar');
  assert.deepEqual(tolerant.matches, [{ strategy: 'whitespace-normalized', occurrences: 2 }]);
});

test('replaceAll handles repeated tolerant and non-overlapping line-window matches', () => {
  const lines = 'foo  \r\nbar  \r\n'.repeat(4000);
  const result = applyTextEdits(lines, [
    { oldText: 'foo\nbar', newText: 'baz\nqux', replaceAll: true },
    { oldText: 'baz qux', newText: 'updated', replaceAll: true },
  ], 'tolerant');
  assert.equal(result.text, 'updated\r\n'.repeat(4000));
  assert.deepEqual(result.matches, [
    { strategy: 'line-trimmed', occurrences: 4000 },
    { strategy: 'whitespace-normalized', occurrences: 4000 },
  ]);
});

test('replaceAll rejects oversized intermediate output before constructing it', () => {
  assert.throws(
    () => applyTextEdits('x'.repeat(1_000_000), [
      { oldText: 'x', newText: 'y'.repeat(100_000), replaceAll: true },
    ]),
    WorkspaceEditOutputLimitError,
  );
});

test('replaceAll still fails when nothing matches', () => {
  const error = rejection(() =>
    applyTextEdits('abc', [{ oldText: 'xyz', newText: '', replaceAll: true }]),
  );
  assert.match(error.message, /old_text was not found/);
});

test('line diagnostic index follows earlier successful batch edits', () => {
  const error = rejection(() => applyTextEdits('alpha\nbeta\n', [
    { oldText: 'not present', newText: 'skip' },
    { oldText: 'alpha', newText: 'first\nsecond' },
    { oldText: 'beta\nmissing', newText: 'nope' },
  ]));
  assert.match(error.message, /Edit 3: old_text was not found; its first line appears at line 3/);
});

test('newline-dense files do not materialize millions of line objects across failed batch edits', () => {
  const source = 'a\n'.repeat(450_000);
  const edits = Array.from({ length: 80 }, () => ({ oldText: 'missing\ntext', newText: 'other' }));
  const started = performance.now();
  const error = rejection(() => applyTextEdits(source, edits));
  assert.equal(error.failures.length, edits.length);
  assert.ok(performance.now() - started < 10_000, 'a bounded file must not re-index every failed diagnostic');
});

test('first-line hints report bounded samples even when the line repeats throughout a file', () => {
  const error = rejection(() => applyTextEdits('a\n'.repeat(100_000), [
    { oldText: 'a\nmissing', newText: 'replacement' },
  ]));
  assert.match(error.message, /its first line appears at lines 1, 2, 3, 4, 5 and 99995 more/);
});

test('repetitive indentation candidates fail closed after a bounded comparison budget', () => {
  const error = rejection(() => applyTextEdits('    a\n'.repeat(1_200), [
    { oldText: `${'a\n'.repeat(199)}a`, newText: 'changed' },
  ], 'tolerant'));
  assert.match(error.message, /too many repetitive line-window candidates/);
});

test('repetitive long line windows return a missing-edit diagnosis without quadratic scans', () => {
  const text = 'line\n'.repeat(24_000);
  const oldText = `${'line\n'.repeat(6_000)}missing`;
  const started = performance.now();
  const error = rejection(() => applyTextEdits(text, [{ oldText, newText: 'replacement' }]));
  assert.match(error.message, /did not apply and nothing was written/);
  assert.ok(performance.now() - started < 2_000, 'a bounded edit must not compare every long window');
});

test('a hundred failing multi-line edits on a large file are diagnosed quickly', () => {
  const text = Array.from({ length: 30_000 }, (_, index) => `    line ${index} = value;`).join('\n');
  const edits = Array.from({ length: 100 }, (_, index) => ({
    oldText: `line ${index} = value;\n  other ${index};\n  more ${index};`,
    newText: 'y',
  }));
  const started = performance.now();
  rejection(() => applyTextEdits(text, edits));
  assert.ok(performance.now() - started < 5_000);
});

test('diagnostics for a hundred failing edits stay within the settlement bound', () => {
  const edits = Array.from({ length: 100 }, (_, index) => ({
    oldText: `missing ${'x'.repeat(200)} ${index}`,
    newText: 'y',
  }));
  const error = rejection(() => applyTextEdits('content\n'.repeat(1000), edits));
  assert.ok(error.message.length <= EDIT_DIAGNOSTIC_MAX_CHARS);
  assert.match(error.message, /^100 of 100 workspace edits did not apply/);
  assert.match(error.message, /more failing edits not shown/);
});
