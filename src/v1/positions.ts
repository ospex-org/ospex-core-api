/**
 * GET /v1/positions/:address — paginated wallet position history.
 *
 * Reads only. The position helpers from agent-server
 * (`/claim-params`, `/withdraw-params`, `/status`) depend on a
 * Firestore-backed helper (`fetchCategorizedPositions`) and are
 * intentionally out of scope for this batch — they need a
 * Supabase rewrite first.
 */

import type { Request, Response } from 'express';
import { isAddress } from 'ethers';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import { wei6ToUSDC } from '../lib/sanitize.js';
import type { ApiError } from '../middleware/errorHandler.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const POSITION_TYPE_TO_INT: Record<'upper' | 'lower', 0 | 1> = { upper: 0, lower: 1 };

interface PositionBody {
  speculationId: string;
  positionType: 0 | 1 | null;
  riskAmountUSDC: number;
  profitAmountUSDC: number;
  claimed: boolean;
  positionCreatedAt: string | null;
}

interface PositionRow {
  speculation_id: string | number;
  position_type: 'upper' | 'lower' | null;
  risk_amount: string | number | null;
  profit_amount: string | number | null;
  claimed: boolean | null;
  position_created_at: string | null;
}

interface ListResponse {
  address: string;
  positions: PositionBody[];
  totals: {
    totalCount: number;
    totalRiskUSDC: number;
    totalProfitUSDC: number;
    activeCount: number;
  };
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
  };
}

function rowToBody(row: PositionRow): PositionBody {
  return {
    speculationId: String(row.speculation_id),
    positionType: row.position_type ? POSITION_TYPE_TO_INT[row.position_type] : null,
    riskAmountUSDC: wei6ToUSDC(row.risk_amount),
    profitAmountUSDC: wei6ToUSDC(row.profit_amount),
    claimed: Boolean(row.claimed),
    positionCreatedAt: row.position_created_at,
  };
}

export async function getPositionsByAddressHandler(req: Request, res: Response): Promise<void> {
  // Lowercase first so mixed-case input passes — `isAddress` rejects
  // mixed-case addresses that don't match the EIP-55 checksum, which is
  // the wrong default for a public read endpoint.
  const address = String(req.params.address ?? '').trim().toLowerCase();
  if (!isAddress(address)) {
    res.status(400).json({
      error: 'Invalid Ethereum address.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

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
  const { data, count, error } = await sb
    .from('positions')
    .select('speculation_id, position_type, risk_amount, profit_amount, claimed, position_created_at', { count: 'exact' })
    .eq('network', config.network)
    .eq('user_address', address)
    .order('position_created_at', { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1);

  if (error) {
    logger.error({ err: error.message }, 'positions: list query failed');
    res.status(500).json({ error: 'Failed to fetch positions.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const positions = (data ?? []).map((r) => rowToBody(r as unknown as PositionRow));
  const total = count ?? 0;
  let totalRiskUSDC = 0;
  let totalProfitUSDC = 0;
  let activeCount = 0;
  for (const p of positions) {
    totalRiskUSDC += p.riskAmountUSDC;
    totalProfitUSDC += p.profitAmountUSDC;
    if (!p.claimed) activeCount++;
  }

  const body: ListResponse = {
    address,
    positions,
    totals: {
      totalCount: total,
      totalRiskUSDC: Math.round(totalRiskUSDC * 100) / 100,
      totalProfitUSDC: Math.round(totalProfitUSDC * 100) / 100,
      activeCount,
    },
    pagination: { limit, offset, total, hasMore: offset + positions.length < total },
  };
  res.status(200).json(body);
}
