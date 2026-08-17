import { config } from './config';
import { workspaceIsolationConfigErrors } from './workspace-isolation';

export class SandboxSecureStartupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SandboxSecureStartupError';
    }
}

function nonEmpty(value: string | undefined): boolean {
    return value !== undefined && value.trim().length > 0;
}

function defaultPort(protocol: string): string | undefined {
    if (protocol === 'http:') return '80';
    if (protocol === 'https:') return '443';
    return undefined;
}

function hostPortFromUrl(url: URL, label: string): string {
    if (url.pathname !== '/' || url.search || url.hash) {
        throw new SandboxSecureStartupError(
            `${label} must not include a path, query, or fragment`,
        );
    }
    const port = url.port || defaultPort(url.protocol);
    if (!port) {
        throw new SandboxSecureStartupError(
            `${label} must use http or https, or include an explicit port`,
        );
    }
    return `${url.hostname}:${port}`;
}

function gatewayHostPort(rawUrl: string): string {
    try {
        return hostPortFromUrl(new URL(rawUrl), 'EGRESS_GATEWAY_URL');
    } catch (error) {
        if (error instanceof SandboxSecureStartupError) throw error;
        throw new SandboxSecureStartupError(
            'EGRESS_GATEWAY_URL must be a valid URL in hardened mode',
        );
    }
}

function forwardTargetHostPort(rawEndpoint: string): string {
    try {
        return hostPortFromUrl(
            new URL(
                rawEndpoint.includes('://')
                    ? rawEndpoint
                    : `http://${rawEndpoint}`,
            ),
            'SANDBOX_FORWARD_TARGET',
        );
    } catch (error) {
        if (error instanceof SandboxSecureStartupError) throw error;
        throw new SandboxSecureStartupError(
            'SANDBOX_FORWARD_TARGET must be a valid URL or host:port in hardened mode',
        );
    }
}

function forbiddenEnvNames(): string[] {
    const forbidden: string[] = [];
    for (const [name, raw] of Object.entries(process.env)) {
        if (!nonEmpty(raw)) continue;
        if (name === 'CODEAPI_HARDENED_SANDBOX_MODE') continue;
        if (name.startsWith('CODEAPI_')) forbidden.push(name);
        if (name.startsWith('REDIS_')) forbidden.push(name);
        if (name.startsWith('AWS_')) forbidden.push(name);
        if (name.startsWith('S3_')) forbidden.push(name);
        if (name.startsWith('MINIO_')) forbidden.push(name);
        if (/(SECRET|TOKEN|PASSWORD|PRIVATE_KEY)/.test(name))
            forbidden.push(name);
    }
    return Array.from(new Set(forbidden)).sort();
}

export function validateHardenedSandboxStartup(): void {
    if (!config.hardened_sandbox_mode) return;

    if (!config.egress_gateway_url.trim()) {
        throw new SandboxSecureStartupError(
            'EGRESS_GATEWAY_URL is required in hardened mode',
        );
    }
    if (!config.require_execution_manifest) {
        throw new SandboxSecureStartupError(
            'SANDBOX_REQUIRE_EGRESS_MANIFEST=true is required in hardened mode',
        );
    }
    if (!config.execution_manifest_public_key.trim()) {
        throw new SandboxSecureStartupError(
            'SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY is required in hardened mode',
        );
    }
    if (config.execution_manifest_secret.trim()) {
        throw new SandboxSecureStartupError(
            'Manifest HMAC secrets are forbidden in sandbox-runner hardened mode',
        );
    }
    if (
        config.file_server_url.trim() ||
        nonEmpty(process.env.TOOL_CALL_SERVER_URL)
    ) {
        throw new SandboxSecureStartupError(
            'Direct file/tool service URLs are forbidden in sandbox-runner hardened mode',
        );
    }
    if (config.allowed_local_network_port <= 0) {
        throw new SandboxSecureStartupError(
            'SANDBOX_ALLOWED_LOCAL_NETWORK_PORT is required in hardened mode',
        );
    }
    const forwardTarget = process.env.SANDBOX_FORWARD_TARGET ?? '';
    if (!forwardTarget.trim()) {
        throw new SandboxSecureStartupError(
            'SANDBOX_FORWARD_TARGET is required in hardened mode',
        );
    }
    if (
        forwardTargetHostPort(forwardTarget) !==
        gatewayHostPort(config.egress_gateway_url)
    ) {
        throw new SandboxSecureStartupError(
            'SANDBOX_FORWARD_TARGET must point to EGRESS_GATEWAY_URL host:port',
        );
    }

    const forbidden = forbiddenEnvNames();
    if (forbidden.length > 0) {
        throw new SandboxSecureStartupError(
            `Forbidden sandbox-runner env in hardened mode: ${forbidden.join(', ')}`,
        );
    }

    const workspaceErrors = workspaceIsolationConfigErrors();
    if (workspaceErrors.length > 0) {
        throw new SandboxSecureStartupError(workspaceErrors.join('; '));
    }
}
