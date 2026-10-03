# Workspace file read contract

Ordinary `read_file` streams complete LF-delimited line windows through the verified
file descriptor. It defaults to 200 lines, accepts at most 500, and returns at most
1 MiB of UTF-8 content, including inter-line separators, regardless of file size.
CR in CRLF is preserved; the final LF does not add a phantom line. An empty file
has one empty line. A start beyond EOF returns an empty, non-truncated window.

Byte-limited windows stop before the first line that cannot fit and return
`nextStartLine = endLine + 1`. If the first requested line exceeds 1 MiB, the read
fails with `READ_LIMIT_EXCEEDED`, without a repeating continuation. Scanning and
collection check cancellation and share a 10-second deadline. Far-away starts
can fail with `READ_LIMIT_EXCEEDED`; use an earlier start or `search_text`.

Memory is bounded by 64 KiB chunks and the returned window. Reads stop at the
opened file's initial size, so concurrent growth cannot extend the scan. Truncation
ends the scan at observed EOF; pathname replacement never switches the open
handle. In-place writes can change observed content. Pagination is not a snapshot
across requests and assumes the file stays unchanged.

UTF-8 and BOM-marked UTF-16LE/BE are decoded incrementally. One leading BOM is
removed; malformed sequences use replacement characters, as before. Binary bytes
are decoded as text, including NUL, not classified or rejected. Neither a successful
window nor continuation validates unread content.

Request/result shapes, protocol version, and capabilities are unchanged. Search,
preview, edit, and write limits remain unchanged. Digest-checked repository
instruction snapshots retain their separate byte-bounded, newline-preserving path.
