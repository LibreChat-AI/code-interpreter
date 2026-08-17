import { describe, expect, test } from 'bun:test';
import { parseBoundedContentLength } from './http-limits';

describe('parseBoundedContentLength', () => {
    test('requires a concrete content length', () => {
        expect(parseBoundedContentLength(undefined, 10, 'too large')).toEqual({
            ok: false,
            status: 411,
            error: 'Content-Length is required',
        });
        expect(parseBoundedContentLength('', 10, 'too large')).toEqual({
            ok: false,
            status: 411,
            error: 'Content-Length is required',
        });
    });

    test('rejects malformed and negative content lengths', () => {
        expect(parseBoundedContentLength('chunked', 10, 'too large')).toEqual({
            ok: false,
            status: 411,
            error: 'Content-Length is required',
        });
        expect(parseBoundedContentLength('-1', 10, 'too large')).toEqual({
            ok: false,
            status: 411,
            error: 'Content-Length is required',
        });
        expect(parseBoundedContentLength('1.5', 10, 'too large')).toEqual({
            ok: false,
            status: 411,
            error: 'Content-Length is required',
        });
    });

    test('enforces the configured byte limit', () => {
        expect(parseBoundedContentLength('11', 10, 'too large')).toEqual({
            ok: false,
            status: 413,
            error: 'too large',
        });
        expect(parseBoundedContentLength('10', 10, 'too large')).toEqual({
            ok: true,
            length: 10,
        });
    });
});
