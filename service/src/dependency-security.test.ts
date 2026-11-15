import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

test.each(['deepmerge', 'deepmerge/dist/umd.js'])(
  '%s preserves own prototype keys as data without poisoning the result',
  entry => {
    const merge = require(entry);
    const payload = JSON.parse('{"__proto__":{"polluted":true},"nested":{"__proto__":{"polluted":true}}}');
    for (const result of [merge(payload, {}), merge(Object.create(null), payload)]) {
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(result.polluted).toBeUndefined();
      expect(Object.getPrototypeOf(result.nested)).toBe(Object.prototype);
      expect(result.nested.polluted).toBeUndefined();
    }
    expect(merge({ a: { b: 1 }, list: [1] }, { a: { c: 2 }, list: [2] }))
      .toEqual({ a: { b: 1, c: 2 }, list: [1, 2] });
    expect(Object.prototype).not.toHaveProperty('polluted');
  },
);

test('ESLint project-service glob matching works with the scoped minimatch upgrade', () => {
  const parser = require('@typescript-eslint/parser');
  const dir = mkdtempSync(path.join(tmpdir(), 'codeapi-parser-'));
  try {
    writeFileSync(path.join(dir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    const result = parser.parseForESLint('const value: number = 1;', {
      filePath: path.join(dir, 'fixture.ts'),
      tsconfigRootDir: dir,
      projectService: { allowDefaultProject: ['fixture.ts'] },
    });
    expect(result.services.program).toBeDefined();
    expect(result.ast.body).toHaveLength(1);
    // The legacy ESLint/glob consumers still require the callable v3 API.
    const eslintRequire = createRequire(require.resolve('eslint'));
    expect(eslintRequire('minimatch')('fixture.ts', '*.ts')).toBe(true);
  } finally {
    parser.clearCaches();
    rmSync(dir, { recursive: true, force: true });
  }
});
