/**
 * GET /v1/metrics — operational stream/connection counters.
 *
 * Surfaces the in-memory stats the SSE subsystem already tracks (previously
 * reachable only from tests): the protocol-stream hub, the odds hub, the
 * own-state hub, and the concurrent-connection accounting. Kept off /readyz so
 * readiness stays a pure up/down dependency check; this is the "how loaded is
 * the stream stack" view.
 * All counters are process-local — point a scraper at every dyno, not the LB.
 */

import type { Request, Response } from 'express';
import { getStreamHub } from './stream/hub.js';
import { getOddsHub } from './stream/oddsHub.js';
import { getOwnStateHub } from './ownState/hub.js';
import { connectionStats } from './stream/connections.js';
import { handlerStats } from './stream/handler.js';

export function getMetricsHandler(_req: Request, res: Response): void {
  res.status(200).json({
    stream: { ...getStreamHub().stats(), ...handlerStats() },
    odds: getOddsHub().stats(),
    ownState: getOwnStateHub().stats(),
    connections: connectionStats(),
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}
