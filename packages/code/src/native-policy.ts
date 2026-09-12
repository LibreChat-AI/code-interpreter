export const NATIVE_SRT_COMMAND_POLICY_PRESETS = [
  'restricted',
  'trusted-vm',
] as const;

export type NativeSrtCommandPolicyPreset =
  typeof NATIVE_SRT_COMMAND_POLICY_PRESETS[number];

export interface NativeSrtCommandPolicy {
  version: 1;
  preset: NativeSrtCommandPolicyPreset;
  network: {
    outbound: 'allowlist' | 'unrestricted';
    allowLocalBinding: boolean;
    allowAllUnixSockets: boolean;
  };
}

const PRESETS: Record<NativeSrtCommandPolicyPreset, NativeSrtCommandPolicy> = {
  restricted: {
    version: 1,
    preset: 'restricted',
    network: {
      outbound: 'allowlist',
      allowLocalBinding: false,
      allowAllUnixSockets: false,
    },
  },
  'trusted-vm': {
    version: 1,
    preset: 'trusted-vm',
    network: {
      outbound: 'unrestricted',
      allowLocalBinding: true,
      allowAllUnixSockets: true,
    },
  },
};

function isPreset(value: unknown): value is NativeSrtCommandPolicyPreset {
  return (
    typeof value === 'string' &&
    NATIVE_SRT_COMMAND_POLICY_PRESETS.some((preset) => preset === value)
  );
}

/** Resolve a named convenience preset into the explicit policy SRT enforces. */
export function resolveNativeSrtCommandPolicy(
  preset: unknown = 'restricted',
): NativeSrtCommandPolicy {
  if (!isPreset(preset)) {
    throw new Error(
      'Native SRT command policy preset must be restricted or trusted-vm',
    );
  }
  const policy = PRESETS[preset];
  return { ...policy, network: { ...policy.network } };
}

/** Validate a programmatic policy and return canonical preset-owned values. */
export function normalizeNativeSrtCommandPolicy(
  policy?: NativeSrtCommandPolicy,
): NativeSrtCommandPolicy {
  const normalized = resolveNativeSrtCommandPolicy(
    policy?.preset ?? 'restricted',
  );
  if (
    policy !== undefined &&
    (policy.version !== normalized.version ||
      policy.network?.outbound !== normalized.network.outbound ||
      policy.network?.allowLocalBinding !==
        normalized.network.allowLocalBinding ||
      policy.network?.allowAllUnixSockets !==
        normalized.network.allowAllUnixSockets)
  ) {
    throw new Error('Native SRT command policy does not match its preset');
  }
  return normalized;
}

/** Stable policy material used in the bridge capability digest. */
export function serializeNativeSrtCommandPolicy(
  policy: NativeSrtCommandPolicy,
): string {
  return JSON.stringify(normalizeNativeSrtCommandPolicy(policy));
}
