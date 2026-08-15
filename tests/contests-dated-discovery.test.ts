/**
 * Dated discovery — `GET /v1/contests?date=YYYY-MM-DD`.
 *
 * What this suite enforces:
 *
 *   - `date` validation: real-calendar UTC days only (the `Date.UTC`
 *     rollover of an impossible day is rejected), and `date`×`window`
 *     mutual exclusion — each with a passing negative control.
 *   - The dated query shape: a HALF-OPEN `[date 00:00Z, date+1 00:00Z)`
 *     window on `effective_start_time` — `gte`/`lt` with the exact literal
 *     bounds (they are input-derived, unlike the now-based default window,
 *     so the VALUES are pinned, not just the column names) — with the
 *     `.not('start_time','is',null)` eligibility rule retained.
 *   - The finality join: `games.final_type` read over `(network,
 *     jsonodds_id)` — never the poisoned `games.contest_id` back-pointer —
 *     and served VERBATIM as `gameFinalType` with the `''` sentinel.
 *   - The default (no-`date`) listing is UNCHANGED: same select string
 *     (no `jsonodds_id`), same `gte`/`lte` window, no `games` query, and
 *     no `gameFinalType` key on any row.
 *
 * The mock projects rows to the select()-ed column list the way PostgREST
 * does (see the MOCK SELF-CHECK), so "selects final_type" is enforced by
 * the served value, not just by string assertions.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

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

const { getContestsHandler } = await import('../src/v1/contests.js');

// ── test doubles (recording + projecting, as in
//    contests-effective-start-time.test.ts, plus `lt` for the half-open
//    dated upper bound) ─────────────────────────────────────────────────

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
function makeReq(query: Record<string, string> = {}): Request {
  return { params: {}, query } as unknown as Request;
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

function parseSelectedColumns(select: unknown): Set<string> | null {
  if (typeof select !== 'string') return null;
  if (select.includes('*') || select.includes('(')) return null;
  const cols = select
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  return cols.length > 0 ? new Set(cols) : null;
}

/** Drop every key the select string did not ask for — PostgREST behaviour. */
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
      for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lt', 'lte', 'not', 'or', 'order', 'range', 'limit']) {
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
function selectArg(calls: RecordedCall[], table: string): string {
  const sel = callsOn(calls, table, 'select')[0];
  return typeof sel?.args[0] === 'string' ? (sel.args[0] as string) : '';
}

// ── fixtures ────────────────────────────────────────────────────────────

/** A contests_effective row on the queried day. All columns the dated
 *  select names are present, so projection decides what survives. */
function dayRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    contest_id: 42,
    jsonodds_id: 'jo-cubs-reds',
    away_team: 'Cubs',
    home_team: 'Reds',
    sport_slug: 'mlb',
    jsonodds_sport_id: 5,
    start_time: '2026-08-14T18:10:00Z',
    effective_start_time: '2026-08-14T18:10:00Z',
    game_match_time: '2026-08-14T18:10:00Z',
    game_earliest_match_time: '2026-08-14T18:10:00Z',
    game_rundown_match_time: null,
    game_sportspage_match_time: null,
    contest_status: 'scored',
    ...over,
  };
}

// Five contests exercising every finality mapping shape at once. The
// distinct `final_type` values (`Finished` vs `Postponed`) make a swapped
// mapping visible, and the shared `jo-cubs-reds` on contests 42 + 46 pins
// the id-set dedup plus the shared lookup.
const DAY_ROWS = [
  dayRow({}), // 42 → 'Finished'
  dayRow({ contest_id: 43, jsonodds_id: 'jo-mets-braves', away_team: 'Mets', home_team: 'Braves' }), // → '' (final_type null)
  dayRow({ contest_id: 44, jsonodds_id: null, away_team: 'Sox', home_team: 'Yanks' }), // → '' (no linkage)
  dayRow({ contest_id: 45, jsonodds_id: 'jo-cards-brewers', away_team: 'Cards', home_team: 'Brewers' }), // → 'Postponed'
  dayRow({ contest_id: 46, away_team: 'Cubs', home_team: 'Reds' }), // doubleheader-ish sibling of 42 → 'Finished'
];

