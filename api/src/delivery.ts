export interface ArtifactDeliveryFailure {
    code: 'artifact_delivery_failed';
    status: 'partial' | 'failed';
    attempted: number;
    delivered: number;
    failed: number;
}

export interface ArtifactDeliveryResult<T> {
    files: T[];
    artifact_delivery?: ArtifactDeliveryFailure;
}

/** Removes unusable generated refs while preserving an explicit delivery failure for callers. */
export function reconcileArtifactDelivery<T extends { id: string }>(
    files: T[],
    generatedFileIds: Iterable<string>,
    uploadedFileIds: ReadonlySet<string>,
): ArtifactDeliveryResult<T> {
    const generatedIds = new Set(generatedFileIds);
    if (generatedIds.size === 0) return { files };

    let delivered = 0;
    const retained = files.filter(file => {
        if (!generatedIds.has(file.id)) return true;
        if (!uploadedFileIds.has(file.id)) return false;
        delivered++;
        return true;
    });
    const failed = generatedIds.size - delivered;
    if (failed === 0) return { files: retained };

    return {
        files: retained,
        artifact_delivery: {
            code: 'artifact_delivery_failed',
            status: delivered === 0 ? 'failed' : 'partial',
            attempted: generatedIds.size,
            delivered,
            failed,
        },
    };
}
