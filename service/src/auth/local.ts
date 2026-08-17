import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../types';
import { applyPrincipal } from './principal';

export function applyLocalPrincipal(req: AuthenticatedRequest): void {
    req.planId = 'local-plan';
    /* Mirror the populate that prod auth does so sessionKey resolvers
     * have a stable userId while local mode bypasses external auth. */
    applyPrincipal(req, {
        userId: 'local-test-user',
        tenantId: 'local',
        principalSource: 'none',
        credentialId: 'local-test-key',
    });
}

export const localAuth = async (
    req: AuthenticatedRequest,
    _res: Response,
    next: NextFunction,
): Promise<void> => {
    applyLocalPrincipal(req);
    next();
};
