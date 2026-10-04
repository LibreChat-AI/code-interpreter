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
const form = await send('pdf', readFileSync(`${fixtures}/form-valid.pdf`));
assert.equal(form.status, 200);
assert.match(form.value.segments[0].text, /Form content/);
const nested = await send('docx', readFileSync(`${fixtures}/nested.docx`));
assert.equal(nested.status, 200);
assert.match(
    nested.value.segments[0].text,
    /Before nested table\nNested left\tNested right[\n]+After nested table/
);
const nestedOnly = await send(
    'docx',
    readFileSync(`${fixtures}/nested-only.docx`)
);
assert.equal(nestedOnly.status, 200);
assert.match(nestedOnly.value.segments[0].text, /Only nested text/);
for (const name of [
    'renamed-valid.docx',
    'renamed-default.docx',
    'renamed-case.docx',
]) {
    const response = await send('docx', readFileSync(`${fixtures}/${name}`));
    assert.equal(response.status, 200, name);
    assert.deepEqual(response.value.segments, docx.value.segments, name);
}
const primitives = await send(
    'docx',
    readFileSync(`${fixtures}/supported-runs.docx`)
);
assert.equal(primitives.status, 200);
assert.equal(
    primitives.value.segments[0].text,
    'Bold Link\tTabbed\nNext-\t\nEnd\n'
);
for (const [name, expected] of [
    ['horizontal.docx', 'Merged text\t\tR0C2\nR1C0\tR1C1\tR1C2\n'],
    ['vertical.docx', 'Merged text\tR0C1\tR0C2\n\tR1C1\tR1C2\n'],
    ['rectangle.docx', 'Merged text\t\tR0C2\n\t\tR1C2\n'],
    ['omitted-cells.docx', '\tMiddle cell\t\n'],
]) {
    const response = await send('docx', readFileSync(`${fixtures}/${name}`));
    assert.equal(response.status, 200, name);
    assert.equal(response.value.segments[0].text, expected, name);
}
const mergedNested = await send(
    'docx',
    readFileSync(`${fixtures}/merged-nested.docx`)
);
assert.equal(mergedNested.status, 200);
assert.equal(
    mergedNested.value.segments[0].text.match(/Unique nested content/g).length,
    1
);
assert.match(
    mergedNested.value.segments[0].text,
    /Before merged nested table[\n]+Unique nested content[\n]+After merged nested table/
);
for (const name of ['merged-large.docx', 'merged-large-vertical.docx']) {
    const response = await send('docx', readFileSync(`${fixtures}/${name}`));
    assert.equal(response.status, 200, name);
    assert.equal(
        response.value.segments[0].text.match(/x/g).length,
        600 * 1024,
        name
    );
}
for (const [name, expected] of [
    ['font-type3-unicode.pdf', '\u03a9'],
    ['font-simple-unicode.pdf', '\u03a9'],
    ['font-known-glyph.pdf', '\u00c1'],
    ['font-ligature.pdf', 'fi'],
    ['font-emoji.pdf', '\ud83d\ude00'],
    ['font-composite-unicode.pdf', 'Afi'],
]) {
    const response = await send('pdf', readFileSync(`${fixtures}/${name}`));
    assert.equal(response.status, 200, name);
    assert.equal(response.value.segments[0].text, expected, name);
}
const fontForm = await send(
    'pdf',
    readFileSync(`${fixtures}/font-form-unicode.pdf`)
);
assert.equal(fontForm.status, 200);
assert.match(fontForm.value.segments[0].text, /First page text[\n]+\u03a9/);
const noResources = await send(
    'pdf',
    readFileSync(`${fixtures}/no-resources-graphics.pdf`)
);
assert.equal(noResources.status, 200);
assert.deepEqual(
    noResources.value.segments.map(segment => segment.text),
    ['', 'Second page text']
);
for (const mode of [
    'null',
    'indirect-null',
    'null-unicode',
    'indirect-null-unicode',
    'null-base',
]) {
    const response = await send(
        'pdf',
        readFileSync(`${fixtures}/font-core-${mode}.pdf`)
    );
    assert.equal(response.status, 200, mode);
    assert.deepEqual(response.value.segments, result.value.segments, mode);
}
for (const [name, expected] of [
    ['font-null-with-unicode.pdf', '\u03a9'],
    ['font-custom-standard.pdf', '\u00c1'],
]) {
    const response = await send('pdf', readFileSync(`${fixtures}/${name}`));
    assert.equal(response.status, 200, name);
    assert.equal(response.value.segments[0].text, expected, name);
}
const rejectedFixtures = [
    ['font-replacement.pdf', 'pdf', 'UNSUPPORTED_ENCODING'],
    ['font-partial-simple.pdf', 'pdf', 'UNSUPPORTED_ENCODING'],
    ['font-no-resources.pdf', 'pdf', 'UNSUPPORTED_ENCODING'],
    ['font-graphics-state.pdf', 'pdf', 'UNSUPPORTED_ENCODING'],
    ['font-type3-unmapped.pdf', 'pdf', 'UNSUPPORTED_ENCODING'],
    ['font-simple-unmapped.pdf', 'pdf', 'UNSUPPORTED_ENCODING'],
    ['font-form-unmapped.pdf', 'pdf', 'UNSUPPORTED_ENCODING'],
    ['font-partial-map.pdf', 'pdf', 'UNSUPPORTED_ENCODING'],
    ['font-empty-map.pdf', 'pdf', 'UNSUPPORTED_ENCODING'],
    ['font-bad-unicode.pdf', 'pdf', 'UNSUPPORTED_ENCODING'],
    ['font-composite-unmapped.pdf', 'pdf', 'UNSUPPORTED_ENCODING'],
    ['font-codec-fallback.pdf', 'pdf', 'UNSUPPORTED_ENCODING'],
    ['font-composite-partial.pdf', 'pdf', 'UNSUPPORTED_ENCODING'],
    ['font-missing.pdf', 'pdf', 'UNSUPPORTED_ENCODING'],
    ['merge-content.docx', 'docx', 'UNSUPPORTED_CONTENT'],
    ['merge-orphan.docx', 'docx', 'INVALID_DOCUMENT'],
    ['merge-span.docx', 'docx', 'INVALID_DOCUMENT'],
    ['merge-legacy.docx', 'docx', 'UNSUPPORTED_CONTENT'],
    ['wide-table.docx', 'docx', 'STRUCTURE_LIMIT'],
    ['control.docx', 'docx', 'UNSUPPORTED_CONTENT'],
    ['control-cell.docx', 'docx', 'UNSUPPORTED_CONTENT'],
    ['control-inline.docx', 'docx', 'UNSUPPORTED_CONTENT'],
    ['control-only.docx', 'docx', 'UNSUPPORTED_CONTENT'],
    ['custom-wrapper.docx', 'docx', 'UNSUPPORTED_CONTENT'],
    ['revision.docx', 'docx', 'UNSUPPORTED_CONTENT'],
    ['simple-field.docx', 'docx', 'UNSUPPORTED_CONTENT'],
    ['renamed-entities.docx', 'docx', 'INVALID_DOCUMENT'],
    ['renamed-default-entities.docx', 'docx', 'INVALID_DOCUMENT'],
    ['renamed-case-entities.docx', 'docx', 'INVALID_DOCUMENT'],
    ['renamed-utf8.docx', 'docx', 'INVALID_DOCUMENT'],
    ['empty.pdf', 'pdf', 'EMPTY_OUTPUT'],
    ['empty.docx', 'docx', 'EMPTY_OUTPUT'],
    ['inflate.pdf', 'pdf', 'DECOMPRESSION_LIMIT'],
    ['aggregate.pdf', 'pdf', 'DECOMPRESSION_LIMIT'],
    ['raw-limit.pdf', 'pdf', 'DECOMPRESSION_LIMIT'],
    ['form-limit.pdf', 'pdf', 'DECOMPRESSION_LIMIT'],
    ['form-filter.pdf', 'pdf', 'UNSUPPORTED_ENCODING'],
    ['aggregate.docx', 'docx', 'DECOMPRESSION_LIMIT'],
    ['bad.docx', 'docx', 'INVALID_DOCUMENT'],
    ['entries.docx', 'docx', 'STRUCTURE_LIMIT'],
    ['duplicate.docx', 'docx', 'INVALID_DOCUMENT'],
    ['forged.docx', 'docx', 'INVALID_DOCUMENT'],
    ['forged-bomb.docx', 'docx', 'DECOMPRESSION_LIMIT'],
    ['utf8.docx', 'docx', 'INVALID_DOCUMENT'],
    ['entities.docx', 'docx', 'INVALID_DOCUMENT'],
    ['bomb.docx', 'docx', 'DECOMPRESSION_LIMIT'],
    ['output.docx', 'docx', 'OUTPUT_LIMIT'],
    ['encrypted.pdf', 'pdf', 'ENCRYPTED_DOCUMENT'],
    ['too-many-pages.pdf', 'pdf', 'STRUCTURE_LIMIT'],
];
for (const subtype of ['type1', 'truetype']) {
    for (const mode of [
        'absent',
        'null',
        'indirect-null',
        'empty-dict',
        'null-base',
        'invalid-number',
    ]) {
        rejectedFixtures.push([
            `font-${subtype}-${mode}.pdf`,
            'pdf',
            'UNSUPPORTED_ENCODING',
        ]);
    }
}
for (const tag of ['dir', 'bdo', 'smartTag', 'unknownWrapper']) {
    for (const placement of ['paragraph', 'cell', 'hyperlink']) {
        rejectedFixtures.push([
            `wrapper-${tag}-${placement}.docx`,
            'docx',
            'UNSUPPORTED_CONTENT',
        ]);
    }
}
for (const name of ['wrapper-block.docx', 'wrapper-run.docx']) {
    rejectedFixtures.push([name, 'docx', 'UNSUPPORTED_CONTENT']);
}
for (const [name, format, code] of rejectedFixtures) {
    const response = await send(format, readFileSync(`${fixtures}/${name}`));
    assert.equal(
        response.value.error?.code,
        code,
        `${name}: ${JSON.stringify(response)}`
    );
}
assert.equal(
    (await send('pdf', readFileSync(`${fixtures}/raw-exact.pdf`))).status,
    200
);
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
    `Container endpoint: PDF/DOCX success, structure, input limits and ${rejectedFixtures.length} adversarial fixtures passed`
);
