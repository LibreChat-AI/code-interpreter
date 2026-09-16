# Repository instructions

After updating Code API and LibreChat to versions supporting repository instruction metadata,
add `--repository-instructions` to the existing `librechat-code run` command. Keep all existing
pairing, workspace, sandbox and environment arguments. This is an explicit machine-owner opt-in;
without it, no instructions are advertised or automatically read.

Only each registered workspace root is examined. `AGENTS.md` takes precedence; `CLAUDE.md`
is considered only when `AGENTS.md` does not exist. Symlinks, directories, unreadable files,
invalid UTF-8 and binary files are omitted. There is no parent-directory walk or globbing.

Metadata refreshes with the existing worker registration heartbeat. It does not change worker
identity, lease slots or workspace permissions. The next run after that refresh sees changed
metadata; this is not a filesystem watch or a guarantee of immediate edit visibility.

The descriptor contains only the relative filename, bounded snapshot byte count, SHA-256 and
truncation flag. SHA-256 identifies the delivered UTF-8 snapshot, not unseen bytes beyond the
32 KiB cap. An incomplete trailing UTF-8 character is omitted. Content travels only through the
authorized `read_file` operation, using `instructionSha256` to reject reads if the snapshot changed.
This mode preserves newlines and is independent of the ordinary line-oriented reader.

LibreChat caches verified content with bounded capacity and principal/machine/workspace scoping.
Its per-agent setting selects `prefer`, `defer` or `off`; it cannot enable discovery on a worker
that did not opt in or widen filesystem, network, or approval permissions.

Rollout: update LibreChat and Code API first, then update workers and enable the flag. Older
workers continue unchanged. An older Code API rejecting the metadata causes the worker to retry
without it and omit metadata until restart. Do not enable this flag against an older LibreChat
instance: older clients validate workspace descriptors strictly.
