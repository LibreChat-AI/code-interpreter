"""Request-local parser. Only the supervisor can choose its mode and files."""
import hashlib
import io
import json
import os
from pathlib import PurePosixPath
import socket
import sys
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
    from pypdf import filters

    used = 0
    original = filters.decode_stream_data

    def inflate(value):
        # Strict bounded decoding, without pypdf's recovery/fallback paths.
        cap = min(ENTRY_BYTES, EXPANDED_BYTES - used)
        decoder = zlib.decompressobj()
        result = decoder.decompress(value, cap + 1)
        if len(result) > cap or decoder.unconsumed_tail:
            raise Rejected("DECOMPRESSION_LIMIT")
        if not decoder.eof:
            raise Rejected("INVALID_DOCUMENT")
        return result

    def decode(stream):
        nonlocal used
        names = stream.get("/Filter", [])
        if not isinstance(names, list):
            names = [names]
        if len(names) > 1 or any(str(name) not in {
            "/FlateDecode", "/Fl", "/ASCIIHexDecode", "/AHx", "/ASCII85Decode", "/A85"
        } for name in names):
            raise Rejected("UNSUPPORTED_ENCODING")
        value = original(stream)
        used += len(value)
        if len(value) > ENTRY_BYTES or used > EXPANDED_BYTES:
            raise Rejected("DECOMPRESSION_LIMIT")
        return value

    filters.decompress = inflate
    filters.decode_stream_data = decode
    reader = pypdf.PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        raise Rejected("ENCRYPTED_DOCUMENT")
    if len(reader.pages) > SEGMENTS:
        raise Rejected("STRUCTURE_LIMIT")
    result = []
    text = Text()
    for index, page in enumerate(reader.pages):
        value = page.extract_text() or ""
        text.add(value)
        result.append({"kind": "page", "index": index + 1, "text": value})
    return result, text.size


def safe_docx(data):
    total = 0
    names = set()
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as archive, zipfile.ZipFile(output, "w") as clean:
        if len(archive.infolist()) > 512:
            raise Rejected("STRUCTURE_LIMIT")
        for entry in archive.infolist():
            name = entry.filename
            path = PurePosixPath(name)
            if (name in names or path.is_absolute() or ".." in path.parts or "\\" in name
                    or "\x00" in name or (entry.external_attr >> 16) & 0o170000 == 0o120000
                    or entry.flag_bits & 1 or entry.compress_type not in (0, 8)):
                raise Rejected("INVALID_DOCUMENT")
            names.add(name)
            if entry.file_size > ENTRY_BYTES:
                raise Rejected("DECOMPRESSION_LIMIT")
            chunks = []
            size = 0
            with archive.open(entry) as source:
                while chunk := source.read(64 * 1024):
                    size += len(chunk)
                    total += len(chunk)
                    if size > ENTRY_BYTES or total > EXPANDED_BYTES:
                        raise Rejected("DECOMPRESSION_LIMIT")
                    chunks.append(chunk)
            value = b"".join(chunks)
            if name.endswith((".xml", ".rels")):
                xml = value.decode("utf-8", errors="strict")
                if "\x00" in xml or "<!DOCTYPE" in xml.upper() or "<!ENTITY" in xml.upper():
                    raise Rejected("INVALID_DOCUMENT")
            # The native parser sees this reconstructed, measured archive only.
            clean.writestr(name, value, compress_type=zipfile.ZIP_STORED)
    return output.getvalue()


def docx_segments(data):
    from docx import Document
    from docx.table import Table

    document = Document(io.BytesIO(safe_docx(data)))
    text = Text()
    for block in document.iter_inner_content():
        if isinstance(block, Table):
            for row in block.rows:
                for index, cell in enumerate(row.cells):
                    if index:
                        text.add("\t")
                    text.add(cell.text)
                text.add("\n")
        else:
            text.add(block.text)
            text.add("\n")
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
