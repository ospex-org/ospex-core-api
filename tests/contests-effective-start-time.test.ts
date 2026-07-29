/**
 * The start-time contract for every contest-shaped surface.
 *
 * Four wire surfaces serve a contest's start time, and all four must agree:
 *
 *   1. `GET /v1/contests`              (list)
 *   2. `GET /v1/contests?since=`       (recovery) — shares its mapper with
 *      `GET /v1/stream/contests`
 *   3. `GET /v1/contests/:contestId`   (detail)
 *   4. `GET /v1/speculations/:id`      (parent-contest context)
 *
 * Each serves THREE fields:
 *   - `matchTime`      = the view's `effective_start_time`, i.e. the EARLIEST
 *                        start we know of. A conservative safety bound, not a
 *                        prediction of first pitch.
 *   - `chainStartTime` = the raw immutable `contests.start_time`.
 *   - `gameMatchTime`  = the raw joined `games.match_time`.
 *
 * All three use the `?? ''` sentinel, never a parsed date — a null must never
 * become epoch (that would read as "already started" and stand the fleet down).
 *
 * SCOPE NOTE: the minimum itself is computed in Postgres by the
 * `contests_effective` view (`LEAST(...)` over a `(network, jsonodds_id)`
 * join). This suite cannot execute that SQL. What it DOES enforce is
 * everything this service owns: that the three columns are read from the view
 * and mapped to the right three wire fields without swapping or dropping any,
 * that the list window filters/orders on the same value it serves, and that no
 * handler ever reconstructs the join itself off the poisoned
 * `games.contest_id` pointer.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { encodeCursor } from '../src/lib/cursor.js';

const SCORERS = {
  moneyline: '0x1111111111111111111111111111111111111111',
  spread: '0x2222222222222222222222222222222222222222',
  total: '0x3333333333333333333333333333333333333333',
};

const supabaseMock = vi.hoisted(() => ({ getSupabase: vi.fn() }));
const envMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    network: 'polygon',
    chainId: 137,
    scorers: {
      moneyline: '0x1111111111111111111111111111111111111111',
      spread: '0x2222222222222222222222222222222222222222',
      total: '0x3333333333333333333333333333333333333333',
    },
  })),
}));

vi.mock('../src/lib/supabase.js', () => supabaseMock);
vi.mock('../src/lib/env.js', () => envMock);

const { getContestsHandler, getContestByIdHandler } = await import('../src/v1/contests.js');
const { getSpeculationByIdHandler } = await import('../src/v1/speculations.js');
const { STREAM_RESOURCES } = await import('../src/v1/stream/resources.js');

// ── test doubles ────────────────────────────────────────────────────────

interface FakeRes {
  statusCode?: number;
  body?: unknown;
  status: (code: number) => FakeRes;
  json: (body: unknown) => FakeRes;
}
function makeRes(): FakeRes {
  const res: FakeRes = {
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}
function makeReq(query: Record<string, string> = {}, params: Record<string, string> = {}): Request {
  return { params, query } as unknown as Request;
}

interface MockResponse {
  data: unknown;
  error: unknown;
  count?: number;
}
interface RecordedCall {
  table: string;
  method: string;
  args: unknown[];
}

/**
 * Per-table response queue that ALSO records every `(table, method, args)`
 * triple, so a test can assert on the query shape (which column a filter ran
 * on, which key a join used) and not only on the response body.
 */
function makeRecordingSupabase(tables: Record<string, MockResponse | MockResponse[]>): {
  client: { from: (table: string) => unknown };
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const callCounts = new Map<string, number>();
  const client = {
    from(table: string): unknown {
      calls.push({ table, method: 'from', args: [table] });
      const responses = tables[table];
      const arr = Array.isArray(responses) ? responses : responses ? [responses] : [];
      const count = callCounts.get(table) ?? 0;
      callCounts.set(table, count + 1);
      const response: MockResponse = arr[Math.min(count, arr.length - 1)] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      const chain =
        (method: string) =>
        (...args: unknown[]): unknown => {
          calls.push({ table, method, args });
          return builder;
        };
      for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'not', 'or', 'order', 'range', 'limit']) {
        builder[m] = chain(m);
      }
      builder['maybeSingle'] = (): Promise<MockResponse> => Promise.resolve(response);
      builder['single'] = (): Promise<MockResponse> => Promise.resolve(response);
      builder['then'] = (resolve: (v: unknown) => void): void => resolve(response);
      return builder;
    },
  };
  return { client, calls };
}

