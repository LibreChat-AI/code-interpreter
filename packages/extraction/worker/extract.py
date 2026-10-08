"""Request-local parser. Only the supervisor can choose its mode and files."""
import hashlib
import io
import json
import logging
import os
from pathlib import PurePosixPath
import socket
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile
import zlib

INPUT_BYTES = 10 * 1024 * 1024
TEXT_BYTES = 1024 * 1024
RESULT_BYTES = 3 * 1024 * 1024
EXPANDED_BYTES = 32 * 1024 * 1024
ENTRY_BYTES = 8 * 1024 * 1024
SEGMENTS = 128


class Rejected(Exception):
    def __init__(self, code):
        self.code = code


class Text:
    def __init__(self):
        self.size = 0
        self.parts = []

    def add(self, value):
        size = len(value.encode("utf-8", errors="strict"))
        if self.size + size > TEXT_BYTES:
            raise Rejected("OUTPUT_LIMIT")
        self.size += size
        self.parts.append(value)

    def value(self):
        return "".join(self.parts)


def pdf_segments(data):
    import pypdf
    from pypdf import filters, _page
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NullObject, StreamObject
    from pypdf._cmap import charset_encoding
    from pypdf._codecs.core_font_metrics import CORE_FONT_METRICS
    from pypdf._text_extraction._text_extractor import TextExtraction

    used = 0
    failure = None
    credited = {}
    shown_bytes = 0

    def reject(code):
        nonlocal failure
        failure = failure or code
        raise Rejected(failure)

    def check_failure():
        if failure is not None:
            raise Rejected(failure)

    class Warnings(logging.Handler):
        def emit(self, record):
            nonlocal failure
            failure = failure or "INVALID_DOCUMENT"

    logger = logging.getLogger("pypdf")
    logger.addHandler(Warnings())
    logger.setLevel(logging.WARNING)
    logger.propagate = False
    original = filters.decode_stream_data
    original_data = DecodedStreamObject.get_data
    original_show = TextExtraction._handle_tj_operation
    original_resources = _page._get_page_resources

    def inflate(value):
        nonlocal used
        # Strict bounded decoding, without pypdf's recovery/fallback paths.
        cap = min(ENTRY_BYTES, EXPANDED_BYTES - used)
        decoder = zlib.decompressobj()
        try:
            result = decoder.decompress(value, cap + 1)
        except zlib.error:
            reject("INVALID_DOCUMENT")
        if len(result) > cap or decoder.unconsumed_tail:
            reject("DECOMPRESSION_LIMIT")
        if not decoder.eof or decoder.unused_data:
            reject("INVALID_DOCUMENT")
        used += len(result)
        credited[id(result)] = result
        return result

    def decoded_data(stream):
        nonlocal used
        value = original_data(stream)
        if not getattr(stream, "_extraction_counted", False):
            if credited.get(id(value)) is not value:
                used += len(value)
            if len(value) > ENTRY_BYTES or used > EXPANDED_BYTES:
                reject("DECOMPRESSION_LIMIT")
            stream._extraction_counted = True
        return value

    def decode(stream):
        names = stream.get("/Filter", [])
        if not isinstance(names, list):
            names = [names]
        if len(names) > 1 or any(str(name) not in {
            "/FlateDecode", "/Fl", "/ASCIIHexDecode", "/AHx", "/ASCII85Decode", "/A85"
        } for name in names):
            reject("UNSUPPORTED_ENCODING")
        try:
            return original(stream)
        except Rejected:
            raise
        except MemoryError:
            reject("RESOURCE_LIMIT")
        except Exception:
            reject("INVALID_DOCUMENT")

    def resources_for_text(obj):
        resources = original_resources(obj)
        if resources:
            fonts = resources.get("/Font")
            if fonts is not None and not isinstance(fonts.get_object(), NullObject):
                for ref in fonts.get_object().values():
                    resource = ref.get_object()
                    for key in ("/Encoding", "/ToUnicode"):
                        if key in resource and isinstance(resource[key], NullObject):
                            del resource[key]
                    encoding = resource.get("/Encoding")
                    if encoding is not None:
                        encoding = encoding.get_object()
                        if not isinstance(encoding, (NameObject, DictionaryObject)):
                            reject("UNSUPPORTED_ENCODING")
                        if isinstance(encoding, DictionaryObject):
                            base = encoding.get("/BaseEncoding")
                            if base is not None and isinstance(base.get_object(), NullObject):
                                del encoding["/BaseEncoding"]
                    unicode_map = resource.get("/ToUnicode")
                    if unicode_map is not None and not isinstance(unicode_map.get_object(), StreamObject):
                        reject("UNSUPPORTED_ENCODING")
            for state in resources.get("/ExtGState", DictionaryObject()).get_object().values():
                if "/Font" in state.get_object():
                    reject("UNSUPPORTED_ENCODING")
            return resources
        # Do not let the parser skip text operators solely because resources
        # are absent. A used missing font must reach the rejection below.
        return DictionaryObject({NameObject("/Font"): DictionaryObject()})

    def show_text(extractor, operands):
        nonlocal shown_bytes
        if operands and operands[0]:
            font, resource = extractor.font, extractor.font_resource
            if resource is None or not font.interpretable:
                reject("UNSUPPORTED_ENCODING")
            if font.sub_type not in {"Type1", "MMType1", "TrueType", "Type3", "Type0"}:
                reject("UNSUPPORTED_ENCODING")
            encoding = resource.get("/Encoding")
            if encoding is not None:
                encoding = encoding.get_object()
            if isinstance(encoding, DictionaryObject):
                encoding = encoding.get("/BaseEncoding")
                if encoding is not None:
                    encoding = encoding.get_object()
            standard_encoding = isinstance(encoding, NameObject) and encoding in charset_encoding
            require_map = ("/ToUnicode" in resource or font.sub_type in {"Type3", "Type0"}
                           or isinstance(font.encoding, str)
                           or (not standard_encoding and font.name not in CORE_FONT_METRICS))
            value = operands[0]
            if isinstance(value, bytes):
                try:
                    if isinstance(font.encoding, str):
                        # Never take pypdf's charmap recovery on codec failure.
                        characters = value.decode(font.encoding, errors="surrogatepass")
                    else:
                        characters = (font.encoding[code] for code in value)
                    for character in characters:
                        if require_map and character not in font.character_map:
                            reject("UNSUPPORTED_ENCODING")
                        mapped = font.character_map.get(character, character)
                        # Unknown Adobe glyph names are preserved as NameObject.
                        if (not isinstance(mapped, str) or isinstance(mapped, NameObject)
                                or not mapped or "\ufffd" in mapped
                                or any(ord(char) < 32 and char not in "\t\n\r" for char in mapped)):
                            reject("UNSUPPORTED_ENCODING")
                        shown_bytes += len(mapped.encode("utf-8", errors="strict"))
                        if shown_bytes > TEXT_BYTES:
                            reject("OUTPUT_LIMIT")
                except (LookupError, UnicodeError, TypeError):
                    reject("UNSUPPORTED_ENCODING")
            elif not isinstance(value, str):
                reject("UNSUPPORTED_ENCODING")
        return original_show(extractor, operands)

    _page._get_page_resources = resources_for_text
    TextExtraction._handle_tj_operation = show_text
    DecodedStreamObject.get_data = decoded_data
    filters.decompress = inflate
    filters.decode_stream_data = decode
    reader = pypdf.PdfReader(io.BytesIO(data), strict=True)
    check_failure()
    if reader.is_encrypted:
        raise Rejected("ENCRYPTED_DOCUMENT")
    if len(reader.pages) > SEGMENTS:
        raise Rejected("STRUCTURE_LIMIT")
    result = []
    text = Text()
    for index, page in enumerate(reader.pages):
        value = page.extract_text() or ""
        check_failure()
        text.add(value)
        result.append({"kind": "page", "index": index + 1, "text": value})
    check_failure()
    return result, text.size


