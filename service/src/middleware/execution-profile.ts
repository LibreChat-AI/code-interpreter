import type { NextFunction, Request, Response } from 'express';
import { env } from '../config';
import {
  checkExecutionProfileExpectation,
  EXECUTION_PROFILE_HEADER,
  EXPECTED_EXECUTION_PROFILE_HEADER,
} from '../execution-profile';
import { executionProfileRequestRejections } from '../metrics';

function expectedExecutionProfile(req: Request): string | undefined {
  const values: string[] = [];
  const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === EXPECTED_EXECUTION_PROFILE_HEADER.toLowerCase()) {
      values.push(rawHeaders[index + 1] ?? '');
    }
  }
  /* Joining makes duplicate assertions invalid even when an HTTP runtime
   * would otherwise collapse them with last-value-wins semantics. */
  return values.length > 0
    ? values.join(',')
    : req.get(EXPECTED_EXECUTION_PROFILE_HEADER);
}

/**
 * Advertise this deployment's profile and fail closed when a trusted caller
 * reaches the wrong endpoint. Apply before routing so no file, programmatic,
 * or ordinary execution request can enqueue work on a mismatched stack.
 */
export function executionProfileMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader(EXECUTION_PROFILE_HEADER, env.EXECUTION_PROFILE);

  const expectation = checkExecutionProfileExpectation(
    expectedExecutionProfile(req),
    env.EXECUTION_PROFILE,
  );
  if (expectation.ok) {
    next();
    return;
  }

  executionProfileRequestRejections.inc({
    reason: expectation.body.error === 'execution_profile_mismatch'
      ? 'mismatch'
      : 'invalid',
  });
  res.status(expectation.status).json(expectation.body);
}
