import express, { Router, type Request, type Response } from 'express';
import { logger } from '../logger';
import {
    bindSessionWorkspace,
    parseSessionBinding,
    unbindSessionWorkspace,
} from '../session-workspace';

/**
 * AWS Lambda MicroVM hook endpoints. The platform POSTs to
 * `/aws/lambda-microvms/runtime/v1/<hook>` on the configured hook port:
 *
 *   /ready, /validate   image build hooks (200 = proceed, 503 = retry)
 *   /run                after start; body {microvmId, runHookPayload};
 *                       external traffic only flows after this returns 200
 *   /resume, /suspend, /terminate   lifecycle transitions
 *
 * Phase 1-2: structured no-ops that log and 200. /suspend and /terminate
 * are the Phase 3 checkpoint-flush attachment points; /run captures the
 * per-VM payload for later runtime-session wiring.
 */

export const LIFECYCLE_HOOK_BASE_PATH = '/aws/lambda-microvms/runtime/v1';

export interface MicrovmRunContext {
    microvmId?: string;
    runHookPayload?: string;
    receivedAt: number;
}

let runContext: MicrovmRunContext | undefined;

export function getMicrovmRunContext(): MicrovmRunContext | undefined {
    return runContext;
}

export function resetMicrovmRunContextForTests(): void {
    runContext = undefined;
}

/** First /run wins; retries with the same microvmId are idempotent, a
 *  different id is logged and ignored. Always 200 — a non-200 would fail
 *  the platform's lifecycle operation. */
export function applyRunHook(body: unknown): MicrovmRunContext {
    const parsed = (typeof body === 'object' && body !== null ? body : {}) as {
        microvmId?: unknown;
        runHookPayload?: unknown;
    };
    const microvmId =
        typeof parsed.microvmId === 'string' ? parsed.microvmId : undefined;
    const runHookPayload =
        typeof parsed.runHookPayload === 'string'
            ? parsed.runHookPayload
            : undefined;

    /* A malformed first delivery must not permanently win the idempotency slot.
     * Lambda can retry lifecycle hooks, so only a payload carrying the platform
     * identity becomes the immutable run context. Keep returning an ephemeral
     * context for malformed calls because the hook must still acknowledge them
     * with 200 rather than failing the lifecycle operation. */
    if (microvmId == null) {
        logger.warn('Ignoring /run hook without a valid microvmId');
        return (
            runContext ?? { microvmId, runHookPayload, receivedAt: Date.now() }
        );
    }

    if (runContext == null) {
        runContext = { microvmId, runHookPayload, receivedAt: Date.now() };
        const binding = parseSessionBinding(runHookPayload);
        if (binding) {
            bindSessionWorkspace(binding);
            logger.info(
                { runtimeSessionId: binding.runtimeSessionId },
                'Bound persistent session workspace',
            );
        }
    } else if (
        runContext.microvmId != null &&
        microvmId != null &&
        runContext.microvmId !== microvmId
    ) {
        logger.warn(
            { existing: runContext.microvmId, incoming: microvmId },
            'Ignoring /run hook for a different microvmId',
        );
    }
    return runContext;
}

const lifecycleRouter = Router();

function ackHook(hook: string) {
    return (_req: Request, res: Response): Response => {
        logger.info({ hook }, 'MicroVM lifecycle hook invoked');
        return res.status(200).json({ hook, status: 'ok' });
    };
}

lifecycleRouter.post('/ready', ackHook('ready'));
lifecycleRouter.post('/validate', ackHook('validate'));

lifecycleRouter.post(
    '/run',
    express.json({ limit: '32kb' }),
    (req: Request, res: Response) => {
        const context = applyRunHook(req.body);
        logger.info(
            {
                hook: 'run',
                microvmId: context.microvmId,
                hasPayload: context.runHookPayload != null,
            },
            'MicroVM lifecycle hook invoked',
        );
        return res.status(200).json({ hook: 'run', status: 'ok' });
    },
);

lifecycleRouter.post('/resume', ackHook('resume'));
lifecycleRouter.post('/suspend', ackHook('suspend'));

lifecycleRouter.post('/terminate', (_req: Request, res: Response) => {
    logger.info({ hook: 'terminate' }, 'MicroVM lifecycle hook invoked');
    void unbindSessionWorkspace().catch(err =>
        logger.error(
            { err },
            'Failed to unbind session workspace on terminate',
        ),
    );
    return res.status(200).json({ hook: 'terminate', status: 'ok' });
});

export default lifecycleRouter;
