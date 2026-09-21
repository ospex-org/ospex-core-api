/**
 * `GET /v1/benchmark/pick/:participantId/:gameId/:market`.
 *
 * Real `@supabase/supabase-js` against a fake PostgREST, same reasoning as the
 * sibling benchmark handler tests: the two things a builder mock cannot see are
 * asserted on the captured query string — that the publication gate is PUSHED
 * DOWN as `slate_date=gte.…` rather than applied after the fact, and that the
 * reveal embed NAMES its foreign key and is `!inner` (two constraints join those
 * tables, so an unqualified embed is a hard `PGRST201` on every request).
 *
 * `maybeSingle()` sends no special header and post-processes the array body
 * client-side, so the fake answers arrays throughout: `[]` becomes `null` and a
 * one-element array becomes the row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  expectReached,
  startFakePostgrest,
  type CapturedRequest,
  type FakePostgrest,
  type FakeReply,
} from './helpers/fakePostgrest.js';

const PARTICIPANT = 'anthropic-claude-fable-5';
const GAME = '017495e7-241b-47fd-877f-34a44347c3e4';
const MIN_SLATE = '2026-08-15';

/**
 * A ledger row shaped as the view serves it.
 *
 * `held_out_of_primary: null` and `net_usdc: 0` are deliberate: the first is the
 * tri-state a `?? false` would collapse, and the second is a REAL zero that a
 * push/void/no-fill carries, distinct from the null a `pending` row has. A
 * fixture with `false` and a non-zero net could not discriminate either.
 */
function ledgerRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    participant_id: PARTICIPANT,
    participant_name: 'Claude Fable 5',
    lab_id: 'anthropic',
    cohort_id: 'watch-v0-2026-08-27',
    slate_date: '2026-08-27',
    game_id: GAME,
    away_team_name: 'New York Yankees',
    away_team_abbreviation: 'NYY',
    home_team_name: 'Toronto Blue Jays',
    home_team_abbreviation: 'TOR',
    start_time: '2026-08-27T23:10:00+00:00',
    game_status: 'final',
    away_score: 8,
    home_score: 2,
    sport: 'mlb',
    market: 'moneyline',
    selection: 'New York Yankees',
    line: null,
    pick_price_decimal: 1.46083,
    closing_line: null,
    closing_price_decimal: 1.50505,
    closing_captured_at: '2026-08-27T22:39:25.807+00:00',
    clv_pct: -6.0782,
    margin_adjusted_clv_pct: -2.9812,
    unscored_reason: null,
    scoring_policy_version: 'scoring-v0.6.2',
    clv_scored_at: '2026-08-31T15:26:53.778+00:00',
    held_out_of_primary: null,
    primary_axis: 'consensus',
    axis_valuation: 2,
    axis_trend: 3,
    axis_consensus: 4,
    axis_news: 2,
    axis_softness: 2,
    primary_expectation: 'line moves toward us',
    fill_tx_hash: null,
    filled_at: null,
    stake_usdc: null,
    fill_price_decimal: null,
    result: 'no_fill',
    net_usdc: 0,
    settlement_tx_hash: null,
    claim_tx_hash: null,
    as_of: '2026-09-06T07:30:00+00:00',
    source_decision_id: 4374,
    run_id: 'watch-v0-2026-08-27-302b26',
    forecast_digest: 'fec5e5c0',
    rationale_digest: '7de77846',
    seal_source_sha256: '6fdb670b',
    reveal_source_sha256: '6fdb670b',
    ...over,
  };
}

const open: FakePostgrest[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
  vi.resetModules();
});

interface Tables {
  benchmark_pick_ledger?: Array<Record<string, unknown>>;
  benchmark_pick_ledger_conflicts?: Array<Record<string, unknown>>;
  benchmark_pick_writeups?: Array<Record<string, unknown>>;
  benchmark_decisions?: Array<Record<string, unknown>>;
}

