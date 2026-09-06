/** Real helper + public handlers against synthetic, offline relational inputs. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { ADDRESS, positionTables, scaleTables, STAMP } from './helpers/positionTables.js';

const db = vi.hoisted(() => ({ getSupabase: vi.fn() }));
vi.mock('../src/lib/supabase.js', () => db);
vi.mock('../src/lib/env.js', () => ({ loadConfig: () => ({ network: 'polygon', chainId: 137 }) }));
vi.mock('../src/lib/logger.js', () => ({ logger: { error: vi.fn() }, formatError: String }));

const { getPositionStatusHandler, getClaimParamsHandler } = await import('../src/v1/positions.js');

async function invoke(handler = getPositionStatusHandler) {
  const res = {
    statusCode: 0, body: {} as Record<string, unknown>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; return this; },
  };
  await handler({ params: { address: ADDRESS } } as unknown as Request, res as unknown as Response);
  expect(res.statusCode).toBe(200);
  return res.body;
}

const ZERO_TOTALS = {
  activeCount: 0, pendingSettleCount: 0, claimableCount: 0,
  estimatedPayoutUSDC: 0, estimatedPayoutWei6: '0',
  pendingSettlePayoutUSDC: 0, pendingSettlePayoutWei6: '0',
};
const ACTION_BUCKETS = ['active', 'settlementCandidates', 'pendingSettle', 'claimable'] as const;

beforeEach(() => vi.clearAllMocks());

describe('public settledLost terminal identity, never exposure or payout', () => {
  it.each([
    ['upper', 0, 'home', 'moneyline'], ['lower', 1, 'away', 'moneyline'],
    ['upper', 0, 'under', 'total'], ['lower', 1, 'over', 'total'],
  ] as const)('returns closed %s loss on %s / %s / %s as full PositionBase plus result only', async (side, positionType, winSide, market) => {
    const tables = scaleTables(1);
    tables.positions[0]!.position_type = side;
    Object.assign(tables.speculations[0]!, { speculation_status: 'closed', win_side: winSide, market_type: market });
    // Closed outcome is authoritative even without scores to predict from.
    tables.contests[0]!.away_score = null;
    tables.contests[0]!.home_score = null;
    db.getSupabase.mockReturnValue(positionTables(tables));
    const body = await invoke();
    expect(body.settledLost).toEqual([{
      positionId: `1_${ADDRESS}_${positionType}`, speculationId: '1', contestId: '1', positionType,
      team: positionType === 0 ? 'Away' : 'Home', opponent: positionType === 0 ? 'Home' : 'Away',
      market, oddsDecimal: 2.5, riskAmountUSDC: 0.01, profitAmountUSDC: 0.015,
      sport: 'mlb', awayTeam: 'Away', homeTeam: 'Home',
      riskAmountWei6: '10000', counterpartyRiskWei6: '15000',
      updatedAtUnixSec: Math.floor(Date.parse(STAMP) / 1000), result: 'lost',
    }]);
    for (const bucket of ACTION_BUCKETS) expect(body[bucket]).toEqual([]);
    expect(body.totals).toEqual(ZERO_TOTALS);
    expect(body.enumeration).toEqual({ complete: true, pageSize: 199, pages: 1, positionCount: 1 });
    expect(await invoke(getClaimParamsHandler)).toEqual({ address: ADDRESS, positions: [] });
    expect(tables.positions[0]).toMatchObject({ claimed: false, risk_amount: '10000', profit_amount: '15000' });
  });

  it.each([0, 1, 199, 200, 398, 450])('reconciles %i terminal-only raw rows, including empty and exact page boundaries', async (count) => {
    const tables = scaleTables(count);
    for (const spec of tables.speculations) Object.assign(spec, { speculation_status: 'closed', win_side: 'home' });
    const sb = positionTables(tables);
    db.getSupabase.mockReturnValue(sb);
    const body = await invoke();
    expect(body.settledLost).toHaveLength(count);
    const lost = body.settledLost as Array<{ positionId: string; speculationId: string }>;
    expect(new Set(lost.map((p) => p.positionId)).size).toBe(count);
    expect(lost.map((p) => p.speculationId)).toEqual(Array.from({ length: count }, (_, i) => String(count - i)));
    for (const bucket of ACTION_BUCKETS) expect(body[bucket]).toEqual([]);
    expect(body.totals).toEqual(ZERO_TOTALS);
    expect(body.enumeration).toEqual({ complete: true, pageSize: 199, pages: Math.floor(count / 199) + 1, positionCount: count });
    expect(sb.queries.filter((q) => q.table === 'positions')).toHaveLength(Math.floor(count / 199) + 1);
    for (const q of sb.queries) {
      expect(q.limit).toBe(199);
      for (const [, ids] of q.joins) expect(ids.length).toBeLessThanOrEqual(199);
    }
    if (count === 0) expect(sb.queries).toHaveLength(1); // no empty joins
    expect(await invoke(getClaimParamsHandler)).toEqual({ address: ADDRESS, positions: [] });
  });

  it.each([
    ['upper', 'away', 'won', '25000'], ['lower', 'home', 'won', '25000'],
    ['upper', 'over', 'won', '25000'], ['lower', 'under', 'won', '25000'],
    ['upper', 'push', 'push', '10000'], ['lower', 'push', 'push', '10000'],
    ['upper', 'void', 'void', '10000'], ['lower', 'void', 'void', '10000'],
  ] as const)('keeps closed %s / %s payable as %s with payout %s', async (side, winSide, result, payout) => {
    const tables = scaleTables(1);
    tables.positions[0]!.position_type = side;
    Object.assign(tables.speculations[0]!, { speculation_status: 'closed', win_side: winSide });
    if (winSide === 'over' || winSide === 'under') tables.speculations[0]!.market_type = 'total';
    if (winSide === 'void') tables.contests[0]!.contest_status = 'voided';
    db.getSupabase.mockReturnValue(positionTables(tables));
    const body = await invoke();
    expect(body.settledLost).toEqual([]);
    expect(body.claimable).toMatchObject([{ speculationId: '1', result, estimatedPayoutWei6: payout }]);
    expect(body.totals).toEqual({ ...ZERO_TOTALS, claimableCount: 1, estimatedPayoutUSDC: Number(payout) / 1e6, estimatedPayoutWei6: payout });
    const params = await invoke(getClaimParamsHandler);
    expect(params.positions).toMatchObject([{
      speculationId: '1', bucket: 'claimable', result, estimatedPayoutWei6: payout,
      txParams: [{ method: 'claimPosition', target: 'PositionModule', args: { speculationId: '1', positionType: side === 'upper' ? 0 : 1 } }],
    }]);
  });

  it.each(['upper', 'lower'] as const)('keeps open predicted %s losers actionable until actually settled', async (side) => {
    const tables = scaleTables(1);
    tables.positions[0]!.position_type = side;
    if (side === 'upper') tables.contests[0]!.home_score = 8;
    db.getSupabase.mockReturnValue(positionTables(tables));
    const open = await invoke();
    expect(open.settledLost).toEqual([]);
    expect(open.settlementCandidates).toMatchObject([{ speculationId: '1', positionType: side === 'upper' ? 0 : 1 }]);
    for (const bucket of ['active', 'pendingSettle', 'claimable']) expect(open[bucket]).toEqual([]);
    expect(open.totals).toEqual(ZERO_TOTALS);
    expect(await invoke(getClaimParamsHandler)).toEqual({ address: ADDRESS, positions: [] });
    Object.assign(tables.speculations[0]!, { speculation_status: 'closed', win_side: side === 'upper' ? 'home' : 'away' });
    const closed = await invoke();
    expect(closed.settledLost).toEqual((open.settlementCandidates as object[]).map((p) => ({ ...p, result: 'lost' })));
    for (const bucket of ACTION_BUCKETS) expect(closed[bucket]).toEqual([]);
    expect(closed.enumeration).toEqual(open.enumeration);
    expect(closed.totals).toEqual(ZERO_TOTALS);
    expect(await invoke(getClaimParamsHandler)).toEqual({ address: ADDRESS, positions: [] });
  });

  it('preserves open-void behavior (still active, no settlement/claim plan)', async () => {
    const tables = scaleTables(1);
    tables.contests[0]!.contest_status = 'voided';
    db.getSupabase.mockReturnValue(positionTables(tables));
    const body = await invoke();
    expect(body.settledLost).toEqual([]);
    expect(body.active).toMatchObject([{ speculationId: '1' }]);
    for (const bucket of ['settlementCandidates', 'pendingSettle', 'claimable']) expect(body[bucket]).toEqual([]);
    expect(body.totals).toEqual({ ...ZERO_TOTALS, activeCount: 1 });
    expect(await invoke(getClaimParamsHandler)).toEqual({ address: ADDRESS, positions: [] });
  });

  it('does not invent a settled loss for closed/tbd or reduce raw count to force completeness', async () => {
    const tables = scaleTables(1);
    tables.speculations[0]!.speculation_status = 'closed';
    db.getSupabase.mockReturnValue(positionTables(tables));
    const body = await invoke();
    expect(body.settledLost).toEqual([]);
    for (const bucket of ACTION_BUCKETS) expect(body[bucket]).toEqual([]);
    // An inconsistent upstream outcome remains visible as a raw/union mismatch.
    expect(body.enumeration).toEqual({ complete: true, pageSize: 199, pages: 1, positionCount: 1 });
    expect(body.totals).toEqual(ZERO_TOTALS);
    expect(await invoke(getClaimParamsHandler)).toEqual({ address: ADDRESS, positions: [] });
  });
});
