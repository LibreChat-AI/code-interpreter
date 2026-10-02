import assert from 'node:assert/strict';
import test from 'node:test';
import { OutputBuffer, renderCommandOutput } from './output.js';

function collect(
    content: Buffer,
    budget: number,
    chunkSize = content.length || 1
): OutputBuffer {
    const output = new OutputBuffer(budget);
    for (let offset = 0; offset < content.length; offset += chunkSize) {
        output.append(content.subarray(offset, offset + chunkSize));
    }
    return output;
}

function assertBounded(text: string, budget: number): void {
    assert.ok(Buffer.byteLength(text) <= budget);
    assert.equal(Buffer.from(text).toString('utf8'), text);
}

test('small output stays byte-for-byte unchanged, including split UTF-8 and exact limits', () => {
    for (const content of ['', '1234567', 'hello\n世界🌍\n']) {
        const bytes = Buffer.from(content);
        const budget = Math.max(1, bytes.length);
        for (const chunkSize of [1, 2, 7, 64]) {
            assert.deepEqual(collect(bytes, budget, chunkSize).render(budget), {
                text: content,
                truncated: false,
            });
        }
    }
});

test('a rolling suffix keeps the last summary and reports the exact dropped-byte count', () => {
    const budget = 128;
    const content = Buffer.from(
        'START\n' + 'x'.repeat(10_000) + '\n42 tests passed\n'
    );
    for (const chunkSize of [1, 3, 63, 64, 65, 127, 1024, content.length]) {
        const result = collect(content, budget, chunkSize).render(budget);
        assert.equal(result.truncated, true);
        assert.ok(result.text.startsWith('START\n'));
        assert.ok(result.text.endsWith('\n42 tests passed\n'));
        const marker = /\n\[\.\.\. (\d+) bytes omitted \.\.\.\]\n/.exec(
            result.text
        );
        assert.ok(marker);
        assert.equal(
            Number(marker[1]),
            content.length -
                Buffer.byteLength(result.text.replace(marker[0], ''))
        );
        assertBounded(result.text, budget);
    }
});

test('either quiet stream donates its budget, and stdout cannot starve stderr', () => {
    const budget = 256;
    const empty = collect(Buffer.alloc(0), budget);
    const exact = collect(Buffer.alloc(budget, 'a'), budget, 1);
    assert.deepEqual(renderCommandOutput(exact, empty, budget), {
        stdout: 'a'.repeat(budget),
        stderr: '',
        truncated: false,
    });
    assert.deepEqual(renderCommandOutput(empty, exact, budget), {
        stdout: '',
        stderr: 'a'.repeat(budget),
        truncated: false,
    });
    const stdout = collect(
        Buffer.from('OUT\n' + 'x'.repeat(4096) + '\nstdout summary'),
        budget
    );
    const stderr = collect(
        Buffer.from('ERR\n' + 'y'.repeat(4096) + '\nstderr summary'),
        budget
    );
    const result = renderCommandOutput(stdout, stderr, budget);
    assert.ok(result.stdout.startsWith('OUT\n'));
    assert.ok(result.stderr.startsWith('ERR\n'));
    assert.ok(result.stdout.endsWith('stdout summary'));
    assert.ok(result.stderr.endsWith('stderr summary'));
    assert.ok(result.stdout.includes('bytes omitted'));
    assert.ok(result.stderr.includes('bytes omitted'));
    assert.ok(
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <=
            budget
    );
    assert.equal(result.truncated, true);

    const shortError = collect(Buffer.from('late failure'), budget);
    assert.equal(
        renderCommandOutput(stdout, shortError, budget).stderr,
        'late failure'
    );
    assert.equal(
        renderCommandOutput(shortError, stdout, budget).stdout,
        'late failure'
    );
});