// `final_type` values are DISTINCT per game, and the decoy row is keyed by
// the STRING FORM OF A CONTEST ID ('42'): a lookup that joins on
// `contest_id` instead of `jsonodds_id` finds the decoy (or nothing) and
// turns the expectations below red either way.
const GAMES_ROWS = [
  { jsonodds_id: 'jo-cubs-reds', final_type: 'Finished' },
  { jsonodds_id: 'jo-mets-braves', final_type: null },
  { jsonodds_id: 'jo-cards-brewers', final_type: 'Postponed' },
  { jsonodds_id: '42', final_type: 'DECOY-WRONG-JOIN-KEY' },
];

interface DatedItem {
  contestId: string;
  matchTime: string;
  status: string;
  gameFinalType?: string;
}

async function runDated(
  query: Record<string, string>,
  tables?: Record<string, MockResponse | MockResponse[]>,
): Promise<{ res: FakeRes; calls: RecordedCall[] }> {
  const { client, calls } = makeRecordingSupabase(
    tables ?? {
      contests_effective: { data: DAY_ROWS, error: null, count: DAY_ROWS.length },
      speculations: { data: [], error: null },
      games: { data: GAMES_ROWS, error: null },
    },
  );
  supabaseMock.getSupabase.mockReturnValue(client);
  const res = makeRes();
  await getContestsHandler(makeReq(query), res as unknown as Response);
  return { res, calls };
}

// ── validation ──────────────────────────────────────────────────────────

