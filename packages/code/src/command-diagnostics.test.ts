import assert from 'node:assert/strict';
import test from 'node:test';
import {
    commandFailureDiagnostic,
    commandFailureEvent,
    commandFailureLogLine,
    readCommandFailureDiagnostic,
} from './command-diagnostics.js';

test('command diagnostics retain only fixed classifications and allowlisted errno', () => {
    const error = Object.assign(
        new Error('token secret /private/path echo password'),
        {
            code: 'ENOSPC',
            command: 'echo password',
            token: 'secret',
        },
    );
    assert.deepEqual(
        commandFailureDiagnostic('sandbox_startup', 'startup_failed', error),
        {
            stage: 'sandbox_startup',
            reason: 'startup_failed',
            osCode: 'ENOSPC',
        },
    );
    assert.deepEqual(
        commandFailureDiagnostic('credential_resolution', 'credential_failed', {
            code: 'private-provider-value',
        }),
        { stage: 'credential_resolution', reason: 'credential_failed' },
    );
});

test('IPC diagnostics are reconstructed rather than forwarding arbitrary metadata', () => {
    const diagnostic = {
        stage: 'sandbox_startup',
        reason: 'startup_failed',
        osCode: 'EPERM',
        message: 'secret',
        command: 'echo password',
        path: '/private/path',
    };
    assert.deepEqual(readCommandFailureDiagnostic(diagnostic), {
        stage: 'sandbox_startup',
        reason: 'startup_failed',
        osCode: 'EPERM',
    });
    for (const value of [
        null,
        'secret',
        {},
        { stage: 'secret', reason: 'startup_failed' },
        { stage: 'sandbox_startup', reason: 'secret' },
    ]) {
        assert.equal(readCommandFailureDiagnostic(value), undefined);
    }
    assert.deepEqual(
        readCommandFailureDiagnostic({ ...diagnostic, osCode: 'secret' }),
        {
            stage: 'sandbox_startup',
            reason: 'startup_failed',
        },
    );
});

test('failure events bound correlation IDs and omit free-form error data', () => {
    const event = commandFailureEvent(undefined, {
        assignmentId: 'assignment-1',
        workerId: 'worker-1',
        incarnationId: 'incarnation-1',
        workspaceId: '/private/path\nsecret',
        operation: 'execute_command',
        mutationMayHaveCommitted: false,
        requiresQuarantine: false,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(event)), {
        event: 'workspace_command_unavailable',
        stage: 'dispatch',
        reason: 'executor_rejected',
        assignmentId: 'assignment-1',
        workerId: 'worker-1',
        incarnationId: 'incarnation-1',
        operation: 'execute_command',
        mutationMayHaveCommitted: false,
        requiresQuarantine: false,
    });
    assert.equal(
        commandFailureEvent(undefined, {
            ...event,
            assignmentId: 'a'.repeat(129),
        }).assignmentId,
        undefined,
    );
});

test('diagnostic correlation retains every valid worker/workspace identifier character', () => {
    const event = commandFailureEvent(undefined, {
        assignmentId: '_assignment-1',
        workerId: 'vm.example',
        workspaceId: 'repo:api',
        incarnationId: 'worker_v1-2',
        operation: 'execute_command',
        mutationMayHaveCommitted: false,
        requiresQuarantine: false,
    });
    assert.equal(event.workerId, 'vm.example');
    assert.equal(event.workspaceId, 'repo:api');
    assert.equal(event.incarnationId, 'worker_v1-2');
    assert.equal(event.assignmentId, '_assignment-1');
    assert.equal(
        commandFailureEvent(undefined, { ...event, workerId: 'vm\n' }).workerId,
        undefined,
    );
});

test('diagnostic extraction cannot invoke exception getters or mask a failure', () => {
    const error = {
        get code() {
            throw new Error('private getter');
        },
    };
    assert.deepEqual(
        commandFailureDiagnostic(
            'credential_resolution',
            'credential_failed',
            error,
        ),
        {
            stage: 'credential_resolution',
            reason: 'credential_failed',
        },
    );
    assert.deepEqual(
        commandFailureDiagnostic(
            'credential_resolution',
            'credential_failed',
            new Proxy(
                {},
                {
                    getOwnPropertyDescriptor() {
                        throw new Error('private proxy');
                    },
                },
            ),
        ),
        {
            stage: 'credential_resolution',
            reason: 'credential_failed',
        },
    );
});

test('CLI diagnostic lines are complete JSON records without a text prefix', () => {
    const event = commandFailureEvent(undefined, {
        assignmentId: 'assignment-1',
        operation: 'execute_command',
        mutationMayHaveCommitted: false,
        requiresQuarantine: false,
    });
    const line = commandFailureLogLine(event);
    assert.equal(line.endsWith('\n'), true);
    assert.equal(line.split('\n').length, 2);
    assert.deepEqual(JSON.parse(line), JSON.parse(JSON.stringify(event)));
});
