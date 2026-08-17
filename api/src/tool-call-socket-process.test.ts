import { afterEach, describe, expect, test } from 'bun:test';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { config } from './config';
import {
    ensureToolCallSocketProxyReady,
    stopToolCallSocketProxy,
} from './tool-call-socket-process';

const originalPort = config.allowed_local_network_port;
const originalEnv = {
    target: process.env.SANDBOX_FORWARD_TARGET,
    socket: process.env.TCS_SOCKET,
    bundle: process.env.TCS_PROXY_BUNDLE,
    node: process.env.TCS_NODE_BINARY,
    marker: process.env.TCS_TEST_MARKER,
};
let tempDir: string | undefined;

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

afterEach(async () => {
    await stopToolCallSocketProxy();
    config.allowed_local_network_port = originalPort;
    restoreEnv('SANDBOX_FORWARD_TARGET', originalEnv.target);
    restoreEnv('TCS_SOCKET', originalEnv.socket);
    restoreEnv('TCS_PROXY_BUNDLE', originalEnv.bundle);
    restoreEnv('TCS_NODE_BINARY', originalEnv.node);
    restoreEnv('TCS_TEST_MARKER', originalEnv.marker);
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
});

describe('lazy tool-call socket process', () => {
    test('starts once on demand, awaits readiness, and stops cleanly', async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lazy-tcs-'));
        const socketPath = path.join(tempDir, 'proxy.sock');
        const markerPath = path.join(tempDir, 'launches.txt');
        const bundlePath = path.join(tempDir, 'fake-proxy.cjs');
        await fsp.writeFile(
            bundlePath,
            `
      const fs = require('fs');
      const net = require('net');
      try { fs.unlinkSync(process.env.TCS_SOCKET); } catch {}
      fs.appendFileSync(process.env.TCS_TEST_MARKER, 'launch\\n');
      const server = net.createServer(socket => socket.end());
      server.listen(process.env.TCS_SOCKET);
      const stop = () => server.close(() => process.exit(0));
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    `,
        );

        config.allowed_local_network_port = 443;
        process.env.SANDBOX_FORWARD_TARGET = 'https://gateway.example';
        process.env.TCS_SOCKET = socketPath;
        process.env.TCS_PROXY_BUNDLE = bundlePath;
        process.env.TCS_TEST_MARKER = markerPath;

        await Promise.all([
            ensureToolCallSocketProxyReady(),
            ensureToolCallSocketProxyReady(),
            ensureToolCallSocketProxyReady(),
        ]);

        expect((await fsp.lstat(socketPath)).isSocket()).toBe(true);
        expect(
            (await fsp.readFile(markerPath, 'utf8')).trim().split('\n'),
        ).toHaveLength(1);

        /* A live child can lose its socket pathname (for example after an external
         * cleanup). A previously-resolved launch promise must not mask that loss. */
        await fsp.unlink(socketPath);
        await Promise.all([
            ensureToolCallSocketProxyReady(),
            ensureToolCallSocketProxyReady(),
            ensureToolCallSocketProxyReady(),
        ]);
        expect((await fsp.lstat(socketPath)).isSocket()).toBe(true);
        expect(
            (await fsp.readFile(markerPath, 'utf8')).trim().split('\n'),
        ).toHaveLength(2);

        await stopToolCallSocketProxy();
        expect(await fsp.lstat(socketPath).catch(() => null)).toBeNull();
    });

    test('fails closed when forwarding is not configured', async () => {
        config.allowed_local_network_port = 0;
        process.env.SANDBOX_FORWARD_TARGET = '';
        await expect(ensureToolCallSocketProxyReady()).rejects.toThrow(
            'not configured',
        );
    });

    test('reports a spawn failure without crashing and permits a later retry', async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lazy-tcs-spawn-'));
        const socketPath = path.join(tempDir, 'proxy.sock');
        const bundlePath = path.join(tempDir, 'fake-proxy.cjs');
        await fsp.writeFile(
            bundlePath,
            `
      const fs = require('fs');
      const net = require('net');
      try { fs.unlinkSync(process.env.TCS_SOCKET); } catch {}
      const server = net.createServer(socket => socket.end());
      server.listen(process.env.TCS_SOCKET);
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
    `,
        );

        config.allowed_local_network_port = 443;
        process.env.SANDBOX_FORWARD_TARGET = 'https://gateway.example';
        process.env.TCS_SOCKET = socketPath;
        process.env.TCS_PROXY_BUNDLE = bundlePath;
        process.env.TCS_NODE_BINARY = path.join(tempDir, 'missing-node');

        await expect(ensureToolCallSocketProxyReady()).rejects.toThrow(
            'tool-call socket proxy failed to spawn',
        );

        process.env.TCS_NODE_BINARY = process.execPath;
        await ensureToolCallSocketProxyReady();
        expect((await fsp.lstat(socketPath)).isSocket()).toBe(true);
    });
});
