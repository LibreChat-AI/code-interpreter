import type { GetMicrovmImageOutput } from '@aws-sdk/client-lambda-microvms';

export type MicrovmImageSnapshot = Pick<
    GetMicrovmImageOutput,
    | 'state'
    | 'imageArn'
    | 'latestActiveImageVersion'
    | 'latestFailedImageVersion'
>;

export interface CompletedMicrovmImage {
    state: 'CREATED' | 'UPDATED';
    imageArn: string;
    imageVersion: string;
    elapsedSeconds: number;
}

export interface MicrovmImageListPage {
    items?: Array<{ name?: string; imageArn?: string }>;
    nextToken?: string;
}

/** UpdateMicrovmImage requires a full ARN even though Create accepts a name.
 * Resolve an exact name through every filtered page; never take the first
 * substring match returned by `nameFilter`. */
export async function resolveMicrovmImageArn(
    nameOrArn: string,
    listImages: (
        nameFilter: string,
        nextToken?: string,
        signal?: AbortSignal,
    ) => Promise<MicrovmImageListPage>,
    signal?: AbortSignal,
): Promise<string> {
    if (nameOrArn.startsWith('arn:')) return nameOrArn;
    const matches = new Set<string>();
    let nextToken: string | undefined;
    do {
        const page = await listImages(nameOrArn, nextToken, signal);
        for (const image of page.items ?? []) {
            if (image.name === nameOrArn && image.imageArn)
                matches.add(image.imageArn);
        }
        nextToken = page.nextToken;
    } while (nextToken);
    if (matches.size === 0) {
        throw new Error(
            `MicroVM image "${nameOrArn}" was not found for update`,
        );
    }
    if (matches.size > 1) {
        throw new Error(
            `MicroVM image name "${nameOrArn}" resolved to multiple ARNs`,
        );
    }
    return Array.from(matches)[0];
}

interface WaitForMicrovmImageOptions {
    imageIdentifier: string;
    deadlineMinutes: number;
    getImage: (
        imageIdentifier: string,
        signal?: AbortSignal,
    ) => Promise<MicrovmImageSnapshot>;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    pollIntervalMs?: number;
    onPending?: (state: string, elapsedSeconds: number) => void;
    /** Optional shared provisioning deadline. Passing the timestamp created
     * before Create/Update makes those calls consume the same overall budget. */
    deadlineAtMs?: number;
    startedAtMs?: number;
    signal?: AbortSignal;
}

export function positiveFiniteNumber(raw: string, label: string): number {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${label} must be a positive number`);
    }
    return value;
}

export function positiveInteger(raw: string, label: string): number {
    const value = positiveFiniteNumber(raw, label);
    if (!Number.isInteger(value)) {
        throw new Error(`${label} must be a positive whole number`);
    }
    return value;
}

export function parseStringMapJson(
    raw: string,
    label: string,
): Record<string, string> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`${label} must be valid JSON`);
    }
    if (parsed == null || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error(`${label} must be a JSON object`);
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (key.length === 0 || typeof value !== 'string') {
            throw new Error(
                `${label} must contain only non-empty keys with string values`,
            );
        }
        result[key] = value;
    }
    return result;
}

export async function waitForMicrovmImage(
    options: WaitForMicrovmImageOptions,
): Promise<CompletedMicrovmImage> {
    if (!options.imageIdentifier.trim()) {
        throw new Error('Create/UpdateMicrovmImage response omitted imageArn');
    }
    if (
        !Number.isFinite(options.deadlineMinutes) ||
        options.deadlineMinutes <= 0
    ) {
        throw new Error(
            'MICROVM_BUILD_DEADLINE_MINUTES must be a positive number',
        );
    }

    const now = options.now ?? Date.now;
    const sleep =
        options.sleep ??
        ((milliseconds: number) =>
            new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
    const pollIntervalMs = options.pollIntervalMs ?? 20_000;
    const startedAt = options.startedAtMs ?? now();
    const deadlineAt =
        options.deadlineAtMs ?? startedAt + options.deadlineMinutes * 60_000;
    let lastState = 'UNKNOWN';

    for (;;) {
        const beforePoll = now();
        if (beforePoll >= deadlineAt) {
            const elapsedSeconds = Math.round((beforePoll - startedAt) / 1000);
            throw new Error(
                `Timed out after ${elapsedSeconds}s still in state ${lastState}. Check the build log group.`,
            );
        }

        const pollController = new AbortController();
        const relayAbort = (): void =>
            pollController.abort(options.signal?.reason);
        if (options.signal?.aborted) relayAbort();
        else
            options.signal?.addEventListener('abort', relayAbort, {
                once: true,
            });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const remainingMs = Math.max(1, deadlineAt - beforePoll);
        const deadline = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
                const error = new Error(
                    `Timed out waiting for GetMicrovmImage in state ${lastState}. Check the build log group.`,
                );
                pollController.abort(error);
                reject(error);
            }, remainingMs);
            timeout.unref?.();
        });
        let image: MicrovmImageSnapshot;
        try {
            image = await Promise.race([
                options.getImage(
                    options.imageIdentifier,
                    pollController.signal,
                ),
                deadline,
            ]);
        } finally {
            if (timeout) clearTimeout(timeout);
            options.signal?.removeEventListener('abort', relayAbort);
        }
        const currentTime = now();
        const elapsedSeconds = Math.round((currentTime - startedAt) / 1000);
        const state = image.state ?? 'UNKNOWN';
        lastState = state;

        if (state === 'CREATED' || state === 'UPDATED') {
            if (!image.imageArn || !image.latestActiveImageVersion) {
                throw new Error(
                    `${state} response omitted imageArn or latestActiveImageVersion`,
                );
            }
            return {
                state,
                imageArn: image.imageArn,
                imageVersion: image.latestActiveImageVersion,
                elapsedSeconds,
            };
        }

        if (state.includes('FAILED')) {
            throw new Error(
                `${state} after ${elapsedSeconds}s. failed version: ` +
                    `${image.latestFailedImageVersion || '(unknown — check the build log group)'}`,
            );
        }

        if (currentTime >= deadlineAt) {
            throw new Error(
                `Timed out after ${elapsedSeconds}s still in state ${state}. Check the build log group.`,
            );
        }

        options.onPending?.(state, elapsedSeconds);
        await sleep(
            Math.min(pollIntervalMs, Math.max(0, deadlineAt - currentTime)),
        );
    }
}
