import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { eip712Auth, type AuthenticatedRequest } from '../middleware/eip712Auth.js';
import { commitmentsRateLimit, readRateLimit } from '../middleware/rateLimit.js';
import { getCommitmentsHandler, postCommitmentHandler } from './commitments.js';
import { getMarketByIdHandler, getMarketsHandler } from './markets.js';
import { getProtocolInfoHandler } from './protocol.js';
import { getPositionsByAddressHandler } from './positions.js';
import { getLeaderboardHandler } from './leaderboard.js';
import { getScheduleHandler } from './schedule.js';

/**
 * Versioned public API. Endpoints migrate here in batches from
 * ospex-agent-server. Each handler registers its own rate-limit /
 * auth middleware where appropriate; the router itself stays thin.
 *
 * Static / specific paths are registered before parameterized ones
 * (e.g. `/markets` before `/markets/:contestId`) so Express's matcher
 * doesn't claim `markets` as a `:contestId`.
 */
export const v1Router: Router = Router();

// ── Writes ────────────────────────────────────────────────────────────
v1Router.post(
  '/commitments',
  commitmentsRateLimit,
  eip712Auth('OspexCommitment'),
  asyncHandler((req, res) => postCommitmentHandler(req as AuthenticatedRequest, res)),
);

// ── Reads ─────────────────────────────────────────────────────────────
v1Router.get('/commitments', readRateLimit, asyncHandler(getCommitmentsHandler));

v1Router.get('/markets', readRateLimit, asyncHandler(getMarketsHandler));
v1Router.get('/markets/:contestId', readRateLimit, asyncHandler(getMarketByIdHandler));

v1Router.get('/protocol/info', readRateLimit, (req, res) => getProtocolInfoHandler(req, res));

v1Router.get('/positions/:address', readRateLimit, asyncHandler(getPositionsByAddressHandler));

v1Router.get('/leaderboard', readRateLimit, asyncHandler(getLeaderboardHandler));

v1Router.get('/schedule', readRateLimit, asyncHandler(getScheduleHandler));
