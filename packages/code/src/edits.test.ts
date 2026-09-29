import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyTextEdits,
  EDIT_DIAGNOSTIC_MAX_CHARS,
  WorkspaceEditMatchError,
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

test('replaceAll still fails when nothing matches', () => {
  const error = rejection(() =>
    applyTextEdits('abc', [{ oldText: 'xyz', newText: '', replaceAll: true }]),
  );
  assert.match(error.message, /old_text was not found/);
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
