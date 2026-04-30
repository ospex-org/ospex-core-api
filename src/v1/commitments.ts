/**
 * POST /v1/commitments — accept a signed EIP-712 OspexCommitment from
 * a maker, persist it to Supabase as `status: 'open'`, and return the
 * stored row. Idempotent on `commitment_hash`: a duplicate post returns
 * 200 with the existing row instead of 409 / a duplicate insert.
 *
 * The signature has already been verified by `eip712Auth`. The handler
 * just needs to map the verified message → DB columns, derive
 * `market_type` from the scorer, derive `speculation_key`, and INSERT.
 */

import type { Response } from 'express';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import { deriveSpeculationKey } from '../lib/eip712.js';
import { scorerToType, type MarketType } from '../lib/speculation.js';
import type { AuthenticatedRequest } from '../middleware/eip712Auth.js';
import type { ApiError } from '../middleware/errorHandler.js';

interface CommitmentResponseBody {
  commitmentHash: string;
  status: string;
  riskAmount: string;
  filledRiskAmount: string;
  remainingRiskAmount: string;
  expiry: string;
  source: string;
  network: string;
}

const POSITION_TYPE_LABEL: Record<number, 'upper' | 'lower'> = { 0: 'upper', 1: 'lower' };

interface CommitmentRow {
  commitment_hash: string;
  status: string;
  risk_amount: string;
  filled_risk_amount: string;
  expiry: string | null;
  source: string;
  network: string;
}

function rowToBody(row: CommitmentRow): CommitmentResponseBody {
  const risk = BigInt(row.risk_amount);
  const filled = BigInt(row.filled_risk_amount);
  const remaining = risk - filled;
  return {
    commitmentHash: row.commitment_hash,
    status: row.status,
    riskAmount: risk.toString(),
    filledRiskAmount: filled.toString(),
    remainingRiskAmount: (remaining < 0n ? 0n : remaining).toString(),
    expiry: row.expiry ?? '',
    source: row.source,
    network: row.network,
  };
}

export async function postCommitmentHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  const config = loadConfig();
  if (!config.scorers) {
    logger.error('postCommitmentHandler invoked but SCORER_*_ADDRESS env vars are not configured');
    res.status(500).json({
      error: 'Server not configured: missing scorer addresses.',
      code: 'INTERNAL_ERROR',
    } satisfies ApiError);
    return;
  }
  const scorers = config.scorers;

  const message = req.actionMessage;
  const commitmentHash = req.actionHash;

  const maker = String(message['maker']).toLowerCase();
  const scorer = String(message['scorer']).toLowerCase();
  const contestId = message['contestId'] as bigint;
  const lineTicks = message['lineTicks'] as number;
  const positionType = message['positionType'] as 0 | 1;
  const oddsTick = message['oddsTick'] as number;
  const riskAmount = message['riskAmount'] as bigint;
  const nonce = message['nonce'] as bigint;
  const expiry = message['expiry'] as bigint;

  // Derive market_type from scorer address.
  const marketType: MarketType | null = scorerToType(scorer, scorers);
  if (!marketType) {
    res.status(400).json({
      error: `Unknown scorer address: ${scorer}. Must be a registered moneyline, spread, or total scorer.`,
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const speculationKey = deriveSpeculationKey(contestId, scorer, lineTicks);
  const expiryISO = new Date(Number(expiry) * 1000).toISOString();
  const sb = getSupabase();
  const signature = (req.body as { signature: string }).signature;

  // Idempotency: if a row with this hash already exists, return it as 200.
  const existing = await sb
    .from('commitments')
    .select('commitment_hash, status, risk_amount, filled_risk_amount, expiry, source, network')
    .eq('network', config.network)
    .eq('commitment_hash', commitmentHash)
    .maybeSingle();

  if (existing.error) {
    logger.error({ err: existing.error.message }, 'commitments: idempotency lookup failed');
    res.status(500).json({ error: 'Failed to check for existing commitment.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  if (existing.data) {
    res.status(200).json(rowToBody(existing.data as CommitmentRow));
    return;
  }

  const insert = await sb
    .from('commitments')
    .insert({
      network: config.network,
      commitment_hash: commitmentHash,
      maker,
      contest_id: contestId.toString(),
      scorer,
      line_ticks: lineTicks,
      position_type: POSITION_TYPE_LABEL[positionType],
      odds_tick: oddsTick,
      market_type: marketType,
      risk_amount: riskAmount.toString(),
      filled_risk_amount: '0',
      nonce: nonce.toString(),
      expiry: expiryISO,
      speculation_key: speculationKey,
      signature,
      status: 'open',
      source: 'agent',
    })
    .select('commitment_hash, status, risk_amount, filled_risk_amount, expiry, source, network')
    .single();

  if (insert.error) {
    // Race: another request inserted the same hash between our SELECT and INSERT.
    if (insert.error.code === '23505') {
      const reread = await sb
        .from('commitments')
        .select('commitment_hash, status, risk_amount, filled_risk_amount, expiry, source, network')
        .eq('network', config.network)
        .eq('commitment_hash', commitmentHash)
        .maybeSingle();
      if (!reread.error && reread.data) {
        res.status(200).json(rowToBody(reread.data as CommitmentRow));
        return;
      }
    }
    logger.error({ err: insert.error.message, code: insert.error.code }, 'commitments: insert failed');
    res.status(500).json({ error: 'Failed to store commitment.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  res.status(201).json(rowToBody(insert.data as CommitmentRow));
}
