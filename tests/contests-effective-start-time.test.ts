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
 *   - `chainStartTime` = the raw `contests.start_time`.
 *   - `gameMatchTime`  = the raw joined `games.match_time`.
 *
 * All three use the `?? ''` sentinel, never a parsed date — a null must never
 * become epoch (that would read as "already started" and stand the fleet down).
 *
 * SCOPE NOTE: the minimum itself is computed in Postgres by the
 * `contests_effective` view (`LEAST(...)` over a `(network, jsonodds_id)`
 * join). This suite cannot execute that SQL. What it DOES enforce is
 * everything this service owns:
 *
 *   - the three columns are SELECTED on every surface (the mock projects rows
 *     to the requested column list exactly as PostgREST does, so dropping a
 *     column from a select string serves `''` and turns the matrix red);
 *   - they are mapped to the right three wire fields without swapping;
 *   - the list window filters/orders on the same value it serves;
 *   - no handler reconstructs the join itself, off the poisoned
 *     `games.contest_id` pointer OR off a correctly-keyed second lookup;
 *   - the documented consumer gate predicate holds, and the one documented
 *     exception to the naive predicate is real.
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
 * Parse a PostgREST select string into the set of column names it requests.
 * Returns null for anything this simple projector shouldn't touch (`*`, or an
 * embedded-resource select) so those queries pass through unprojected.
 */
function parseSelectedColumns(select: unknown): Set<string> | null {
  if (typeof select !== 'string') return null;
  if (select.includes('*') || select.includes('(')) return null;
  const cols = select
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  return cols.length > 0 ? new Set(cols) : null;
}

/**
 * Drop every key the select string did not ask for.
 *
 * This is the behaviour that makes the select strings testable at all:
 * PostgREST returns ONLY the requested columns, so an omitted column arrives
 * as `undefined` and the mappers' `?? ''` turns it into the empty sentinel —
 * a silent wrong answer, not an error. Without this projection a test can
 * assert the mapping is right while the query that feeds it has stopped
 * selecting the column.
 */
function projectRow(data: unknown, cols: Set<string> | null): unknown {
  if (cols === null || data === null || data === undefined) return data;
  const one = (row: unknown): unknown => {
    if (typeof row !== 'object' || row === null) return row;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (cols.has(k)) out[k] = v;
    }
    return out;
  };
  return Array.isArray(data) ? data.map(one) : one(data);
}

