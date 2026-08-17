import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { describe, expect, test } from 'bun:test';
import { hashRawToolInputJson, hashToolInput } from './tool-input-signature';

function jqHash(json: string): string {
    const canonical = execFileSync('jq', ['-cS', '.'], {
        input: json,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

describe('hashToolInput', () => {
    test('matches bash jq canonicalization for negative zero fallback inputs', () => {
        expect(hashToolInput({ value: -0 })).toBe(jqHash('{"value":-0}'));
    });

    test('matches bash jq canonicalization for exponent-form numbers', () => {
        expect(hashToolInput({ big: 1e21, small: 1e-7 })).toBe(
            jqHash('{"small":1e-7,"big":1e+21}'),
        );
    });

    test('preserves raw number spellings when hashing legacy JSON inputs', () => {
        for (const json of [
            '{"x":1000000000000000000000}',
            '{"x":1.0}',
            '{"x":1.2300}',
            '{"x":1e+21}',
            '{"x":1e-7}',
            '{"x":1e0}',
            '{"x":1e-07}',
            '{"x":1.2300e+02}',
            '{"x":0.001e+5}',
            '{"x":0.001e+2}',
            '{"x":0.001e+3}',
            '{"x":0e-7}',
            '{"x":0.000001}',
            '{"x":0.0000001}',
            '{"x":0.00000010}',
            '{"x":0.000000}',
            '{"x":0.0000000}',
            '{"x":-0}',
        ]) {
            expect(hashRawToolInputJson(json)).toBe(jqHash(json));
        }
    });
});
