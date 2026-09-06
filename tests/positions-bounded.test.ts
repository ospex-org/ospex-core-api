/** Complete-enumeration tests execute the real helper + handlers against an in-memory DB double. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ADDRESS, positionTables, scaleTables, STAMP, type Reply, type Row, type Table, type Tables } from './helpers/positionTables.js';

const db = vi.hoisted(() => ({ getSupabase: vi.fn() }));
vi.mock('../src/lib/supabase.js', () => db);
vi.mock('../src/lib/env.js', () => ({ loadConfig: () => ({ network: 'polygon', chainId: 137 }) }));
vi.mock('../src/lib/logger.js', () => ({ logger: { error: vi.fn() }, formatError: String }));

const { fetchCategorizedPositions } = await import('../src/v1/utils/positionFetch.js');
const { getPositionStatusHandler, getClaimParamsHandler } = await import('../src/v1/positions.js');
const COMPLETE = { complete: true } as const;

function response() {
  const res = { statusCode: 0, body: {} as Record<string, unknown>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; return this; },
  };
  return res;
}
async function invoke(handler: typeof getPositionStatusHandler, address = ADDRESS) {
  const res = response();
  await handler({ params: { address } } as unknown as Request, res as unknown as Response);
  return res;
}

beforeEach(() => vi.clearAllMocks());

describe('bounded complete positions enumeration', () => {
  it('scans 450 raw rows through a settledLost-only first page, tied/null timestamps, and bounded joins', async () => {
    const tables = scaleTables(450);
    // Newest 199 are closed losers: terminal identity, never exposure or payout.
    for (const s of tables.speculations) {
      if (Number(s.speculation_id) >= 252) { s.speculation_status = 'closed'; s.win_side = 'home'; }
    }
    // Next 51 are predicted losers, which MUST remain settlement candidates.
    for (const c of tables.contests) {
      if (Number(c.contest_id) >= 201) c.home_score = 8;
      if (Number(c.contest_id) >= 2 && Number(c.contest_id) < 200) c.contest_status = 'verified';
    }
    tables.speculations[0]!.speculation_status = 'closed';
    tables.speculations[0]!.win_side = 'away';
    tables.positions[198]!.position_created_at = null; // boundary null cannot hide this row
    for (const [id, patch] of [
      [451, { risk_amount: '0' }], [452, { claimed: true }],
      [453, { network: 'base' }], [454, { user_address: '0x0000000000000000000000000000000000000001' }],
    ] as Array<[number, Partial<Row>]>) {
      tables.positions.push({ ...tables.positions[0]!, id, ...patch } as Row);
    }
    // Same IDs on the other network must not contaminate either join.
    tables.speculations.push({ ...tables.speculations[0]!, network: 'base', win_side: 'home' });
    tables.contests.push({ ...tables.contests[199]!, network: 'base', contest_status: 'verified' });
    const sb = positionTables(tables);
    db.getSupabase.mockReturnValue(sb);
    const res = await invoke(getPositionStatusHandler, ADDRESS.toUpperCase().replace('0X', '0x'));
    expect(res.statusCode).toBe(200);
    expect(res.body.enumeration).toEqual({ complete: true, pageSize: 199, pages: 3, positionCount: 450 });
    expect(res.body.active).toHaveLength(198);
    expect(res.body.pendingSettle).toMatchObject([{ speculationId: '200', result: 'won' }]);
    expect(res.body.claimable).toMatchObject([{ speculationId: '1', result: 'won' }]);
    const lost = res.body.settledLost as Array<{ speculationId: string; positionId: string; result: string }>;
    expect(lost).toHaveLength(199);
    expect(lost.map((p) => p.speculationId)).toEqual(Array.from({ length: 199 }, (_, i) => String(450 - i)));
    expect(lost.every((p) => p.result === 'lost')).toBe(true);
    const delivered = ['active', 'pendingSettle', 'claimable', 'settlementCandidates', 'settledLost']
      .flatMap((bucket) => res.body[bucket] as Array<{ positionId: string }>);
    // Candidates overlap pendingSettle: completeness is a union, NOT a sum.
    expect(new Set(delivered.map((p) => p.positionId)).size).toBe(450);
    const candidates = res.body.settlementCandidates as Array<{ speculationId: string }>;
    expect(candidates.map((p) => p.speculationId)).toEqual(Array.from({ length: 52 }, (_, i) => String(251 - i)));
    expect(res.body.totals).toEqual({ activeCount: 198, pendingSettleCount: 1, claimableCount: 1,
      pendingSettlePayoutUSDC: 0.025, pendingSettlePayoutWei6: '25000', estimatedPayoutUSDC: 0.025, estimatedPayoutWei6: '25000' });
    const pages = sb.queries.filter((q) => q.table === 'positions');
    expect(pages.map((q) => q.lt)).toEqual([[], [['id', '252']], [['id', '53']]]);
    for (const q of pages) {
      expect(q.limit).toBe(199);
      expect(q.orders).toEqual([['id', { ascending: false }]]);
      expect(q.select?.split(',').map((s) => s.trim())).toContain('id');
      expect(q.eq).toEqual([['network', 'polygon'], ['user_address', ADDRESS], ['claimed', false]]);
      expect(q.gt).toEqual([['risk_amount', 0]]);
    }
    for (const table of ['speculations', 'contests']) {
      const joins = sb.queries.filter((q) => q.table === table);
      expect(joins.map((q) => q.joins[0]![1].length)).toEqual([199, 199, 52]);
      for (const q of joins) expect(q.eq).toEqual([['network', 'polygon']]);
    }
    // Terminal historical risk never enters either kind of payable plan.
    const params = await invoke(getClaimParamsHandler);
    expect(params.statusCode).toBe(200);
    expect(params.body.positions).toMatchObject([
      { speculationId: '1', bucket: 'claimable', estimatedPayoutWei6: '25000', txParams: [
        { method: 'claimPosition', target: 'PositionModule', args: { speculationId: '1', positionType: 0 } },
      ] },
      { speculationId: '200', bucket: 'pendingSettle', estimatedPayoutWei6: '25000', txParams: [
        { method: 'settleSpeculation', target: 'SpeculationModule', args: { speculationId: '200' } },
        { method: 'claimPosition', target: 'PositionModule', args: { speculationId: '200', positionType: 0 } },
      ] },
    ]);
  });

  it.each([0, 1, 199, 200, 398])('enumerates %i rows; pages counts successful reads including the terminal empty page', async (count) => {
    const sb = positionTables(scaleTables(count));
    db.getSupabase.mockReturnValue(sb);
    const result = await fetchCategorizedPositions(ADDRESS, COMPLETE);
    expect(result.enumeration).toEqual({ complete: true, pageSize: 199, pages: Math.floor(count / 199) + 1, positionCount: count });
    expect(result.hitCap).toBe(false);
    expect(result.pendingSettle).toHaveLength(count);
  });

  it('retains the default own-state 200-row cap and raw hitCap even when all 200 rows are filtered losers', async () => {
    const tables = scaleTables(401);
    for (const c of tables.contests) c.home_score = 9;
    const sb = positionTables(tables);
    db.getSupabase.mockReturnValue(sb);
    const result = await fetchCategorizedPositions(ADDRESS);
    expect(result.hitCap).toBe(true);
    expect(result.enumeration).toBeUndefined();
    expect(result.derivedStatuses).toHaveLength(200);
    expect(sb.queries.filter((q) => q.table === 'speculations')).toHaveLength(1);
    expect(sb.queries.filter((q) => q.table === 'contests')).toHaveLength(1);
    expect(result.pendingSettle).toEqual([]);
    expect(result.active).toEqual([]);
    expect(result.claimable).toEqual([]);
    expect(sb.queries.filter((q) => q.table === 'positions')).toMatchObject([
      { limit: 200, orders: [['position_created_at', { ascending: false, nullsFirst: false }]], lt: [] },
    ]);
  });

  it('never skips the older tail when claimed=false shrinks between pages', async () => {
    const tables = scaleTables(450);
    const sb = positionTables(tables, (q, _n, reply) => {
      if (q.table === 'positions') {
        for (const row of reply.data ?? []) tables.positions.find((p) => p.id === row.id)!.claimed = true;
        // Return the rows as read, before the concurrent claims in the double.
        return { ...reply, data: reply.data!.map((row) => ({ ...row, claimed: false })) };
      }
    });
    db.getSupabase.mockReturnValue(sb);
    const result = await fetchCategorizedPositions(ADDRESS, COMPLETE);
    expect(result.enumeration?.positionCount).toBe(450);
    expect(new Set(result.pendingSettle.map((p) => p.positionId)).size).toBe(450);
    expect(result.pendingSettle.at(-1)?.speculationId).toBe('1');
  });

  it('includes scored/open candidates even when a prediction cannot be computed', async () => {
    const tables = scaleTables(4);
    tables.contests[0]!.home_score = null;
    tables.speculations[1]!.market_type = 'spread'; tables.speculations[1]!.line_ticks = null;
    tables.contests[2]!.contest_status = 'voided';
    tables.speculations[3]!.speculation_status = 'closed'; tables.speculations[3]!.win_side = 'void';
    db.getSupabase.mockReturnValue(positionTables(tables));
    const result = await fetchCategorizedPositions(ADDRESS, COMPLETE);
    expect(result.settlementCandidates.map((p) => p.speculationId)).toEqual(['2', '1']);
    expect(result.pendingSettle).toEqual([]);
    expect(result.claimable).toMatchObject([{ speculationId: '4', result: 'void' }]);
  });

  it('builds all 450 claim plans, not just the first 200', async () => {
    const tables = scaleTables(450);
    for (const s of tables.speculations) { s.speculation_status = 'closed'; s.win_side = 'away'; }
    db.getSupabase.mockReturnValue(positionTables(tables));
    const res = await invoke(getClaimParamsHandler);
    expect(res.statusCode).toBe(200);
    const plans = res.body.positions as Array<{ speculationId: string; txParams: unknown[] }>;
    expect(plans).toHaveLength(450);
    expect(new Set(plans.map((p) => p.speculationId)).size).toBe(450);
    expect(plans.at(-1)?.txParams).toEqual([{ method: 'claimPosition', target: 'PositionModule', args: { speculationId: '1', positionType: 0 } }]);
  });

  it('uses exact string bigint identity cursors without timestamp or number rounding', async () => {
    const tables = scaleTables(200);
    tables.positions.forEach((p, i) => { p.id = (9007199254740993n + BigInt(i)).toString(); });
    const sb = positionTables(tables);
    db.getSupabase.mockReturnValue(sb);
    const result = await fetchCategorizedPositions(ADDRESS, COMPLETE);
    expect(result.pendingSettle).toHaveLength(200);
    expect(sb.queries.filter((q) => q.table === 'positions')[1]?.lt).toEqual([['id', '9007199254740994']]);
  });
});

describe('fail closed, never return partial enumeration or claim plans', () => {
  it.each([
    ['positions', 1], ['positions', 2], ['positions', 3],
    ['speculations', 1], ['speculations', 2], ['contests', 1], ['contests', 2],
  ] as Array<[Table, number]>)('propagates %s query error at read %i through both public handlers', async (table, occurrence) => {
    for (const handler of [getPositionStatusHandler, getClaimParamsHandler]) {
      db.getSupabase.mockReturnValue(positionTables(scaleTables(450), (q, n) =>
        q.table === table && n === occurrence ? { data: [], error: { message: 'offline injected read failure' } } : undefined,
      ));
      const res = await invoke(handler);
      expect(res.statusCode).toBe(500);
      expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(Object.keys(res.body).sort()).toEqual(['code', 'error']);
    }
  });

  it.each(['repeated-page', 'short-repeat', 'out-of-order', 'duplicate-id', 'missing-id', 'unsafe-number-id', 'oversized-page', 'null-data'])('rejects %s instead of claiming complete or stalling', async (fault) => {
    let first: Reply;
    const sb = positionTables(scaleTables(450), (q, n, reply) => {
      if (q.table !== 'positions') return;
      if (n === 1) first = reply;
      if (n !== 2) return;
      const data = reply.data!.map((p) => ({ ...p }));
      if (fault === 'repeated-page') return first;
      if (fault === 'short-repeat') return { data: first.data!.slice(-1), error: null };
      if (fault === 'out-of-order') data.reverse();
      if (fault === 'duplicate-id') data[1]!.id = data[0]!.id!;
      if (fault === 'missing-id') delete data[0]!.id;
      if (fault === 'unsafe-number-id') data[0]!.id = Number.MAX_SAFE_INTEGER + 1;
      if (fault === 'oversized-page') data.push(data[0]!);
      return { data: fault === 'null-data' ? null : data, error: null };
    });
    db.getSupabase.mockReturnValue(sb);
    await expect(fetchCategorizedPositions(ADDRESS, COMPLETE)).rejects.toThrow(/fetchCategorizedPositions/);
    expect(sb.queries.filter((q) => q.table === 'positions')).toHaveLength(2);
  });

  it.each(['speculations', 'contests'] as const)('rejects missing %s joins rather than silently dropping a controlled position', async (table) => {
    const tables = scaleTables(450);
    tables[table].splice(0, 1);
    db.getSupabase.mockReturnValue(positionTables(tables));
    expect((await invoke(getPositionStatusHandler)).statusCode).toBe(500);
  });
});

// Small immutable historical input fixture. Raw JSON strings below are exact substrings
// of the source captures, pinned by hashes. This is deterministic DB-shape mapping,
// NOT a captured DB/status response, and does not claim a live settlement or claim tx.
const fixtureBytes = readFileSync(new URL('./fixtures/postgame-ledger.json', import.meta.url));
interface Captured { source: string; rowIndex: number; rawSha256: string; raw: string }
const fixture = JSON.parse(fixtureBytes.toString()) as { entries: Array<{ label: string; enriched: Captured; history: Captured }> };
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function mappedLedger(): Tables {
  const tables: Tables = { positions: [], speculations: [], contests: [] };
  fixture.entries.forEach((entry, i) => {
    const r = JSON.parse(entry.enriched.raw);
    const h = JSON.parse(entry.history.raw);
    // Moneyline-only selected evidence: enum 0=open/tbd, 1=closed/away, 2=home/scored.
    // IDs and row_updated_at do NOT exist in the capture; use explicit synthetic values.
    tables.positions.push({ id: i + 1, network: 'polygon', speculation_id: r.speculationId,
      user_address: r.address, position_type: r.side === 0 ? 'upper' : 'lower',
      risk_amount: String(r.risk), profit_amount: String(r.profit), claimed: r.claimed,
      position_created_at: h.positionCreatedAt, row_updated_at: STAMP });
    if (!tables.speculations.some((s) => s.speculation_id === r.speculationId)) {
      tables.speculations.push({ network: 'polygon', speculation_id: r.speculationId, contest_id: r.contestId,
        market_type: r.market, line_ticks: r.lineTicks, speculation_status: r.specStatus === 0 ? 'open' : 'closed',
        win_side: r.winSide === 0 ? 'tbd' : r.winSide === 1 ? 'away' : 'home', row_updated_at: STAMP });
      tables.contests.push({ network: 'polygon', contest_id: r.contestId, away_team: r.datedAPI.awayTeam,
        home_team: r.datedAPI.homeTeam, sport_slug: 'mlb', contest_status: 'scored',
        away_score: r.awayScore, home_score: r.homeScore, row_updated_at: STAMP });
    }
  });
  return tables;
}

describe('real-ledger regression (offline deterministic mapping, no live writes)', () => {
  const maker = '0x5316fa54c170d1927f30d1a497ac9e85e3826a9b';
  const flow = '0x16dc5d67d080a5521ef2c79680dbfc2abf724d30';
  it('pins exact input bytes and reconciles the history rows to the enriched chain evidence', () => {
    expect(sha256(fixtureBytes)).toBe('3d0101b9068fa893439bf1002121914da11378b79bc511408f5f4da51c29a757');
    expect(fixture.entries).toHaveLength(3);
    for (const entry of fixture.entries) {
      for (const row of [entry.enriched, entry.history]) expect(sha256(row.raw)).toBe(row.rawSha256);
      const r = JSON.parse(entry.enriched.raw); const h = JSON.parse(entry.history.raw);
      expect(h).toMatchObject({ speculationId: String(r.speculationId), positionType: r.side, claimed: r.claimed,
        riskAmountUSDC: r.risk / 1e6, profitAmountUSDC: r.profit / 1e6 });
      expect(Date.parse(h.positionCreatedAt) / 1000).toBe(r.firstFillTimestamp);
    }
  });

  it('finds maker-won 277 AND its controlled losing flow side without polluting pendingSettle', async () => {
    db.getSupabase.mockReturnValue(positionTables(mappedLedger()));
    const winner = await invoke(getPositionStatusHandler, maker);
    expect(winner.statusCode).toBe(200);
    expect(winner.body.settlementCandidates).toMatchObject([{ speculationId: '277', positionType: 0, riskAmountWei6: '10000', contestId: '118' }]);
    expect(winner.body.pendingSettle).toMatchObject([{ speculationId: '277', result: 'won', estimatedPayoutWei6: '20000' }]);
    expect(winner.body.claimable).toMatchObject([{ speculationId: '407', positionType: 1, estimatedPayoutWei6: '6797346' }]);
    const loser = await invoke(getPositionStatusHandler, flow);
    expect(loser.body.settlementCandidates).toMatchObject([{ speculationId: '277', positionType: 1, riskAmountWei6: '10000' }]);
    expect(loser.body.pendingSettle).toEqual([]);
    expect(loser.body.claimable).toEqual([]);
    expect(loser.body.totals).toMatchObject({ pendingSettlePayoutWei6: '0', estimatedPayoutWei6: '0' });
  });

  it('constructs maker claim 407 and settle/claim 277, but no losing flow claim', async () => {
    db.getSupabase.mockReturnValue(positionTables(mappedLedger()));
    const res = await invoke(getClaimParamsHandler, maker);
    expect(res.statusCode).toBe(200);
    expect(res.body.positions).toMatchObject([
      { speculationId: '407', bucket: 'claimable', estimatedPayoutWei6: '6797346', txParams: [
        { method: 'claimPosition', target: 'PositionModule', args: { speculationId: '407', positionType: 1 } },
      ] },
      { speculationId: '277', bucket: 'pendingSettle', estimatedPayoutWei6: '20000', txParams: [
        { method: 'settleSpeculation', target: 'SpeculationModule', args: { speculationId: '277' } },
        { method: 'claimPosition', target: 'PositionModule', args: { speculationId: '277', positionType: 0 } },
      ] },
    ]);
    expect((await invoke(getClaimParamsHandler, flow)).body.positions).toEqual([]);
  });
});
