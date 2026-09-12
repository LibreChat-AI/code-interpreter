import { expect, test } from 'bun:test';
import path from 'node:path';

function readHttpInputCacheDefault(value?: string): boolean {
  const env = { ...process.env };
  if (value === undefined) delete env.SANDBOX_HTTP_INPUT_CACHE_ENABLED;
  else env.SANDBOX_HTTP_INPUT_CACHE_ENABLED = value;
  const script = [
    `const { config } = await import(${JSON.stringify(path.resolve(process.cwd(), 'src/config.ts'))})`,
    'process.stdout.write(JSON.stringify(config.http_input_cache_enabled))',
  ].join(';');
  const result = Bun.spawnSync({ cmd: [process.execPath, '--eval', script], env });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString()) as boolean;
}

test('authorized HTTP input reuse defaults on and retains an explicit rollback switch', () => {
  expect(readHttpInputCacheDefault()).toBe(true);
  expect(readHttpInputCacheDefault('false')).toBe(false);
  expect(readHttpInputCacheDefault('true')).toBe(true);
});
