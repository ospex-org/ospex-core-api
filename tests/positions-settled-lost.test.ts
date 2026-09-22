/** Real helper + public handlers against synthetic, offline relational inputs. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { ADDRESS, positionTables, scaleTables, STAMP } from './helpers/positionTables.js';

const db = vi.hoisted(() => ({ getSupabase: vi.fn() }));
vi.mock('../src/lib/supabase.js', () => db);
vi.mock('../src/lib/env.js', () => ({ loadConfig: () => ({ network: 'polygon', chainId: 137 }) }));
vi.mock('../src/lib/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }, formatError: String }));

/**
 * `#79`'s chain term, stubbed at the module boundary. The `eth_call` itself, and
 * every bound on it, are covered against a real socket in `tests/voidCooldown.test.ts`
 * (`3i-install`: this file drives the CALL SITE and the serialization).
 */
const cooldown = vi.hoisted(() => ({
  readVoidCooldownSeconds: vi.fn<() => Promise<number | null>>(async () => null),
  DEFAULT_COOLDOWN_TIMEOUT_MS: 2_500,
}));
vi.mock('../src/lib/voidCooldown.js', () => cooldown);

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

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears CALLS, not implementations, so a `mockResolvedValue`
  // set by one case would leak into every later one and the block below would
  // pass only because of where it sits in the file. Each case states its own world.
  cooldown.readVoidCooldownSeconds.mockResolvedValue(null);
});

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

  it('reports an open void as settlement work, with no settled loss, no payout and no claim plan', async () => {
    // This case used to assert that an open void produced NO settlement
    // candidate, under a name saying that behaviour was preserved on purpose. It
    // was the defect in ospex-core-api#77 wearing a passing test's clothes, and
    // it is the reason no later sweep looked at it. The three properties it was
    // genuinely protecting are kept below; the candidate expectation is flipped.
    const tables = scaleTables(1);
    tables.contests[0]!.contest_status = 'voided';
    db.getSupabase.mockReturnValue(positionTables(tables));
    const body = await invoke();
    // Not a settled loss: the speculation is still open, and a void loses nobody.
    expect(body.settledLost).toEqual([]);
    // Actionable work, which is the fix.
    expect(body.settlementCandidates).toMatchObject([{ speculationId: '1', positionType: 0 }]);
    // Still in `active`, so the row does not vanish from the own-state snapshot.
    expect(body.active).toMatchObject([{ speculationId: '1' }]);
    // And still not payable: no payout bucket, no money in totals, no claim plan.
    // That bound is deliberate and documented — serving the refund amount needs a
    // coordinated ospex-sdk release, see docs/positions-complete-enumeration.md.
    for (const bucket of ['pendingSettle', 'claimable']) expect(body[bucket]).toEqual([]);
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


/**
 * `#79`'s diagnostic has to be on the WIRE, not just in the helper's return value.
 *
 * PR #92's second blocker: `voidCooldownSeconds` was added to `CategorizedPositions`,
 * documented in the README and in `docs/positions-complete-enumeration.md` as a
 * served number-or-null, and never threaded through `StatusResponse` or the
 * serialized body. Every test asserted it off the HELPER, so nothing noticed - rule
 * 2, probe the artifact and not the function. These read the HTTP body.
 *
 * Key PRESENCE is asserted separately from the value, because reading a missing key
 * and reading an explicit `null` both yield `undefined`/`null`-ish in a loose check.
 * Only an `in` test tells them apart, and "the key is absent" was exactly the defect.
 */
describe('#79 voidCooldownSeconds reaches the public status body', () => {
  it('carries the key with a null when the term was not applied', async () => {
    db.getSupabase.mockReturnValue(positionTables(scaleTables(1)));
    const body = await invoke();
    expect('voidCooldownSeconds' in body).toBe(true);
    expect(body['voidCooldownSeconds']).toBeNull();
  });

  it('carries the key on an EMPTY wallet too', async () => {
    // The empty-wallet path returns from its own early exit, so it is a SECOND
    // serialization site and a separate property (`3d-sibling`).
    db.getSupabase.mockReturnValue(positionTables(scaleTables(0)));
    const body = await invoke();
    expect('voidCooldownSeconds' in body).toBe(true);
    expect(body['voidCooldownSeconds']).toBeNull();
  });

  it('carries the NUMBER when the cooldown was read', async () => {
    cooldown.readVoidCooldownSeconds.mockResolvedValue(604_800);
    const tables = scaleTables(1);
    // A `verified` contest has to be in scope or the term is never read - that gate
    // is what keeps a wallet with nothing verified from spending an RPC request.
    Object.assign(tables.contests[0]!, {
      contest_status: 'verified',
      away_score: null,
      home_score: null,
      start_time: '2026-08-01T12:00:00+00:00',
    });
    db.getSupabase.mockReturnValue(positionTables(tables));
    const body = await invoke();
    expect(body['voidCooldownSeconds']).toBe(604_800);
  });

  it('never reads the term when no contest is verified', async () => {
    // The cost property, asserted on the CALL rather than on the answer: a fixture
    // with only a scored contest must not touch the provider at all.
    cooldown.readVoidCooldownSeconds.mockResolvedValue(604_800);
    db.getSupabase.mockReturnValue(positionTables(scaleTables(1)));
    const body = await invoke();
    expect(cooldown.readVoidCooldownSeconds).not.toHaveBeenCalled();
    expect(body['voidCooldownSeconds']).toBeNull();
  });

  it('is absent from claim-params, which stays payable-only', async () => {
    // The negative control on the field's SCOPE: a diagnostic about settlement work
    // does not belong on a claim plan, and putting it there would be a wire change
    // nobody asked for.
    cooldown.readVoidCooldownSeconds.mockResolvedValue(604_800);
    db.getSupabase.mockReturnValue(positionTables(scaleTables(1)));
    const body = await invoke(getClaimParamsHandler);
    expect('voidCooldownSeconds' in body).toBe(false);
  });
});
