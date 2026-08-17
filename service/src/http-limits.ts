export type BoundedContentLength =
    | { ok: true; length: number }
    | { ok: false; status: 411 | 413; error: string };

export function parseBoundedContentLength(
    rawLength: string | undefined,
    maxBytes: number,
    exceededMessage: string,
): BoundedContentLength {
    if (rawLength == null || rawLength.trim() === '') {
        return { ok: false, status: 411, error: 'Content-Length is required' };
    }

    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length < 0) {
        return { ok: false, status: 411, error: 'Content-Length is required' };
    }

    if (length > maxBytes) {
        return { ok: false, status: 413, error: exceededMessage };
    }

    return { ok: true, length };
}
