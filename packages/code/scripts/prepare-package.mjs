import { execFileSync } from 'node:child_process';
import { copyFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
// Never carry stale compiler output or scratch files into the published artifact.
await rm(new URL('../dist/', import.meta.url), {
    recursive: true,
    force: true,
});
execFileSync(
    process.execPath,
    [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'],
    {
        cwd: packageRoot,
        stdio: 'inherit',
    }
);
for (const name of ['LICENSE', 'NOTICE']) {
    await copyFile(
        new URL(`../../../${name}`, import.meta.url),
        new URL(`../${name}`, import.meta.url)
    );
}
