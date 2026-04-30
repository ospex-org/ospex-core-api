import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { eip712Auth, type AuthenticatedRequest } from '../middleware/eip712Auth.js';
import { commitmentsRateLimit } from '../middleware/rateLimit.js';
import { postCommitmentHandler } from './commitments.js';

/**
 * Versioned public API. Endpoints migrate here in batches from
 * ospex-agent-server. Each handler registers its own rate-limit /
 * auth middleware where appropriate; the router itself stays thin.
 */
export const v1Router: Router = Router();

v1Router.post(
  '/commitments',
  commitmentsRateLimit,
  eip712Auth('OspexCommitment'),
  asyncHandler((req, res) => postCommitmentHandler(req as AuthenticatedRequest, res)),
);
