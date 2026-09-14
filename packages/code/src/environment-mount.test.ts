import assert from 'node:assert/strict';
import test from 'node:test';
import { assertEnvironmentMountIsolation } from './environment-mount.js';

const base = '1 0 8:1 / / rw - ext4 /dev/root rw\n';
test('mount coordinates reject definition aliases in both directions and mounted files', () => {
    for (const entry of [
        '2 1 8:1 /workspace/config /operator rw - ext4 /dev/root rw',
        '2 1 8:1 /operator /workspace/config rw - ext4 /dev/root rw',
        '2 1 8:1 /operator/app.yaml /workspace/app.yaml rw - ext4 /dev/root rw',
        '2 1 8:1 /workspace/app.yaml /operator/app.yaml rw - ext4 /dev/root rw',
    ])
        assert.throws(
            () =>
                assertEnvironmentMountIsolation(
                    base + entry,
                    ['/operator/app.yaml'],
                    ['/workspace'],
                ),
            /mount alias/,
        );
});
test('mount coordinates retain safe separate filesystems and escaped paths', () => {
    assertEnvironmentMountIsolation(
        base + '2 1 9:1 / /workspace rw - ext4 /dev/other rw',
        ['/operator/app.yaml'],
        ['/workspace'],
    );
    assertEnvironmentMountIsolation(
        base,
        ['/operator/app.yaml'],
        ['/workspace'],
    );
    assert.throws(
        () =>
            assertEnvironmentMountIsolation(
                base +
                    '2 1 8:1 /workspace/my\\040config /operator rw - ext4 /dev/root rw',
                ['/operator/app.yaml'],
                ['/workspace'],
            ),
        /mount alias/,
    );
    assert.throws(() => assertEnvironmentMountIsolation('invalid', [], []));
    assertEnvironmentMountIsolation(
        base + '2 1 9:1 / / rw - ext4 /dev/other rw',
        ['/operator/app.yaml'],
        ['/workspace'],
    );
    assert.throws(
        () =>
            assertEnvironmentMountIsolation(
                base + '2 1 9:1 / / rw - ext4 /dev/other rw',
                ['/workspace/config/app.yaml'],
                ['/workspace'],
            ),
        /mount alias/,
    );
    const many = Array.from(
        { length: 257 },
        (_, index) =>
            `${index + 2} 1 9:1 / /workspace/m${index} rw - ext4 /dev/other rw`,
    ).join('\n');
    assert.throws(
        () =>
            assertEnvironmentMountIsolation(
                base + many,
                ['/operator/app.yaml'],
                ['/workspace'],
            ),
        /Too many/,
    );
});