def validate_xml(value):
    xml = value.decode("utf-8", errors="strict")
    if "\x00" in xml or "<!DOCTYPE" in xml.upper() or "<!ENTITY" in xml.upper():
        raise Rejected("INVALID_DOCUMENT")
    return ET.fromstring(value)


def xml_parts(parts):
    types = validate_xml(parts["[Content_Types].xml"])
    namespace = "{http://schemas.openxmlformats.org/package/2006/content-types}"
    if types.tag != namespace + "Types":
        raise Rejected("INVALID_DOCUMENT")
    defaults = {}
    overrides = {}
    for item in types:
        content_type = item.attrib["ContentType"].lower()
        if item.tag == namespace + "Default":
            key = item.attrib["Extension"].lower()
            mapping = defaults
        elif item.tag == namespace + "Override":
            key = item.attrib["PartName"].lower()
            mapping = overrides
        else:
            raise Rejected("INVALID_DOCUMENT")
        if key in mapping:
            raise Rejected("INVALID_DOCUMENT")
        mapping[key] = content_type
    for name, value in parts.items():
        lowered = name.lower()
        content_type = overrides.get("/" + lowered, defaults.get(PurePosixPath(lowered).suffix[1:], ""))
        if (lowered.endswith((".xml", ".rels")) or content_type.endswith("+xml")
                or content_type in ("application/xml", "text/xml")):
            validate_xml(value)