test('budgeting includes UTF-8 boundaries and marker overhead for every small limit', () => {
    const content = Buffer.from('世界🌍 café Ελληνικά\n'.repeat(100));
    for (let budget = 1; budget <= 256; budget += 1) {
        const result = collect(content, budget, 1).render(budget);
        assertBounded(result.text, budget);
        assert.equal(result.truncated, true);
        assert.ok(
            !result.text.includes('\ufffd'),
            `split code point at budget ${budget}`
        );
        const marker = /\n\[\.\.\. (\d+) bytes omitted \.\.\.\]\n/.exec(
            result.text
        );
        if (marker) {
            assert.equal(
                Number(marker[1]),
                content.length -
                    Buffer.byteLength(result.text.replace(marker[0], ''))
            );
        }
        const streams = renderCommandOutput(
            collect(content, budget, 7),
            collect(content, budget, 3),
            budget
        );
        assert.ok(
            Buffer.byteLength(streams.stdout) +
                Buffer.byteLength(streams.stderr) <=
                budget
        );
        assert.ok(
            !streams.stdout.includes('\ufffd') &&
                !streams.stderr.includes('\ufffd')
        );
    }
});

test('malformed output cannot expand past the byte budget during decoding', () => {
    for (const content of [
        Buffer.alloc(1024, 0xff),
        Buffer.from([0xf0, 0x80, 0xff, 0xc2, 0xa2, 0xe0, 0xa0]),
        Buffer.from('a\ufffdb'.repeat(300)),
    ]) {
        for (let budget = 1; budget <= 128; budget += 1) {
            const result = collect(content, budget, 1).render(budget);
            assertBounded(result.text, budget);
            if (content.length > budget) assert.equal(result.truncated, true);
        }
    }
});

test('short decoded output is preserved when replacement characters fit the combined budget', () => {
    const budget = 32;
    assert.deepEqual(
        renderCommandOutput(
            collect(Buffer.from([0xff, 0xff]), budget),
            collect(Buffer.from('child failure'), budget),
            budget
        ),
        { stdout: '\ufffd\ufffd', stderr: 'child failure', truncated: false }
    );
});

test('quiet-stream donation counts decoded bytes beside noisy output', () => {
    for (const bytes of [
        Buffer.from([0xff, 0xff]),
        Buffer.from([0x80, 0x80]),
        Buffer.from([0xf0, 0x9f]),
        Buffer.from([0x61, 0xff, 0x62]),
    ]) {
        const decoded = bytes.toString('utf8');
        for (const budget of [16, 31, 32, 63, 64, 128]) {
            const quiet = collect(bytes, budget, 1);
            const noisy = collect(Buffer.alloc(budget * 4, 'x'), budget, 7);
            for (const [stdout, stderr, stream] of [
                [noisy, quiet, 'stderr'],
                [quiet, noisy, 'stdout'],
            ] as const) {
                const result = renderCommandOutput(stdout, stderr, budget);
                assert.equal(result[stream], decoded);
                assert.equal(result.truncated, true);
                assert.ok(
                    Buffer.byteLength(result.stdout) +
                        Buffer.byteLength(result.stderr) <=
                        budget
                );
            }
        }
    }
});

test('tiny budgets still flag truncation and give stderr the odd byte', () => {
    for (let budget = 1; budget < 32; budget += 1) {
        const result = renderCommandOutput(
            collect(Buffer.from('a'.repeat(256)), budget),
            collect(Buffer.from('b'.repeat(256)), budget),
            budget
        );
        assert.equal(result.truncated, true);
        assert.ok(result.stderr.length > 0);
        assert.ok(
            Buffer.byteLength(result.stdout) +
                Buffer.byteLength(result.stderr) <=
                budget
        );
    }
});

test('copies bounded windows instead of retaining or repeatedly concatenating source chunks', () => {
    const budget = 128;
    const output = new OutputBuffer(budget);
    const oversized = Buffer.alloc(1024 * 1024, 'a');
    output.append(oversized);
    oversized.fill('z');
    const byte = Buffer.from('b');
    for (let i = 0; i < 100_000; i += 1) output.append(byte);
    byte[0] = 0x7a;
    const result = output.render(budget);
    assert.ok(result.text.startsWith('a'.repeat(40)));
    assert.ok(result.text.endsWith('b'.repeat(40)));
    assert.ok(!result.text.includes('z'));
    assert.equal(output.bytes, 1024 * 1024 + 100_000);
    assertBounded(result.text, budget);
});
