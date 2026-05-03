/**
 * Position read endpoints.
 *
 *   GET /v1/positions/by-tx/:txHash       — parse PositionFilled events
 *                                            from a tx receipt (R4 emits
 *                                            two positions per fill —
 *                                            maker + taker).
 *   GET /v1/positions/claim-result/:txHash — parse PositionClaimed event.
 *   GET /v1/positions/:address/claim-params — txParams for claimable rows
 *   GET /v1/positions/:address/status      — categorized active|claimable
 *   GET /v1/positions/:address             — paginated history (existing).
 *
 * Out of scope (no R4 analog):
 *   - /v1/positions/:address/withdraw-params — R4 has no
 *     `adjustUnmatchedPair`. The "pull back unfilled stake" flow is
 *     `MatchingModule.cancelCommitment(commitment)`, which is
 *     commitment-domain. Consumers can build that call directly from
 *     the existing `GET /v1/commitments?maker=…` response — every
 *     commitment row carries the 9 fields needed.
 *   - /v1/positions/withdraw-result/:txHash — R4 has no
 *     `PositionAdjusted` event.
 */

import type { Request, Response } from 'express';
import { ethers, isAddress } from 'ethers';
import { loadConfig } from '../lib/env.js';
import { logger, formatError } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import { getProvider } from '../lib/rpc.js';
import { wei6ToUSDC } from '../lib/sanitize.js';
import {
  fetchCategorizedPositions,
  positionTypeIntToString,
} from './utils/positionFetch.js';
import type {
  ClaimablePosition,
  PendingSettlePosition,
  PositionBase,
} from './utils/positionFetch.js';
import type { ApiError } from '../middleware/errorHandler.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const TX_HASH_REGEX = /^0x[0-9a-fA-F]{64}$/;
const POSITION_TYPE_TO_INT: Record<'upper' | 'lower', 0 | 1> = { upper: 0, lower: 1 };

// ─── R4 PositionModule event ABIs (human-readable form) ─────────────────
//
// Solidity declares `PositionType` as an enum; in the encoded event ABI
// it appears as `uint8`. ethers parses these fine when the param type is
// `uint8`.
const POSITION_FILLED_ABI = [
  'event PositionFilled(uint256 indexed speculationId, address indexed maker, address indexed taker, uint8 makerPositionType, uint8 takerPositionType, uint256 makerRisk, uint256 takerRisk)',
];
const POSITION_CLAIMED_ABI = [
  'event PositionClaimed(uint256 indexed speculationId, address indexed user, uint8 positionType, uint256 payout)',
];

const positionFilledIface = new ethers.Interface(POSITION_FILLED_ABI);
const positionClaimedIface = new ethers.Interface(POSITION_CLAIMED_ABI);

// ──────────────────────────────────────────────────────────────────────
// GET /v1/positions/:address  (history list — pre-existing)
// ──────────────────────────────────────────────────────────────────────

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
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
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

function parseAddressParam(raw: unknown): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const lower = String(v ?? '').trim().toLowerCase();
  if (!isAddress(lower)) return null;
  return lower;
}

function parseLimitOffset(req: Request, defaultLimit: number, maxLimit: number):
  | { limit: number; offset: number }
  | { errorBody: ApiError } {
  const limit = req.query.limit ? Number(req.query.limit) : defaultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    return { errorBody: { error: `limit must be an integer between 1 and ${maxLimit}.`, code: 'INVALID_PARAM' } };
  }
  const offset = req.query.offset ? Number(req.query.offset) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    return { errorBody: { error: 'offset must be a non-negative integer.', code: 'INVALID_PARAM' } };
  }
  return { limit, offset };
}

export async function getPositionsByAddressHandler(req: Request, res: Response): Promise<void> {
  const address = parseAddressParam(req.params.address);
  if (!address) {
    res.status(400).json({ error: 'Invalid Ethereum address.', code: 'INVALID_PARAM' } satisfies ApiError);
    return;
  }
  const lo = parseLimitOffset(req, DEFAULT_LIMIT, MAX_LIMIT);
  if ('errorBody' in lo) { res.status(400).json(lo.errorBody); return; }

  const config = loadConfig();
  const sb = getSupabase();
  const { data, count, error } = await sb
    .from('positions')
    .select('speculation_id, position_type, risk_amount, profit_amount, claimed, position_created_at', { count: 'exact' })
    .eq('network', config.network)
    .eq('user_address', address)
    .order('position_created_at', { ascending: false, nullsFirst: false })
    .range(lo.offset, lo.offset + lo.limit - 1);

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
    pagination: { limit: lo.limit, offset: lo.offset, total, hasMore: lo.offset + positions.length < total },
  };
  res.status(200).json(body);
}

