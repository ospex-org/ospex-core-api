import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { eip712Auth, type AuthenticatedRequest } from '../middleware/eip712Auth.js';
import { commitmentsRateLimit, readRateLimit } from '../middleware/rateLimit.js';
import {
  deleteCommitmentHandler,
  getCommitmentByHashHandler,
  getCommitmentsHandler,
  postCommitmentHandler,
} from './commitments.js';
import { getApprovedScriptsHandler } from './contests.js';
import { getMarketByIdHandler, getMarketsHandler } from './markets.js';
import { getOddsHistoryHandler } from './analytics.js';
import { getAuthDomainHandler } from './auth.js';
import { getPublicConfigHandler } from './config.js';
import { getProtocolInfoHandler } from './protocol.js';
import {
  getClaimParamsHandler,
  getClaimResultHandler,
  getPositionByTxHandler,
  getPositionStatusHandler,
  getPositionsByAddressHandler,
} from './positions.js';
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

v1Router.delete(
  '/commitments/:hash',
  commitmentsRateLimit,
  eip712Auth('CancelCommitment'),
  asyncHandler((req, res) => deleteCommitmentHandler(req as AuthenticatedRequest, res)),
);

// ── Reads ─────────────────────────────────────────────────────────────
// Single-row :hash lookup is mounted before the bare list route so the
// path-by-segment ordering matches how positions.ts mounts its
// static-prefix paths first. Express would resolve either order
// correctly here (no segment collision), but consistent ordering keeps
// the file readable.
v1Router.get('/commitments/:hash', readRateLimit, asyncHandler(getCommitmentByHashHandler));
v1Router.get('/commitments', readRateLimit, asyncHandler(getCommitmentsHandler));

v1Router.get('/markets', readRateLimit, asyncHandler(getMarketsHandler));
v1Router.get('/markets/:contestId', readRateLimit, asyncHandler(getMarketByIdHandler));

v1Router.get('/contests/scripts/approved', readRateLimit, (req, res) =>
  getApprovedScriptsHandler(req, res),
);

v1Router.get('/protocol/info', readRateLimit, (req, res) => getProtocolInfoHandler(req, res));

v1Router.get('/auth/domain', readRateLimit, (req, res) => getAuthDomainHandler(req, res));

v1Router.get('/config/public', readRateLimit, (req, res) => getPublicConfigHandler(req, res));

// Static-prefix tx parsers MUST come before `/positions/:address`
// so Express doesn't match `by-tx` / `claim-result` as an address.
v1Router.get('/positions/by-tx/:txHash', readRateLimit, asyncHandler(getPositionByTxHandler));
v1Router.get('/positions/claim-result/:txHash', readRateLimit, asyncHandler(getClaimResultHandler));
v1Router.get('/positions/:address/claim-params', readRateLimit, asyncHandler(getClaimParamsHandler));
v1Router.get('/positions/:address/status', readRateLimit, asyncHandler(getPositionStatusHandler));
v1Router.get('/positions/:address', readRateLimit, asyncHandler(getPositionsByAddressHandler));

v1Router.get('/leaderboard', readRateLimit, asyncHandler(getLeaderboardHandler));

v1Router.get('/schedule', readRateLimit, asyncHandler(getScheduleHandler));

v1Router.get('/analytics/odds-history/:contestId', readRateLimit, asyncHandler(getOddsHistoryHandler));
