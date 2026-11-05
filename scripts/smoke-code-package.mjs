import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function within(root, path) {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

function diagnostic(value) {
  return String(value)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/((?:_authToken|_auth|password|token)\s*[=:]\s*)[^\s]+/gi, '$1[redacted]')
    .slice(-8192);
}

function run(command, args, { cwd, timeoutMs = 30_000, env = {}, label = command } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    const tail = (previous, chunk) => Buffer.concat([previous, chunk]).subarray(-65_536);
    child.stdout.on('data', chunk => { stdout = tail(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = tail(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(new Error(`${label}: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) {
        resolveRun(stdout.toString('utf8'));
      } else {
        const status = timedOut ? `timed out after ${timeoutMs} ms` : `exit ${code}, signal ${signal ?? 'none'}`;
        reject(new Error(`${label}: ${status}\n${diagnostic(`${stdout}\n${stderr}`)}`));
      }
    });
  });
}

async function checkConsumer(expected) {
  const assert = (await import('node:assert/strict')).default;
  const { fork } = await import('node:child_process');
  const { randomBytes } = await import('node:crypto');
  const { constants } = await import('node:fs');
  const { access, lstat, open, readFile, readdir, realpath, stat } = await import('node:fs/promises');
  const { createRequire } = await import('node:module');
  const { isAbsolute, join, relative, resolve, sep } = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const consumer = await realpath(process.cwd());
  const modules = join(consumer, 'node_modules');
  const packageRoot = join(modules, '@librechat', 'code');
  assert.ok((await lstat(packageRoot)).isDirectory(), 'The package must be installed, not symlinked');
  assert.equal(await realpath(packageRoot), packageRoot);
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@librechat/code');
  assert.equal(manifest.name, expected.name);
  assert.equal(manifest.version, expected.version);
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/);
  console.log(`ok: installed ${manifest.name}@${manifest.version}`);

  assert.ok(manifest.exports && typeof manifest.exports === 'object' && !Array.isArray(manifest.exports));
  const specifiers = new Set(['@librechat/code']);
  for (const subpath of Object.keys(manifest.exports)) {
    assert.ok(subpath === '.' || subpath.startsWith('./'), `Unexpected export: ${subpath}`);
    assert.ok(!subpath.includes('*'), `Export patterns need concrete smoke cases: ${subpath}`);
    specifiers.add(subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`);
  }
  const entries = new Map();
  for (const specifier of specifiers) {
    const target = await realpath(fileURLToPath(import.meta.resolve(specifier)));
    assert.ok(within(packageRoot, target), `Export escaped the installed package: ${specifier}`);
    entries.set(specifier, await import(specifier));
  }
  console.log(`ok: imports (${entries.size}): ${[...entries.keys()].join(', ')}`);

  const require = createRequire(import.meta.url);
  for (const dependency of ['koffi', '@anthropic-ai/sandbox-runtime']) {
    const path = dependency === 'koffi' ? require.resolve(dependency) : fileURLToPath(import.meta.resolve(dependency));
    assert.ok(within(modules, await realpath(path)), `${dependency} resolved outside the consumer`);
  }
  const koffi = require('koffi');
  const getpid = koffi.load(null).func('int getpid()');
  assert.equal(getpid(), process.pid);
  console.log('ok: Koffi host native getpid()');

  const identity = entries.get('@librechat/code/identity');
  const enrollment = entries.get('@librechat/code/browser-enrollment');
  assert.ok(identity && enrollment, 'Identity and enrollment subpaths must be public');
  assert.equal(entries.get('@librechat/code').createBridgeIdentity, identity.createBridgeIdentity);
  const key = identity.createBridgeIdentity();
  const timestamp = new Date().toISOString();
  const token = () => randomBytes(32).toString('base64url');
  const request = {
    credential: 'package-smoke-placeholder', method: 'POST', path: '/v1/package-smoke',
    timestamp, nonce: token(), body: '{}',
  };
  const requestSignature = identity.signBridgeRequest(key.privateKey, request);
  assert.equal(identity.verifyBridgeRequest(key.publicKey, request, requestSignature), true);
  assert.equal(identity.verifyBridgeRequest(key.publicKey, { ...request, body: '{"changed":true}' }, requestSignature), false);
  const setup = {
    version: 1, instance: 'https://smoke.example.invalid', attemptId: token(), createdAt: timestamp,
    publicKey: key.publicKey, machineName: 'package-smoke', workspace: { type: 'private' },
    allowWorkspaceWrites: false, allowWorkspaceCommands: false,
  };
  const proof = {
    operation: 'setup.start', instance: setup.instance, attemptId: setup.attemptId,
    requestHash: enrollment.hashBrowserEnrollmentRequest(setup), timestamp, nonce: token(),
  };
  const proofSignature = enrollment.signBrowserSetupProof(key.privateKey, proof);
  assert.equal(enrollment.verifyBrowserSetupProof(key.publicKey, proof, proofSignature), true);
  assert.equal(enrollment.verifyBrowserSetupProof(key.publicKey, { ...proof, operation: 'setup.cancel' }, proofSignature), false);
  const redemption = {
    operation: 'enrollment.redeem', serverId: setup.instance, instance: setup.instance,
    attemptId: setup.attemptId, requestHash: proof.requestHash, workerId: 'package-smoke',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const redemptionSignature = enrollment.signBrowserEnrollmentRedemption(key.privateKey, redemption);
  assert.equal(enrollment.verifyBrowserEnrollmentRedemption(key.publicKey, redemption, redemptionSignature), true);
  assert.equal(enrollment.verifyBrowserEnrollmentRedemption(key.publicKey, { ...redemption, workerId: 'changed' }, redemptionSignature), false);
  console.log('ok: identity request and browser setup/redemption signatures; tampering rejected');

  assert.deepEqual(manifest.bin, {
    'lc-code': './dist/cli.js',
    'librechat-code': './dist/cli.js',
  });
  let primaryHelp;
  let primarySetupHelp;
  for (const name of ['lc-code', 'librechat-code']) {
    const binTarget = resolve(packageRoot, manifest.bin[name]);
    assert.ok(binTarget !== packageRoot && within(packageRoot, binTarget), `Missing or invalid ${name} bin`);
    assert.match(await readFile(binTarget, 'utf8'), /^#!\/usr\/bin\/env node\r?\n/);
    const executable = join(modules, '.bin', name);
    assert.equal(await realpath(executable), await realpath(binTarget));
    if (process.platform !== 'win32') {
      assert.ok((await stat(binTarget)).mode & 0o111, 'Installed bin must be executable');
      await access(executable, constants.X_OK);
    }
    const help = await run(executable, ['--help'], { cwd: consumer, timeoutMs: 15_000, label: `${name} --help` });
    assert.match(help, /Usage: lc-code <command>/);
    assert.match(help, /librechat-code remains available as a compatibility alias/);
    const setupHelp = await run(executable, ['setup', '--help'], { cwd: consumer, timeoutMs: 15_000, label: `${name} setup --help` });
    assert.match(setupHelp, /Usage: lc-code setup/);
    assert.match(setupHelp, /--instance/);
    if (primaryHelp === undefined) {
      primaryHelp = help;
      primarySetupHelp = setupHelp;
    } else {
      assert.equal(help, primaryHelp, 'Compatibility alias changed CLI help');
      assert.equal(setupHelp, primarySetupHelp, 'Compatibility alias changed setup help');
    }
    await assert.rejects(run(executable, ['unknown-command'], { cwd: consumer, timeoutMs: 15_000, label: `${name} unknown-command` }), /exit 1.*[\s\S]*Unknown command: unknown-command/);
  }
  console.log('ok: lc-code and librechat-code alias share executable, help, setup and error behavior');

  const childPath = join(packageRoot, 'dist', 'native-process-child.js');
  assert.ok((await lstat(childPath)).isFile(), 'Missing installed dist/native-process-child.js');
  const child = fork(childPath, [], {
    cwd: consumer, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
    timeout: 20_000, killSignal: 'SIGKILL',
  });
  let childOutput = '';
  const capture = chunk => { childOutput = (childOutput + chunk.toString()).slice(-4096); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const exited = new Promise(resolveExited => child.once('exit', (code, signal) => resolveExited({ code, signal })));
  try {
    const reply = await new Promise((resolveReply, reject) => {
      const fail = error => { clearTimeout(timer); reject(error); };
      const timer = setTimeout(() => fail(new Error('Native executor IPC timed out')), 15_000);
      child.once('error', fail);
      child.once('exit', (code, signal) => fail(new Error(`Native executor exited before IPC reply (${code}, ${signal})`)));
      child.once('message', message => { clearTimeout(timer); resolveReply(message); });
      child.send({ id: 'package-smoke', type: 'close' }, error => { if (error) fail(error); });
    });
    assert.equal(reply.id, 'package-smoke');
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'COMMAND_UNAVAILABLE');
    assert.deepEqual(reply.diagnostic, { stage: 'cleanup', reason: 'cleanup_failed' });
    assert.equal(reply.mutation, false);
    assert.equal(reply.requiresQuarantine, false);
    assert.equal(reply.fatal, false);
  } catch (error) {
    throw new Error(`${error.message}\n${diagnostic(childOutput)}`);
  } finally {
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    if (child.connected) child.disconnect();
    const status = await exited;
    clearTimeout(killTimer);
    child.stdout.destroy();
    child.stderr.destroy();
    assert.equal(status.code, 0, `Native executor did not shut down cleanly (${status.signal ?? status.code})`);
  }
  console.log('ok: installed native executor fork IPC; unprepared close safely rejected');

  if (process.platform === 'darwin') {
    const { removeMacOsAcl, verifyMacOsAcl } = await import(pathToFileURL(join(packageRoot, 'dist', 'macos-storage.js')).href);
    const path = join(consumer, 'private-acl-smoke');
    const handle = await open(path, 'wx', 0o600);
    try {
      const metadata = await handle.stat();
      assert.equal(metadata.mode & 0o777, 0o600);
      assert.equal(metadata.uid, process.getuid());
      removeMacOsAcl(handle.fd, path);
      verifyMacOsAcl(handle.fd, path, false, true);
    } finally {
      await handle.close();
    }
    console.log('ok: macOS descriptor ACL native calls on an owner-only temporary file');
  }

  let packageBytes = 0;
  let dependencyBytes = 0;
  async function measure(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        assert.ok(within(modules, await realpath(path)), 'Installed dependency symlink escaped the consumer');
      } else if (entry.isDirectory()) {
        await measure(path);
      } else if (entry.isFile()) {
        const { size } = await stat(path);
        dependencyBytes += size;
        if (within(packageRoot, path)) packageBytes += size;
      }
    }
  }
  await measure(modules);
  console.log(`size: installed package ${packageBytes} bytes; production node_modules ${dependencyBytes} bytes`);
}

async function main() {
  assert.equal(process.argv.length, 3, 'Usage: node scripts/smoke-code-package.mjs <tarball>');
  const tarball = await realpath(resolve(process.argv[2]));
  const archive = await stat(tarball);
  assert.ok(archive.isFile(), 'Tarball must be a regular file');
  const sourceRoot = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const tempRoot = await realpath(tmpdir());
  assert.ok(!within(sourceRoot, tempRoot), 'TMPDIR must be outside the source repository');
  const expected = JSON.parse(await readFile(new URL('../packages/code/package.json', import.meta.url), 'utf8'));
  assert.equal(expected.name, '@librechat/code');
  const consumer = await mkdtemp(join(tempRoot, 'librechat-code-smoke-'));
  try {
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'code-package-smoke', private: true, type: 'module' }));
    console.log(`size: tarball ${archive.size} bytes`);
    await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', tarball], {
      cwd: consumer, timeoutMs: 180_000, label: 'npm install tarball',
      env: { npm_config_cache: join(consumer, '.npm-cache'), npm_config_update_notifier: 'false' },
    });
    const script = join(consumer, 'smoke.mjs');
    await writeFile(script, [
      "import { spawn } from 'node:child_process';",
      "import { isAbsolute, relative, sep } from 'node:path';",
      within.toString(), diagnostic.toString(), run.toString(), checkConsumer.toString(),
      `await checkConsumer(${JSON.stringify({ name: expected.name, version: expected.version })});`,
    ].join('\n'));
    // Keep all package resolution anchored to the consumer, never this checkout.
    const output = await run(process.execPath, [script], { cwd: consumer, timeoutMs: 90_000, label: 'installed package checks' });
    process.stdout.write(output);
    console.log('ok: packed consumer smoke passed');
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`smoke-code-package: ${diagnostic(error.message)}`);
  process.exitCode = 1;
});