function callsOn(calls: RecordedCall[], table: string, method: string): RecordedCall[] {
  return calls.filter((c) => c.table === table && c.method === method);
}

// ── the matrix ──────────────────────────────────────────────────────────
//
// `eff` is what Postgres `LEAST(start_time, game_match_time)` returns for the
// pair (LEAST ignores NULLs; it is NULL only when both are). The expectations
// are written out as literals rather than derived, so a mapping bug can't be
// masked by a shared helper.

interface TimeCase {
  name: string;
  chain: string | null;
  game: string | null;
  eff: string | null;
  expect: { matchTime: string; chainStartTime: string; gameMatchTime: string };
}

const CASES: TimeCase[] = [
  {
    name: 'game EARLIER than chain (Mode A move-up) → serves the game time',
    chain: '2026-05-04T01:00:00Z',
    game: '2026-05-04T00:10:00Z',
    eff: '2026-05-04T00:10:00Z',
    expect: {
      matchTime: '2026-05-04T00:10:00Z',
      chainStartTime: '2026-05-04T01:00:00Z',
      gameMatchTime: '2026-05-04T00:10:00Z',
    },
  },
  {
    name: 'game LATER than chain (reschedule) → serves the chain time',
    chain: '2026-05-04T01:00:00Z',
    game: '2026-05-04T02:45:00Z',
    eff: '2026-05-04T01:00:00Z',
    expect: {
      matchTime: '2026-05-04T01:00:00Z',
      chainStartTime: '2026-05-04T01:00:00Z',
      gameMatchTime: '2026-05-04T02:45:00Z',
    },
  },
  {
    name: 'chain and game AGREE',
    chain: '2026-05-04T01:00:00Z',
    game: '2026-05-04T01:00:00Z',
    eff: '2026-05-04T01:00:00Z',
    expect: {
      matchTime: '2026-05-04T01:00:00Z',
      chainStartTime: '2026-05-04T01:00:00Z',
      gameMatchTime: '2026-05-04T01:00:00Z',
    },
  },
  {
    name: 'NO games row joined → degrades to the chain time, gameMatchTime is the "" sentinel',
    chain: '2026-05-04T01:00:00Z',
    game: null,
    eff: '2026-05-04T01:00:00Z',
    expect: {
      matchTime: '2026-05-04T01:00:00Z',
      chainStartTime: '2026-05-04T01:00:00Z',
      gameMatchTime: '',
    },
  },
  {
    name: 'NULL chain start (unverified) with a games row → degrades to the game time',
    chain: null,
    game: '2026-05-04T02:00:00Z',
    eff: '2026-05-04T02:00:00Z',
    expect: {
      matchTime: '2026-05-04T02:00:00Z',
      chainStartTime: '',
      gameMatchTime: '2026-05-04T02:00:00Z',
    },
  },
  {
    name: 'BOTH null → all three are the "" sentinel, never an epoch date',
    chain: null,
    game: null,
    eff: null,
    expect: { matchTime: '', chainStartTime: '', gameMatchTime: '' },
  },
];

/** Fixture sanity: each case's `eff` really is LEAST(chain, game). Not a product guarantee. */
function leastOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a <= b ? a : b;
}

// ── row builders (shapes the view returns) ──────────────────────────────

function listRow(c: TimeCase): Record<string, unknown> {
  return {
    contest_id: 42,
    away_team: 'Lakers',
    home_team: 'Celtics',
    sport_slug: 'nba',
    jsonodds_sport_id: 1,
    start_time: c.chain,
    effective_start_time: c.eff,
    game_match_time: c.game,
    contest_status: 'verified',
  };
}

function recoveryRow(c: TimeCase): Record<string, unknown> {
  return {
    contest_id: 42,
    away_team: 'Lakers',
    home_team: 'Celtics',
    sport_slug: 'nba',
    jsonodds_sport_id: 1,
    start_time: c.chain,
    effective_start_time: c.eff,
    game_match_time: c.game,
    contest_status: 'verified',
    away_score: null,
    home_score: null,
    verified_at: null,
    scored_at: null,
    voided_at: null,
    contest_created_at: null,
    id: 9,
    row_updated_at: '2026-05-01T00:00:00.000Z',
  };
}