async function call(
  params: { participantId?: string; gameId?: string; market?: string } = {},
  tables: Tables = {},
  config: Record<string, unknown> = {},
  override?: (req: CapturedRequest) => FakeReply | undefined,
): Promise<{ fake: FakePostgrest; body: Record<string, unknown>; status: number }> {
  const data: Tables = {
    benchmark_pick_ledger: [ledgerRow()],
    benchmark_pick_ledger_conflicts: [],
    benchmark_pick_writeups: [{ writeup: 'Because the Yankees are short.' }],
    benchmark_decisions: [{
      sealed_at: '2026-08-27T12:00:00+00:00',
      benchmark_decision_reveals: { revealed_at: '2026-08-27T12:00:01+00:00' },
    }],
    ...tables,
  };
  const fake = await startFakePostgrest((req) => {
    const forced = override?.(req);
    if (forced !== undefined) return forced;
    const table = /^\/rest\/v1\/([^/?]+)/.exec(req.path)?.[1] ?? '';
    return { body: data[table as keyof Tables] ?? [] };
  });
  open.push(fake);

  vi.resetModules();
  vi.doMock('../src/lib/env.js', () => ({
    loadConfig: () => ({
      supabaseUrl: fake.url,
      supabaseServiceRoleKey: 'test-key',
      network: 'polygon',
      benchmarkPublicMinSlateDate: MIN_SLATE,
      ...config,
    }),
  }));
  vi.doMock('../src/lib/logger.js', () => ({ logger: { error: vi.fn() }, formatError: String }));

  const { getBenchmarkPickHandler } = await import('../src/v1/benchmark/pick.js');
  const res = {
    statusCode: 0, body: {} as Record<string, unknown>,
    status(c: number) { this.statusCode = c; return this; },
    json(b: Record<string, unknown>) { this.body = b; return this; },
  };
  await getBenchmarkPickHandler({
    params: {
      participantId: params.participantId ?? PARTICIPANT,
      gameId: params.gameId ?? GAME,
      market: params.market ?? 'moneyline',
    },
  } as unknown as Request, res as unknown as Response);
  return { fake, body: res.body, status: res.statusCode };
}

describe('pick detail — refusals cost nothing', () => {
  it.each([
    ['an empty participantId', { participantId: '  ' }],
    ['an empty gameId', { gameId: '' }],
    ['an unknown market', { market: 'parlay' }],
    ['a market differing only in case', { market: 'Moneyline' }],
  ])('refuses %s before any read', async (_why, params) => {
    const { status, body, fake } = await call(params);
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'INVALID_PARAM' });
    // The refusal is BEFORE the database, not after it.
    expect(fake.requests).toHaveLength(0);
  });

  it('answers not_published with no read at all when the gate is unset', async () => {
    const { status, body, fake } = await call({}, {}, { benchmarkPublicMinSlateDate: undefined });
    expect(status).toBe(200);
    expect(body).toMatchObject({ state: 'not_published', pick: null, conflict: null });
    // An unset gate is a deliberate operator state, and making "nothing is
    // published" cost the same as serving is the defect this pins.
    expect(fake.requests).toHaveLength(0);
  });
});

