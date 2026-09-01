import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const wrapper = path.resolve(__dirname, '../../docker/bash-run.sh');

describe('Bash RTK run wrapper', () => {
  let tempDir: string;
  let sourcePath: string;
  let mockBin: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeapi-rtk-test-'));
    sourcePath = path.join(tempDir, 'script.sh');
    mockBin = path.join(tempDir, 'bin');
    fs.mkdirSync(mockBin);
    fs.writeFileSync(sourcePath, "printf 'raw:%s\\n' \"${1:-none}\"\n");
    fs.writeFileSync(path.join(mockBin, 'rtk'), `#!/bin/bash
case "\${MOCK_RTK_STATUS:-0}" in
  0|3) printf '%s\\n' 'printf '\"'\"'filtered:%s\\n'\"'\"' "$1"' ;;
  *) printf '%s\\n' 'printf '\"'\"'must-not-run\\n'\"'\"'' ;;
esac
exit "\${MOCK_RTK_STATUS:-0}"
`);
    fs.chmodSync(path.join(mockBin, 'rtk'), 0o755);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(options: {
    filter?: 'raw' | 'rtk';
    status?: number;
    args?: string[];
  } = {}): string {
    return execFileSync('bash', [wrapper, sourcePath, ...(options.args ?? [])], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        CODEAPI_SHELL_OUTPUT_FILTER: options.filter ?? 'raw',
        MOCK_RTK_STATUS: String(options.status ?? 0),
      },
    });
  }

  it('preserves raw execution when the request does not opt in', () => {
    expect(run()).toBe('raw:none\n');
  });

  it('executes RTK rewrites and preserves user script arguments', () => {
    expect(run({ filter: 'rtk', args: ['argument'] })).toBe('filtered:argument\n');
  });

  it('preserves the submitted path as $0 and BASH_ARGV0 for rewrites', () => {
    fs.writeFileSync(path.join(mockBin, 'rtk'), `#!/bin/bash
printf '%s\\n' 'printf "identity:%s:%s:%s\\n" "$0" "$BASH_ARGV0" "$1"'
`);
    fs.chmodSync(path.join(mockBin, 'rtk'), 0o755);

    expect(run({ filter: 'rtk', args: ['argument'] })).toBe(
      `identity:${sourcePath}:${sourcePath}:argument\n`,
    );
  });

  it('preserves file execution for scripts that inspect BASH_SOURCE', () => {
    fs.writeFileSync(
      sourcePath,
      'printf \'identity:%s:%s\\n\' "${BASH_SOURCE[0]}" "$0"\n',
    );

    expect(run({ filter: 'rtk' })).toBe(`identity:${sourcePath}:${sourcePath}\n`);
  });

  it('accepts RTK ask rewrites because the API request already authorizes execution', () => {
    expect(run({ filter: 'rtk', status: 3 })).toBe('filtered:\n');
  });

  it('fails open to the original script when RTK cannot rewrite the command', () => {
    expect(run({ filter: 'rtk', status: 1, args: ['original'] })).toBe('raw:original\n');
    expect(run({ filter: 'rtk', status: 2, args: ['original'] })).toBe('raw:original\n');
  });
});
