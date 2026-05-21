/**
 * GET /v1/fills — the append-only fill (position_fills) event stream.
 *
 * Unlike the mutable-row recovery endpoints (commitments/positions/etc.,
 * which converge to a latest state), `position_fills` rows are immutable
 * once written, so this is true event-like recovery: every matching fill
 * is delivered in cursor order. Each on-chain match writes one row
 * (maker + taker sides captured together).
 *
 * Identity filters (all optional): maker, taker, speculationId, contestId,
 * commitmentHash. Cursor recovery via `?since=<cursor>`; ordered by
 * (row_updated_at, id) ascending. Dedupe key client-side is
 * (tx_hash, log_index).
 */

import type { Request, Response } from 'express';
import { isAddress } from 'ethers';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import { wei6ToUSDC } from '../lib/sanitize.js';
import { keysetOrExpr, type CursorableRow } from '../lib/cursor.js';
import { nextCursor, parseRecovery } from '../lib/recovery.js';
import type { ApiError } from '../middleware/errorHandler.js';

const POSITION_TYPE_TO_INT: Record<'upper' | 'lower', 0 | 1> = { upper: 0, lower: 1 };
const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;

interface FillBody {
  speculationId: string;
  contestId: string;
  commitmentHash: string;
  maker: string;
  taker: string;
  makerPositionType: 0 | 1;
  takerPositionType: 0 | 1;
  makerRiskAmount: string; // wei6 (USDC has 6 decimals) as string
  takerRiskAmount: string;
  makerRiskUSDC: number;
  takerRiskUSDC: number;
  oddsTick: number;
  filledAt: string;
  contestStarted: boolean;
  txHash: string;
  logIndex: number;
}

interface FillRow extends CursorableRow {
  speculation_id: string | number;
  contest_id: string | number;
  commitment_hash: string;
  maker_address: string;
  taker_address: string;
  maker_position_type: 'upper' | 'lower';
  taker_position_type: 'upper' | 'lower';
  maker_risk_amount: string | number;
  taker_risk_amount: string | number;
  odds_tick: number;
  filled_at: string;
  contest_started: boolean;
  tx_hash: string;
  log_index: number;
}

const FILL_COLUMNS =
  'speculation_id, contest_id, commitment_hash, maker_address, taker_address, ' +
  'maker_position_type, taker_position_type, maker_risk_amount, taker_risk_amount, ' +
  'odds_tick, filled_at, contest_started, tx_hash, log_index, id, row_updated_at';

function rowToBody(r: FillRow): FillBody {
  return {
    speculationId: String(r.speculation_id),
    contestId: String(r.contest_id),
    commitmentHash: r.commitment_hash,
    maker: r.maker_address,
    taker: r.taker_address,
    makerPositionType: POSITION_TYPE_TO_INT[r.maker_position_type],
    takerPositionType: POSITION_TYPE_TO_INT[r.taker_position_type],
    makerRiskAmount: String(r.maker_risk_amount),
    takerRiskAmount: String(r.taker_risk_amount),
    makerRiskUSDC: wei6ToUSDC(r.maker_risk_amount),
    takerRiskUSDC: wei6ToUSDC(r.taker_risk_amount),
    oddsTick: r.odds_tick,
    filledAt: r.filled_at,
    contestStarted: Boolean(r.contest_started),
    txHash: r.tx_hash,
    logIndex: r.log_index,
  };
}

export async function getFillsHandler(req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  const sb = getSupabase();

  const recovery = parseRecovery(req, 'fills');
  if ('errorBody' in recovery) {
    res.status(400).json(recovery.errorBody);
    return;
  }

  let maker: string | undefined;
  if (req.query.maker !== undefined) {
    const lowered = String(req.query.maker).trim().toLowerCase();
    if (!isAddress(lowered)) {
      res.status(400).json({ error: 'maker must be a valid Ethereum address.', code: 'INVALID_PARAM' } satisfies ApiError);
      return;
    }
    maker = lowered;
  }

  let taker: string | undefined;
  if (req.query.taker !== undefined) {
    const lowered = String(req.query.taker).trim().toLowerCase();
    if (!isAddress(lowered)) {
      res.status(400).json({ error: 'taker must be a valid Ethereum address.', code: 'INVALID_PARAM' } satisfies ApiError);
      return;
    }
    taker = lowered;
  }

  let speculationId: string | undefined;
  if (req.query.speculationId !== undefined) {
    try {
      const v = BigInt(String(req.query.speculationId));
      if (v < 0n) throw new Error();
      speculationId = v.toString();
    } catch {
      res.status(400).json({ error: 'speculationId must be a non-negative integer.', code: 'INVALID_PARAM' } satisfies ApiError);
      return;
    }
  }

  let contestId: string | undefined;
  if (req.query.contestId !== undefined) {
    try {
      const v = BigInt(String(req.query.contestId));
      if (v < 0n) throw new Error();
      contestId = v.toString();
    } catch {
      res.status(400).json({ error: 'contestId must be a non-negative integer.', code: 'INVALID_PARAM' } satisfies ApiError);
      return;
    }
  }

  let commitmentHash: string | undefined;
  if (req.query.commitmentHash !== undefined) {
    const raw = String(req.query.commitmentHash).trim();
    if (!HASH_PATTERN.test(raw)) {
      res.status(400).json({ error: 'commitmentHash must be a 0x-prefixed 32-byte hex string.', code: 'INVALID_PARAM' } satisfies ApiError);
      return;
    }
    commitmentHash = raw.toLowerCase();
  }

  let q = sb.from('position_fills').select(FILL_COLUMNS).eq('network', config.network);
  if (maker !== undefined) q = q.eq('maker_address', maker);
  if (taker !== undefined) q = q.eq('taker_address', taker);
  if (speculationId !== undefined) q = q.eq('speculation_id', speculationId);
  if (contestId !== undefined) q = q.eq('contest_id', contestId);
  if (commitmentHash !== undefined) q = q.eq('commitment_hash', commitmentHash);
  if (recovery.cursor) q = q.or(keysetOrExpr(recovery.cursor));
  q = q.order('row_updated_at', { ascending: true }).order('id', { ascending: true }).limit(recovery.limit);

  const { data, error } = await q;
  if (error) {
    logger.error({ err: error.message }, 'fills: recovery query failed');
    res.status(500).json({ error: 'Failed to fetch fills.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const rows = (data ?? []) as unknown as FillRow[];
  const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
  res.status(200).json({
    fills: rows.map(rowToBody),
    nextCursor: nextCursor('fills', last, recovery.sinceRaw),
    hasMore: rows.length === recovery.limit,
  });
}
