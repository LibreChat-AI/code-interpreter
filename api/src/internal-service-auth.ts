export const INTERNAL_SERVICE_TOKEN_ENV = 'CODEAPI_INTERNAL_SERVICE_TOKEN';
export const INTERNAL_SERVICE_TOKEN_HEADER = 'X-CodeAPI-Internal-Token';

function configuredToken(): string {
    return (process.env[INTERNAL_SERVICE_TOKEN_ENV] ?? '').trim();
}

export function internalServiceHeaders(
    headers: Record<string, string> = {},
): Record<string, string> {
    const token = configuredToken();
    if (!token) return headers;
    return {
        ...headers,
        [INTERNAL_SERVICE_TOKEN_HEADER]: token,
    };
}
