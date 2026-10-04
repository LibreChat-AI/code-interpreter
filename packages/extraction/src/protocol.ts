import { createHash } from 'node:crypto';

export const policy = Object.freeze({
    inputBytes: 10 * 1024 * 1024,
    textBytes: 1024 * 1024,
    resultBytes: 3 * 1024 * 1024,
    deadlineMs: 10_000,
    maxSegments: 128,
});
export type Format = 'pdf' | 'docx';
export type ErrorCode =
    | 'INVALID_REQUEST'
    | 'INPUT_LIMIT'
    | 'BUSY'
    | 'DEADLINE'
    | 'CANCELLED'
    | 'UNAVAILABLE'
    | 'INVALID_DOCUMENT'
    | 'EMPTY_OUTPUT'
    | 'OUTPUT_LIMIT'
    | 'DECOMPRESSION_LIMIT'
    | 'STRUCTURE_LIMIT'
    | 'ENCRYPTED_DOCUMENT'
    | 'UNSUPPORTED_ENCODING'
    | 'UNSUPPORTED_CONTENT'
    | 'RESOURCE_LIMIT';
export class ExtractionError extends Error {
    constructor(readonly code: ErrorCode) {
        super(code);
    }
}
export interface Segment {
    kind: 'page' | 'document';
    index: number;
    text: string;
}
export interface Result {
    version: 1;
    operation: 'document.extract-text';
    format: Format;
    inputSha256: string;
    textBytes: number;
    segments: Segment[];
}
const keys = (value: object, expected: string[]) =>
    Object.keys(value).length === expected.length &&
    expected.every(key => Object.hasOwn(value, key));
export function validateResult(
    bytes: Buffer,
    format: Format,
    digest: string
): Result {
    if (bytes.length > policy.resultBytes)
        throw new ExtractionError('OUTPUT_LIMIT');
    let result: Result;
    try {
        result = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        ) as Result;
    } catch {
        throw new ExtractionError('INVALID_DOCUMENT');
    }
    if (
        !result ||
        typeof result !== 'object' ||
        !keys(result, [
            'version',
            'operation',
            'format',
            'inputSha256',
            'textBytes',
            'segments',
        ]) ||
        result.version !== 1 ||
        result.operation !== 'document.extract-text' ||
        result.format !== format ||
        result.inputSha256 !== digest ||
        !Array.isArray(result.segments) ||
        !result.segments.length ||
        result.segments.length > (format === 'pdf' ? policy.maxSegments : 1)
    ) {
        throw new ExtractionError('INVALID_DOCUMENT');
    }
    let size = 0;
    let nonempty = false;
    for (const [index, segment] of result.segments.entries()) {
        if (
            !segment ||
            typeof segment !== 'object' ||
            !keys(segment, ['kind', 'index', 'text']) ||
            segment.kind !== (format === 'pdf' ? 'page' : 'document') ||
            segment.index !== index + 1 ||
            typeof segment.text !== 'string' ||
            !segment.text.isWellFormed()
        )
            throw new ExtractionError('INVALID_DOCUMENT');
        size += Buffer.byteLength(segment.text);
        nonempty ||= Boolean(segment.text.trim());
    }
    if (size > policy.textBytes) throw new ExtractionError('OUTPUT_LIMIT');
    if (size !== result.textBytes || !nonempty)
        throw new ExtractionError('INVALID_DOCUMENT');
    return result;
}
export function sha256(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}
