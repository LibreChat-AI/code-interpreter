"""Create bounded adversarial test documents inside the disposable test container."""
from pathlib import Path
import struct
import zipfile
from docx import Document
from pypdf import PdfReader, PdfWriter

root = Path('/tests/fixtures')
(root / 'bad.docx').write_bytes(b'PK\x03\x04not a zip')
with zipfile.ZipFile(root / 'entries.docx', 'w') as file:
    for index in range(513):
        file.writestr(str(index), 'x')
with zipfile.ZipFile(root / 'duplicate.docx', 'w') as file:
    file.writestr('same', 'a')
    file.writestr('same', 'b')
with zipfile.ZipFile(root / 'bomb.docx', 'w', compression=zipfile.ZIP_DEFLATED) as file:
    file.writestr('content.xml', b'x' * (8 * 1024 * 1024 + 1))
with zipfile.ZipFile(root / 'aggregate.docx', 'w', compression=zipfile.ZIP_DEFLATED) as file:
    for index in range(5):
        file.writestr(str(index), b'x' * (7 * 1024 * 1024))
for name, value in [('utf8.docx', b'\xff'), ('entities.docx', b'<!DOCTYPE x [<!ENTITY x "y">]><x/>')]:
    with zipfile.ZipFile(root / name, 'w') as file:
        file.writestr('word/document.xml', value)
with zipfile.ZipFile(root / 'forged.docx', 'w', compression=zipfile.ZIP_DEFLATED) as file:
    file.writestr('content.xml', 'forged-content' * 20)
value = bytearray((root / 'forged.docx').read_bytes())
central = value.index(b'PK\x01\x02')
struct.pack_into('<I', value, central + 24, 1)
(root / 'forged.docx').write_bytes(value)
document = Document()
document.add_paragraph('x' * (1024 * 1024 + 1))
document.save(root / 'output.docx')
document = Document()
document.add_paragraph('x' * (1024 * 1024 - 1))
document.save(root / 'exact.docx')
writer = PdfWriter()
writer.append(root / 'pages.pdf')
writer.encrypt('private-test-password')
writer.write(root / 'encrypted.pdf')
writer = PdfWriter()
for index in range(129):
    writer.add_blank_page(width=10, height=10)
writer.write(root / 'too-many-pages.pdf')
print('Adversarial documents generated')

for delta, name in [(0, 'raw-exact.pdf'), (1, 'raw-limit.pdf')]:
    writer = PdfWriter()
    writer.append(root / 'pages.pdf')
    stream = writer.pages[0]['/Contents'].get_object()
    value = stream.get_data()
    stream.set_data(b' ' * (8 * 1024 * 1024 - len(value) + delta) + value)
    writer.write(root / name)

document = Document()
outer = document.add_table(rows=1, cols=1)
cell = outer.cell(0, 0)
cell.paragraphs[0].text = 'Before nested table'
nested = cell.add_table(rows=1, cols=2)
nested.cell(0, 0).text = 'Nested left'
nested.cell(0, 1).text = 'Nested right'
cell.add_paragraph('After nested table')
document.save(root / 'nested.docx')
document = Document()
outer = document.add_table(rows=1, cols=1)
outer.cell(0, 0).add_table(rows=1, cols=1).cell(0, 0).text = 'Only nested text'
document.save(root / 'nested-only.docx')

from pypdf.generic import (
    ArrayObject, DecodedStreamObject, DictionaryObject, EncodedStreamObject,
    NameObject, NumberObject,
)
for name, mode in [('form-limit.pdf', 'limit'), ('form-filter.pdf', 'filter'), ('form-valid.pdf', 'valid')]:
    writer = PdfWriter()
    writer.append(root / 'pages.pdf')
    page = writer.pages[0]
    if mode == 'filter':
        form = EncodedStreamObject()
        form._data = b'x'
        form[NameObject('/Filter')] = NameObject('/LZWDecode')
    else:
        form = DecodedStreamObject()
        form.set_data(b' ' * (8 * 1024 * 1024 + 1) if mode == 'limit'
                      else b'BT /F1 12 Tf 72 700 Td (Form content) Tj ET')
        form = form.flate_encode()
    form[NameObject('/Type')] = NameObject('/XObject')
    form[NameObject('/Subtype')] = NameObject('/Form')
    form[NameObject('/BBox')] = ArrayObject([NumberObject(v) for v in [0, 0, 612, 792]])
    form[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): page['/Resources']['/Font']})
    page['/Resources'][NameObject('/XObject')] = DictionaryObject({NameObject('/Form'): writer._add_object(form)})
    stream = page['/Contents'].get_object()
    stream.set_data(stream.get_data() + b'\n/Form Do')
    writer.write(root / name)

# A valid XML prefix with forged size AND CRC must not hide trailing inflation.
with zipfile.ZipFile(root / 'body.docx') as source, zipfile.ZipFile(root / 'forged-bomb.docx', 'w', compression=zipfile.ZIP_DEFLATED) as target:
    prefix = source.read('word/document.xml')
    for entry in source.infolist():
        value = source.read(entry)
        if entry.filename == 'word/document.xml':
            value += b' ' * (9 * 1024 * 1024)
        target.writestr(entry.filename, value)
value = bytearray((root / 'forged-bomb.docx').read_bytes())
position = 0
while True:
    position = value.find(b'PK\x01\x02', position)
    if position < 0:
        raise RuntimeError('Missing central entry')
    length = struct.unpack_from('<H', value, position + 28)[0]
    if value[position + 46:position + 46 + length] == b'word/document.xml':
        import zlib
        struct.pack_into('<I', value, position + 16, zlib.crc32(prefix))
        struct.pack_into('<I', value, position + 24, len(prefix))
        break
    position += 4
(root / 'forged-bomb.docx').write_bytes(value)
