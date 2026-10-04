import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createHash } from 'node:crypto';

const socketPath = '/socket/extraction.sock';
function send(format, bytes, path = '/v1/extract-text', extra = {}) {
    return new Promise((resolve, reject) => {
        const req = request(
            {
                socketPath,
                path,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': bytes.length,
                    'X-Extraction-Version': '1',
                    'X-Extraction-Format': format,
                    ...extra,
                },
            },
            res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () =>
                    resolve({
                        status: res.statusCode,
                        value: JSON.parse(
                            Buffer.concat(chunks).toString('utf8')
                        ),
                    })
                );
                res.on('error', reject);
            }
        );
        req.on('error', reject);
        req.end(bytes);
    });
}
const fixtures = '/tests/fixtures';
const pages = readFileSync(`${fixtures}/pages.pdf`);
const result = await send('pdf', pages);
assert.equal(result.status, 200);
assert.deepEqual(
    result.value.segments.map(s => [s.kind, s.index, s.text]),
    [
        ['page', 1, 'First page text'],
        ['page', 2, 'Second page text'],
    ]
);
assert.equal(
    result.value.inputSha256,
    createHash('sha256').update(pages).digest('hex')
);
assert.equal(
    (await send('pdf', readFileSync(`${fixtures}/compressed.pdf`))).value
        .segments[0].text,
    'Compressed page text'
);
const docx = await send('docx', readFileSync(`${fixtures}/body.docx`));
assert.equal(docx.status, 200);
assert.deepEqual(docx.value.segments, [
    {
        kind: 'document',
        index: 1,
        text: 'First paragraph\nLeft cell\tRight cell\nLast paragraph\n',
    },
]);
for (const [name, format, code] of [
    ['empty.pdf', 'pdf', 'EMPTY_OUTPUT'],
    ['empty.docx', 'docx', 'EMPTY_OUTPUT'],
    ['inflate.pdf', 'pdf', 'DECOMPRESSION_LIMIT'],
    ['aggregate.pdf', 'pdf', 'DECOMPRESSION_LIMIT'],
    ['aggregate.docx', 'docx', 'DECOMPRESSION_LIMIT'],
    ['bad.docx', 'docx', 'INVALID_DOCUMENT'],
    ['entries.docx', 'docx', 'STRUCTURE_LIMIT'],
    ['duplicate.docx', 'docx', 'INVALID_DOCUMENT'],
    ['forged.docx', 'docx', 'INVALID_DOCUMENT'],
    ['utf8.docx', 'docx', 'INVALID_DOCUMENT'],
    ['entities.docx', 'docx', 'INVALID_DOCUMENT'],
    ['bomb.docx', 'docx', 'DECOMPRESSION_LIMIT'],
    ['output.docx', 'docx', 'OUTPUT_LIMIT'],
    ['encrypted.pdf', 'pdf', 'ENCRYPTED_DOCUMENT'],
    ['too-many-pages.pdf', 'pdf', 'STRUCTURE_LIMIT'],
]) {
    const response = await send(format, readFileSync(`${fixtures}/${name}`));
    assert.equal(
        response.value.error?.code,
        code,
        `${name}: ${JSON.stringify(response)}`
    );
}
const exact = await send('docx', readFileSync(`${fixtures}/exact.docx`));
assert.equal(exact.status, 200);
assert.equal(exact.value.textBytes, 1024 * 1024);
assert.equal(
    (await send('pdf', Buffer.from('not a pdf'))).value.error.code,
    'INVALID_DOCUMENT'
);
assert.equal((await send('docx', pages)).value.error.code, 'INVALID_DOCUMENT');
assert.equal((await send('xls', pages)).status, 400);
assert.equal((await send('pdf', pages, '/exec')).status, 404);
assert.equal(
    (await send('pdf', pages, '/v1/extract-text?script=x')).status,
    404
);
assert.equal(
    (
        await send('pdf', pages, '/v1/extract-text', {
            'X-Extraction-Url': 'http://example.com',
        })
    ).status,
    400
);
// Exact input cap is accepted; one byte more is rejected before parsing.
const padded = Buffer.alloc(10 * 1024 * 1024, 32);
pages.copy(padded);
assert.equal((await send('pdf', padded)).status, 200);
assert.equal((await send('pdf', Buffer.alloc(padded.length + 1))).status, 413);
console.log(
    'Container endpoint: PDF/DOCX success, structure, input limits and 15 adversarial fixtures passed'
);