describe('pick detail — the reads', () => {
  it('pushes the publication gate down and names the reveal foreign key', async () => {
    const { fake, status } = await call();
    expect(status).toBe(200);
    expectReached(fake);

    const ledger = fake.requests.find((r) => r.path === '/rest/v1/benchmark_pick_ledger');
    expect(ledger).toBeDefined();
    // The gate as a pushed-down predicate. Applied after the fact it would read
    // an unpublished row before discarding it.
    expect(ledger?.params.get('slate_date')).toBe(`gte.${MIN_SLATE}`);
    expect(ledger?.params.get('participant_id')).toBe(`eq.${PARTICIPANT}`);
    expect(ledger?.params.get('game_id')).toBe(`eq.${GAME}`);
    expect(ledger?.params.get('market')).toBe('eq.moneyline');
    expect(ledger?.params.get('network')).toBe('eq.polygon');

    const decisions = fake.requests.find((r) => r.path === '/rest/v1/benchmark_decisions');
    // Two constraints join decisions to reveals, so an unqualified embed is a
    // hard PGRST201 on EVERY request. The FK name and `!inner` are both
    // load-bearing: left would admit a sealed-but-unrevealed decision.
    expect(decisions?.rawQuery).toContain('fk_benchmark_reveal_decision');
    expect(decisions?.rawQuery).toContain('%21inner');
    expect(decisions?.params.get('id')).toBe('eq.4374');
  });

  it('reads the ledger BEFORE any base table, which is what makes the base read safe', async () => {
    // Not stylistic. core-api connects as service_role, which 086's live-only
    // RESTRICTIVE policies do not constrain, so a base-table read on an
    // unconfirmed key could return a rehearsal cohort's row. The ledger view
    // filters live membership in its own body, so reading it FIRST and keying the
    // base read on the row it returned is the whole safety argument.
    const { fake } = await call();
    const tables = fake.tables();
    expect(tables[0]).toBe('benchmark_pick_ledger');
    expect(tables.indexOf('benchmark_pick_ledger')).toBeLessThan(tables.indexOf('benchmark_decisions'));
  });

  it.each([4374, 9999])('keys the companion reads on the ledger row source_decision_id (%i)', async (id) => {
    // TWO ids on purpose. With one, a build that hardcoded the fixture's own
    // decision id would satisfy the assertion exactly — a mutation battery
    // caught precisely that, and a single-value case could never tell the two
    // implementations apart.
    const { fake } = await call({}, { benchmark_pick_ledger: [ledgerRow({ source_decision_id: id })] });
    const writeups = fake.requests.find((r) => r.path === '/rest/v1/benchmark_pick_writeups');
    const decisions = fake.requests.find((r) => r.path === '/rest/v1/benchmark_decisions');
    expect(writeups?.params.get('decision_id')).toBe(`eq.${String(id)}`);
    expect(decisions?.params.get('id')).toBe(`eq.${String(id)}`);
  });
});