// ──────────────────────────────────────────────────────────────────────
// GET /v1/positions/:address/status   (categorized active | claimable)
// ──────────────────────────────────────────────────────────────────────

interface StatusResponse {
  address: string;
  active: PositionBase[];
  pendingSettle: PendingSettlePosition[];
  claimable: ClaimablePosition[];
  totals: {
    activeCount: number;
    pendingSettleCount: number;
    claimableCount: number;
    /** Aggregate of `claimable` payouts only (matches the "ready to
     * sweep right now" mental model). Pending-settle entries are
     * predictions that require an extra tx to materialize and are
     * tracked separately below. */
    estimatedPayoutUSDC: number;
    estimatedPayoutWei6: string;
    /** Aggregate of `pendingSettle` predicted payouts. */
    pendingSettlePayoutUSDC: number;
    pendingSettlePayoutWei6: string;
  };
}

export async function getPositionStatusHandler(req: Request, res: Response): Promise<void> {
  const address = parseAddressParam(req.params.address);
  if (!address) {
    res.status(400).json({ error: 'Invalid Ethereum address.', code: 'INVALID_PARAM' } satisfies ApiError);
    return;
  }

  let result;
  try {
    result = await fetchCategorizedPositions(address);
  } catch (err) {
    logger.error({ err: formatError(err) }, 'positions: status fetch failed');
    res.status(500).json({ error: 'Failed to categorize positions.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  // Sum in wei6 (bigint) so sub-cent payouts aggregate without rounding loss.
  let claimablePayoutWei6 = 0n;
  for (const p of result.claimable) claimablePayoutWei6 += BigInt(p.estimatedPayoutWei6);
  let pendingSettlePayoutWei6 = 0n;
  for (const p of result.pendingSettle) pendingSettlePayoutWei6 += BigInt(p.estimatedPayoutWei6);

  const body: StatusResponse = {
    address,
    active: result.active,
    pendingSettle: result.pendingSettle,
    claimable: result.claimable,
    totals: {
      activeCount: result.active.length,
      pendingSettleCount: result.pendingSettle.length,
      claimableCount: result.claimable.length,
      estimatedPayoutUSDC: wei6ToUSDC(claimablePayoutWei6.toString()),
      estimatedPayoutWei6: claimablePayoutWei6.toString(),
      pendingSettlePayoutUSDC: wei6ToUSDC(pendingSettlePayoutWei6.toString()),
      pendingSettlePayoutWei6: pendingSettlePayoutWei6.toString(),
    },
  };
  res.status(200).json(body);
}

// ──────────────────────────────────────────────────────────────────────
// GET /v1/positions/:address/claim-params
// ──────────────────────────────────────────────────────────────────────

/**
 * One step in the on-chain action plan a client must execute to
 * realize a payout. `target` is a stable label the SDK maps to a
 * deployed contract address per chain — the API never returns raw
 * contract addresses here so address rotations don't ripple through
 * every consumer.
 *
 * For M3, two `(target, method)` pairs are emitted:
 *   - SpeculationModule.settleSpeculation(speculationId)
 *   - PositionModule.claimPosition(speculationId, positionType)
 */
type TxStep =
  | {
      method: 'settleSpeculation';
      target: 'SpeculationModule';
      args: { speculationId: string };
    }
  | {
      method: 'claimPosition';
      target: 'PositionModule';
      args: { speculationId: string; positionType: 0 | 1 };
    };

interface ClaimParamEntry {
  positionId: string;
  speculationId: string;
  description: string;
  /**
   * Whether the parent speculation is already settled on-chain
   * (`'claimable'`) or still needs `settleSpeculation` first
   * (`'pendingSettle'`). The bucket label lets clients render
   * different UX without re-deriving from `txParams.length`.
   */
  bucket: 'claimable' | 'pendingSettle';
  /** Predicted result; for pendingSettle this is computed off-chain
   * by replaying the scorer logic against the contest scores. */
  result: 'won' | 'push' | 'void';
  estimatedPayoutUSDC: number;
  estimatedPayoutWei6: string;
  /**
   * Ordered list of on-chain calls to make. The SDK MUST execute these
   * in array order; later steps depend on earlier ones (a `claimPosition`
   * call would revert with `NotSettled` if the preceding
   * `settleSpeculation` hasn't yet landed).
   *
   * `claimable` rows have a single `claimPosition` step.
   * `pendingSettle` rows have two steps: `settleSpeculation` then
   * `claimPosition`.
   */
  txParams: TxStep[];
}

interface ClaimParamsResponse {
  address: string;
  positions: ClaimParamEntry[];
}

const MARKET_LABEL: Record<string, string> = {
  moneyline: 'moneyline',
  spread: 'spread',
  total: 'total',
};

function payoutDisplay(usdc: number): string {
  // Sub-cent payouts round to "$0.00" with toFixed(2) — surface them
  // honestly as "<$0.01" so the description doesn't mislead. The
  // structured fields (estimatedPayoutUSDC, estimatedPayoutWei6) carry
  // full precision regardless.
  return usdc >= 0.01 ? `$${usdc.toFixed(2)}` : '<$0.01';
}

function resultLabel(result: 'won' | 'push' | 'void'): string {
  return result === 'won' ? 'Won' : result === 'push' ? 'Push' : 'Void';
}

export async function getClaimParamsHandler(req: Request, res: Response): Promise<void> {
  const address = parseAddressParam(req.params.address);
  if (!address) {
    res.status(400).json({ error: 'Invalid Ethereum address.', code: 'INVALID_PARAM' } satisfies ApiError);
    return;
  }

  let result;
  try {
    result = await fetchCategorizedPositions(address);
  } catch (err) {
    logger.error({ err: formatError(err) }, 'positions: claim-params fetch failed');
    res.status(500).json({ error: 'Failed to fetch claimable positions.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const claimableEntries: ClaimParamEntry[] = result.claimable.map((p) => ({
    positionId: p.positionId,
    speculationId: p.speculationId,
    description: `${p.team} ${MARKET_LABEL[p.market] ?? p.market} — ${resultLabel(p.result)} (≈ ${payoutDisplay(p.estimatedPayoutUSDC)})`,
    bucket: 'claimable',
    result: p.result,
    estimatedPayoutUSDC: p.estimatedPayoutUSDC,
    estimatedPayoutWei6: p.estimatedPayoutWei6,
    txParams: [
      {
        method: 'claimPosition',
        target: 'PositionModule',
        args: { speculationId: p.speculationId, positionType: p.positionType },
      },
    ],
  }));

  const pendingEntries: ClaimParamEntry[] = result.pendingSettle.map((p) => ({
    positionId: p.positionId,
    speculationId: p.speculationId,
    description: `${p.team} ${MARKET_LABEL[p.market] ?? p.market} — ${resultLabel(p.result)} (≈ ${payoutDisplay(p.estimatedPayoutUSDC)}, needs settle)`,
    bucket: 'pendingSettle',
    result: p.result,
    estimatedPayoutUSDC: p.estimatedPayoutUSDC,
    estimatedPayoutWei6: p.estimatedPayoutWei6,
    txParams: [
      {
        method: 'settleSpeculation',
        target: 'SpeculationModule',
        args: { speculationId: p.speculationId },
      },
      {
        method: 'claimPosition',
        target: 'PositionModule',
        args: { speculationId: p.speculationId, positionType: p.positionType },
      },
    ],
  }));

  // Claimable first — they're a single tx, faster to execute.
  // pendingSettle entries follow.
  const positions: ClaimParamEntry[] = [...claimableEntries, ...pendingEntries];

  const body: ClaimParamsResponse = { address, positions };
  res.status(200).json(body);
}

// ──────────────────────────────────────────────────────────────────────
// GET /v1/positions/by-tx/:txHash   (parse PositionFilled events)
// ──────────────────────────────────────────────────────────────────────

interface FilledEntry {
  positionId: string;
  speculationId: string;
  user: string;
  positionType: 0 | 1;
  role: 'maker' | 'taker';
  riskAmount: string;             // wei6 as string
  riskAmountUSDC: number;
  counterparty: string;
}

interface PositionByTxResponse {
  txHash: string;
  blockNumber: number;
  positions: FilledEntry[];
}

function shouldFilterLog(log: { address: string }, filterAddress: string | undefined): boolean {
  if (!filterAddress) return false;
  return log.address.toLowerCase() !== filterAddress.toLowerCase();
}

function parseTxHash(raw: unknown): string | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const v = String(first ?? '').trim();
  return TX_HASH_REGEX.test(v) ? v : null;
}

export async function getPositionByTxHandler(req: Request, res: Response): Promise<void> {
  const txHash = parseTxHash(req.params.txHash);
  if (!txHash) {
    res.status(400).json({ error: 'Invalid transaction hash format. Expected 0x + 64 hex chars.', code: 'INVALID_PARAM' } satisfies ApiError);
    return;
  }

  let provider;
  try {
    provider = getProvider();
  } catch (err) {
    logger.error({ err: formatError(err) }, 'positions: provider unavailable for by-tx');
    res.status(500).json({ error: 'Server not configured for tx parsing (missing ALCHEMY_RPC_URL).', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const config = loadConfig();
  const filterAddress = config.positionModuleAddress;

  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    logger.error({ err: formatError(err) }, 'positions: receipt fetch failed');
    res.status(502).json({ error: 'Upstream RPC error fetching tx receipt.', code: 'UPSTREAM_ERROR' } satisfies ApiError);
    return;
  }
  if (!receipt) {
    res.status(404).json({ error: 'Transaction not found.', code: 'NOT_FOUND' } satisfies ApiError);
    return;
  }
  if (receipt.status === 0) {
    res.status(400).json({ error: 'Transaction reverted on-chain.', code: 'TX_REVERTED' } satisfies ApiError);
    return;
  }

  const positions: FilledEntry[] = [];
  for (const log of receipt.logs) {
    if (shouldFilterLog(log, filterAddress)) continue;
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = positionFilledIface.parseLog({ topics: log.topics as string[], data: log.data });
    } catch {
      continue;
    }
    if (!parsed || parsed.name !== 'PositionFilled') continue;

    const speculationId = String(parsed.args.speculationId);
    const maker = String(parsed.args.maker).toLowerCase();
    const taker = String(parsed.args.taker).toLowerCase();
    const makerPositionType = Number(parsed.args.makerPositionType) as 0 | 1;
    const takerPositionType = Number(parsed.args.takerPositionType) as 0 | 1;
    const makerRisk = String(parsed.args.makerRisk);
    const takerRisk = String(parsed.args.takerRisk);

    positions.push({
      positionId: `${speculationId}_${maker}_${makerPositionType}`,
      speculationId,
      user: maker,
      positionType: makerPositionType,
      role: 'maker',
      riskAmount: makerRisk,
      riskAmountUSDC: wei6ToUSDC(makerRisk),
      counterparty: taker,
    });
    positions.push({
      positionId: `${speculationId}_${taker}_${takerPositionType}`,
      speculationId,
      user: taker,
      positionType: takerPositionType,
      role: 'taker',
      riskAmount: takerRisk,
      riskAmountUSDC: wei6ToUSDC(takerRisk),
      counterparty: maker,
    });
  }

  if (positions.length === 0) {
    res.status(404).json({ error: 'No PositionFilled event in this transaction.', code: 'NOT_FOUND' } satisfies ApiError);
    return;
  }

  const body: PositionByTxResponse = {
    txHash,
    blockNumber: receipt.blockNumber,
    positions,
  };
  res.status(200).json(body);
}

// ──────────────────────────────────────────────────────────────────────
// GET /v1/positions/claim-result/:txHash   (parse PositionClaimed)
// ──────────────────────────────────────────────────────────────────────

interface ClaimResultResponse {
  txHash: string;
  blockNumber: number;
  speculationId: string;
  user: string;
  positionType: 0 | 1;
  payoutUSDC: number;
  payoutWei6: string;
}

export async function getClaimResultHandler(req: Request, res: Response): Promise<void> {
  const txHash = parseTxHash(req.params.txHash);
  if (!txHash) {
    res.status(400).json({ error: 'Invalid transaction hash format. Expected 0x + 64 hex chars.', code: 'INVALID_PARAM' } satisfies ApiError);
    return;
  }

  let provider;
  try {
    provider = getProvider();
  } catch (err) {
    logger.error({ err: formatError(err) }, 'positions: provider unavailable for claim-result');
    res.status(500).json({ error: 'Server not configured for tx parsing (missing ALCHEMY_RPC_URL).', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const config = loadConfig();
  const filterAddress = config.positionModuleAddress;

  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    logger.error({ err: formatError(err) }, 'positions: receipt fetch failed (claim-result)');
    res.status(502).json({ error: 'Upstream RPC error fetching tx receipt.', code: 'UPSTREAM_ERROR' } satisfies ApiError);
    return;
  }
  if (!receipt) {
    res.status(404).json({ error: 'Transaction not found.', code: 'NOT_FOUND' } satisfies ApiError);
    return;
  }
  if (receipt.status === 0) {
    res.status(400).json({ error: 'Transaction reverted on-chain.', code: 'TX_REVERTED' } satisfies ApiError);
    return;
  }

  for (const log of receipt.logs) {
    if (shouldFilterLog(log, filterAddress)) continue;
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = positionClaimedIface.parseLog({ topics: log.topics as string[], data: log.data });
    } catch {
      continue;
    }
    if (!parsed || parsed.name !== 'PositionClaimed') continue;

    const speculationId = String(parsed.args.speculationId);
    const user = String(parsed.args.user).toLowerCase();
    const positionType = Number(parsed.args.positionType) as 0 | 1;
    const payoutWei6 = String(parsed.args.payout);

    const body: ClaimResultResponse = {
      txHash,
      blockNumber: receipt.blockNumber,
      speculationId,
      user,
      positionType,
      payoutUSDC: wei6ToUSDC(payoutWei6),
      payoutWei6,
    };
    res.status(200).json(body);
    return;
  }

  res.status(404).json({ error: 'No PositionClaimed event in this transaction.', code: 'NOT_FOUND' } satisfies ApiError);
}

// Re-export for any future callers that want the helper directly.
export { positionTypeIntToString };
