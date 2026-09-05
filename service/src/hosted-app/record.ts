import type { ResidentHostedAppSpec } from './spec';

/** Durable hosted-app fields carried by the existing fenced MicroVM registry.
 * The registry's top-level runtime_session_id is the opaque `happ_*` lease id;
 * `source_runtime_session_id` identifies the coding workspace checkpoint that
 * was copied into this independent app-host VM. */
export interface HostedAppRecordDetails {
  source_runtime_session_id: string;
  app_id: string;
  revision: string;
  spec_fingerprint: string;
  spec: ResidentHostedAppSpec;
  checkpoint_key: string;
  preview_credential?: string;
  preview_credential_expires_at?: number;
}

export interface HostedAppPublicStatus {
  app_id: string;
  revision: string;
  state: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
  preview_id: string;
  /** Short-lived owner capability exchange URL on the isolated app origin. */
  preview_url?: string;
  hard_deadline_at?: number;
  updated_at: number;
  error?: string;
}