describe('pick detail — published body', () => {
  it('serves the pick with the distinctions the DDL carries', async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body).toMatchObject({ state: 'published', conflict: null, axisScale: { min: 1, max: 5 } });
    const pick = body.pick as Record<string, any>;

    // 1.46083 decimal -> -round(100 / 0.46083) = -217. The fixture price is the
    // real production value, so the expectation is derived from it rather than
    // copied from the sibling test (whose 1.8065 gives -124).
    expect(pick.selectionLabel).toBe('New York Yankees -217');
    expect(pick.priceAmerican).toBe(-217);
    expect(pick.selectionSide).toBe('away');
    expect(pick.writeup).toBe('Because the Yankees are short.');
    expect(pick.timeline).toEqual({
      sealedAt: '2026-08-27T12:00:00+00:00',
      revealedAt: '2026-08-27T12:00:01+00:00',
    });
    expect(pick.digests.algorithm).toBe('sha256');
    expect(pick.closing.ready).toBe(true);

    // The three distinctions #72 requires stay visible, each asserted for the
    // value it actually holds rather than for truthiness.
    expect(pick.clv.heldOutOfPrimary).toBeNull();
    expect(pick.execution.result).toBe('no_fill');
    expect(pick.execution.netUsdc).toBe(0);
    expect(pick.execution.fillTxHash).toBeNull();
  });

  it('keeps a tri-state hold-out tag distinct from a false one', async () => {
    // The `3g-nullish` pin. A `?? false` anywhere on this path turns "not
    // tagged" into "not held", and only a fixture carrying BOTH values can tell
    // the two apart — so both are asserted.
    const nulled = await call({}, { benchmark_pick_ledger: [ledgerRow({ held_out_of_primary: null })] });
    const flagged = await call({}, { benchmark_pick_ledger: [ledgerRow({ held_out_of_primary: false })] });
    const held = await call({}, { benchmark_pick_ledger: [ledgerRow({ held_out_of_primary: true })] });
    expect((nulled.body.pick as any).clv.heldOutOfPrimary).toBeNull();
    expect((flagged.body.pick as any).clv.heldOutOfPrimary).toBe(false);
    expect((held.body.pick as any).clv.heldOutOfPrimary).toBe(true);
  });

  it('distinguishes a pending null net from a real zero', async () => {
    const pending = await call({}, {
      benchmark_pick_ledger: [ledgerRow({ result: 'pending', net_usdc: null })],
    });
    expect((pending.body.pick as any).execution.netUsdc).toBeNull();
    expect((pending.body.pick as any).execution.result).toBe('pending');
  });

  it.each([
    ['a refused score', { clv_pct: null, unscored_reason: 'no_close' }, null, 'no_close'],
    ['a not-yet-scored pick', { clv_pct: null, unscored_reason: null }, null, null],
  ])('keeps %s distinct', async (_why, over, pct, reason) => {
    const { body } = await call({}, { benchmark_pick_ledger: [ledgerRow(over)] });
    expect((body.pick as any).clv.pct).toBe(pct);
    expect((body.pick as any).clv.unscoredReason).toBe(reason);
  });

  it('serves a spread AND its close as side-labelled pairs with null lines', async () => {
    // The convention merged in #80: the stored value is the HOME handicap, so an
    // away pick's number is its negation and no bare `line` ships.
    //
    // The CLOSING line is a spread too, and the first draft of this endpoint
    // served it raw — #71 reintroduced one object over from the fix for it. The
    // first draft of this TEST could not catch that, because it left
    // `closing_line` at the fixture's null.
    //
    // -1.5 for the pick and -2.5 for the close on purpose: equal values would let
    // a build that reused the pick's pair for the close pass, and that is the
    // most likely wrong implementation.
    const { body } = await call(
      { market: 'spread' },
      {
        benchmark_pick_ledger: [ledgerRow({
          market: 'spread', line: -1.5, closing_line: -2.5, pick_price_decimal: 1.9,
        })],
      },
    );
    const pick = body.pick as Record<string, any>;
    expect(pick.line).toBeNull();
    expect(pick.awayLine).toBe(1.5);
    expect(pick.homeLine).toBe(-1.5);
    expect(pick.selectionLabel).toBe('New York Yankees +1.5');

    expect(pick.closing.line).toBeNull();
    expect(pick.closing.awayLine).toBe(2.5);
    expect(pick.closing.homeLine).toBe(-2.5);
  });

  it('keeps a non-spread closing line as the stored threshold', async () => {
    // Paired control: only a spread loses its bare `line`. A total's close is
    // perspective-neutral and must survive untouched.
    const { body } = await call(
      { market: 'total' },
      {
        benchmark_pick_ledger: [ledgerRow({
          market: 'total', selection: 'under', line: 8.5, closing_line: 9,
        })],
      },
    );
    const pick = body.pick as Record<string, any>;
    expect(pick.closing.line).toBe(9);
    expect(pick.closing.awayLine).toBeNull();
    expect(pick.closing.homeLine).toBeNull();
  });

  it('serves a total line as the perspective-neutral threshold', async () => {
    const { body } = await call(
      { market: 'total' },
      { benchmark_pick_ledger: [ledgerRow({ market: 'total', selection: 'under', line: 8.5 })] },
    );
    const pick = body.pick as Record<string, any>;
    expect(pick.line).toBe(8.5);
    expect(pick.awayLine).toBeNull();
    expect(pick.homeLine).toBeNull();
    expect(pick.selectionLabel).toBe('Under 8.5');
  });
});