function detailRow(c: TimeCase, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contest_id: 42,
    jsonodds_id: 'a783e37e-4ce1-4f42-9dd6-615568f73044',
    rundown_id: 'r1',
    sportspage_id: 's1',
    contest_creator: '0x' + '00'.repeat(20),
    league_id: 'nba',
    verify_source_hash: null,
    market_update_source_hash: null,
    score_contest_source_hash: null,
    away_team: 'Lakers',
    home_team: 'Celtics',
    sport_slug: 'nba',
    jsonodds_sport_id: 1,
    start_time: c.chain,
    effective_start_time: c.eff,
    game_match_time: c.game,
    contest_status: 'verified',
    away_score: null,
    home_score: null,
    contest_created_at: null,
    verified_at: null,
    scored_at: null,
    voided_at: null,
    ...overrides,
  };
}

function contextRow(c: TimeCase, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contest_id: 42,
    jsonodds_id: 'a783e37e-4ce1-4f42-9dd6-615568f73044',
    away_team: 'Lakers',
    home_team: 'Celtics',
    sport_slug: 'nba',
    start_time: c.chain,
    effective_start_time: c.eff,
    game_match_time: c.game,
    contest_status: 'verified',
    ...overrides,
  };
}

const SPEC_ROW = {
  speculation_id: 100,
  contest_id: 42,
  speculation_scorer: SCORERS.moneyline,
  market_type: 'moneyline',
  line_ticks: 0,
  speculation_status: 'open',
};

interface TimeFields {
  matchTime: string;
  chainStartTime: string;
  gameMatchTime: string;
}

// ── the sweep ───────────────────────────────────────────────────────────

describe('start-time fields — matrix across every contest-shaped surface', () => {
  it('every fixture encodes LEAST(chain, game) correctly (fixture self-check)', () => {
    for (const c of CASES) expect(leastOf(c.chain, c.game)).toBe(c.eff);
  });

  for (const c of CASES) {
    describe(c.name, () => {
      it('GET /v1/contests (list)', async () => {
        const { client } = makeRecordingSupabase({
          contests_effective: { data: [listRow(c)], error: null, count: 1 },
          speculations: { data: [], error: null },
        });
        supabaseMock.getSupabase.mockReturnValue(client);
        const res = makeRes();
        await getContestsHandler(makeReq({ limit: '10' }), res as unknown as Response);
        expect(res.statusCode).toBe(200);
        const body = res.body as { contests: TimeFields[] };
        expect(body.contests[0]).toMatchObject(c.expect);
      });

      it('GET /v1/contests?since= (recovery + the SSE contests mapper)', async () => {
        const { client } = makeRecordingSupabase({
          contests_effective: { data: [recoveryRow(c)], error: null },
        });
        supabaseMock.getSupabase.mockReturnValue(client);
        const cursor = encodeCursor({ t: 'contests', s: '2026-05-01T00:00:00.000Z', i: '1', k: 'page' });
        const res = makeRes();
        await getContestsHandler(makeReq({ since: cursor }), res as unknown as Response);
        expect(res.statusCode).toBe(200);
        const body = res.body as { contests: TimeFields[] };
        expect(body.contests[0]).toMatchObject(c.expect);

        // Same mapper, invoked exactly as the SSE poller invokes it — the
        // stream body must not diverge from the recovery body.
        const streamBody = STREAM_RESOURCES.contests.toBody(
          recoveryRow(c) as unknown as Parameters<typeof STREAM_RESOURCES.contests.toBody>[0],
        );
        expect(streamBody).toMatchObject(c.expect);
      });

      it('GET /v1/contests/:contestId (detail)', async () => {
        const { client } = makeRecordingSupabase({
          contests_effective: { data: detailRow(c), error: null },
          speculations: { data: [], error: null },
          commitments: { data: [], error: null },
          games: { data: { away_team_id: 'lakers-uuid', home_team_id: 'celtics-uuid' }, error: null },
        });
        supabaseMock.getSupabase.mockReturnValue(client);
        const res = makeRes();
        await getContestByIdHandler(makeReq({}, { contestId: '42' }), res as unknown as Response);
        expect(res.statusCode).toBe(200);
        expect(res.body as TimeFields).toMatchObject(c.expect);
      });

      it('GET /v1/speculations/:speculationId (parent contest context)', async () => {
        const { client } = makeRecordingSupabase({
          speculations: { data: SPEC_ROW, error: null },
          contests_effective: { data: contextRow(c), error: null },
          commitments: { data: [], error: null },
          games: { data: { away_team_id: 'lakers-uuid', home_team_id: 'celtics-uuid' }, error: null },
        });
        supabaseMock.getSupabase.mockReturnValue(client);
        const res = makeRes();
        await getSpeculationByIdHandler(makeReq({}, { speculationId: '100' }), res as unknown as Response);
        expect(res.statusCode).toBe(200);
        const body = res.body as { contest: TimeFields };
        expect(body.contest).toMatchObject(c.expect);
      });
    });
  }
});

