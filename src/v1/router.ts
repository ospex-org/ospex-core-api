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
import {
  getApprovedScriptsHandler,
  getContestByIdHandler,
  getContestsHandler,
} from './contests.js';
import {
  getSpeculationByIdHandler,
  getSpeculationsHandler,
} from './speculations.js';
import { getOddsHistoryHandler } from './analytics.js';
import { getCurrentOddsHandler } from './odds.js';
import { getGameByIdHandler, getGamesHandler } from './games.js';
import { getTeamAliasesHandler } from './teams.js';
import { getAuthDomainHandler } from './auth.js';
import { postStreamChallengeHandler, postStreamTokenHandler } from './streamAuth.js';
import { getPublicConfigHandler } from './config.js';
import { getProtocolInfoHandler } from './protocol.js';
import { getMetricsHandler } from './metrics.js';
import {
  getClaimParamsHandler,
  getClaimResultHandler,
  getPositionByTxHandler,
  getPositionStatusHandler,
  getPositionsByAddressHandler,
  getPositionsRecoveryHandler,
} from './positions.js';
import { getFillsHandler } from './fills.js';
import { getStreamHandler } from './stream/handler.js';
import { getOddsStreamHandler } from './stream/oddsHandler.js';
import { getLeaderboardHandler } from './leaderboard.js';
import { getScheduleHandler } from './schedule.js';

/**
 * Versioned public API. Endpoints migrate here in batches from
 * ospex-agent-server. Each handler registers its own rate-limit /
 * auth middleware where appropriate; the router itself stays thin.
 *
 * Static / specific paths are registered before parameterized ones
 * (e.g. `/contests/scripts/approved` before `/contests/:contestId`)
 * so Express's matcher doesn't claim a static segment as a parameter.
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

// Static /contests/scripts/approved MUST come before /contests/:contestId
// or Express would match `scripts` as the contestId.
v1Router.get('/contests/scripts/approved', readRateLimit, (req, res) =>
  getApprovedScriptsHandler(req, res),
);
v1Router.get('/contests', readRateLimit, asyncHandler(getContestsHandler));
v1Router.get('/contests/:contestId/odds', readRateLimit, asyncHandler(getCurrentOddsHandler));
v1Router.get('/contests/:contestId', readRateLimit, asyncHandler(getContestByIdHandler));

v1Router.get('/speculations', readRateLimit, asyncHandler(getSpeculationsHandler));
v1Router.get('/speculations/:speculationId', readRateLimit, asyncHandler(getSpeculationByIdHandler));

v1Router.get('/protocol/info', readRateLimit, (req, res) => getProtocolInfoHandler(req, res));

v1Router.get('/auth/domain', readRateLimit, (req, res) => getAuthDomainHandler(req, res));

// ── Stream-auth (M3): EIP-712 challenge → bearer token ──────────────
// Owner-auth handshake for the M4 `/v1/own-state/*` surfaces. Both endpoints
// share the same rate budget as signed-write commitments — moderate cost,
// stops a bad actor from burning challenges or HMAC-grinding at request-rate.
v1Router.post('/auth/stream-challenge', commitmentsRateLimit, (req, res) =>
  postStreamChallengeHandler(req, res),
);
v1Router.post('/auth/stream-token', commitmentsRateLimit, (req, res) =>
  postStreamTokenHandler(req, res),
);

v1Router.get('/config/public', readRateLimit, (req, res) => getPublicConfigHandler(req, res));

// Operational metrics — process-local stream / odds / connection counters.
v1Router.get('/metrics', readRateLimit, (req, res) => getMetricsHandler(req, res));

// Bare /positions is the cursor-recovery endpoint (positions stream).
// The :address routes below stay the snapshot/history surface.
v1Router.get('/positions', readRateLimit, asyncHandler(getPositionsRecoveryHandler));
// Static-prefix tx parsers MUST come before `/positions/:address`
// so Express doesn't match `by-tx` / `claim-result` as an address.
v1Router.get('/positions/by-tx/:txHash', readRateLimit, asyncHandler(getPositionByTxHandler));
v1Router.get('/positions/claim-result/:txHash', readRateLimit, asyncHandler(getClaimResultHandler));
v1Router.get('/positions/:address/claim-params', readRateLimit, asyncHandler(getClaimParamsHandler));
v1Router.get('/positions/:address/status', readRateLimit, asyncHandler(getPositionStatusHandler));
v1Router.get('/positions/:address', readRateLimit, asyncHandler(getPositionsByAddressHandler));

// Append-only fill event stream (position_fills).
v1Router.get('/fills', readRateLimit, asyncHandler(getFillsHandler));

// ── SSE streams ───────────────────────────────────────────────────────
// Long-lived Server-Sent Events. No readRateLimit (a stream is one long
// request, not a burst); the handlers enforce a concurrent-connection cap
// instead.
//
// Odds is its own static route (latest-state: snapshot + live change/refresh,
// no cursor) and MUST be registered before `/stream/:resource` so Express
// doesn't bind `odds` as the `:resource` param.
v1Router.get('/stream/odds', (req, res) => {
  void getOddsStreamHandler(req, res);
});
// Protocol streams: live deltas + cursor catch-up + resync. `:resource` is
// validated against the stream registry (404 otherwise).
v1Router.get('/stream/:resource', (req, res) => getStreamHandler(req, res));

v1Router.get('/leaderboard', readRateLimit, asyncHandler(getLeaderboardHandler));

v1Router.get('/schedule', readRateLimit, asyncHandler(getScheduleHandler));

v1Router.get('/games', readRateLimit, asyncHandler(getGamesHandler));
v1Router.get('/games/:gameId', readRateLimit, asyncHandler(getGameByIdHandler));

v1Router.get('/teams/aliases', readRateLimit, asyncHandler(getTeamAliasesHandler));

v1Router.get('/analytics/odds-history/:contestId', readRateLimit, asyncHandler(getOddsHistoryHandler));
