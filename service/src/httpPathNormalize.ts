/**
 * Normalizes URL paths for Prometheus `path` labels (low cardinality).
 * Based on LibreChat `packages/api/src/app/metrics.ts` PATH_NORMALIZATIONS,
 * with codeapi-specific patterns for file server and API routes.
 */
const PATH_NORMALIZATIONS: [RegExp, string][] = [
    [/\/api\/messages\/[^/]+/, '/api/messages/#id'],
    [/\/api\/convos\/[^/]+/, '/api/convos/#id'],
    [/\/api\/files\/[^/]+/, '/api/files/#id'],
    [/\/api\/agents\/[^/]+/, '/api/agents/#id'],
    [/\/api\/assistants\/[^/]+/, '/api/assistants/#id'],
    [/\/api\/share\/[^/]+/, '/api/share/#token'],
    /** Catch-all: MongoDB ObjectId (24 hex chars) */
    [/\/[0-9a-f]{24}(?=\/|$)/gi, '/#id'],
    /** Catch-all: UUID v4 */
    [
        /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi,
        '/#id',
    ],
    /** Codeapi file server */
    [/\/sessions\/[^/]+\/objects\/[^/]+/, '/sessions/#id/objects/#id'],
    [/\/sessions\/[^/]+\/objects\/?$/, '/sessions/#id/objects'],
    /** Codeapi egress gateway internal grants */
    [
        /\/internal\/egress-grants\/[^/]+\/restore-result/,
        '/internal/egress-grants/#id/restore-result',
    ],
    [
        /\/internal\/egress-grants\/[^/]+\/revoke/,
        '/internal/egress-grants/#id/revoke',
    ],
    /** Codeapi API v1 dynamic segments */
    [/\/v1\/download\/[^/]+\/[^/]+/, '/v1/download/#id/#id'],
    [/\/v1\/files\/[^/]+\/[^/]+/, '/v1/files/#id/#id'],
    [/\/v1\/files\/[^/]+/, '/v1/files/#id'],
];

export function normalizeMetricPath(rawPath: string): string {
    return PATH_NORMALIZATIONS.reduce(
        (p, [pattern, replacement]) => p.replace(pattern, replacement),
        rawPath,
    );
}
