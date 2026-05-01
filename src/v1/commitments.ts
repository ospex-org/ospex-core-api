/**
 * /v1/commitments — write + read for the EIP-712 commitment relay.
 *
 *   POST   /v1/commitments        — accept a signed OspexCommitment and persist it.
 *                                   Idempotent on commitment_hash; if an indexer-only
 *                                   row exists, enrich it. Returns the canonical
 *                                   commitment body.
 *
 *   GET    /v1/commitments        — list commitments with filters (maker,
 *                                   contestId, scorer, status) and pagination
 *                                   (limit, offset). Sorted by
 *                                   `created_at DESC, commitment_hash ASC` —
 *                                   newest first; tie-break on hash so
 *                                   offset-based pagination is deterministic
 *                                   across ties (rows backfilled by indexer
 *                                   migration 039 share a timestamp).
 *
 *   DELETE /v1/commitments/:hash  — off-chain cancel via signed CancelCommitment
 *                                   action. Sets `status='cancelled'` so the row
 *                                   stops surfacing in the open book. Authoritative
 *                                   cancel is still on-chain (cancelCommitment /
 *                                   raiseMinNonce); see docs/CANCEL_FLOW.md.
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
  createdAt: string;              // ISO 8601 — filled by DB default `now()`
}

const COMMITMENT_COLUMNS =
  'commitment_hash, maker, contest_id, scorer, line_ticks, position_type, ' +
  'odds_tick, market_type, risk_amount, filled_risk_amount, nonce, expiry, ' +
  'speculation_key, signature, status, source, network, nonce_invalidated, ' +
  'created_at';

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
  created_at: string;
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
    createdAt: row.created_at,
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

function parseBoolQuery(value: unknown): boolean | null {
  if (value === undefined) return false;
  const s = String(value).toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return null;
}

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

  // Status: comma-separated list. Default `open,partially_filled` because
  // both are still-fillable liquidity (a partially_filled commitment has
  // remaining_risk_amount > 0 and can be matched again). The previous
  // single-value default of `open` silently hid valid takeable orders.
  let statuses: string[];
  if (req.query.status !== undefined) {
    const raw = String(req.query.status).toLowerCase();
    statuses = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (statuses.length === 0) {
      res.status(400).json({
        error: 'status must be a non-empty comma-separated list.',
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
    for (const s of statuses) {
      if (!VALID_STATUSES.has(s)) {
        res.status(400).json({
          error: `Invalid status "${s}". Must be one of: ${[...VALID_STATUSES].join(', ')}.`,
          code: 'INVALID_PARAM',
        } satisfies ApiError);
        return;
      }
    }
  } else {
    statuses = ['open', 'partially_filled'];
  }

  // Boolean opt-outs for the default "matchable open book" filters.
  // Defaults exclude nonce-invalidated rows (the contract will reject
  // matchCommitment) and expired rows. Power users can opt back in.
  const includeInvalidated = parseBoolQuery(req.query.includeInvalidated);
  if (req.query.includeInvalidated !== undefined && includeInvalidated === null) {
    res.status(400).json({
      error: 'includeInvalidated must be true|false|1|0.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  const includeExpired = parseBoolQuery(req.query.includeExpired);
  if (req.query.includeExpired !== undefined && includeExpired === null) {
    res.status(400).json({
      error: 'includeExpired must be true|false|1|0.',
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
    .in('status', statuses);

  if (maker !== undefined) q = q.eq('maker', maker);
  if (scorer !== undefined) q = q.eq('scorer', scorer);
  if (contestId !== undefined) q = q.eq('contest_id', contestId);
  if (!includeInvalidated) q = q.eq('nonce_invalidated', false);
  if (!includeExpired) {
    // Postgres `>` returns false (not true, not null) for NULL operands,
    // so this naturally excludes rows with NULL expiry. That's the right
    // behavior here: NULL expiry only appears on indexer-cancel-only rows
    // (per migration 028), which already have status='cancelled' and
    // wouldn't pass the default status filter anyway.
    q = q.gt('expiry', new Date().toISOString());
  }

  q = q
    .order('created_at', { ascending: false })
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

// ────────────────────────────────────────────────────────────────────────
// DELETE /v1/commitments/:hash
// ────────────────────────────────────────────────────────────────────────

/**
 * Off-chain cancel. The maker signs a CancelCommitment action; we mark
 * the row as `cancelled` so it stops appearing in the open book. The
 * authoritative cancel is on-chain — once the indexer projects the
 * COMMITMENT_CANCELLED event, the row's `status` already lands on
 * `cancelled`, so this endpoint and the indexer converge on the same
 * terminal state.
 *
 * Race notes (see docs/CANCEL_FLOW.md):
 *   - Off-chain DELETE then on-chain cancel: both write `status='cancelled'`.
 *     Idempotent.
 *   - On-chain cancel then off-chain DELETE: handler sees `status='cancelled'`
 *     and returns 200 idempotent.
 *   - Off-chain DELETE while a taker has an in-flight matchCommitment tx:
 *     contract is the source of truth — if the on-chain match lands first,
 *     status flips to `partially_filled` / `filled`, and DELETE returns 409.
 */
