import { openEgressHandle, type EgressHandleClaims } from './egress-grant';

/**
 * Express route params are already URL-decoded. Passing them through
 * decodeURIComponent again can throw on valid decoded bytes like `%` and turn
 * malformed handles into 500s instead of scoped egress-token rejections.
 */
export function openEgressRouteHandle(
    raw: string,
    secret: string,
): EgressHandleClaims {
    return openEgressHandle(raw, secret);
}
