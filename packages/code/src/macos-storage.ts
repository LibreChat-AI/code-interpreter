import koffi from 'koffi';
import { BridgeProtocolError } from './protocol.js';

// Darwin sys/acl.h. Use the held descriptor, never /dev/fd path metadata.
const ACL_TYPE_EXTENDED = 0x100;
const ACL_EXTENDED_ALLOW = 1;
const ACL_EXTENDED_DENY = 2;
const ACL_NEXT_ENTRY = -1;
const lib = koffi.load('/usr/lib/libSystem.B.dylib');
const getAcl = lib.func('void *acl_get_fd_np(int fd, int type)');
const setAcl = lib.func('int acl_set_fd_np(int fd, void *acl, int type)');
const initAcl = lib.func('void *acl_init(int count)');
const freeAcl = lib.func('int acl_free(void *acl)');
const getEntry = lib.func('int acl_get_entry(void *acl, int index, _Out_ void **entry)');
const getTag = lib.func('int acl_get_tag_type(void *entry, _Out_ int *tag)');
const getMask = lib.func('int acl_get_permset_mask_np(void *entry, _Out_ uint64_t *mask)');
// Only read/list, search/execute, and metadata reads are safe on ancestors.
const ANCESTOR_READ_PERMISSIONS = (1 << 1) | (1 << 3) | (1 << 7) | (1 << 9) | (1 << 11);

function unavailable(): never {
  throw new BridgeProtocolError('Cannot verify macOS storage ACLs on the opened object; use a local filesystem with ACL support.');
}

export function verifyMacOsAcl(fd: number, path: string, directory = false, empty = false): void {
  const acl = getAcl(fd, ACL_TYPE_EXTENDED);
  if (acl == null) {
    // On a valid descriptor Darwin reports ENOENT when no extended ACL exists.
    if (koffi.errno() === koffi.os.errno.ENOENT) return;
    unavailable();
  }
  try {
    for (let index = 0; ; index = ACL_NEXT_ENTRY) {
      const entry = [null];
      if (getEntry(acl, index, entry) !== 0) {
        // Darwin uses EINVAL at end of the ACL (unlike Linux's zero result).
        if (koffi.errno() === koffi.os.errno.EINVAL) return;
        unavailable();
      }
      const tag = [0];
      const mask = [0];
      if (getTag(entry[0], tag) !== 0 || getMask(entry[0], mask) !== 0) unavailable();
      if (empty || (tag[0] !== ACL_EXTENDED_DENY &&
        (tag[0] !== ACL_EXTENDED_ALLOW || !directory ||
          (BigInt(mask[0]) & ~BigInt(ANCESTOR_READ_PERMISSIONS)) !== 0n))) {
        throw new BridgeProtocolError(
          `macOS ACL grants access beyond owner-only storage at ${path}. ` +
          'Remove the sharing ACL before using this path. If a credential was exposed, revoke it and pair again.',
        );
      }
    }
  } finally {
    freeAcl(acl);
  }
}

export function removeMacOsAcl(fd: number, path: string): void {
  const acl = initAcl(0);
  if (acl == null) unavailable();
  try {
    if (setAcl(fd, acl, ACL_TYPE_EXTENDED) !== 0) unavailable();
  } finally {
    freeAcl(acl);
  }
  verifyMacOsAcl(fd, path, false, true);
}

// Darwin's statfs64 layout is identical on arm64 and x86_64 (sys/mount.h).
const Statfs = koffi.struct({
  bsize: 'uint32_t', iosize: 'int32_t',
  blocks: 'uint64_t', bfree: 'uint64_t', bavail: 'uint64_t',
  files: 'uint64_t', ffree: 'uint64_t', fsid: 'int32_t[2]',
  owner: 'uint32_t', type: 'uint32_t', flags: 'uint32_t', subtype: 'uint32_t',
  typename: 'char[16]', mountpoint: 'char[1024]', source: 'char[1024]',
  flagsExt: 'uint32_t', reserved: 'uint32_t[7]',
});
const statfs = lib.func('statfs64', 'int', ['str', koffi.out(koffi.pointer(Statfs))]);

export function macOsMountPoint(path: string): string {
  const result: { mountpoint?: string } = {};
  if (statfs(path, result) !== 0 || !result.mountpoint?.startsWith('/')) {
    throw new BridgeProtocolError('Cannot verify macOS identity mount status.');
  }
  return result.mountpoint;
}