// ── the served value never exceeds the on-chain value ───────────────────

describe('invariant: matchTime <= chainStartTime whenever both are present', () => {
  it('holds across the whole matrix on the list surface', async () => {
    for (const c of CASES) {
      const { client } = makeRecordingSupabase({
        contests_effective: { data: [listRow(c)], error: null, count: 1 },
        speculations: { data: [], error: null },
      });
      supabaseMock.getSupabase.mockReturnValue(client);
      const res = makeRes();
      await getContestsHandler(makeReq({ limit: '10' }), res as unknown as Response);
      const row = (res.body as { contests: TimeFields[] }).contests[0]!;
      if (row.matchTime !== '' && row.chainStartTime !== '') {
        // Both are the same ISO-8601 `...Z` shape here, so lexicographic
        // ordering equals chronological ordering. No Date.parse — a parse
        // would truncate timestamptz microseconds.
        expect(row.matchTime <= row.chainStartTime).toBe(true);
      }
    }
  });
});

// ── query shape: the list window filters what it serves ─────────────────

describe('GET /v1/contests — window filter + ordering run on effective_start_time', () => {
  async function runList(): Promise<RecordedCall[]> {
    const { client, calls } = makeRecordingSupabase({
      contests_effective: { data: [], error: null, count: 0 },
      speculations: { data: [], error: null },
    });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getContestsHandler(makeReq({ limit: '10' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    return calls;
  }

  it('reads the contests_effective view, not the base contests table', async () => {
    const calls = await runList();
    expect(calls.some((c) => c.method === 'from' && c.table === 'contests_effective')).toBe(true);
    expect(calls.some((c) => c.method === 'from' && c.table === 'contests')).toBe(false);
  });

  it('bounds and orders the window on effective_start_time, never on start_time', async () => {
    const calls = await runList();
    const gteCols = callsOn(calls, 'contests_effective', 'gte').map((c) => c.args[0]);
    const lteCols = callsOn(calls, 'contests_effective', 'lte').map((c) => c.args[0]);
    const orderCols = callsOn(calls, 'contests_effective', 'order').map((c) => c.args[0]);
    expect(gteCols).toContain('effective_start_time');
    expect(lteCols).toContain('effective_start_time');
    expect(orderCols).toContain('effective_start_time');
    // Negative control — the raw column must not be reintroduced as the bound.
    expect(gteCols).not.toContain('start_time');
    expect(lteCols).not.toContain('start_time');
    expect(orderCols).not.toContain('start_time');
  });

  it('still excludes contests with a NULL start_time (unverified stay invisible)', async () => {
    const calls = await runList();
    const notCalls = callsOn(calls, 'contests_effective', 'not').map((c) => JSON.stringify(c.args));
    expect(notCalls).toContain(JSON.stringify(['start_time', 'is', null]));
  });
});

// ── BLOCKER-1 regression: never join games on contest_id ────────────────

describe('the games join key is jsonodds_id — never the poisoned games.contest_id', () => {
  // `games.contest_id` is a nullable back-pointer with no unique constraint,
  // and contest ids restart from 1 on a protocol redeploy. Rows written under a
  // previous deployment kept their old pointer, so in production a single
  // contest_id resolves to more than one games row — weeks apart. Joining on it
  // would hand back some unrelated older game's time and make the majority of
  // contests instantly report "already started". `(network, jsonodds_id)` is
  // the games primary key and the only safe join.
  const STALE_POINTER_MATCH_TIME = '2026-04-01T23:30:00Z'; // ~1 month before the real game
  const CASE: TimeCase = {
    name: 'stale-pointer guard',
    chain: '2026-05-04T01:00:00Z',
    game: '2026-05-04T00:10:00Z',
    eff: '2026-05-04T00:10:00Z',
    expect: {
      matchTime: '2026-05-04T00:10:00Z',
      chainStartTime: '2026-05-04T01:00:00Z',
      gameMatchTime: '2026-05-04T00:10:00Z',
    },
  };

  it('detail: serves the joined time and issues no contest_id-keyed games query', async () => {
    const { client, calls } = makeRecordingSupabase({
      contests_effective: { data: detailRow(CASE), error: null },
      speculations: { data: [], error: null },
      commitments: { data: [], error: null },
      // A stale-pointer row from a previous deployment: different jsonodds_id, a
      // match_time, same contest_id. Any handler that re-derived the join off
      // contest_id would pick this up.
      games: {
        data: {
          away_team_id: 'lakers-uuid',
          home_team_id: 'celtics-uuid',
          jsonodds_id: 'stale-pointer-jsonodds-id',
          contest_id: 42,
          match_time: STALE_POINTER_MATCH_TIME,
        },
        error: null,
      },
    });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getContestByIdHandler(makeReq({}, { contestId: '42' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as TimeFields;
    expect(body).toMatchObject(CASE.expect);
    expect(body.matchTime).not.toBe(STALE_POINTER_MATCH_TIME);

    const gamesEqCols = callsOn(calls, 'games', 'eq').map((c) => c.args[0]);
    // Negative control: `games` IS queried here (team-id resolve), so the
    // absence of a contest_id filter is a real observation, not a vacuous one.
    expect(gamesEqCols).toContain('jsonodds_id');
    expect(gamesEqCols).not.toContain('contest_id');
  });

  it('speculation detail: same guard on the parent-context path', async () => {
    const { client, calls } = makeRecordingSupabase({
      speculations: { data: SPEC_ROW, error: null },
      contests_effective: { data: contextRow(CASE), error: null },
      commitments: { data: [], error: null },
      games: {
        data: {
          away_team_id: 'lakers-uuid',
          home_team_id: 'celtics-uuid',
          jsonodds_id: 'stale-pointer-jsonodds-id',
          contest_id: 42,
          match_time: STALE_POINTER_MATCH_TIME,
        },
        error: null,
      },
    });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getSpeculationByIdHandler(makeReq({}, { speculationId: '100' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { contest: TimeFields };
    expect(body.contest).toMatchObject(CASE.expect);
    expect(body.contest.matchTime).not.toBe(STALE_POINTER_MATCH_TIME);

    const gamesEqCols = callsOn(calls, 'games', 'eq').map((c) => c.args[0]);
    expect(gamesEqCols).toContain('jsonodds_id');
    expect(gamesEqCols).not.toContain('contest_id');
  });

  it('list: resolves the time from the view row alone — no games query at all', async () => {
    const { client, calls } = makeRecordingSupabase({
      contests_effective: { data: [listRow(CASE)], error: null, count: 1 },
      speculations: { data: [], error: null },
    });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getContestsHandler(makeReq({ limit: '10' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect((res.body as { contests: TimeFields[] }).contests[0]).toMatchObject(CASE.expect);
    expect(calls.some((c) => c.table === 'games')).toBe(false);
  });
});

// ── SSE resource registry ───────────────────────────────────────────────

describe('the contests stream resource reads the view', () => {
  it('polls contests_effective while keeping the contests cursor tag', () => {
    expect(STREAM_RESOURCES.contests.table).toBe('contests_effective');
    // The cursor identity must NOT change — clients hold `t: 'contests'`
    // cursors and `decodeCursor` rejects a mismatched tag.
    expect(STREAM_RESOURCES.contests.cursorTable).toBe('contests');
  });

  it('selects both view columns so toBody can stay synchronous', () => {
    expect(STREAM_RESOURCES.contests.columns).toContain('effective_start_time');
    expect(STREAM_RESOURCES.contests.columns).toContain('game_match_time');
  });
});
