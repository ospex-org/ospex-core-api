/**
 * Unit tests for `fetchCategorizedPositions` — the pure helper backing
 * /v1/positions/:address/{status,claim-params}.
 *
 * We mock both the Supabase client (`getSupabase`) and the env loader
 * (`loadConfig`) so the test never touches a real network. Each test
 * builds a tiny in-memory query mock that mirrors the PostgREST chain
 * the helper invokes:
 *
 *   .from(table).select(...).eq(...).in(...).order(...).limit(...)
 *
 * That's enough to drive the three sequential reads (positions →
 * speculations → contests) without pulling in supabase-js's full
 * builder runtime.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => ({ getSupabase: vi.fn() }));
const envMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ network: 'polygon', chainId: 137 })),
}));

vi.mock('../src/lib/supabase.js', () => supabaseMock);
vi.mock('../src/lib/env.js', () => envMock);

const { fetchCategorizedPositions } = await import('../src/v1/utils/positionFetch.js');

interface Tables {
  positions: unknown[];
  speculations: unknown[];
  contests: unknown[];
}

function makeSupabase(tables: Tables): { from: (table: keyof Tables) => unknown } {
  // Each `.from(table)` returns a new builder whose terminal awaits
  // resolve to `{ data, error }`. The methods are noops that return
  // `this` — the helper only filters client-side, all the actual
  // filtering happens in this test by handing back the right rows.
  return {
    from(table: keyof Tables): unknown {
      const data = tables[table] ?? [];
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        gt: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
          resolve({ data, error: null }),
      };
      return builder;
    },
  };
}

const ADDR = '0xabcdefabcdef0123456789abcdef0123456789ab';

beforeEach(() => {
  envMock.loadConfig.mockReturnValue({ network: 'polygon', chainId: 137 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchCategorizedPositions — claimable bucket', () => {
  it('classifies a winning closed-speculation position as claimable with payout = risk + profit', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        positions: [
          {
            speculation_id: 1,
            user_address: ADDR,
            position_type: 'upper',
            risk_amount: '100000000', // 100 USDC
            profit_amount: '90000000', // 90 USDC
            claimed: false,
            position_created_at: '2026-01-01T00:00:00Z',
          },
        ],
        speculations: [
          {
            speculation_id: 1,
            contest_id: 42,
            market_type: 'moneyline',
            line_ticks: 0,
            speculation_status: 'closed',
            win_side: 'away',
          },
        ],
        contests: [
          {
            contest_id: 42,
            away_team: 'Lakers',
            home_team: 'Celtics',
            contest_status: 'scored',
            away_score: 110,
            home_score: 105,
          },
        ],
      }),
    );

    const result = await fetchCategorizedPositions(ADDR);

    expect(result.active).toEqual([]);
    expect(result.pendingSettle).toEqual([]);
    expect(result.claimable).toHaveLength(1);
    const c = result.claimable[0]!;
    expect(c.speculationId).toBe('1');
    expect(c.team).toBe('Lakers');
    expect(c.opponent).toBe('Celtics');
    expect(c.result).toBe('won');
    expect(c.estimatedPayoutWei6).toBe('190000000');
    expect(c.positionId).toBe(`1_${ADDR}_0`);
  });

  it('drops losing closed-speculation positions (would revert with NoPayout)', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        positions: [
          {
            speculation_id: 1,
            user_address: ADDR,
            position_type: 'upper', // bet on away
            risk_amount: '100000000',
            profit_amount: '90000000',
            claimed: false,
            position_created_at: null,
          },
        ],
        speculations: [
          {
            speculation_id: 1,
            contest_id: 42,
            market_type: 'moneyline',
            line_ticks: 0,
            speculation_status: 'closed',
            win_side: 'home', // upper lost
          },
        ],
        contests: [
          {
            contest_id: 42,
            away_team: 'A',
            home_team: 'B',
            contest_status: 'scored',
            away_score: 95,
            home_score: 110,
          },
        ],
      }),
    );

    const result = await fetchCategorizedPositions(ADDR);
    expect(result.claimable).toHaveLength(0);
    expect(result.pendingSettle).toHaveLength(0);
    expect(result.active).toHaveLength(0);
  });

  it('returns push positions in the claimable bucket with payout = risk', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        positions: [
          {
            speculation_id: 1,
            user_address: ADDR,
            position_type: 'lower',
            risk_amount: '50000000',
            profit_amount: '50000000',
            claimed: false,
            position_created_at: null,
          },
        ],
        speculations: [
          {
            speculation_id: 1,
            contest_id: 42,
            market_type: 'spread',
            line_ticks: -35,
            speculation_status: 'closed',
            win_side: 'push',
          },
        ],
        contests: [
          {
            contest_id: 42,
            away_team: 'A',
            home_team: 'B',
            contest_status: 'scored',
            away_score: 100,
            home_score: 103,
          },
        ],
      }),
    );

    const result = await fetchCategorizedPositions(ADDR);
    expect(result.claimable).toHaveLength(1);
    expect(result.claimable[0]!.result).toBe('push');
    expect(result.claimable[0]!.estimatedPayoutWei6).toBe('50000000');
  });
});

describe('fetchCategorizedPositions — pendingSettle bucket', () => {
  it('classifies an open speculation on a scored contest as pendingSettle with predicted result', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        positions: [
          {
            speculation_id: 7,
            user_address: ADDR,
            position_type: 'upper',
            risk_amount: '100000000',
            profit_amount: '110000000',
            claimed: false,
            position_created_at: null,
          },
        ],
        speculations: [
          {
            speculation_id: 7,
            contest_id: 99,
            market_type: 'moneyline',
            line_ticks: 0,
            speculation_status: 'open',
            win_side: 'tbd',
          },
        ],
        contests: [
          {
            contest_id: 99,
            away_team: 'Away',
            home_team: 'Home',
            contest_status: 'scored',
            away_score: 21,
            home_score: 14,
          },
        ],
      }),
    );

    const result = await fetchCategorizedPositions(ADDR);
    expect(result.active).toEqual([]);
    expect(result.claimable).toEqual([]);
    expect(result.pendingSettle).toHaveLength(1);
    const ps = result.pendingSettle[0]!;
    expect(ps.predictedWinSide).toBe('away');
    expect(ps.result).toBe('won');
    expect(ps.estimatedPayoutWei6).toBe('210000000');
  });

  it('replays the spread scorer (10× ticks domain) and predicts the cover side', async () => {
    // Away -3.5 (lineTicks=-35). Final 110-100 → adjusted 110*10 + (-35) = 1065 vs 1000.
    // Away covers.
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        positions: [
          {
            speculation_id: 11,
            user_address: ADDR,
            position_type: 'upper',
            risk_amount: '100000000',
            profit_amount: '90000000',
            claimed: false,
            position_created_at: null,
          },
        ],
        speculations: [
          {
            speculation_id: 11,
            contest_id: 100,
            market_type: 'spread',
            line_ticks: -35,
            speculation_status: 'open',
            win_side: 'tbd',
          },
        ],
        contests: [
          {
            contest_id: 100,
            away_team: 'A',
            home_team: 'B',
            contest_status: 'scored',
            away_score: 110,
            home_score: 100,
          },
        ],
      }),
    );

    const result = await fetchCategorizedPositions(ADDR);
    expect(result.pendingSettle).toHaveLength(1);
    expect(result.pendingSettle[0]!.predictedWinSide).toBe('away');
    expect(result.pendingSettle[0]!.result).toBe('won');
  });

  it('replays the total scorer and predicts under/over', async () => {
    // Total line 215 ticks (21.5 in 10× domain). Combined 100+105 = 205, *10 = 2050.
    // 2050 > 215 → over. So 'lower' (Under) loses → filtered out.
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        positions: [
          {
            speculation_id: 13,
            user_address: ADDR,
            position_type: 'lower',
            risk_amount: '100000000',
            profit_amount: '100000000',
            claimed: false,
            position_created_at: null,
          },
        ],
        speculations: [
          {
            speculation_id: 13,
            contest_id: 200,
            market_type: 'total',
            line_ticks: 215,
            speculation_status: 'open',
            win_side: 'tbd',
          },
        ],
        contests: [
          {
            contest_id: 200,
            away_team: 'A',
            home_team: 'B',
            contest_status: 'scored',
            away_score: 100,
            home_score: 105,
          },
        ],
      }),
    );

    const result = await fetchCategorizedPositions(ADDR);
    expect(result.pendingSettle).toHaveLength(0);
    expect(result.active).toHaveLength(0); // predicted-loser filtered
  });

  it('skips pendingSettle predicted-losers (settling would just reveal NoPayout)', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        positions: [
          {
            speculation_id: 17,
            user_address: ADDR,
            position_type: 'upper',
            risk_amount: '100000000',
            profit_amount: '100000000',
            claimed: false,
            position_created_at: null,
          },
        ],
        speculations: [
          {
            speculation_id: 17,
            contest_id: 300,
            market_type: 'moneyline',
            line_ticks: 0,
            speculation_status: 'open',
            win_side: 'tbd',
          },
        ],
        contests: [
          {
            contest_id: 300,
            away_team: 'A',
            home_team: 'B',
            contest_status: 'scored',
            away_score: 80,
            home_score: 90,
          },
        ],
      }),
    );

    const result = await fetchCategorizedPositions(ADDR);
    expect(result.pendingSettle).toHaveLength(0);
    expect(result.claimable).toHaveLength(0);
    expect(result.active).toHaveLength(0);
  });

  it('puts open positions on a not-yet-scored contest in active', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        positions: [
          {
            speculation_id: 19,
            user_address: ADDR,
            position_type: 'upper',
            risk_amount: '100000000',
            profit_amount: '100000000',
            claimed: false,
            position_created_at: null,
          },
        ],
        speculations: [
          {
            speculation_id: 19,
            contest_id: 400,
            market_type: 'moneyline',
            line_ticks: 0,
            speculation_status: 'open',
            win_side: 'tbd',
          },
        ],
        contests: [
          {
            contest_id: 400,
            away_team: 'A',
            home_team: 'B',
            contest_status: 'verified',
            away_score: null,
            home_score: null,
          },
        ],
      }),
    );

    const result = await fetchCategorizedPositions(ADDR);
    expect(result.active).toHaveLength(1);
    expect(result.pendingSettle).toHaveLength(0);
    expect(result.claimable).toHaveLength(0);
  });
});

describe('fetchCategorizedPositions — mixed and edge cases', () => {
  it('returns one entry per bucket for an address with all three states', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        positions: [
          // active (open, contest verified-only)
          {
            speculation_id: 1,
            user_address: ADDR,
            position_type: 'upper',
            risk_amount: '10000000',
            profit_amount: '10000000',
            claimed: false,
            position_created_at: null,
          },
          // pendingSettle (open, contest scored)
          {
            speculation_id: 2,
            user_address: ADDR,
            position_type: 'lower',
            risk_amount: '20000000',
            profit_amount: '20000000',
            claimed: false,
            position_created_at: null,
          },
          // claimable (closed, won)
          {
            speculation_id: 3,
            user_address: ADDR,
            position_type: 'upper',
            risk_amount: '30000000',
            profit_amount: '30000000',
            claimed: false,
            position_created_at: null,
          },
        ],
        speculations: [
          {
            speculation_id: 1,
            contest_id: 100,
            market_type: 'moneyline',
            line_ticks: 0,
            speculation_status: 'open',
            win_side: 'tbd',
          },
          {
            speculation_id: 2,
            contest_id: 200,
            market_type: 'moneyline',
            line_ticks: 0,
            speculation_status: 'open',
            win_side: 'tbd',
          },
          {
            speculation_id: 3,
            contest_id: 300,
            market_type: 'moneyline',
            line_ticks: 0,
            speculation_status: 'closed',
            win_side: 'away',
          },
        ],
        contests: [
          {
            contest_id: 100,
            away_team: 'A1',
            home_team: 'B1',
            contest_status: 'verified',
            away_score: null,
            home_score: null,
          },
          {
            contest_id: 200,
            away_team: 'A2',
            home_team: 'B2',
            contest_status: 'scored',
            away_score: 80, // away loses → lower wins
            home_score: 90,
          },
          {
            contest_id: 300,
            away_team: 'A3',
            home_team: 'B3',
            contest_status: 'scored',
            away_score: 110,
            home_score: 100,
          },
        ],
      }),
    );

    const result = await fetchCategorizedPositions(ADDR);
    expect(result.active).toHaveLength(1);
    expect(result.active[0]!.speculationId).toBe('1');
    expect(result.pendingSettle).toHaveLength(1);
    expect(result.pendingSettle[0]!.speculationId).toBe('2');
    expect(result.pendingSettle[0]!.predictedWinSide).toBe('home');
    expect(result.claimable).toHaveLength(1);
    expect(result.claimable[0]!.speculationId).toBe('3');
  });

  it('returns empty buckets when the address has no rows', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({ positions: [], speculations: [], contests: [] }),
    );
    const result = await fetchCategorizedPositions(ADDR);
    expect(result).toEqual({ active: [], pendingSettle: [], claimable: [], hitCap: false });
  });

  it('throws when the positions query reports an error', async () => {
    supabaseMock.getSupabase.mockReturnValue({
      from() {
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: () => builder,
          gt: () => builder,
          order: () => builder,
          limit: () => builder,
          then: (resolve: (v: { data: null; error: { message: string } }) => void) =>
            resolve({ data: null, error: { message: 'boom' } }),
        };
        return builder;
      },
    });
    await expect(fetchCategorizedPositions(ADDR)).rejects.toThrow(/boom/);
  });
});
