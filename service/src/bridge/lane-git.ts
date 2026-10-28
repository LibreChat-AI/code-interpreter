import { isWorkspaceLaneGit } from '../../../packages/code/src/protocol';

export type LaneGitDropReason = 'disabled' | 'not_advertised' | 'invalid';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a fulfilled command result carries a `laneGit` key at all. */
export function hasLaneGit(result: unknown): boolean {
  return isRecord(result) && 'laneGit' in result;
}

/**
 * Decide what happens to the `laneGit` on an execute_command result. It is kept,
 * unchanged, only when the deployment enables the feature, the worker advertised
 * `lane_git`, and the value is exactly `{ branch, head }` within bounds. Anything
 * else is dropped; the command result itself is never failed over it. The reason
 * is a fixed label, never the value.
 */
export function laneGitPolicy(args: {
  result: Record<string, unknown>;
  enabled: boolean;
  advertised: boolean;
}): { result: Record<string, unknown>; dropped?: LaneGitDropReason } {
  const reason: LaneGitDropReason | undefined = !args.enabled
    ? 'disabled'
    : !args.advertised
      ? 'not_advertised'
      : isWorkspaceLaneGit(args.result.laneGit)
        ? undefined
        : 'invalid';
  if (reason === undefined) return { result: args.result };
  const { laneGit: _laneGit, ...rest } = args.result;
  return { result: rest, dropped: reason };
}
