import crypto from 'crypto';

type RawJsonValue =
    | null
    | boolean
    | string
    | { type: 'number'; raw: string }
    | { type: 'array'; items: RawJsonValue[] }
    | { type: 'object'; entries: Map<string, RawJsonValue> };

/* Format a finite JS number exactly as jq 1.6 prints it (jvp_dtoa_fmt in
 * src/jv_dtoa.c). jq parses JSON numbers to doubles and prints the shortest
 * round-trip decimal representation, choosing fixed vs scientific notation by
 * the dtoa `decpt` (value = 0.digits * 10^decpt): scientific when
 * decpt <= -4 or decpt > ndigits + 15, otherwise fixed. */
function jqNumberFormat(num: number): string {
    if (Object.is(num, -0)) return '-0';
    if (num === 0) return '0';
    if (!Number.isFinite(num)) return String(num);
    const negative = num < 0;
    const { digits, sciExp } = shortestDigits(Math.abs(num));
    const sign = negative ? '-' : '';
    const ndigits = digits.length;
    const decpt = sciExp + 1;

    if (decpt <= -4 || decpt > ndigits + 15) {
        // Scientific notation: coefficient + 'e' + signed, zero-padded exponent.
        const coefficient =
            ndigits > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
        const expSign = sciExp < 0 ? '-' : '+';
        const expStr = expSign + String(Math.abs(sciExp)).padStart(2, '0');
        return `${sign}${coefficient}e${expStr}`;
    }
    if (decpt <= 0) {
        // Fixed: 0.000...digits
        return `${sign}0.${'0'.repeat(-decpt)}${digits}`;
    }
    // Fixed: decimal point after `decpt` digits, padding with zeros.
    if (decpt >= ndigits) {
        return `${sign}${digits}${'0'.repeat(decpt - ndigits)}`;
    }
    return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

/* Extract the shortest significant digits and the scientific exponent
 * (value = digits[0].digits[1..] * 10^sciExp) from a JS number's shortest
 * string form. */
function shortestDigits(absNum: number): { digits: string; sciExp: number } {
    const s = absNum.toString();
    const eIdx = s.search(/[eE]/);
    if (eIdx !== -1) {
        // Scientific form: "M e E" — mantissa is already in [1, 10).
        const mant = s.slice(0, eIdx);
        const expPart = parseInt(s.slice(eIdx + 1), 10);
        const dotIdx = mant.indexOf('.');
        const intPart = dotIdx === -1 ? mant : mant.slice(0, dotIdx);
        const fracPart = dotIdx === -1 ? '' : mant.slice(dotIdx + 1);
        return { digits: intPart + fracPart, sciExp: expPart };
    }
    const dotIdx = s.indexOf('.');
    if (dotIdx === -1) {
        // Integer form: strip trailing zeros, exponent = len - 1.
        return { digits: s.replace(/0+$/, ''), sciExp: s.length - 1 };
    }
    const intPart = s.slice(0, dotIdx);
    const fracPart = s.slice(dotIdx + 1);
    if (intPart === '0') {
        // 0.xxx — first nonzero digit at index p gives sciExp = -(p + 1).
        const p = fracPart.search(/[1-9]/);
        return { digits: fracPart.slice(p), sciExp: -(p + 1) };
    }
    return { digits: intPart + fracPart, sciExp: intPart.length - 1 };
}

function canonicalJson(value: unknown): string {
    if (typeof value === 'number') {
        return jqNumberFormat(value);
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
    const num = Number(raw);
    if (!Number.isFinite(num)) return raw;
    return jqNumberFormat(num);
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
