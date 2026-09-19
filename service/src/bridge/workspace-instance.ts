import { createHash } from 'node:crypto';

/** Bind a caller-selected conversation identity to the authenticated principal. */
export function principalWorkspaceInstanceId(args: {
  instanceId: string;
  tenantId: string;
  principalId: string;
}): string {
  return createHash('sha256')
    .update('codeapi-workspace-instance-v1\0')
    .update(args.tenantId)
    .update('\0')
    .update(args.principalId)
    .update('\0')
    .update(args.instanceId)
    .digest('hex');
}
