import axios from 'axios';
import type {
    SandboxBackend,
    SandboxExecuteContext,
    SandboxRawResponse,
    SandboxTransportRequest,
} from './types';
import { injectTraceHeaders, withSpan } from '../telemetry';
import { Jobs } from '../enum';
import { env } from '../config';

/** Current behavior: POST the signed request to SANDBOX_ENDPOINT.
 *  Axios errors are rethrown untouched so the worker's existing
 *  abort/timeout/sandbox-error mapping stays byte-identical. */
export class HttpSandboxBackend implements SandboxBackend {
    readonly name = 'http' as const;

    async execute(
        req: SandboxTransportRequest,
        ctx: SandboxExecuteContext,
    ): Promise<SandboxRawResponse> {
        const response = await withSpan(
            'codeapi.sandbox.execute',
            {
                'http.request.method': 'POST',
                'url.path': `/${Jobs.execute}`,
                'codeapi.language': ctx.language,
                'codeapi.sandbox.backend': this.name,
            },
            () =>
                axios.post<SandboxRawResponse>(
                    `${env.SANDBOX_ENDPOINT}/${Jobs.execute}`,
                    req.body,
                    {
                        headers: injectTraceHeaders(req.headers),
                        signal: ctx.signal,
                    },
                ),
            'CLIENT',
        );

        if (response.status !== 200) {
            throw new Error('Error from sandbox');
        }

        return response.data;
    }
}
