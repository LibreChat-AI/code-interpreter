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

from docx.oxml import OxmlElement
from docx.oxml.ns import qn
import xml.etree.ElementTree as ET

# Body, cell and inline wrappers are rejected rather than silently omitted.
for name, placement in [('control.docx', 'body'), ('control-cell.docx', 'cell'),
                        ('control-inline.docx', 'inline'), ('control-only.docx', 'only')]:
    document = Document()
    if placement != 'only':
        document.add_paragraph('Ordinary text must not hide unsupported content')
    if placement == 'cell':
        paragraph = document.add_table(rows=1, cols=1).cell(0, 0).add_paragraph('Controlled cell text')
        element = paragraph._p
    elif placement == 'inline':
        element = document.add_paragraph('Before ').add_run('Controlled inline text')._r
    else:
        element = document.add_paragraph('Controlled body text')._p
    parent, index = element.getparent(), element.getparent().index(element)
    control = OxmlElement('w:sdt')
    content = OxmlElement('w:sdtContent')
    control.append(content)
    content.append(element)
    parent.insert(index, control)
    document.save(root / name)

for name, tag in [('custom-wrapper.docx', 'w:customXml'), ('revision.docx', 'w:ins'),
                  ('simple-field.docx', 'w:fldSimple')]:
    document = Document()
    document.add_paragraph('Ordinary text')
    paragraph = document.add_paragraph('Wrapped text')
    element = paragraph.add_run('Hidden field text')._r if tag == 'w:fldSimple' else paragraph._p
    parent, index = element.getparent(), element.getparent().index(element)
    wrapper = OxmlElement(tag)
    wrapper.append(element)
    parent.insert(index, wrapper)
    document.save(root / name)

ct = '{http://schemas.openxmlformats.org/package/2006/content-types}'
for name, mapping, payload in [
    ('renamed-valid.docx', 'override', 'valid'),
    ('renamed-default.docx', 'default', 'valid'),
    ('renamed-case.docx', 'case', 'valid'),
    ('renamed-entities.docx', 'override', 'entity'),
    ('renamed-default-entities.docx', 'default', 'entity'),
    ('renamed-case-entities.docx', 'case', 'entity'),
    ('renamed-utf8.docx', 'override', 'utf8'),
]:
    with zipfile.ZipFile(root / 'body.docx') as source, zipfile.ZipFile(root / name, 'w', compression=zipfile.ZIP_DEFLATED) as target:
        for entry in source.infolist():
            value = source.read(entry)
            member = entry.filename
            if member == '[Content_Types].xml':
                types = ET.fromstring(value)
                for item in list(types):
                    if item.attrib.get('PartName') == '/word/document.xml':
                        if mapping == 'default':
                            types.remove(item)
                            ET.SubElement(types, ct + 'Default', Extension='bin', ContentType=item.attrib['ContentType'])
                        else:
                            item.attrib['PartName'] = '/WORD/DOCUMENT.BIN' if mapping == 'case' else '/word/document.bin'
                value = ET.tostring(types, encoding='utf-8', xml_declaration=True)
            elif member == '_rels/.rels':
                value = value.replace(b'word/document.xml', b'word/document.bin')
            elif member == 'word/document.xml':
                member = 'word/document.bin'
                if payload == 'entity':
                    declaration_end = value.index(b'?>') + 2
                    value = value[:declaration_end] + b'<!DOCTYPE w:document [<!ENTITY controlled "Entity text">]>' + value[declaration_end:]
                    value = value.replace(b'First paragraph', b'&controlled;')
                elif payload == 'utf8':
                    value = value.replace(b'First paragraph', b'\xff')
            elif member == 'word/_rels/document.xml.rels':
                member = 'word/_rels/document.bin.rels'
            target.writestr(member, value)
print('DOCX completeness and content-type fixtures generated')

# The supported structure is closed, not an expanding list of forbidden tags.
for tag in ['dir', 'bdo', 'smartTag', 'unknownWrapper']:
    for placement in ['paragraph', 'cell', 'hyperlink']:
        document = Document()
        document.add_paragraph('Ordinary text must not hide wrapped content')
        paragraph = (document.add_table(rows=1, cols=1).cell(0, 0).add_paragraph()
                     if placement == 'cell' else document.add_paragraph())
        run = paragraph.add_run('Wrapped run text')._r
        parent = run.getparent()
        if placement == 'hyperlink':
            link = OxmlElement('w:hyperlink')
            link.set(qn('w:anchor'), 'test')
            parent.append(link)
            parent = link
        wrapper = OxmlElement('w:' + tag)
        if tag in ('dir', 'bdo'):
            wrapper.set(qn('w:val'), 'rtl')
        wrapper.append(run)
        parent.append(wrapper)
        document.save(root / f'wrapper-{tag}-{placement}.docx')

# A malformed unknown block and run child cannot bypass the same invariant.
document = Document()
document.add_paragraph('Ordinary text')
paragraph = document.add_paragraph('Unknown body wrapper text')
parent = paragraph._p.getparent()
wrapper = OxmlElement('w:unknownWrapper')
wrapper.append(paragraph._p)
parent.insert(0, wrapper)
document.save(root / 'wrapper-block.docx')
document = Document()
document.add_paragraph('Ordinary text')
run = document.add_paragraph().add_run('Run wrapper text')._r
text = run[0]
wrapper = OxmlElement('w:unknownWrapper')
wrapper.append(text)
run.append(wrapper)
document.save(root / 'wrapper-run.docx')

# Accepted formatting, hyperlinks, bookmarks and run text primitives retain order.
document = Document()
paragraph = document.add_paragraph()
bookmark = OxmlElement('w:bookmarkStart')
bookmark.set(qn('w:id'), '1')
bookmark.set(qn('w:name'), 'test')
paragraph._p.append(bookmark)
paragraph.add_run('Bold ').bold = True
link = OxmlElement('w:hyperlink')
link.set(qn('w:anchor'), 'test')
run = OxmlElement('w:r')
text = OxmlElement('w:t')
text.text = 'Link'
run.append(text)
link.append(run)
paragraph._p.append(link)
paragraph.add_run('\tTabbed\nNext')
run = paragraph.add_run()._r
run.append(OxmlElement('w:noBreakHyphen'))
run.append(OxmlElement('w:ptab'))
run.append(OxmlElement('w:cr'))
text = OxmlElement('w:t')
text.text = 'End'
run.append(text)
run.append(OxmlElement('w:lastRenderedPageBreak'))
bookmark = OxmlElement('w:bookmarkEnd')
bookmark.set(qn('w:id'), '1')
paragraph._p.append(bookmark)
document.save(root / 'supported-runs.docx')
print('DOCX closed-structure fixtures generated')
