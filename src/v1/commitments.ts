/**
 * /v1/commitments — write + read for the EIP-712 commitment relay.
 *
 *   POST /v1/commitments  — accept a signed OspexCommitment and persist it.
 *                           Idempotent on commitment_hash; if an indexer-only
 *                           row exists, enrich it. Returns the canonical
 *                           commitment body.
 *
 *   GET  /v1/commitments  — list open commitments. Supports filters
 *                           (maker, contestId, scorer, status) and
 *                           pagination (limit, offset). Sorted by
 *                           `expiry ASC, commitment_hash ASC`.
 *
 *   The default sort would normally be `created_at DESC`, but the
 *   commitments table has no created_at column today (only the indexer's
 *   migrations are visible to this repo, and those don't add one).
 *   `expiry ASC` is the next most useful temporal axis: closest-to-
 *   expiring commitments are the most urgent for takers to fill, and
 *   for makers to monitor or replace. Tie-break on `commitment_hash`
 *   so offset-based pagination is deterministic across ties.
 */

import type { Request, Response } from 'express';
import { isAddress } from 'ethers';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import { deriveSpeculationKey } from '../lib/eip712.js';
import { scorerToType, type MarketType } from '../lib/speculation.js';
import type { AuthenticatedRequest } from '../middleware/eip712Auth.js';
import type { ApiError } from '../middleware/errorHandler.js';

// ────────────────────────────────────────────────────────────────────────
// Canonical commitment body
//
// Same shape used by POST and GET responses so consumers don't have to
// branch on which endpoint produced a row. snake_case columns from
// Supabase are normalized to camelCase here.
// ────────────────────────────────────────────────────────────────────────

interface CommitmentBody {
  commitmentHash: string;
  maker: string;
  contestId: string | null;
  scorer: string | null;
  lineTicks: number | null;
  positionType: 0 | 1 | null;     // 0 = upper (away/over), 1 = lower (home/under)
  oddsTick: number | null;
  marketType: MarketType | null;
  riskAmount: string;             // uint256 as string
  filledRiskAmount: string;
  remainingRiskAmount: string;    // computed: max(0, risk - filled)
  nonce: string;
  expiry: string | null;
  speculationKey: string | null;
  signature: string | null;
  status: string;
  source: string;
  network: string;
  nonceInvalidated: boolean;
}

const COMMITMENT_COLUMNS =
  'commitment_hash, maker, contest_id, scorer, line_ticks, position_type, ' +
  'odds_tick, market_type, risk_amount, filled_risk_amount, nonce, expiry, ' +
  'speculation_key, signature, status, source, network, nonce_invalidated';

interface CommitmentRow {
  commitment_hash: string;
  maker: string;
  contest_id: string | number | null;
  scorer: string | null;
  line_ticks: number | null;
  position_type: 'upper' | 'lower' | null;
  odds_tick: number | null;
  market_type: MarketType | null;
  risk_amount: string | number | null;
  filled_risk_amount: string | number | null;
  nonce: string | number | null;
  expiry: string | null;
  speculation_key: string | null;
  signature: string | null;
  status: string;
  source: string;
  network: string;
  nonce_invalidated: boolean | null;
}

const POSITION_TYPE_TO_INT: Record<'upper' | 'lower', 0 | 1> = { upper: 0, lower: 1 };

function rowToBody(row: CommitmentRow): CommitmentBody {
  const risk = row.risk_amount != null ? BigInt(String(row.risk_amount)) : 0n;
  const filled = row.filled_risk_amount != null ? BigInt(String(row.filled_risk_amount)) : 0n;
  const remaining = risk > filled ? risk - filled : 0n;
  return {
    commitmentHash: row.commitment_hash,
    maker: row.maker,
    contestId: row.contest_id != null ? String(row.contest_id) : null,
    scorer: row.scorer,
    lineTicks: row.line_ticks,
    positionType: row.position_type ? POSITION_TYPE_TO_INT[row.position_type] : null,
    oddsTick: row.odds_tick,
    marketType: row.market_type,
    riskAmount: risk.toString(),
    filledRiskAmount: filled.toString(),
    remainingRiskAmount: remaining.toString(),
    nonce: row.nonce != null ? String(row.nonce) : '0',
    expiry: row.expiry,
    speculationKey: row.speculation_key,
    signature: row.signature,
    status: row.status,
    source: row.source,
    network: row.network,
    nonceInvalidated: Boolean(row.nonce_invalidated),
  };
}

// ────────────────────────────────────────────────────────────────────────
// POST /v1/commitments
// ────────────────────────────────────────────────────────────────────────

