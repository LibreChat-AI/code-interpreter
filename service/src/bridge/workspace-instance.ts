import { createHash } from 'node:crypto';

/** Bind a caller-selected conversation identity to the authenticated principal. */
export function principalWorkspaceInstanceId(args: {
  instanceId: string;
  tenantId: string;
  principalId: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'codeapi-workspace-instance-v1',
      args.tenantId,
      args.principalId,
      args.instanceId,
    ]))
    .digest('hex');
}