/**
 * Per-table response queue that ALSO
 *   (a) records every `(table, method, args)` triple, so a test can assert on
 *       the query shape — which column a filter ran on, which key a join used;
 *   (b) projects each response to the columns its `select()` actually named,
 *       the way PostgREST does.
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

      let selected: Set<string> | null = null;
      const resolved = (): MockResponse => ({ ...response, data: projectRow(response.data, selected) });

      const builder: Record<string, unknown> = {};
      const chain =
        (method: string) =>
        (...args: unknown[]): unknown => {
          calls.push({ table, method, args });
          if (method === 'select') selected = parseSelectedColumns(args[0]);
          return builder;
        };
      for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'not', 'or', 'order', 'range', 'limit']) {
        builder[m] = chain(m);
      }
      builder['maybeSingle'] = (): Promise<MockResponse> => Promise.resolve(resolved());
      builder['single'] = (): Promise<MockResponse> => Promise.resolve(resolved());
      builder['then'] = (resolve: (v: unknown) => void): void => resolve(resolved());
      return builder;
    },
  };
  return { client, calls };
}

function callsOn(calls: RecordedCall[], table: string, method: string): RecordedCall[] {
  return calls.filter((c) => c.table === table && c.method === method);
}

/** The select string a table's Nth (0-based) query used. */
function selectArg(calls: RecordedCall[], table: string, nth = 0): string {
  const sel = callsOn(calls, table, 'select')[nth];
  return typeof sel?.args[0] === 'string' ? (sel.args[0] as string) : '';
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

/** The one case that falsifies a naive `matchTime <= chainStartTime`. */
const UNVERIFIED_CASE = CASES[4]!;

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

/** A plain (non-stale) games row for the team-id resolve. */
const TEAM_IDS_ROW = { away_team_id: 'lakers-uuid', home_team_id: 'celtics-uuid' };

interface TimeFields {
  matchTime: string;
  chainStartTime: string;
  gameMatchTime: string;
}

// ── per-surface drivers ─────────────────────────────────────────────────
//
// Each returns BOTH the served time fields and the recorded calls, so the same
// driver serves the value assertions and the query-shape assertions.

interface SurfaceRun {
  fields: TimeFields;
  calls: RecordedCall[];
}

async function runList(c: TimeCase): Promise<SurfaceRun> {
  const { client, calls } = makeRecordingSupabase({
    contests_effective: { data: [listRow(c)], error: null, count: 1 },
    speculations: { data: [], error: null },
  });
  supabaseMock.getSupabase.mockReturnValue(client);
  const res = makeRes();
  await getContestsHandler(makeReq({ limit: '10' }), res as unknown as Response);
  expect(res.statusCode).toBe(200);
  return { fields: (res.body as { contests: TimeFields[] }).contests[0]!, calls };
}

async function runRecovery(c: TimeCase): Promise<SurfaceRun> {
  const { client, calls } = makeRecordingSupabase({
    contests_effective: { data: [recoveryRow(c)], error: null },
  });
  supabaseMock.getSupabase.mockReturnValue(client);
  const cursor = encodeCursor({ t: 'contests', s: '2026-05-01T00:00:00.000Z', i: '1', k: 'page' });
  const res = makeRes();
  await getContestsHandler(makeReq({ since: cursor }), res as unknown as Response);
  expect(res.statusCode).toBe(200);
  return { fields: (res.body as { contests: TimeFields[] }).contests[0]!, calls };
}

async function runDetail(c: TimeCase, gamesRow: Record<string, unknown> = TEAM_IDS_ROW): Promise<SurfaceRun> {
  const { client, calls } = makeRecordingSupabase({
    contests_effective: { data: detailRow(c), error: null },
    speculations: { data: [], error: null },
    commitments: { data: [], error: null },
    games: { data: gamesRow, error: null },
  });
  supabaseMock.getSupabase.mockReturnValue(client);
  const res = makeRes();
  await getContestByIdHandler(makeReq({}, { contestId: '42' }), res as unknown as Response);
  expect(res.statusCode).toBe(200);
  return { fields: res.body as TimeFields, calls };
}

async function runSpecContext(
  c: TimeCase,
  gamesRow: Record<string, unknown> = TEAM_IDS_ROW,
): Promise<SurfaceRun> {
  const { client, calls } = makeRecordingSupabase({
    speculations: { data: SPEC_ROW, error: null },
    contests_effective: { data: contextRow(c), error: null },
    commitments: { data: [], error: null },
    games: { data: gamesRow, error: null },
  });
  supabaseMock.getSupabase.mockReturnValue(client);
  const res = makeRes();
  await getSpeculationByIdHandler(makeReq({}, { speculationId: '100' }), res as unknown as Response);
  expect(res.statusCode).toBe(200);
  return { fields: (res.body as { contest: TimeFields }).contest, calls };
}

const SURFACES: Array<{ name: string; run: (c: TimeCase) => Promise<SurfaceRun> }> = [
  { name: 'GET /v1/contests (list)', run: runList },
  { name: 'GET /v1/contests?since= (recovery)', run: runRecovery },
  { name: 'GET /v1/contests/:contestId (detail)', run: runDetail },
  { name: 'GET /v1/speculations/:speculationId (parent contest)', run: runSpecContext },
];

// ── the sweep ───────────────────────────────────────────────────────────

describe('start-time fields — matrix across every contest-shaped surface', () => {
  it('every fixture encodes LEAST(chain, game) correctly (fixture self-check)', () => {
    for (const c of CASES) expect(leastOf(c.chain, c.game)).toBe(c.eff);
  });

  for (const c of CASES) {
    describe(c.name, () => {
      for (const surface of SURFACES) {
        it(surface.name, async () => {
          const { fields } = await surface.run(c);
          expect(fields).toMatchObject(c.expect);
        });
      }

      it('GET /v1/stream/contests (the SSE mapper, invoked as the poller invokes it)', () => {
        const streamBody = STREAM_RESOURCES.contests.toBody(
          recoveryRow(c) as unknown as Parameters<typeof STREAM_RESOURCES.contests.toBody>[0],
        );
        expect(streamBody).toMatchObject(c.expect);
      });
    });
  }
});

// ── every surface actually SELECTS all three time columns ───────────────
//
// The mock projects to the requested column list, so these two layers are
// independent: the assertions below name the defect precisely, and the matrix
// above goes red from the served value even if these were deleted.

describe('every contest-shaped query selects all three time columns', () => {
  const TIME_COLUMNS = ['start_time', 'effective_start_time', 'game_match_time'] as const;

  for (const surface of SURFACES) {
    it(`${surface.name} selects them from contests_effective`, async () => {
      const { calls } = await surface.run(CASES[0]!);
      const select = selectArg(calls, 'contests_effective');
      for (const col of TIME_COLUMNS) {
        expect(select.split(',').map((s) => s.trim())).toContain(col);
      }
    });
  }

  it('the SSE resource column constant carries them too', () => {
    const cols = STREAM_RESOURCES.contests.columns.split(',').map((s) => s.trim());
    for (const col of TIME_COLUMNS) expect(cols).toContain(col);
  });

  it('MOCK SELF-CHECK: the projector really drops unrequested keys', () => {
    // Asserts the test double, not product code — labelled so it is not
    // mistaken for a product guarantee. Its purpose is to keep the projection
    // honest: without it, the matrix above would pass on a query that had
    // stopped selecting the column, because the mock would hand back a field
    // nobody asked for.
    //
    // A response-body negative control CANNOT show this: the handlers build
    // their bodies key by key, so an unrequested row column never reaches the
    // wire either way. (An earlier draft of this test tried exactly that and
    // was vacuous — it stayed green with the projection disabled.) The
    // product-level proof is a mutation: dropping a column from a select
    // string turns the matrix red even with these name assertions skipped.
    const cols = new Set(['a', 'b']);
    expect(projectRow({ a: 1, b: 2, c: 3 }, cols)).toEqual({ a: 1, b: 2 });
    expect(projectRow([{ a: 1, c: 3 }], cols)).toEqual([{ a: 1 }]);
    // `null` cols = "don't project" (a `*` or embedded select) — pass through.
    expect(projectRow({ a: 1, c: 3 }, null)).toEqual({ a: 1, c: 3 });
  });
});

// ── the ordering guarantee, and its one documented exception ────────────

/** The predicate the README and the type jsdoc tell consumers to use. */
function documentedGate(b: TimeFields): boolean {
  return b.chainStartTime === '' || b.matchTime <= b.chainStartTime;
}
/** The predicate a reader would write if the guarantee were unconditional. */
function naiveGate(b: TimeFields): boolean {
  return b.matchTime <= b.chainStartTime;
}

describe('ordering guarantee: matchTime <= chainStartTime WHENEVER chainStartTime is present', () => {
  for (const surface of SURFACES) {
    it(`holds across the whole matrix on ${surface.name}`, async () => {
      for (const c of CASES) {
        const { fields } = await surface.run(c);
        // Both values are the same ISO-8601 `...Z` shape, so lexicographic
        // ordering equals chronological ordering. No Date.parse — a parse
        // would truncate timestamptz microseconds.
        expect(documentedGate(fields)).toBe(true);
        if (fields.chainStartTime !== '') {
          expect(fields.matchTime <= fields.chainStartTime).toBe(true);
        }
      }
    });
  }

  it('the unverified window is a REAL counterexample to the naive predicate', async () => {
    // `contests.start_time` is NULL between CONTEST_CREATED and
    // CONTEST_VERIFIED. With a games row already linked, the body carries a
    // non-empty matchTime beside an empty chainStartTime — so an unqualified
    // `matchTime <= chainStartTime` is FALSE. This is exactly why the README
    // and the SpeculationParentContext jsdoc qualify the guarantee instead of
    // stating it flat, and why an operator gate must short-circuit on `''`.
    //
    // If this ever stops being true — e.g. chainStartTime gains a fallback —
    // this test goes red and the qualification must be revisited.
    for (const surface of SURFACES) {
      const { fields } = await surface.run(UNVERIFIED_CASE);
      expect(fields.chainStartTime).toBe('');
      expect(fields.matchTime).not.toBe('');
      expect(naiveGate(fields)).toBe(false);
      expect(documentedGate(fields)).toBe(true);
    }
  });

  it('negative control: the naive predicate DOES hold once the contest is verified', async () => {
    // Pairs with the counterexample above — the qualification is needed only
    // for the unverified window, not everywhere.
    for (const surface of SURFACES) {
      const { fields } = await surface.run(CASES[0]!);
      expect(fields.chainStartTime).not.toBe('');
      expect(naiveGate(fields)).toBe(true);
    }
  });
});

// ── query shape: the list window filters what it serves ─────────────────

describe('GET /v1/contests — window filter + ordering run on effective_start_time', () => {
  async function emptyList(): Promise<RecordedCall[]> {
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
    const calls = await emptyList();
    expect(calls.some((c) => c.method === 'from' && c.table === 'contests_effective')).toBe(true);
    expect(calls.some((c) => c.method === 'from' && c.table === 'contests')).toBe(false);
  });

  it('bounds and orders the window on effective_start_time, never on start_time', async () => {
    const calls = await emptyList();
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
    const calls = await emptyList();
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
  // A stale-pointer row from a previous deployment: different jsonodds_id, its
  // own match_time, SAME contest_id. Any handler that re-derived the join off
  // contest_id would pick this up.
  const STALE_GAMES_ROW = {
    ...TEAM_IDS_ROW,
    jsonodds_id: 'stale-pointer-jsonodds-id',
    contest_id: 42,
    match_time: STALE_POINTER_MATCH_TIME,
  };

  it('detail: serves the joined time and issues no contest_id-keyed games query', async () => {
    const { fields, calls } = await runDetail(CASE, STALE_GAMES_ROW);
    expect(fields).toMatchObject(CASE.expect);
    expect(fields.matchTime).not.toBe(STALE_POINTER_MATCH_TIME);

    const gamesEqCols = callsOn(calls, 'games', 'eq').map((c) => c.args[0]);
    // Negative control: `games` IS queried here (team-id resolve), so the
    // absence of a contest_id filter is a real observation, not a vacuous one.
    expect(gamesEqCols).toContain('jsonodds_id');
    expect(gamesEqCols).not.toContain('contest_id');
  });

  it('speculation detail: same guard on the parent-context path', async () => {
    const { fields, calls } = await runSpecContext(CASE, STALE_GAMES_ROW);
    expect(fields).toMatchObject(CASE.expect);
    expect(fields.matchTime).not.toBe(STALE_POINTER_MATCH_TIME);

    const gamesEqCols = callsOn(calls, 'games', 'eq').map((c) => c.args[0]);
    expect(gamesEqCols).toContain('jsonodds_id');
    expect(gamesEqCols).not.toContain('contest_id');
  });

  it('list: resolves the time from the view row alone — no games query at all', async () => {
    const { fields, calls } = await runList(CASE);
    expect(fields).toMatchObject(CASE.expect);
    expect(calls.some((c) => c.table === 'games')).toBe(false);
  });
});

// ── the min comes from the view, not from a second lookup in JS ─────────

describe('no handler re-derives the minimum from a games lookup', () => {
  // The whole reason for the view is that `StreamResource.toBody` is a
  // SYNCHRONOUS interface and the list window has to filter on the same value
  // it serves. A JS re-derivation would defeat both — and would need
  // `match_time` from the `games` table, which nothing here asks for. The
  // detail and speculation-context paths DO query `games` (team-id resolve),
  // so this is where such a re-derivation would most plausibly appear.
  for (const [label, run] of [
    ['contest detail', runDetail],
    ['speculation parent context', runSpecContext],
  ] as const) {
    it(`${label}: the games query fetches team ids only, never a time column`, async () => {
      const { calls } = await run(CASES[0]!);
      const select = selectArg(calls, 'games')
        .split(',')
        .map((s) => s.trim());
      // Positive control: the games query really happens and really asks for
      // what it is supposed to.
      expect(select).toContain('away_team_id');
      expect(select).toContain('home_team_id');
      // The guard itself.
      expect(select).not.toContain('match_time');
      expect(select).not.toContain('effective_start_time');
    });
  }
});

// ── SSE resource registry ───────────────────────────────────────────────

describe('the contests stream resource reads the view', () => {
  it('polls contests_effective while keeping the contests cursor tag', () => {
    expect(STREAM_RESOURCES.contests.table).toBe('contests_effective');
    // The cursor identity must NOT change — clients hold `t: 'contests'`
    // cursors and `decodeCursor` rejects a mismatched tag.
    expect(STREAM_RESOURCES.contests.cursorTable).toBe('contests');
  });
});
