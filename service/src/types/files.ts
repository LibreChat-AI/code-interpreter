import type { ItemBucketMetadata } from 'minio';
export interface UploadResult {
    filename: string;
    fileId: string;
}

export type SimpleObject = string;

export interface SummaryObject {
    name: string;
    size: number;
    lastModified: Date;
    etag: string;
}

export interface FullObject extends SummaryObject {
    metadata: ItemBucketMetadata;
    versionId: string | null;
    contentType: string;
}

/**
 * Self-contained file reference - ideal for subsequent API calls.
 */
export interface NormalizedObject {
    id: string;
    name: string;
    storage_session_id: string;
    size: number;
    contentType: string;
    lastModified: Date;
}

export type DetailLevel = 'simple' | 'summary' | 'full' | 'normalized';

export type ObjectTypes =
    SimpleObject | SummaryObject | FullObject | NormalizedObject;

export interface BatchUploadFileSuccess {
    status: 'success';
    filename: string;
    fileId: string;
}

export interface BatchUploadFileError {
    status: 'error';
    filename: string;
    error: string;
}

export type BatchUploadFileResult =
    BatchUploadFileSuccess | BatchUploadFileError;

export interface BatchUploadResponse {
    message: 'success' | 'partial_success' | 'error';
    /** Storage session id — the bucket where the uploaded files live in
     *  object storage. Distinct from the top-level `session_id` on /exec
     *  responses (which is an execution session). Upload responses never
     *  have an execution session because no /exec ran. */
    storage_session_id: string;
    files: BatchUploadFileResult[];
    succeeded: number;
    failed: number;
    filesLimitReached?: boolean;
    maxFiles?: number;
}

/* Single-file upload response. Field names mirror `BatchUploadResponse`
 * so client deserializers can read `storage_session_id` uniformly
 * across both routes — the prior shape used `session_id`, which
 * collided with the (transient) execution-session id used on /exec
 * responses and silently parsed as `undefined` on clients reading
 * `storage_session_id`. */
export interface UploadResponse {
    message: 'success';
    storage_session_id: string;
    files: UploadResult[];
}