def safe_docx(data):
    total = 0
    names = set()
    parts = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if len(archive.infolist()) > 512:
            raise Rejected("STRUCTURE_LIMIT")
        for entry in archive.infolist():
            name = entry.filename
            if entry.orig_filename != name:
                raise Rejected("INVALID_DOCUMENT")
            path = PurePosixPath(name)
            if (name in names or path.is_absolute() or ".." in path.parts or "\\" in name
                    or "\x00" in name or (entry.external_attr >> 16) & 0o170000 == 0o120000
                    or entry.flag_bits & 1 or entry.compress_type not in (0, 8)):
                raise Rejected("INVALID_DOCUMENT")
            names.add(name)
            if entry.file_size > ENTRY_BYTES:
                raise Rejected("DECOMPRESSION_LIMIT")
            # Let ZipFile validate local names, flags and entry overlap, but do
            # not use ZipExtFile.read(): it trims data to untrusted file_size.
            with archive.open(entry):
                offset = entry.header_offset
                if offset < 0 or offset + 30 > len(data):
                    raise Rejected("INVALID_DOCUMENT")
                method = struct.unpack_from("<H", data, offset + 8)[0]
                if method != entry.compress_type:
                    raise Rejected("INVALID_DOCUMENT")
                name_size, extra_size = struct.unpack_from("<HH", data, offset + 26)
                start = offset + 30 + name_size + extra_size
                end = start + entry.compress_size
                if end > len(data):
                    raise Rejected("INVALID_DOCUMENT")
                decoder = zlib.decompressobj(-zlib.MAX_WBITS) if entry.compress_type == 8 else None
                chunks = []
                size = 0
                crc = 0
                for position in range(start, end, 64 * 1024):
                    chunk = data[position:min(position + 64 * 1024, end)]
                    if decoder:
                        cap = min(ENTRY_BYTES - size, EXPANDED_BYTES - total)
                        chunk = decoder.decompress(chunk, cap + 1)
                    size += len(chunk)
                    total += len(chunk)
                    if size > ENTRY_BYTES or total > EXPANDED_BYTES:
                        raise Rejected("DECOMPRESSION_LIMIT")
                    crc = zlib.crc32(chunk, crc)
                    chunks.append(chunk)
                if decoder and (not decoder.eof or decoder.unused_data or decoder.unconsumed_tail):
                    raise Rejected("INVALID_DOCUMENT")
                if size != entry.file_size or crc != entry.CRC:
                    raise Rejected("INVALID_DOCUMENT")
            value = b"".join(chunks)
            parts[name] = value
    xml_parts(parts)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as clean:
        for name, value in parts.items():
            # The document parser sees only measured, validated parts.
            clean.writestr(name, value, compress_type=zipfile.ZIP_STORED)
    return output.getvalue()


def validate_docx_body(body):
    from lxml.etree import _Element

    literal = _Element.text.__get__
    word = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    # These are the exact content paths read by pinned python-docx. Unknown
    # wrappers fail closed rather than hiding text from its direct-child XPath.
    grammar = {
        "body": {"p", "tbl", "sectPr"},
        "tbl": {"tblPr", "tblGrid", "tr"},
        "tr": {"trPr", "tc"},
        "tc": {"tcPr", "p", "tbl"},
        "p": {"pPr", "r", "hyperlink"},
        "hyperlink": {"r"},
        "r": {"rPr", "t", "tab", "br", "cr", "noBreakHyphen", "ptab", "lastRenderedPageBreak"},
    }
    properties = {"sectPr", "tblPr", "tblGrid", "trPr", "tcPr", "pPr", "rPr"}
    markers = {"bookmarkStart", "bookmarkEnd", "commentRangeStart", "commentRangeEnd",
               "permStart", "permEnd", "proofErr"}
    stack = [(body, "body")]
    while stack:
        parent, kind = stack.pop()
        if literal(parent) and literal(parent).strip():
            raise Rejected("UNSUPPORTED_CONTENT")
        for child in parent:
            tag = child.tag.removeprefix(word) if isinstance(child.tag, str) else ""
            marker = kind in {"body", "p", "hyperlink", "tc"} and tag in markers
            if child.tag != word + tag or (tag not in grammar[kind] and not marker):
                raise Rejected("UNSUPPORTED_CONTENT")
            if child.tail and child.tail.strip():
                raise Rejected("UNSUPPORTED_CONTENT")
            if tag in properties:
                # Formatting is ignored, but cannot conceal textual content.
                if any(node.tag in {word + "t", word + "instrText", word + "delText"}
                       or (literal(node) and literal(node).strip())
                       or (node.tail and node.tail.strip()) for node in child.iter()):
                    raise Rejected("UNSUPPORTED_CONTENT")
            elif tag in grammar:
                stack.append((child, tag))
            elif len(child) or (tag != "t" and literal(child) and literal(child).strip()):
                raise Rejected("UNSUPPORTED_CONTENT")


