/**
 * GET /v1/config/public — bootstrap config for public clients (SDK, CLI).
 *
 * Returns the Supabase publishable credentials a client needs to open
 * Realtime channels, plus network identity. Contract addresses live
 * separately on /v1/protocol/info — keeping this payload minimal so the
 * SDK's first call is small and cacheable.
 *
 * Returns 503 NOT_READY if SUPABASE_ANON_KEY is unset, mirroring the
 * pattern used by /v1/auth/domain when MATCHING_MODULE_ADDRESS is unset.
 */

import type { Request, Response } from 'express';
import { loadConfig, type ChainId, type Network } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import type { ApiError } from '../middleware/errorHandler.js';

interface PublicConfigResponse {
  supabaseUrl: string;
  supabaseAnonKey: string;
  network: Network;
  chainId: ChainId;
}

export function getPublicConfigHandler(_req: Request, res: Response): void {
  const config = loadConfig();
  if (!config.supabaseAnonKey) {
    logger.warn('getPublicConfigHandler: SUPABASE_ANON_KEY not configured');
    res.status(503).json({
      error: 'Server not configured for public Realtime: SUPABASE_ANON_KEY is not set.',
      code: 'NOT_READY',
    } satisfies ApiError);
    return;
  }
  const body: PublicConfigResponse = {
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    network: config.network,
    chainId: config.chainId,
  };
  res.set('Cache-Control', 'public, max-age=300');
  res.status(200).json(body);
}
