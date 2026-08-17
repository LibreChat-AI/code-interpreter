import type * as t from './types';

type RunLike = {
    stdout?: unknown;
    stderr?: unknown;
    output?: unknown;
    code?: unknown;
    signal?: unknown;
    message?: unknown;
    status?: unknown;
    cpu_time?: unknown;
    wall_time?: unknown;
    memory?: unknown;
};

type SandboxResponseLike = {
    session_id?: unknown;
    language?: unknown;
    version?: unknown;
    files?: unknown;
    run?: RunLike;
};

export function summarizeText(value: unknown): {
    length: number;
    present: boolean;
} {
    if (typeof value !== 'string') {
        return { length: 0, present: false };
    }
    return { length: value.length, present: value.length > 0 };
}

export function summarizeFiles(files: unknown): {
    count: number;
    inheritedCount: number;
    modifiedCount: number;
} {
    if (!Array.isArray(files)) {
        return { count: 0, inheritedCount: 0, modifiedCount: 0 };
    }
    return {
        count: files.length,
        inheritedCount: files.filter(file =>
            Boolean((file as t.FileRef | undefined)?.inherited),
        ).length,
        modifiedCount: files.filter(
            file => (file as t.FileRef | undefined)?.modified_from != null,
        ).length,
    };
}

export function summarizeRequestedFiles(files: unknown): {
    count: number;
    skillCount: number;
    agentCount: number;
    userCount: number;
} {
    if (!Array.isArray(files)) {
        return { count: 0, skillCount: 0, agentCount: 0, userCount: 0 };
    }
    return {
        count: files.length,
        skillCount: files.filter(
            file => (file as t.RequestFile | undefined)?.kind === 'skill',
        ).length,
        agentCount: files.filter(
            file => (file as t.RequestFile | undefined)?.kind === 'agent',
        ).length,
        userCount: files.filter(
            file => (file as t.RequestFile | undefined)?.kind === 'user',
        ).length,
    };
}

export function summarizeSandboxResponse(
    data: SandboxResponseLike,
): Record<string, unknown> {
    const run = data.run;
    return {
        session_id: data.session_id,
        language: data.language,
        version: data.version,
        files: summarizeFiles(data.files),
        run:
            run == null
                ? undefined
                : {
                      code: run.code,
                      signal: run.signal,
                      status: run.status,
                      message: summarizeText(run.message),
                      stdout: summarizeText(run.stdout),
                      stderr: summarizeText(run.stderr),
                      output: summarizeText(run.output),
                      cpu_time: run.cpu_time,
                      wall_time: run.wall_time,
                      memory: run.memory,
                  },
    };
}
