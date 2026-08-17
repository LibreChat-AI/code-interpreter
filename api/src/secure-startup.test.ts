import { afterEach, describe, expect, test } from 'bun:test';
import { config } from './config';
import { validateHardenedSandboxStartup } from './secure-startup';

const savedEnv = { ...process.env };
const saved = {
    hardened: config.hardened_sandbox_mode,
    gateway: config.egress_gateway_url,
    requireManifest: config.require_execution_manifest,
    publicKey: config.execution_manifest_public_key,
    secret: config.execution_manifest_secret,
    fileServer: config.file_server_url,
    port: config.allowed_local_network_port,
    perJobUids: config.per_job_uids,
    jobUidCount: config.job_uid_count,
    maxConcurrentJobs: config.max_concurrent_jobs,
    jobUidBase: config.job_uid_base,
    jobGidBase: config.job_gid_base,
    workspaceReaperMaxAgeSeconds: config.workspace_reaper_max_age_seconds,
};

function setValidHardenedConfig(): void {
    config.hardened_sandbox_mode = true;
    config.egress_gateway_url = 'http://egress-gateway:3190';
    config.require_execution_manifest = true;
    config.execution_manifest_public_key = 'public-key';
    config.execution_manifest_secret = '';
    config.file_server_url = '';
    config.allowed_local_network_port = 3190;
    config.per_job_uids = true;
    config.max_concurrent_jobs = 8;
    config.job_uid_count = 8;
    config.job_uid_base = 200000;
    config.job_gid_base = 200000;
    config.workspace_reaper_max_age_seconds = 3600;
    process.env.CODEAPI_HARDENED_SANDBOX_MODE = 'true';
    process.env.SANDBOX_FORWARD_TARGET = 'egress-gateway:3190';
}

function restore(): void {
    for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    config.hardened_sandbox_mode = saved.hardened;
    config.egress_gateway_url = saved.gateway;
    config.require_execution_manifest = saved.requireManifest;
    config.execution_manifest_public_key = saved.publicKey;
    config.execution_manifest_secret = saved.secret;
    config.file_server_url = saved.fileServer;
    config.allowed_local_network_port = saved.port;
    config.per_job_uids = saved.perJobUids;
    config.job_uid_count = saved.jobUidCount;
    config.max_concurrent_jobs = saved.maxConcurrentJobs;
    config.job_uid_base = saved.jobUidBase;
    config.job_gid_base = saved.jobGidBase;
    config.workspace_reaper_max_age_seconds =
        saved.workspaceReaperMaxAgeSeconds;
}

afterEach(restore);

describe('hardened sandbox-runner startup config', () => {
    test('accepts the gateway-only public-verifier configuration', () => {
        setValidHardenedConfig();
        expect(() => validateHardenedSandboxStartup()).not.toThrow();
    });

    test('rejects the legacy CODEAPI manifest public-key env in hardened mode', () => {
        setValidHardenedConfig();
        process.env.CODEAPI_EXECUTION_MANIFEST_PUBLIC_KEY = 'public-key';
        expect(() => validateHardenedSandboxStartup()).toThrow(
            'CODEAPI_EXECUTION_MANIFEST_PUBLIC_KEY',
        );
    });

    test('normalizes default ports when validating the sandbox forward target', () => {
        setValidHardenedConfig();
        config.egress_gateway_url = 'http://egress-gateway:80';
        config.allowed_local_network_port = 80;
        process.env.SANDBOX_FORWARD_TARGET = 'egress-gateway:80';
        expect(() => validateHardenedSandboxStartup()).not.toThrow();

        config.egress_gateway_url = 'http://egress-gateway';
        process.env.SANDBOX_FORWARD_TARGET = 'http://egress-gateway:80';
        expect(() => validateHardenedSandboxStartup()).not.toThrow();

        config.egress_gateway_url = 'https://egress-gateway';
        config.allowed_local_network_port = 443;
        process.env.SANDBOX_FORWARD_TARGET = 'egress-gateway:443';
        expect(() => validateHardenedSandboxStartup()).not.toThrow();

        process.env.SANDBOX_FORWARD_TARGET = 'egress-gateway:80';
        expect(() => validateHardenedSandboxStartup()).toThrow(
            'SANDBOX_FORWARD_TARGET',
        );
    });

    test('rejects direct service URLs and secret/control-plane env', () => {
        setValidHardenedConfig();
        config.file_server_url = 'http://file-server:3000';
        expect(() => validateHardenedSandboxStartup()).toThrow(
            'Direct file/tool service URLs',
        );

        config.file_server_url = '';
        config.execution_manifest_secret = 'legacy-hmac-secret';
        expect(() => validateHardenedSandboxStartup()).toThrow(
            'Manifest HMAC secrets',
        );

        config.execution_manifest_secret = '';
        process.env.CODEAPI_INTERNAL_SERVICE_TOKEN = 'internal-token';
        expect(() => validateHardenedSandboxStartup()).toThrow(
            'CODEAPI_INTERNAL_SERVICE_TOKEN',
        );

        delete process.env.CODEAPI_INTERNAL_SERVICE_TOKEN;
        process.env.CODEAPI_EXECUTION_MANIFEST_SECRET = 'legacy-hmac-secret';
        expect(() => validateHardenedSandboxStartup()).toThrow(
            'CODEAPI_EXECUTION_MANIFEST_SECRET',
        );

        delete process.env.CODEAPI_EXECUTION_MANIFEST_SECRET;
        process.env.REDIS_HOST = 'redis';
        expect(() => validateHardenedSandboxStartup()).toThrow('REDIS_HOST');
    });

    test('rejects missing manifest verifier and wrong forwarding target', () => {
        setValidHardenedConfig();
        config.egress_gateway_url = '';
        expect(() => validateHardenedSandboxStartup()).toThrow(
            'EGRESS_GATEWAY_URL',
        );

        config.egress_gateway_url = 'http://egress-gateway:3190';
        config.require_execution_manifest = false;
        expect(() => validateHardenedSandboxStartup()).toThrow(
            'SANDBOX_REQUIRE_EGRESS_MANIFEST',
        );

        config.require_execution_manifest = true;
        config.execution_manifest_public_key = '';
        expect(() => validateHardenedSandboxStartup()).toThrow(
            'SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY',
        );

        config.execution_manifest_public_key = 'public-key';
        process.env.SANDBOX_FORWARD_TARGET = 'file-server:3000';
        expect(() => validateHardenedSandboxStartup()).toThrow(
            'SANDBOX_FORWARD_TARGET',
        );
    });

    test('rejects weakened workspace isolation config in hardened mode', () => {
        setValidHardenedConfig();
        config.per_job_uids = false;
        expect(() => validateHardenedSandboxStartup()).toThrow(
            'SANDBOX_PER_JOB_UIDS',
        );

        config.per_job_uids = true;
        config.job_uid_count = 7;
        expect(() => validateHardenedSandboxStartup()).toThrow(
            'SANDBOX_JOB_UID_COUNT',
        );

        config.job_uid_count = 8;
        config.job_uid_base = 1000;
        expect(() => validateHardenedSandboxStartup()).toThrow(
            'SANDBOX_JOB_UID_BASE',
        );

        config.job_uid_base = 200000;
        config.workspace_reaper_max_age_seconds = 10;
        expect(() => validateHardenedSandboxStartup()).toThrow(
            'SANDBOX_WORKSPACE_REAPER_MAX_AGE_SECONDS',
        );
    });
});
