import { describe, expect, test } from 'bun:test';
import {
    positiveFiniteNumber,
    positiveInteger,
    parseStringMapJson,
    resolveMicrovmImageArn,
    waitForMicrovmImage,
    type MicrovmImageSnapshot,
} from './create-microvm-image-lib';

function scriptedPoller(snapshots: MicrovmImageSnapshot[]): {
    getImage: (imageIdentifier: string) => Promise<MicrovmImageSnapshot>;
    identifiers: string[];
} {
    const queue = [...snapshots];
    const identifiers: string[] = [];
    return {
        identifiers,
        getImage: async imageIdentifier => {
            identifiers.push(imageIdentifier);
            const next = queue.shift();
            if (!next) throw new Error('unexpected extra poll');
            return next;
        },
    };
}

describe('waitForMicrovmImage', () => {
    test('returns the pinned latest active version after create', async () => {
        const poller = scriptedPoller([
            { state: 'CREATING', imageArn: 'arn:image' },
            {
                state: 'CREATED',
                imageArn: 'arn:image',
                latestActiveImageVersion: '7',
                // Guard against regressing to the nonexistent GetMicrovmImage
                // `imageVersion` field that the first helper implementation read.
                ...({ imageVersion: 'wrong-field' } as Record<string, string>),
            },
        ]);
        let now = 0;

        const result = await waitForMicrovmImage({
            imageIdentifier: 'arn:image',
            deadlineMinutes: 1,
            getImage: poller.getImage,
            now: () => now,
            sleep: async milliseconds => {
                now += milliseconds;
            },
            pollIntervalMs: 20_000,
        });

        expect(result).toEqual({
            state: 'CREATED',
            imageArn: 'arn:image',
            imageVersion: '7',
            elapsedSeconds: 20,
        });
        expect(poller.identifiers).toEqual(['arn:image', 'arn:image']);
    });

    test('accepts the UPDATED terminal state', async () => {
        const poller = scriptedPoller([
            {
                state: 'UPDATED',
                imageArn: 'arn:image',
                latestActiveImageVersion: '8',
            },
        ]);

        await expect(
            waitForMicrovmImage({
                imageIdentifier: 'arn:image',
                deadlineMinutes: 1,
                getImage: poller.getImage,
            }),
        ).resolves.toMatchObject({ state: 'UPDATED', imageVersion: '8' });
    });

    test('surfaces the failed image version', async () => {
        const poller = scriptedPoller([
            {
                state: 'UPDATE_FAILED',
                imageArn: 'arn:image',
                latestFailedImageVersion: '9',
            },
        ]);

        await expect(
            waitForMicrovmImage({
                imageIdentifier: 'arn:image',
                deadlineMinutes: 1,
                getImage: poller.getImage,
            }),
        ).rejects.toThrow('UPDATE_FAILED after 0s. failed version: 9');
    });

    test('bounds a build that never leaves a pending state', async () => {
        let now = 0;

        await expect(
            waitForMicrovmImage({
                imageIdentifier: 'arn:image',
                deadlineMinutes: 1 / 60,
                getImage: async () => ({
                    state: 'CREATING',
                    imageArn: 'arn:image',
                }),
                now: () => now,
                sleep: async milliseconds => {
                    now += milliseconds;
                },
                pollIntervalMs: 1_000,
            }),
        ).rejects.toThrow('Timed out after 1s still in state CREATING');
    });

    test('bounds a GetMicrovmImage call whose socket never settles', async () => {
        const deadlineAtMs = Date.now() + 20;
        let observedAbort = false;
        await expect(
            waitForMicrovmImage({
                imageIdentifier: 'arn:image',
                deadlineMinutes: 1,
                deadlineAtMs,
                getImage: async (_identifier, signal) =>
                    new Promise((_resolve, reject) => {
                        signal?.addEventListener(
                            'abort',
                            () => {
                                observedAbort = true;
                                reject(signal.reason);
                            },
                            { once: true },
                        );
                    }),
            }),
        ).rejects.toThrow();
        expect(observedAbort).toBe(true);
    });

    test('rejects invalid numeric configuration instead of disabling the deadline', () => {
        expect(() =>
            positiveFiniteNumber(
                'not-a-number',
                'MICROVM_BUILD_DEADLINE_MINUTES',
            ),
        ).toThrow('MICROVM_BUILD_DEADLINE_MINUTES must be a positive number');
        expect(() => positiveFiniteNumber('0', 'MICROVM_MEMORY_MIB')).toThrow(
            'MICROVM_MEMORY_MIB must be a positive number',
        );
        expect(() => positiveInteger('4096.5', 'MICROVM_MEMORY_MIB')).toThrow(
            'MICROVM_MEMORY_MIB must be a positive whole number',
        );
    });

    test('accepts only a JSON object whose environment values are strings', () => {
        expect(
            parseStringMapJson('{"PORT":"8080","FEATURE":"true"}', 'ENV'),
        ).toEqual({ PORT: '8080', FEATURE: 'true' });
        expect(() => parseStringMapJson('not-json', 'ENV')).toThrow(
            'ENV must be valid JSON',
        );
        expect(() => parseStringMapJson('[]', 'ENV')).toThrow(
            'ENV must be a JSON object',
        );
        expect(() => parseStringMapJson('{"PORT":8080}', 'ENV')).toThrow(
            'ENV must contain only non-empty keys with string values',
        );
        expect(() => parseStringMapJson('{"": "value"}', 'ENV')).toThrow(
            'ENV must contain only non-empty keys with string values',
        );
    });
});

describe('resolveMicrovmImageArn', () => {
    test('paginates and selects an exact name instead of a substring match', async () => {
        const tokens: Array<string | undefined> = [];
        const arn = await resolveMicrovmImageArn(
            'codeapi-session',
            async (_filter, nextToken) => {
                tokens.push(nextToken);
                if (!nextToken) {
                    return {
                        items: [
                            {
                                name: 'codeapi-session-old',
                                imageArn:
                                    'arn:aws:lambda:us-east-1:1:microvm-image:old',
                            },
                        ],
                        nextToken: 'page-2',
                    };
                }
                return {
                    items: [
                        {
                            name: 'codeapi-session',
                            imageArn:
                                'arn:aws:lambda:us-east-1:1:microvm-image:codeapi-session',
                        },
                    ],
                };
            },
        );

        expect(arn).toBe(
            'arn:aws:lambda:us-east-1:1:microvm-image:codeapi-session',
        );
        expect(tokens).toEqual([undefined, 'page-2']);
    });

    test('passes an ARN through without listing', async () => {
        let listed = false;
        const arn = 'arn:aws:lambda:us-east-1:1:microvm-image:codeapi-session';
        expect(
            await resolveMicrovmImageArn(arn, async () => {
                listed = true;
                return {};
            }),
        ).toBe(arn);
        expect(listed).toBe(false);
    });

    test('fails closed when the filtered result has no exact match', async () => {
        await expect(
            resolveMicrovmImageArn('wanted', async () => ({
                items: [{ name: 'wanted-old', imageArn: 'arn:old' }],
            })),
        ).rejects.toThrow('was not found for update');
    });
});
