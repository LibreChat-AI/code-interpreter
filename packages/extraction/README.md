# File extraction service

Standalone companion container for fixed `document.extract-text` operations. It does not
start or call the Code Interpreter API, `/exec`, Redis, tool calling, or conversation storage.
LibreChat and RAG API client migrations are not included.

## Deploy

Requires a Linux Docker host with Landlock ABI 3 or newer (normally Linux 6.2+), seccomp,
and Docker Compose. Docker Desktop support depends on its Linux VM kernel and is not assumed.

```sh
docker compose -f packages/extraction/compose.yaml up --build -d --wait
```

Only a Unix socket is exposed. Share the `extraction-socket` named volume with the authorized
caller, mounted read-only at its chosen socket directory. The caller must be able to use group
10001; the socket is mode 0660, its directory 0770. Do not publish a TCP port or mount the
Docker socket, application storage, secrets, or cloud/database credentials into this service.
Socket access authorizes use of the processor, not access to any user's files.

The processor starts only after the restricted worker imports its dependencies and verifies
filesystem, socket, and process restrictions. Unsupported isolation or missing dependencies
prevent startup. A cleanup failure makes subsequent admission and readiness fail until restart.
No unsandboxed or local-parser fallback exists.

## Protocol

`GET /v1/capabilities` reports the protocol version, fixed operation, supported formats and caps.

`POST /v1/extract-text` accepts document bytes directly, with these required headers:

```text
Content-Type: application/octet-stream
Content-Length: <exact positive byte count>
X-Extraction-Version: 1
X-Extraction-Format: pdf | docx
```

Unknown extraction parameters, query parameters, chunked uploads, duplicate control headers,
and unsupported formats are rejected before parser execution. No scripts, paths, URLs,
passwords, parser options, or runtime selection are accepted.

Example from a caller with the socket mounted at `/run/extraction`:

```sh
curl --unix-socket /run/extraction/extraction.sock \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-Extraction-Version: 1' -H 'X-Extraction-Format: pdf' \
  --data-binary @document.pdf http://localhost/v1/extract-text
```

The response is bounded UTF-8 JSON, directly returned without base64 or upload/download staging:

```json
{
    "version": 1,
    "operation": "document.extract-text",
    "format": "pdf",
    "inputSha256": "<sha256 of request bytes>",
    "textBytes": 31,
    "segments": [
        { "kind": "page", "index": 1, "text": "First page text" },
        { "kind": "page", "index": 2, "text": "Second page text" }
    ]
}
```

The supervisor validates version, operation, format, digest, segment kinds/order, exact UTF-8
text byte count, and result size after the parser closes. Scratch cleanup completes before
success is sent. Admission remains held until response delivery finishes or the socket closes.

Errors are `{ "error": { "code": "..." } }`, never raw parser diagnostics or submitted content.
HTTP 400 covers invalid requests; 413 covers input/decompression/structure/output caps;
422 covers malformed, encrypted, empty, unsupported-encoding, or resource-limited documents;
429 is immediate admission rejection; 503 is unavailable isolation/backend; 504 is a processing
deadline. A disconnected or stalled upload may close without a response. There is no queue.

## Initial formats

-   **PDF:** pypdf, one segment per page, including empty pages. Text only, without OCR,
    image decoding, attachment extraction, or script execution. Encrypted files are rejected.
    Compressed text streams support a single Flate, ASCIIHex, or ASCII85 filter. Other filter
    combinations are deliberately rejected. Malformed PDFs are not repaired.
-   **DOCX:** python-docx/lxml, one document-body segment. Paragraphs and table rows remain
    ordered; cells are tab-separated. Headers, footers, comments, text boxes, tracked revisions,
    embedded files, and pagination are not extracted. ZIP entries are measured while reading,
    then reconstructed into an uncompressed archive before the native XML parser sees them.
    Duplicate names, unsafe paths, symlinks, encryption, non-UTF-8 XML and DTDs are rejected.

