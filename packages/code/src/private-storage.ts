import { BridgeProtocolError } from './protocol.js';

/** Linux POSIX ACL masks are reflected in group mode bits. macOS extended
 * ACLs and Windows DACLs are not: chmod/stat alone cannot establish privacy.
 * Fail before creating files, reading credentials, or redeeming pairing codes
 * until a native verifier can inspect the actual opened object's ACLs.
 */
export function assertPrivateStorageSupported(): void {
  if (process.platform !== 'linux' || process.getuid === undefined) {
    throw new BridgeProtocolError(
      'Owner-only storage ACL verification is unavailable on this platform. ' +
      'Worker credentials, GitHub App keys, and quarantine state require Linux ' +
      '(including WSL2) with storage on a native Linux filesystem, not /mnt.',
    );
  }
}
