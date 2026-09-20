import { describe, expect, it } from 'bun:test';
import { principalWorkspaceInstanceId } from './workspace-instance';

describe('principalWorkspaceInstanceId', () => {
  it('keeps principal components distinct even when identifiers contain delimiters', () => {
    const instanceId = 'a'.repeat(64);
    expect(principalWorkspaceInstanceId({ instanceId, tenantId: 'tenant\0user', principalId: 'a' }))
      .not.toBe(principalWorkspaceInstanceId({ instanceId, tenantId: 'tenant', principalId: 'user\0a' }));
  });
  it('is stable only within the same authenticated principal', () => {
    const instanceId = 'a'.repeat(64);
    const first = principalWorkspaceInstanceId({
      instanceId,
      tenantId: 'tenant',
      principalId: 'user-a',
    });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(
      principalWorkspaceInstanceId({
        instanceId,
        tenantId: 'tenant',
        principalId: 'user-a',
      })
    ).toBe(first);
    expect(
      principalWorkspaceInstanceId({
        instanceId,
        tenantId: 'tenant',
        principalId: 'user-b',
      })
    ).not.toBe(first);
    expect(
      principalWorkspaceInstanceId({
        instanceId,
        tenantId: 'other',
        principalId: 'user-a',
      })
    ).not.toBe(first);
  });
});
