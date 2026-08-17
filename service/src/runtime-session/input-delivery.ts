import type * as t from '../types';
import type { SandboxInputDeliveryRef } from '../sandbox-backend/types';
import { inputCacheKey } from './files';

function isFileRef(
    file: t.PayloadBody['files'][number],
): file is t.PayloadFileRef {
    return 'id' in file && typeof file.id === 'string';
}

/**
 * Joins the authorized payload to its sandbox-visible counterpart by position.
 * Hardened egress preserves file ordering while replacing ref identifiers with
 * per-grant handles. The returned raw refs never cross the sandbox boundary;
 * only the stable digest is added to the manifest-bound execute body.
 */
export function prepareInputDelivery(
    authorized: t.PayloadBody,
    sandboxVisible: t.PayloadBody,
): { payload: t.PayloadBody; refs: SandboxInputDeliveryRef[] } {
    if (authorized.files.length !== sandboxVisible.files.length) {
        throw new Error('Sandbox egress changed the input file count');
    }

    const refs: SandboxInputDeliveryRef[] = [];
    const seen = new Set<string>();
    const files = sandboxVisible.files.map((sandboxFile, index) => {
        const authorizedFile = authorized.files[index];
        const authorizedIsRef = isFileRef(authorizedFile);
        const sandboxIsRef = isFileRef(sandboxFile);
        if (
            authorizedIsRef !== sandboxIsRef ||
            authorizedFile.name !== sandboxFile.name
        ) {
            throw new Error(
                `Sandbox egress changed files[${index}] shape or destination`,
            );
        }
        if (!authorizedIsRef || !sandboxIsRef) return { ...sandboxFile };

        const cacheKey = inputCacheKey(
            authorizedFile.storage_session_id,
            authorizedFile.id,
        );
        if (!seen.has(cacheKey)) {
            seen.add(cacheKey);
            refs.push({
                id: authorizedFile.id,
                storage_session_id: authorizedFile.storage_session_id,
                name: authorizedFile.name,
                cache_key: cacheKey,
            });
        }
        return { ...sandboxFile, input_cache_key: cacheKey };
    });

    return { payload: { ...sandboxVisible, files }, refs };
}
