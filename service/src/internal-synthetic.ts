export const CODEAPI_SYNTHETIC_INTERNAL_REQUEST_HEADER =
    'X-CodeAPI-Synthetic-Request';

export function isSyntheticInternalRequestHeader(
    value: string | undefined,
): boolean {
    return value?.trim().toLowerCase() === 'true';
}
