/**
 * GET /v1/contests/scripts/approved — EIP-712 script approvals for the
 * deployment's network.
 *
 * Required by @ospex/sdk M4 contests.create() — the SDK fetches these at
 * runtime so a re-signed approval can ship via core-api redeploy without
 * an SDK release. Static, no DB, no auth.
 *
 * If the deployment's network has no approvals committed (e.g. amoy
 * before the first amoy signing), responds 503 SCRIPT_APPROVALS_NOT_CONFIGURED.
 */
import type { Request, Response } from 'express';
import { loadConfig } from '../lib/env.js';
import {
  SCRIPT_APPROVALS_BY_NETWORK,
  type ScriptApprovalsBundle,
} from '../data/scriptApprovals.js';
import type { ApiError } from '../middleware/errorHandler.js';

export function getApprovedScriptsHandler(_req: Request, res: Response): void {
  const config = loadConfig();
  const bundle: ScriptApprovalsBundle | null = SCRIPT_APPROVALS_BY_NETWORK[config.network];
  if (bundle === null) {
    res.status(503).json({
      error: `Script approvals not configured for network "${config.network}".`,
      code: 'SCRIPT_APPROVALS_NOT_CONFIGURED',
    } satisfies ApiError);
    return;
  }
  res.status(200).json(bundle);
}