def docx_segments(data):
    from docx import Document
    from docx.table import Table, _Cell

    document = Document(io.BytesIO(safe_docx(data)))
    validate_docx_body(document.element.body)
    text = Text()
    def blocks(container, depth=0, cell=False):
        if depth > 32:
            raise Rejected("STRUCTURE_LIMIT")
        first = True
        for block in container.iter_inner_content():
            if cell and not first:
                text.add("\n")
            first = False
            if isinstance(block, Table):
                width = len(block._tbl.tblGrid.gridCol_lst)
                if width < 1 or width > 512:
                    raise Rejected("STRUCTURE_LIMIT")
                previous = set()
                for row_index, row in enumerate(block.rows):
                    if row_index:
                        text.add("\n")
                    before, after = row.grid_cols_before, row.grid_cols_after
                    if before < 0 or after < 0 or before + after >= width:
                        raise Rejected("INVALID_DOCUMENT")
                    column = before
                    text.add("\t" * before)
                    current = set()
                    for index, tc in enumerate(row._tr.tc_lst):
                        span, merge = tc.grid_span, tc.vMerge
                        if span < 1 or column + span > width - after:
                            raise Rejected("INVALID_DOCUMENT")
                        if tc.tcPr is not None and tc.tcPr.find(
                                "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}hMerge") is not None:
                            raise Rejected("UNSUPPORTED_CONTENT")
                        if index:
                            text.add("\t")
                        position = (column, span)
                        if merge == "continue":
                            if position not in previous:
                                raise Rejected("INVALID_DOCUMENT")
                            # Continuations occupy columns, not another copy of
                            # the originating cell. Hidden content is rejected.
                            if tc.xpath(".//w:t | .//w:tbl | .//w:tab | .//w:br | .//w:cr | .//w:noBreakHyphen | .//w:ptab"):
                                raise Rejected("UNSUPPORTED_CONTENT")
                        else:
                            blocks(_Cell(tc, block), depth + 1, cell=True)
                        if merge is not None:
                            if merge not in {"restart", "continue"}:
                                raise Rejected("INVALID_DOCUMENT")
                            current.add(position)
                        text.add("\t" * (span - 1))
                        column += span
                    if column + after != width:
                        raise Rejected("INVALID_DOCUMENT")
                    text.add("\t" * after)
                    previous = current
                if not cell:
                    text.add("\n")
            else:
                text.add(block.text)
                if not cell:
                    text.add("\n")

    blocks(document)
    return [{"kind": "document", "index": 1, "text": text.value()}], text.size


def probe():
    import pypdf
    import docx
    import lxml.etree

    for path in ("/socket", "/jobs", "/proc/self/environ", "/etc/passwd"):
        try:
            if path in ("/socket", "/jobs"):
                os.listdir(path)
            else:
                open(path, "rb").read(1)
        except PermissionError:
            continue
        raise Rejected("ISOLATION_UNAVAILABLE")
    try:
        socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    except PermissionError:
        pass
    else:
        raise Rejected("ISOLATION_UNAVAILABLE")
    try:
        os.fork()
    except PermissionError:
        pass
    else:
        raise Rejected("ISOLATION_UNAVAILABLE")
    if "EXTRACTION_SECRET_CANARY" in os.environ:
        raise Rejected("ISOLATION_UNAVAILABLE")
    print("READY", flush=True)


def main():
    if sys.argv[1] == "probe":
        probe()
        return
    data = open("input", "rb").read(INPUT_BYTES + 1)
    if not data or len(data) > INPUT_BYTES:
        raise Rejected("INPUT_LIMIT")
    mode = sys.argv[1]
    if mode == "pdf":
        if not data.startswith(b"%PDF-"):
            raise Rejected("INVALID_DOCUMENT")
        segments, size = pdf_segments(data)
    elif mode == "docx":
        if not data.startswith(b"PK\x03\x04"):
            raise Rejected("INVALID_DOCUMENT")
        segments, size = docx_segments(data)
    else:
        raise Rejected("UNSUPPORTED_FORMAT")
    if not any(item["text"].strip() for item in segments):
        raise Rejected("EMPTY_OUTPUT")
    result = json.dumps({"version": 1, "operation": "document.extract-text", "format": mode,
                         "inputSha256": hashlib.sha256(data).hexdigest(), "textBytes": size,
                         "segments": segments}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(result) > RESULT_BYTES:
        raise Rejected("OUTPUT_LIMIT")
    with open("result", "xb") as target:
        target.write(result)


if __name__ == "__main__":
    try:
        main()
    except Rejected as error:
        print(error.code, flush=True)
        sys.exit(2)
    except MemoryError:
        print("RESOURCE_LIMIT", flush=True)
        sys.exit(2)
    except Exception:
        print("INVALID_DOCUMENT", flush=True)
        sys.exit(2)
