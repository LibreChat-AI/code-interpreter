import crypto from 'crypto';

type RawJsonValue =
    | null
    | boolean
    | string
    | { type: 'number'; raw: string }
    | { type: 'array'; items: RawJsonValue[] }
    | { type: 'object'; entries: Map<string, RawJsonValue> };

function canonicalJson(value: unknown): string {
    if (typeof value === 'number') {
        if (Object.is(value, -0)) return '-0';
        return JSON.stringify(value).replace('e', 'E');
    }
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
        .sort()
        .map(key => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
        .join(',')}}`;
}

export function hashToolInput(input: Record<string, unknown>): string {
    return crypto
        .createHash('sha256')
        .update(canonicalJson(input), 'utf8')
        .digest('hex');
}

function normalizeRawJsonNumber(raw: string): string {
    const match = raw.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
    if (match == null) return raw;
    const [, sign, intPart, fracPart = '', exponentPart] = match;

    const exponent =
        exponentPart == null ? 0 : Number.parseInt(exponentPart, 10);
    if (!Number.isSafeInteger(exponent)) return raw.replace(/[eE]/, 'E');

    const digits = intPart + fracPart;
    const point = intPart.length + exponent;
    const firstNonZero = digits.search(/[1-9]/);
    if (firstNonZero === -1) {
        const zeroExponent = exponent - fracPart.length;
        if (zeroExponent === 0) return `${sign}0`;
        if (zeroExponent >= -6 && zeroExponent < 0) {
            return `${sign}0.${'0'.repeat(-zeroExponent - 1)}0`;
        }
        const exponentSign = zeroExponent >= 0 ? '+' : '';
        return `${sign}0E${exponentSign}${zeroExponent}`;
    }

    const scientificExponent = point - firstNonZero - 1;

    if (scientificExponent >= -6 && point <= digits.length) {
        if (point <= 0) {
            return `${sign}0.${'0'.repeat(-point)}${digits}`;
        }
        if (point < digits.length) {
            const integer =
                digits.slice(0, point).replace(/^0+(?=\d)/, '') || '0';
            return `${sign}${integer}.${digits.slice(point)}`;
        }
        const expanded = digits.slice(0, point).replace(/^0+(?=\d)/, '');
        return `${sign}${expanded || '0'}`;
    }

    const significantDigits = digits.slice(firstNonZero);
    const coefficient = `${significantDigits[0]}${
        significantDigits.length > 1 ? `.${significantDigits.slice(1)}` : ''
    }`;
    const exponentSign = scientificExponent >= 0 ? '+' : '';
    return `${sign}${coefficient}E${exponentSign}${scientificExponent}`;
}

function parseRawJson(text: string): RawJsonValue {
    let i = 0;

    function fail(): never {
        throw new Error('invalid JSON');
    }

    function skipWs(): void {
        while (i < text.length && /\s/.test(text[i])) i++;
    }

    function parseString(): string {
        const start = i;
        if (text[i] !== '"') fail();
        i++;
        while (i < text.length) {
            const ch = text[i];
            if (ch === '"') {
                i++;
                return JSON.parse(text.slice(start, i)) as string;
            }
            if (ch === '\\') {
                i += 2;
                continue;
            }
            if (ch < ' ') fail();
            i++;
        }
        fail();
    }

    function parseNumber(): RawJsonValue {
        const start = i;
        if (text[i] === '-') i++;
        if (text[i] === '0') {
            i++;
        } else if (/[1-9]/.test(text[i])) {
            i++;
            while (/[0-9]/.test(text[i])) i++;
        } else {
            fail();
        }
        if (text[i] === '.') {
            i++;
            if (!/[0-9]/.test(text[i])) fail();
            while (/[0-9]/.test(text[i])) i++;
        }
        if (text[i] === 'e' || text[i] === 'E') {
            i++;
            if (text[i] === '+' || text[i] === '-') i++;
            if (!/[0-9]/.test(text[i])) fail();
            while (/[0-9]/.test(text[i])) i++;
        }
        return {
            type: 'number',
            raw: normalizeRawJsonNumber(text.slice(start, i)),
        };
    }

    function parseArray(): RawJsonValue {
        i++;
        skipWs();
        const items: RawJsonValue[] = [];
        if (text[i] === ']') {
            i++;
            return { type: 'array', items };
        }
        while (i < text.length) {
            items.push(parseValue());
            skipWs();
            if (text[i] === ']') {
                i++;
                return { type: 'array', items };
            }
            if (text[i] !== ',') fail();
            i++;
            skipWs();
        }
        fail();
    }

    function parseObject(): RawJsonValue {
        i++;
        skipWs();
        const entries = new Map<string, RawJsonValue>();
        if (text[i] === '}') {
            i++;
            return { type: 'object', entries };
        }
        while (i < text.length) {
            const key = parseString();
            skipWs();
            if (text[i] !== ':') fail();
            i++;
            entries.set(key, parseValue());
            skipWs();
            if (text[i] === '}') {
                i++;
                return { type: 'object', entries };
            }
            if (text[i] !== ',') fail();
            i++;
            skipWs();
        }
        fail();
    }

    function parseLiteral(literal: string, value: RawJsonValue): RawJsonValue {
        if (text.slice(i, i + literal.length) !== literal) fail();
        i += literal.length;
        return value;
    }

    function parseValue(): RawJsonValue {
        skipWs();
        const ch = text[i];
        if (ch === '"') return parseString();
        if (ch === '{') return parseObject();
        if (ch === '[') return parseArray();
        if (ch === 't') return parseLiteral('true', true);
        if (ch === 'f') return parseLiteral('false', false);
        if (ch === 'n') return parseLiteral('null', null);
        return parseNumber();
    }

    const value = parseValue();
    skipWs();
    if (i !== text.length) fail();
    return value;
}

function canonicalRawJson(value: RawJsonValue): string {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'string') return JSON.stringify(value);
    if (value.type === 'number') return value.raw;
    if (value.type === 'array') {
        return `[${value.items.map(canonicalRawJson).join(',')}]`;
    }
    return `{${Array.from(value.entries.keys())
        .sort()
        .map(
            key =>
                `${JSON.stringify(key)}:${canonicalRawJson(value.entries.get(key)!)}`,
        )
        .join(',')}}`;
}

function hashCanonicalJsonText(canonical: string): string {
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function hashRawToolInputJson(inputJson: string): string | undefined {
    try {
        return hashCanonicalJsonText(canonicalRawJson(parseRawJson(inputJson)));
    } catch {
        return undefined;
    }
}

export function pendingInputHashesFromRawPayload(
    rawPayload: string,
): Array<string | undefined> {
    let root: RawJsonValue;
    try {
        root = parseRawJson(rawPayload);
    } catch {
        return [];
    }
    if (
        root === null ||
        typeof root !== 'object' ||
        !('type' in root) ||
        root.type !== 'object'
    ) {
        return [];
    }
    const pending = root.entries.get('pending');
    if (
        pending === null ||
        typeof pending !== 'object' ||
        !('type' in pending) ||
        pending.type !== 'array'
    ) {
        return [];
    }
    return pending.items.map(item => {
        if (
            item === null ||
            typeof item !== 'object' ||
            !('type' in item) ||
            item.type !== 'object'
        ) {
            return undefined;
        }
        const input = item.entries.get('input');
        return input === undefined
            ? undefined
            : hashCanonicalJsonText(canonicalRawJson(input));
    });
}