describe('pick detail — the axis vector is never fabricated', () => {
  /**
   * The DDL permits each axis to be independently null, and this endpoint
   * advertises a 1-5 scale. So a zero is not a low score, it is a value outside
   * the scale — and the first draft produced one with `?? 0`.
   *
   * Four cases, because the two wrong implementations fail on different ones: a
   * `?? 0` build fails the partial case, and a build using `valuation` as the
   * sentinel for "no axes" fails the valuation-null case by discarding the rest.
   */
  const AXES = ['axis_valuation', 'axis_trend', 'axis_consensus', 'axis_news', 'axis_softness'] as const;

  it('serves every axis when every axis is present', async () => {
    const { body } = await call();
    expect((body.pick as any).axes).toEqual({
      valuation: 2, trend: 3, consensus: 4, news: 2, softness: 2,
    });
  });

  it('preserves an individual null rather than turning it into a zero', async () => {
    const { body } = await call({}, {
      benchmark_pick_ledger: [ledgerRow({ axis_trend: null, axis_news: null })],
    });
    expect((body.pick as any).axes).toEqual({
      valuation: 2, trend: null, consensus: 4, news: null, softness: 2,
    });
  });

  it('keeps the other axes when VALUATION alone is null', async () => {
    // The sentinel bug: valuation was used to decide whether any axes existed, so
    // a null valuation discarded a real trend.
    const { body } = await call({}, {
      benchmark_pick_ledger: [ledgerRow({ axis_valuation: null })],
    });
    expect((body.pick as any).axes).toEqual({
      valuation: null, trend: 3, consensus: 4, news: 2, softness: 2,
    });
  });

  it('serves null for the whole vector only when every axis is null', async () => {
    const empty = Object.fromEntries(AXES.map((k) => [k, null]));
    const { body } = await call({}, { benchmark_pick_ledger: [ledgerRow(empty)] });
    expect((body.pick as any).axes).toBeNull();
  });

  it.each(AXES)('a vector with only %s set is still a vector', async (present) => {
    // Each axis alone, so no single field can be the one the implementation
    // happens to consult.
    const row = Object.fromEntries(AXES.map((k) => [k, k === present ? 4 : null]));
    const { body } = await call({}, { benchmark_pick_ledger: [ledgerRow(row)] });
    const axes = (body.pick as any).axes as Record<string, number | null>;
    expect(axes).not.toBeNull();
    expect(Object.values(axes).filter((v) => v !== null)).toEqual([4]);
  });
});

describe('pick detail — absence', () => {
  it('reports a conflicted key as an affirmative withheld state, not a 404', async () => {
    const { status, body, fake } = await call({}, {
      benchmark_pick_ledger: [],
      benchmark_pick_ledger_conflicts: [{
        participant_id: PARTICIPANT, game_id: GAME, sport: 'mlb', market: 'moneyline',
        slate_date: '2026-08-27', reason: 'immutable_source_conflict',
        as_of: '2026-09-06T07:30:00+00:00',
      }],
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      state: 'withheld_conflict',
      pick: null,
      conflict: {
        reason: 'immutable_source_conflict',
        asOf: '2026-09-06T07:30:00+00:00',
        sport: 'mlb',
        slateDate: '2026-08-27',
      },
    });
    // `pick` is null rather than an object of nulls, so there is no field a
    // consumer can misread as a zero.
    expect(body.pick).toBeNull();
    // And no base table was consulted for a key the view withheld.
    expect(fake.tables()).not.toContain('benchmark_decisions');
  });

  it('reports a plain absence as not_published, having asked the conflicts view', async () => {
    const { status, body, fake } = await call({}, {
      benchmark_pick_ledger: [],
      benchmark_pick_ledger_conflicts: [],
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ state: 'not_published', pick: null, conflict: null });
    // The conflicts read is what makes the two states distinguishable at all, so
    // it must actually happen.
    expect(fake.tables()).toContain('benchmark_pick_ledger_conflicts');
  });

  it('gates the conflicts read too, so a pre-gate conflict is not disclosed', async () => {
    const { fake } = await call({}, { benchmark_pick_ledger: [] });
    const conflicts = fake.requests.find((r) => r.path === '/rest/v1/benchmark_pick_ledger_conflicts');
    expect(conflicts?.params.get('slate_date')).toBe(`gte.${MIN_SLATE}`);
  });
});

describe('pick detail — failure', () => {
  it('fails closed on a read error rather than reporting not_published', async () => {
    // A 500 and "no such pick" must never be the same answer: one is an outage,
    // the other is a statement about the data.
    const { status, body } = await call({}, {}, {}, (req) =>
      req.path === '/rest/v1/benchmark_pick_ledger'
        ? { status: 500, body: { message: 'injected read failure' } }
        : undefined);
    expect(status).toBeGreaterThanOrEqual(500);
    expect(body.state).toBeUndefined();
  });
});