const POSITION_TYPE_LABEL: Record<number, 'upper' | 'lower'> = { 0: 'upper', 1: 'lower' };

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

  // Idempotency / enrichment lookup. Gate enrichment on `!signature` only
  // (provenance preserved — see review feedback comments in PR #2).
  const existing = await sb
    .from('commitments')
    .select(COMMITMENT_COLUMNS)
    .eq('network', config.network)
    .eq('commitment_hash', commitmentHash)
    .maybeSingle();

  if (existing.error) {
    logger.error({ err: existing.error.message }, 'commitments: idempotency lookup failed');
    res.status(500).json({ error: 'Failed to check for existing commitment.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  if (existing.data) {
    const existingRow = existing.data as unknown as CommitmentRow;
    if (!existingRow.signature) {
      const enriched = await sb
        .from('commitments')
        .update({
          signature,
          risk_amount: riskAmount.toString(),
          nonce: nonce.toString(),
          expiry: expiryISO,
          speculation_key: speculationKey,
        })
        .eq('network', config.network)
        .eq('commitment_hash', commitmentHash)
        .select(COMMITMENT_COLUMNS)
        .single();
      if (enriched.error) {
        logger.error({ err: enriched.error.message }, 'commitments: enrichment update failed');
        res.status(500).json({ error: 'Failed to enrich existing commitment.', code: 'INTERNAL_ERROR' } satisfies ApiError);
        return;
      }
      logger.info(
        { commitmentHash, priorSource: existingRow.source },
        'commitments: enriched signature-less row',
      );
      res.status(200).json(rowToBody(enriched.data as unknown as CommitmentRow));
      return;
    }
    res.status(200).json(rowToBody(existingRow));
    return;
  }

  // Nonce-floor pre-check. The contract rejects matchCommitment with
  // NonceTooLow if nonce < s_minNonces[maker][specKey]. Without this
  // pre-check the API would accept commitments no taker can fill.
  const floor = await sb
    .from('maker_nonce_floors')
    .select('min_nonce')
    .eq('network', config.network)
    .eq('maker', maker)
    .eq('speculation_key', speculationKey)
    .maybeSingle();

  if (floor.error) {
    logger.error({ err: floor.error.message }, 'commitments: nonce floor lookup failed');
    res.status(500).json({ error: 'Failed to check nonce floor.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  if (floor.data) {
    const minNonce = BigInt(String(floor.data.min_nonce));
    if (nonce < minNonce) {
      res.status(400).json({
        error: `Commitment nonce (${nonce.toString()}) is below the maker's current nonce floor (${minNonce.toString()}). Read maker_nonce_floors before signing.`,
        code: 'NONCE_TOO_LOW',
      } satisfies ApiError);
      return;
    }
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
    .select(COMMITMENT_COLUMNS)
    .single();

  if (insert.error) {
    if (insert.error.code === '23505') {
      const reread = await sb
        .from('commitments')
        .select(COMMITMENT_COLUMNS)
        .eq('network', config.network)
        .eq('commitment_hash', commitmentHash)
        .maybeSingle();
      if (!reread.error && reread.data) {
        res.status(200).json(rowToBody(reread.data as unknown as CommitmentRow));
        return;
      }
    }
    logger.error({ err: insert.error.message, code: insert.error.code }, 'commitments: insert failed');
    res.status(500).json({ error: 'Failed to store commitment.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  res.status(201).json(rowToBody(insert.data as unknown as CommitmentRow));
}

// ────────────────────────────────────────────────────────────────────────
// GET /v1/commitments
// ────────────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const VALID_STATUSES = new Set(['open', 'partially_filled', 'filled', 'cancelled']);

interface ListResponse {
  commitments: CommitmentBody[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
  };
}

export async function getCommitmentsHandler(req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  const sb = getSupabase();

  // ── Parse + validate query params ─────────────────────────────────────
  const limitRaw = req.query.limit ? Number(req.query.limit) : DEFAULT_LIMIT;
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
    res.status(400).json({
      error: `limit must be an integer between 1 and ${MAX_LIMIT}.`,
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  const offsetRaw = req.query.offset ? Number(req.query.offset) : 0;
  if (!Number.isInteger(offsetRaw) || offsetRaw < 0) {
    res.status(400).json({
      error: 'offset must be a non-negative integer.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const status = req.query.status ? String(req.query.status).toLowerCase() : 'open';
  if (!VALID_STATUSES.has(status)) {
    res.status(400).json({
      error: `Invalid status "${status}". Must be one of: ${[...VALID_STATUSES].join(', ')}.`,
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  // Lowercase first so mixed-case input passes (see positions.ts comment).
  let maker: string | undefined;
  if (req.query.maker !== undefined) {
    const lowered = String(req.query.maker).trim().toLowerCase();
    if (!isAddress(lowered)) {
      res.status(400).json({
        error: 'maker must be a valid Ethereum address.',
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
    maker = lowered;
  }

  let scorer: string | undefined;
  if (req.query.scorer !== undefined) {
    const lowered = String(req.query.scorer).trim().toLowerCase();
    if (!isAddress(lowered)) {
      res.status(400).json({
        error: 'scorer must be a valid Ethereum address.',
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
    scorer = lowered;
  }

  let contestId: string | undefined;
  if (req.query.contestId !== undefined) {
    try {
      const v = BigInt(String(req.query.contestId));
      if (v < 0n) throw new Error();
      contestId = v.toString();
    } catch {
      res.status(400).json({
        error: 'contestId must be a non-negative integer.',
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
  }

  // ── Build query ───────────────────────────────────────────────────────
  let q = sb
    .from('commitments')
    .select(COMMITMENT_COLUMNS, { count: 'exact' })
    .eq('network', config.network)
    .eq('status', status);

  if (maker !== undefined) q = q.eq('maker', maker);
  if (scorer !== undefined) q = q.eq('scorer', scorer);
  if (contestId !== undefined) q = q.eq('contest_id', contestId);

  q = q
    .order('expiry', { ascending: true, nullsFirst: false })
    .order('commitment_hash', { ascending: true })
    .range(offsetRaw, offsetRaw + limitRaw - 1);

  const { data, count, error } = await q;
  if (error) {
    logger.error({ err: error.message }, 'commitments: list query failed');
    res.status(500).json({ error: 'Failed to list commitments.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const total = count ?? 0;
  const body: ListResponse = {
    commitments: (data ?? []).map((r) => rowToBody(r as unknown as CommitmentRow)),
    pagination: {
      limit: limitRaw,
      offset: offsetRaw,
      total,
      hasMore: offsetRaw + (data?.length ?? 0) < total,
    },
  };
  res.status(200).json(body);
}
