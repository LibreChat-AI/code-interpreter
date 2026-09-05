import type { Job } from 'bullmq';
import type { HostedAppPublicStatus } from './record';
import type { ResidentHostedAppSpec } from './spec';

export const HOSTED_APP_JOBS = [
  'hosted-app:start',
  'hosted-app:stop',
  'hosted-app:refresh-preview',
] as const;
export type HostedAppJobName = (typeof HOSTED_APP_JOBS)[number];

interface HostedAppJobBase {
  hostedAppRuntimeId: string;
  tenantId: string;
  canonicalUserId: string;
  _otel?: Record<string, string>;
}

export interface HostedAppStartJobData extends HostedAppJobBase {
  operation: 'start';
  sourceRuntimeSessionId: string;
  spec: ResidentHostedAppSpec;
}

export interface HostedAppStopJobData extends HostedAppJobBase {
  operation: 'stop' | 'refresh-preview';
}

export type HostedAppJobData = HostedAppStartJobData | HostedAppStopJobData;
export type HostedAppJobResult = HostedAppPublicStatus;
export type HostedAppJob = Job<HostedAppJobData, HostedAppJobResult, HostedAppJobName>;
