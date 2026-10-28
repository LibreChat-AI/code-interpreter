import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('supervisor has no parser or application stack dependencies', async () => {
    const manifest = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8')
    );
    assert.equal(manifest.dependencies, undefined);
    for (const name of ['server.ts', 'backend.ts', 'protocol.ts', 'main.ts']) {
        const source = await readFile(
            new URL(`../src/${name}`, import.meta.url),
            'utf8'
        );
        for (const match of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
            assert.ok(
                match[1]?.startsWith('node:') || match[1]?.startsWith('./'),
                match[1]
            );
        }
    }
});
