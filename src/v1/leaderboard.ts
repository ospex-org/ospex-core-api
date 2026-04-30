/**
 * GET /v1/leaderboard — current active leaderboard with registered bankrolls.
 *
 * Returns the soonest-ending leaderboard whose start_time has passed
 * and end_time hasn't, plus the top-N registered bankrolls (sorted
 * desc by `declared_bankroll`).
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import { wei6ToUSDC } from '../lib/sanitize.js';
import type { ApiError } from '../middleware/errorHandler.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

interface LeaderboardEntry {
  rank: number;
  address: string;
  declaredBankrollUSDC: number;
}

interface LeaderboardResponse {
  leaderboardId: string;
  startTime: string;
  endTime: string;
  entries: LeaderboardEntry[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
}

export async function getLeaderboardHandler(req: Request, res: Response): Promise<void> {
  const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    res.status(400).json({
      error: `limit must be an integer between 1 and ${MAX_LIMIT}.`,
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  const offset = req.query.offset ? Number(req.query.offset) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    res.status(400).json({
      error: 'offset must be a non-negative integer.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const config = loadConfig();
  const sb = getSupabase();
  const now = new Date().toISOString();

  const lbRes = await sb
    .from('leaderboards')
    .select('leaderboard_id, start_time, end_time')
    .eq('network', config.network)
    .lte('start_time', now)
    .gt('end_time', now)
    .order('end_time', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (lbRes.error) {
    logger.error({ err: lbRes.error.message }, 'leaderboard: active lookup failed');
    res.status(500).json({ error: 'Failed to fetch leaderboard.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  if (!lbRes.data) {
    res.status(404).json({ error: 'No active leaderboard.', code: 'NOT_FOUND' } satisfies ApiError);
    return;
  }
  const lb = lbRes.data;

  const regsRes = await sb
    .from('leaderboard_registrations')
    .select('user_address, declared_bankroll', { count: 'exact' })
    .eq('network', config.network)
    .eq('leaderboard_id', lb.leaderboard_id)
    .order('declared_bankroll', { ascending: false })
    .range(offset, offset + limit - 1);

  if (regsRes.error) {
    logger.error({ err: regsRes.error.message }, 'leaderboard: registrations query failed');
    res.status(500).json({ error: 'Failed to fetch leaderboard registrations.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const total = regsRes.count ?? 0;
  const entries: LeaderboardEntry[] = (regsRes.data ?? []).map((r, i) => ({
    rank: offset + i + 1,
    address: String(r.user_address),
    declaredBankrollUSDC: wei6ToUSDC(r.declared_bankroll),
  }));

  const body: LeaderboardResponse = {
    leaderboardId: String(lb.leaderboard_id),
    startTime: lb.start_time ?? '',
    endTime: lb.end_time ?? '',
    entries,
    pagination: { limit, offset, total, hasMore: offset + entries.length < total },
  };
  res.status(200).json(body);
}
