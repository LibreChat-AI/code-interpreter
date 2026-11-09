import type { RequestFile } from '../types';
import { env } from '../config';
import { validateRequestedFiles } from './file-authorization';
export type ContinuationFiles = { call_id: string; files?: RequestFile[] };
/** Additive references cannot replace another input during replay. */
export function mergeContinuationFiles(
    existing: RequestFile[],
    results: ContinuationFiles[],
    issued: ReadonlySet<string>,
): RequestFile[] {
    const names = new Map(existing.map(file => [file.name, file]));
    for (const result of results) {
        if (!result.files?.length) continue;
        if (!issued.has(result.call_id))
            throw new Error('unissued_continuation_file');
        for (const file of validateRequestedFiles(result.files)) {
            const prior = names.get(file.name);
            if (
                prior &&
                (prior.id !== file.id ||
                    prior.storage_session_id !== file.storage_session_id ||
                    prior.resource_id !== file.resource_id ||
                    prior.kind !== file.kind ||
                    prior.version !== file.version)
            )
                throw new Error('continuation_filename_conflict');
            names.set(file.name, file);
            if (names.size > Math.min(100, env.INPUT_MANIFEST_MAX_FILES))
                throw new Error('continuation_file_limit_exceeded');
        }
    }
    return [...names.values()];
}