export async function deleteCommitmentHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  const config = loadConfig();
  const sb = getSupabase();

  // ── Validate the URL :hash matches the signed action ─────────────────
  const urlHash = String(req.params['hash'] ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(urlHash)) {
    res.status(400).json({
      error: 'Path :hash must be a 0x-prefixed 32-byte hex string.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  const signedHash = String(req.actionMessage['commitmentHash']).toLowerCase();
  if (signedHash !== urlHash) {
    res.status(400).json({
      error: 'Signed commitmentHash does not match the URL :hash. Re-sign with the correct hash.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  // ── Lookup ────────────────────────────────────────────────────────────
  const lookup = await sb
    .from('commitments')
    .select(COMMITMENT_COLUMNS)
    .eq('network', config.network)
    .eq('commitment_hash', urlHash)
    .maybeSingle();

  if (lookup.error) {
    logger.error({ err: lookup.error.message }, 'commitments: cancel lookup failed');
    res.status(500).json({ error: 'Failed to look up commitment.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  if (!lookup.data) {
    res.status(404).json({
      error: 'Commitment not found.',
      code: 'NOT_FOUND',
    } satisfies ApiError);
    return;
  }
  const row = lookup.data as unknown as CommitmentRow;

  // ── Authorization: signer must equal the row's maker ─────────────────
  // The middleware already verified the signature; the recovered address
  // is the only authoritative claim of identity. Since CancelCommitment
  // doesn't carry maker in the typed data, we compare here.
  if (req.authenticatedWallet.toLowerCase() !== row.maker.toLowerCase()) {
    logger.warn(
      { recovered: req.authenticatedWallet, rowMaker: row.maker, commitmentHash: urlHash },
      'commitments: cancel signer does not match commitment maker',
    );
    res.status(403).json({
      error: 'Signature does not match the commitment maker.',
      code: 'FORBIDDEN',
    } satisfies ApiError);
    return;
  }

  // ── Status branching ──────────────────────────────────────────────────
  // Already cancelled → idempotent 200 with current row.
  if (row.status === 'cancelled') {
    res.status(200).json(rowToBody(row));
    return;
  }
  // Matched (filled or partially_filled) → on-chain only.
  if (row.status === 'filled' || row.status === 'partially_filled') {
    res.status(409).json({
      error: `Commitment is ${row.status}; off-chain cancel is not allowed once a match exists. Use MatchingModule.cancelCommitment(c) on chain.`,
      code: 'COMMITMENT_MATCHED',
    } satisfies ApiError);
    return;
  }
  // Anything other than `open` at this point is an unexpected state.
  if (row.status !== 'open') {
    logger.warn(
      { commitmentHash: urlHash, status: row.status },
      'commitments: cancel hit an unexpected status',
    );
    res.status(409).json({
      error: `Commitment is in an unexpected state (${row.status}) and cannot be cancelled.`,
      code: 'INVALID_STATE',
    } satisfies ApiError);
    return;
  }

  // ── Mark cancelled ────────────────────────────────────────────────────
  // `cancelled_at` column is not yet in the schema (see step5b flag).
  // When the migration adds it, this UPDATE should also set
  // `cancelled_at: new Date().toISOString()`.
  const update = await sb
    .from('commitments')
    .update({ status: 'cancelled' })
    .eq('network', config.network)
    .eq('commitment_hash', urlHash)
    .eq('status', 'open') // CAS guard against race with indexer match
    .select(COMMITMENT_COLUMNS)
    .maybeSingle();

  if (update.error) {
    logger.error({ err: update.error.message }, 'commitments: cancel update failed');
    res.status(500).json({ error: 'Failed to cancel commitment.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  if (!update.data) {
    // CAS lost — between lookup and update the row stopped being `open`.
    // Re-read and respond based on the new state.
    const reread = await sb
      .from('commitments')
      .select(COMMITMENT_COLUMNS)
      .eq('network', config.network)
      .eq('commitment_hash', urlHash)
      .maybeSingle();
    if (reread.error || !reread.data) {
      res.status(500).json({ error: 'Failed to cancel commitment.', code: 'INTERNAL_ERROR' } satisfies ApiError);
      return;
    }
    const fresh = reread.data as unknown as CommitmentRow;
    if (fresh.status === 'cancelled') {
      res.status(200).json(rowToBody(fresh));
      return;
    }
    res.status(409).json({
      error: `Commitment status changed to ${fresh.status} during cancel; off-chain cancel is no longer applicable.`,
      code: 'COMMITMENT_MATCHED',
    } satisfies ApiError);
    return;
  }

  logger.info({ commitmentHash: urlHash, maker: row.maker }, 'commitments: off-chain cancel applied');
  res.status(200).json(rowToBody(update.data as unknown as CommitmentRow));
}