Spreadsheet formats are not advertised. A later spreadsheet slice must return ordered sheet
segments, not flatten them into one string. Consumers retain page/sheet metadata and choose
any flattening themselves. Raw text/Markdown semantics, OCR and office previews are separate
operations, not fallback behavior of this endpoint.

## Limits and lifecycle

| Bound                                            |               Default |
| ------------------------------------------------ | --------------------: |
| Input                                            |                10 MiB |
| Aggregate decoded PDF/ZIP content                |                32 MiB |
| Individual decoded stream/ZIP entry              |                 8 MiB |
| ZIP entries                                      |                   512 |
| PDF pages                                        |                   128 |
| Extracted UTF-8 text                             |                 1 MiB |
| Serialized result                                |                 3 MiB |
| Admitted requests, including upload/delivery     |                     2 |
| HTTP connections                                 |                    16 |
| Request wall deadline, including upload/delivery |            10 seconds |
| Worker CPU time / address space                  |   8 seconds / 512 MiB |
| Worker file size / open descriptors              |            4 MiB / 64 |
| Container memory / CPU / PIDs                    | 768 MiB / 2 CPUs / 32 |
| Shared scratch tmpfs                             | 96 MiB / 1,024 inodes |

Bounds are fixed in this initial protocol and advertised by capabilities. The caller must bound
its own transport and apply stricter application-specific limits where needed. Cancellation
kills the parser process group and waits for process close before removing scratch. Container
shutdown closes connections, cancelling active work. Scratch tmpfs disappears with the container.

## Isolation guarantees and limitations

The shipped container is unprivileged, non-root, read-only, capability-free, without a network,
and uses Docker's default seccomp profile plus `no-new-privileges`. The Node 24 supervisor loads
no document parser. Every request starts a fresh Python subprocess through a small C launcher:

-   Landlock limits file reads to packaged runtime libraries, the worker, and its own job directory;
    writes are limited to that job directory and `/dev/null`.
-   An additional seccomp filter denies sockets, process creation, signals to other processes,
    ptrace/process-memory access, namespace/mount operations, shared-memory IPC and selected
    privileged syscalls. Only Python and its ELF loader receive Landlock execute access.
-   The worker inherits no caller environment or descriptors other than standard I/O pipes.
    Hard resource limits and parent-death termination are set before parser imports.

This is **a restricted subprocess inside a shared container, not a disposable container or VM**.
The container and host kernel are shared. Landlock does not hide all filesystem metadata or
provide a separate PID namespace per job. Kernel vulnerabilities and hardware side channels
are outside this boundary. A container-wide OOM can terminate the supervisor and other jobs.
The runtime filesystem is readable, so it must contain no secrets. Do not colocate unrelated
services in the container. A stronger backend can be added later without changing caller policy.

Authorization, content inspection, identity metadata, chunking, embeddings, ingestion rollback,
and persistence remain with LibreChat/RAG API. Parser output is untrusted content, not trusted
identity or policy. This service neither modifies nor re-enables LibreChat's native LibreOffice path.

## Verify

```sh
cd packages/extraction
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:container
```

Unit tests cover request validation, result validation, deadline/cancellation, cleanup failures,
admission and stalled output readers. Container tests build and run the actual Compose recipe,
extract real synthetic PDF/DOCX documents through the endpoint, exercise adversarial archives,
inspect mounts/resources, probe cross-job/credential/network/process access, test worker
termination and restart, and remove their containers/volumes. Fixtures contain no user data.

Qualification must pass on the deployment host without relaxing capabilities, seccomp, LSMs,
or sysctls. Passing parser tests alone does not qualify a different container/runtime recipe.

### Qualified runtime

The shipped recipe passed locally on 2026-10-04 with Docker 29.8.2, Linux
7.0.0-1013-aws (x86_64), Node 24.16.0 and Python 3.13.16. Docker's default
seccomp profile, capability dropping and `no-new-privileges` remained enabled.
Other hosts must run the same qualification before enablement.