describe('GET /v1/contests?date= — validation', () => {
  it('rejects date + window together, loudly', async () => {
    const { res } = await runDated({ date: '2026-08-14', window: '24' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
    expect((res.body as { error: string }).error).toContain('mutually exclusive');
  });

  it('negative control: window alone still works', async () => {
    const { res } = await runDated({ window: '24' }, {
      contests_effective: { data: [], error: null, count: 0 },
      speculations: { data: [], error: null },
    });
    expect(res.statusCode).toBe(200);
  });

  // '2026-02-29' does not exist (2026 is not a leap year) — `Date.UTC`
  // would roll it over to Mar 1, and the round-trip check refuses that.
  // '2028-02-29' is the same shape on a real leap day and must pass, so
  // the rejection is calendar integrity, not a blanket Feb-29 refusal.
  // '9999-12-31' is a real calendar day whose +1-day upper bound leaves
  // the 4-digit ISO year domain (`+010000-…`, which Postgres refuses with
  // SQLSTATE 22009) — refused here as a 400 rather than becoming a 500.
  const BAD_DATES = ['2026-02-29', '2026-02-30', '2026-13-01', '2026-8-14', '2026-08-14T00:00:00Z', 'yesterday', '', '9999-12-31'];
  for (const bad of BAD_DATES) {
    it(`rejects ${JSON.stringify(bad)}`, async () => {
      const { res } = await runDated({ date: bad });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
    });
  }

  it('negative control: the real leap day 2028-02-29 is accepted', async () => {
    const { res } = await runDated({ date: '2028-02-29' }, {
      contests_effective: { data: [], error: null, count: 0 },
      speculations: { data: [], error: null },
    });
    expect(res.statusCode).toBe(200);
  });

  it('negative control: 9999-12-30 is accepted — the domain clamp refuses only the crossover day', async () => {
    const { res } = await runDated({ date: '9999-12-30' }, {
      contests_effective: { data: [], error: null, count: 0 },
      speculations: { data: [], error: null },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ── dated query shape ───────────────────────────────────────────────────

describe('GET /v1/contests?date= — query shape', () => {
  it('bounds a HALF-OPEN UTC day on effective_start_time with the exact literals', async () => {
    const { calls } = await runDated({ date: '2026-08-14' });
    const gte = callsOn(calls, 'contests_effective', 'gte').map((c) => c.args);
    const lt = callsOn(calls, 'contests_effective', 'lt').map((c) => c.args);
    // The bounds are derived from the input, so the VALUES are pinned —
    // a wrong day-window arithmetic can't hide behind a column-name check.
    // `toEqual` on the WHOLE call list (not containment) also bounds the
    // COUNT to exactly one each: an implementation that kept the forward
    // listing's `.gte(effective_start_time, now)` floor beside the dated
    // lower bound would return nothing for any past day and still satisfy
    // a containment assertion.
    expect(gte).toEqual([['effective_start_time', '2026-08-14T00:00:00.000Z']]);
    expect(lt).toEqual([['effective_start_time', '2026-08-15T00:00:00.000Z']]);
    // Half-open: the forward-window `.lte` upper bound must NOT run here.
    expect(callsOn(calls, 'contests_effective', 'lte')).toHaveLength(0);
  });

  it('keeps the eligibility of the default listing and orders with a unique tiebreaker', async () => {
    const { calls } = await runDated({ date: '2026-08-14' });
    const notCalls = callsOn(calls, 'contests_effective', 'not').map((c) => JSON.stringify(c.args));
    expect(notCalls).toContain(JSON.stringify(['start_time', 'is', null]));
    expect(callsOn(calls, 'contests_effective', 'eq').map((c) => c.args)).toContainEqual([
      'network',
      'polygon',
    ]);
    // Dated mode enumerates a whole day for settle-and-claim, and slates
    // cluster on shared start instants — without a unique secondary key,
    // offset pagination can silently skip or repeat a tied row between
    // pages. `contest_id` is unique within the network scope.
    expect(callsOn(calls, 'contests_effective', 'order').map((c) => c.args[0])).toEqual([
      'effective_start_time',
      'contest_id',
    ]);
    expect(callsOn(calls, 'contests_effective', 'range').length).toBeGreaterThan(0);
  });

  it('composes with the status filter (postgame: --status scored)', async () => {
    const { calls } = await runDated({ date: '2026-08-14', status: 'scored' });
    expect(callsOn(calls, 'contests_effective', 'eq').map((c) => c.args)).toContainEqual([
      'contest_status',
      'scored',
    ]);
  });

  it('selects jsonodds_id (for the finality join) plus all six time columns', async () => {
    const { calls } = await runDated({ date: '2026-08-14' });
    const cols = selectArg(calls, 'contests_effective')
      .split(',')
      .map((s) => s.trim());
    for (const col of [
      'jsonodds_id',
      'start_time',
      'effective_start_time',
      'game_match_time',
      'game_earliest_match_time',
      'game_rundown_match_time',
      'game_sportspage_match_time',
    ]) {
      expect(cols).toContain(col);
    }
  });
});

// ── the finality join ───────────────────────────────────────────────────

describe('GET /v1/contests?date= — gameFinalType via the (network, jsonodds_id) games join', () => {
  it('queries games by network + the DEDUPED non-null jsonodds_id set', async () => {
    const { calls } = await runDated({ date: '2026-08-14' });
    expect(selectArg(calls, 'games')).toBe('jsonodds_id, final_type');
    expect(callsOn(calls, 'games', 'eq').map((c) => c.args)).toContainEqual(['network', 'polygon']);
    const inCalls = callsOn(calls, 'games', 'in');
    expect(inCalls).toHaveLength(1);
    // Null linkage (contest 44) excluded; the shared id appears once.
    expect(inCalls[0]!.args).toEqual([
      'jsonodds_id',
      ['jo-cubs-reds', 'jo-mets-braves', 'jo-cards-brewers'],
    ]);
  });

  it('serves final_type verbatim with the "" sentinel, mapped per game', async () => {
    const { res } = await runDated({ date: '2026-08-14' });
    expect(res.statusCode).toBe(200);
    const items = (res.body as { contests: DatedItem[] }).contests;
    const byId = new Map(items.map((i) => [i.contestId, i]));
    expect(byId.get('42')!.gameFinalType).toBe('Finished');
    expect(byId.get('43')!.gameFinalType).toBe(''); // games row present, final_type null
    expect(byId.get('44')!.gameFinalType).toBe(''); // no games linkage
    expect(byId.get('45')!.gameFinalType).toBe('Postponed');
    expect(byId.get('46')!.gameFinalType).toBe('Finished'); // shares 42's game
    // The rest of the row shape is the ordinary list item.
    expect(byId.get('42')!.matchTime).toBe('2026-08-14T18:10:00Z');
    expect(byId.get('42')!.status).toBe('scored');
  });

  it('skips the games query entirely when no row has a linkage', async () => {
    const { res, calls } = await runDated({ date: '2026-08-14' }, {
      contests_effective: {
        data: [dayRow({ jsonodds_id: null })],
        error: null,
        count: 1,
      },
      speculations: { data: [], error: null },
    });
    expect(res.statusCode).toBe(200);
    expect(callsOn(calls, 'games', 'from')).toHaveLength(0);
    expect((res.body as { contests: DatedItem[] }).contests[0]!.gameFinalType).toBe('');
  });

  it('a failed finality read is a 500, never a silent "" degrade', async () => {
    const { res } = await runDated({ date: '2026-08-14' }, {
      contests_effective: { data: DAY_ROWS, error: null, count: DAY_ROWS.length },
      speculations: { data: [], error: null },
      games: { data: null, error: { message: 'connection reset' } },
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

// ── the default listing is unchanged ────────────────────────────────────

describe('GET /v1/contests without date — unchanged by dated discovery', () => {
  it('issues no games query, keeps the forward gte/lte window, and selects no jsonodds_id', async () => {
    const { res, calls } = await runDated({}, {
      contests_effective: { data: [dayRow({})], error: null, count: 1 },
      speculations: { data: [], error: null },
      games: { data: GAMES_ROWS, error: null }, // present but must never be queried
    });
    expect(res.statusCode).toBe(200);
    expect(callsOn(calls, 'games', 'from')).toHaveLength(0);
    // Forward window: closed upper bound via lte, no lt.
    expect(callsOn(calls, 'contests_effective', 'lte').map((c) => c.args[0])).toContain(
      'effective_start_time',
    );
    expect(callsOn(calls, 'contests_effective', 'lt')).toHaveLength(0);
    // The dated tiebreaker deliberately does NOT reach the forward
    // listing — its ordering is exactly the pre-`date` single key.
    expect(callsOn(calls, 'contests_effective', 'order').map((c) => c.args[0])).toEqual([
      'effective_start_time',
    ]);
    const cols = selectArg(calls, 'contests_effective')
      .split(',')
      .map((s) => s.trim());
    expect(cols).not.toContain('jsonodds_id');
  });

  it('serves no gameFinalType key at all (absent, not "")', async () => {
    const { res } = await runDated({}, {
      contests_effective: { data: [dayRow({})], error: null, count: 1 },
      speculations: { data: [], error: null },
    });
    expect(res.statusCode).toBe(200);
    const item = (res.body as { contests: DatedItem[] }).contests[0]!;
    expect('gameFinalType' in item).toBe(false);
  });
});

// ── mock self-check ─────────────────────────────────────────────────────

it('MOCK SELF-CHECK: the projector really drops unrequested keys', () => {
  // Asserts the test double, not product code — without the projection, the
  // finality expectations above would pass even if the games query stopped
  // selecting `final_type`, because the mock would hand back a column
  // nobody asked for.
  const cols = new Set(['a', 'b']);
  expect(projectRow({ a: 1, b: 2, c: 3 }, cols)).toEqual({ a: 1, b: 2 });
  expect(projectRow([{ a: 1, c: 3 }], cols)).toEqual([{ a: 1 }]);
  expect(projectRow({ a: 1, c: 3 }, null)).toEqual({ a: 1, c: 3 });
});
