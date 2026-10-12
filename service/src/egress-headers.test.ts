import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('deployed egress command accepts scoped grants above 16 KiB, with a finite cap', async () => {
  const dockerfile = readFileSync(new URL('../Dockerfile.egress-gateway', import.meta.url), 'utf8');
  const command: string[] = JSON.parse(dockerfile.match(/^CMD (.+)$/m)![1]);
  const bundledDockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const commands: string[][] = [...dockerfile.matchAll(/^CMD (.+)$/gm),
    ...bundledDockerfile.matchAll(/^CMD (.+egress-gateway.+)$/gm)]
    .map(match => JSON.parse(match[1]));
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  commands.push(packageJson.scripts['start:egress-gateway'].split(' '));
  expect(commands).toHaveLength(4);
  for (const entrypoint of commands) expect(entrypoint).toContain('--max-http-header-size=262144');
  const probe = `
    const http = require('node:http');
    const server = http.createServer((req, res) => res.end('ok'));
    server.listen(0, '127.0.0.1', async () => {
      try {
        const statuses = [];
        for (const size of [32768, 280000]) {
          const response = await fetch('http://127.0.0.1:' + server.address().port, {
            headers: { 'X-CodeAPI-Egress-Grant': 'a'.repeat(size) },
          });
          statuses.push(response.status);
          await response.text();
        }
        console.log(JSON.stringify(statuses));
      } finally { server.close(); }
    });`;
  const directory = mkdtempSync(join(tmpdir(), 'codeapi-header-test-'));
  const script = join(directory, 'probe.cjs');
  writeFileSync(script, probe);
  const run = async (options: string[]) => {
    const child = Bun.spawn([process.execPath, ...options, script], { stdout: 'pipe', stderr: 'pipe' });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    if (await child.exited !== 0) throw new Error(stderr);
    expect(await child.exited).toBe(0);
    return JSON.parse(stdout);
  };
  try {
    expect(await run(['run'])).toEqual([431, 431]);
    // Preserve the deployed command's argument order, replacing only the file.
    expect(await run(command.slice(1, -1))).toEqual([200, 431]);
  } finally { rmSync(directory, { recursive: true }); }
});
