interface OutputWindow {
    text: string;
    bytes: number;
}

function utf8Window(
    buffer: Buffer,
    length: number,
    tail: boolean
): OutputWindow {
    let start = tail ? buffer.length - length : 0;
    let end = tail ? buffer.length : length;
    if (tail) {
        while (start < end && (buffer[start] & 0xc0) === 0x80) start += 1;
    } else if (end > 0) {
        let last = end - 1;
        while (last > 0 && (buffer[last] & 0xc0) === 0x80) last -= 1;
        const lead = buffer[last];
        const width =
            lead >= 0xc2 && lead <= 0xdf
                ? 2
                : lead >= 0xe0 && lead <= 0xef
                ? 3
                : lead >= 0xf0 && lead <= 0xf4
                ? 4
                : 1;
        if (end - last < width) end = last;
    }
    return {
        text: buffer.subarray(start, end).toString('utf8'),
        bytes: end - start,
    };
}

function boundedWindow(
    buffer: Buffer,
    budget: number,
    tail: boolean
): OutputWindow {
    const length = Math.min(buffer.length, budget);
    const window = utf8Window(buffer, length, tail);
    if (Buffer.byteLength(window.text) <= budget) return window;

    // Malformed bytes expand to replacement characters. Valid UTF-8 takes the fast path.
    let low = 0;
    let high = length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (
            Buffer.byteLength(utf8Window(buffer, middle, tail).text) <= budget
        ) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    return utf8Window(buffer, low, tail);
}

/** Copies a prefix and rolling suffix, never retaining child-process chunk buffers. */
export class OutputBuffer {
    private readonly headCapacity: number;
    private readonly tailCapacity: number;
    private head?: Buffer;
    private tail?: Buffer;
    private headLength = 0;
    private tailLength = 0;
    private tailOffset = 0;
    private totalBytes = 0;

    constructor(capacity: number) {
        this.headCapacity = Math.floor(capacity / 2);
        this.tailCapacity = capacity - this.headCapacity;
    }

    get bytes(): number {
        return this.totalBytes;
    }

    append(chunk: Buffer): void {
        this.totalBytes += chunk.length;
        const headBytes = Math.min(
            chunk.length,
            this.headCapacity - this.headLength
        );
        if (headBytes > 0) {
            this.head ??= Buffer.allocUnsafe(this.headCapacity);
            chunk.copy(this.head, this.headLength, 0, headBytes);
            this.headLength += headBytes;
        }
        const remaining = chunk.length - headBytes;
        if (remaining === 0) return;
        this.tail ??= Buffer.allocUnsafe(this.tailCapacity);
        if (remaining >= this.tailCapacity) {
            chunk.copy(this.tail, 0, chunk.length - this.tailCapacity);
            this.tailOffset = 0;
            this.tailLength = this.tailCapacity;
            return;
        }
        const first = Math.min(remaining, this.tailCapacity - this.tailOffset);
        chunk.copy(this.tail, this.tailOffset, headBytes, headBytes + first);
        chunk.copy(this.tail, 0, headBytes + first);
        this.tailOffset = (this.tailOffset + remaining) % this.tailCapacity;
        this.tailLength = Math.min(
            this.tailCapacity,
            this.tailLength + remaining
        );
    }

    private suffix(): Buffer {
        if (!this.tail) return Buffer.alloc(0);
        if (this.tailLength < this.tailCapacity)
            return this.tail.subarray(0, this.tailLength);
        if (this.tailOffset === 0) return this.tail;
        return Buffer.concat([
            this.tail.subarray(this.tailOffset),
            this.tail.subarray(0, this.tailOffset),
        ]);
    }

    render(budget: number): { text: string; truncated: boolean } {
        const head = this.head?.subarray(0, this.headLength) ?? Buffer.alloc(0);
        const tail = this.suffix();
        if (this.totalBytes <= budget) {
            const text = Buffer.concat([head, tail]).toString('utf8');
            if (Buffer.byteLength(text) <= budget)
                return { text, truncated: false };
        }
        const marker = (bytes: number): string =>
            `\n[... ${bytes} bytes omitted ...]\n`;
        const markerBytes = Buffer.byteLength(marker(this.totalBytes));
        const includeMarker = budget >= markerBytes;
        const contentBudget = includeMarker ? budget - markerBytes : budget;
        const prefix = boundedWindow(
            head,
            Math.floor(contentBudget / 2),
            false
        );
        const suffix = boundedWindow(tail, Math.ceil(contentBudget / 2), true);
        const omitted = this.totalBytes - prefix.bytes - suffix.bytes;
        return {
            text:
                prefix.text +
                (includeMarker ? marker(omitted) : '') +
                suffix.text,
            truncated: omitted > 0,
        };
    }
}

/** Each stream can use the whole budget when the other is quiet; stderr cannot be starved. */
export function renderCommandOutput(
    stdout: OutputBuffer,
    stderr: OutputBuffer,
    budget: number
): {
    stdout: string;
    stderr: string;
    truncated: boolean;
} {
    if (stdout.bytes + stderr.bytes <= budget) {
        const out = stdout.render(budget);
        const err = stderr.render(budget);
        if (
            Buffer.byteLength(out.text) + Buffer.byteLength(err.text) <=
            budget
        ) {
            return {
                stdout: out.text,
                stderr: err.text,
                truncated: out.truncated || err.truncated,
            };
        }
    }
    const stderrReserve = Math.ceil(budget / 2);
    const stdoutBudget = Math.min(
        stdout.bytes,
        budget - stderrReserve + Math.max(0, stderrReserve - stderr.bytes)
    );
    const out = stdout.render(stdoutBudget);
    const err = stderr.render(budget - stdoutBudget);
    return {
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
    };
}
