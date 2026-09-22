/**
 * `GET /v1/benchmark/ledger` — the filtered, keyset-paged ledger walk.
 *
 * Real `@supabase/supabase-js` against a fake PostgREST, same reasoning as the
 * sibling benchmark handler tests. Three things here cannot be seen by a builder
 * mock and each one is a live defect class:
 *
 *   - whether the publication gate is PUSHED DOWN (`slate_date=gte.…`) or applied
 *     after the fact;
 *   - whether the page asks for `limit + 1` — the extra-row `hasMore` probe. A
 *     fake that ignored `limit` would return everything and a build asking for a
 *     plain `limit` would pass, so the fake honours `order` and `limit` via
 *     `applyPage`;
 *   - whether the COUNT read carries the same filters as the page and omits the
 *     cursor. Those are two separately-built query chains describing one
 *     population, which is the `3d-sibling` shape, and the only way to see a
 *     divergence is from the wire.
 *
 * The fake derives its `Content-Range` total from the rows IT filtered, so a
 * filter the handler forgot on the count chain shows up as a total that
 * disagrees with the page rather than as a number nobody checks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  applyFilters,
  applyPage,
  expectReached,
  requestTo,
  startFakePostgrest,
  type CapturedRequest,
  type FakePostgrest,
  type FakeReply,
} from './helpers/fakePostgrest.js';

const PARTICIPANT = 'anthropic-claude-fable-5';
const OTHER_PARTICIPANT = 'openai-gpt-5';
const GAME = '017495e7-241b-47fd-877f-34a44347c3e4';
const OTHER_GAME = '9f2c1d84-77aa-4b31-8e05-1c6b0a2f5d33';
const MIN_SLATE = '2026-08-15';
const LEDGER = 'benchmark_pick_ledger';

/**
 * One ledger row as the view serves it.
 *
 * Three fixture choices carry discrimination and none is incidental:
 *
 *   - `held_out_of_primary: null` is the tri-state a `?? false` collapses.
 *   - `net_usdc: 0` beside `result: 'no_fill'` is a REAL zero, which a
 *     truthiness check merges with the null a `pending` row carries.
 *   - the spread rows below give `line` and `closing_line` DIFFERENT values, so a
 *     build that reused the pick's computed pair for the close fails. Equal
 *     values would let exactly the defect #85's review caught pass again.
 */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    participant_id: PARTICIPANT,
    participant_name: 'Claude Fable 5',
    lab_id: 'anthropic',
    cohort_id: 'watch-v0-2026-08-27',
    network: 'polygon',
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
    result: 'no_fill',
    filled_at: null,
    stake_usdc: null,
    net_usdc: 0,
    fill_tx_hash: null,
    as_of: '2026-09-06T07:30:00+00:00',
    source_decision_id: 4374,
    ...over,
  };
}

/**
 * Twelve rows with DISTINCT, non-contiguous decision ids.
 *
 * Non-contiguous on purpose: an id sequence of 1..12 cannot tell a cursor that
 * carries a real id from one that carries a row OFFSET, because for the first
 * page the two coincide. These jump in irregular steps so only a genuine keyset
 * produces the right second page.
 *
 * The ids are also deliberately spread across three and four digits (990 to
 * 4374), because a fake that compared them as STRINGS would order '990' after
 * '4374' and every paging assertion would be measuring the harness.
 */
function ledger(): Array<Record<string, unknown>> {
  const ids = [990, 1207, 1318, 1902, 2044, 2571, 3003, 3110, 3687, 4001, 4210, 4374];
  return ids.map((id, i) =>
    row({
      source_decision_id: id,
      // Two slate dates so a slateDate anchor selects a strict subset.
      slate_date: i < 7 ? '2026-08-27' : '2026-08-28',
      // A third of them are spreads, with a close that differs from the pick.
      ...(i % 3 === 0
        ? { market: 'spread', line: -1.5, closing_line: -2.5 }
        : i % 3 === 1
          ? { market: 'total', selection: 'over', line: 8.5, closing_line: 9 }
          : {}),
      // Two rows belong to another participant and another game, so an anchor
      // that is not pushed down returns them and the assertion notices.
      ...(i === 5 ? { participant_id: OTHER_PARTICIPANT } : {}),
      ...(i === 6 ? { game_id: OTHER_GAME } : {}),
    }),
  );
}

const open: FakePostgrest[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
  vi.resetModules();
});

interface CallResult {
  fake: FakePostgrest;
  body: Record<string, unknown>;
  status: number;
}

async function call(
  query: Record<string, string> = {},
  rows: Array<Record<string, unknown>> | undefined = undefined,
  config: Record<string, unknown> = {},
  override?: (req: CapturedRequest) => FakeReply | undefined,
): Promise<CallResult> {
  const data = rows ?? ledger();
  const fake = await startFakePostgrest((req) => {
    const forced = override?.(req);
    if (forced !== undefined) return forced;
    const filtered = applyFilters(data, req.params);
    const prefer = String(req.headers.prefer ?? '');
    if (prefer.includes('count=exact')) {
      // The count read. The total comes from the rows THIS request's own filters
      // selected, so a filter missing from the count chain makes the served
      // total disagree with the page — which a test can then see.
      return {
        status: 206,
        body: applyPage(filtered, req.params),
        contentRange: `0-0/${String(filtered.length)}`,
      };
    }
    return { body: applyPage(filtered, req.params) };
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
  vi.doMock('../src/lib/logger.js', () => ({
    logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    formatError: String,
  }));

  const { getBenchmarkLedgerHandler } = await import('../src/v1/benchmark/ledger.js');
  const res = {
    statusCode: 0,
    body: {} as Record<string, unknown>,
    status(c: number) { this.statusCode = c; return this; },
    json(b: Record<string, unknown>) { this.body = b; return this; },
  };
  await getBenchmarkLedgerHandler(
    { query, params: {} } as unknown as Request,
    res as unknown as Response,
  );
  return { fake, body: res.body, status: res.statusCode };
}

/** The served rows, typed enough to index. */
function rowsOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return body.rows as Array<Record<string, unknown>>;
}
function pageOf(body: Record<string, unknown>): Record<string, unknown> {
  return body.page as Record<string, unknown>;
}

describe('ledger — a filter is required, and the refusal costs nothing', () => {
  it('refuses a request with no anchor, before any read', async () => {
    const { status, body, fake } = await call({});
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'FILTER_REQUIRED' });
    expect(fake.requests).toHaveLength(0);
  });

  /**
   * The contract decision this endpoint exists to encode, and the assertion is on
   * the CODE rather than the status.
   *
   * `sport` and `market` are syntactically valid values, so a handler that
   * validated them and forgot the anchor rule would still answer 400 — with
   * `INVALID_PARAM`. Only `FILTER_REQUIRED` distinguishes "you sent a filter that
   * does not bound the read" from "you sent a bad value", and only the first is
   * what the measured timeout requires.
   */
  it.each([
    ['sport alone', { sport: 'mlb' }],
    ['market alone', { market: 'moneyline' }],
    ['sport and market together', { sport: 'mlb', market: 'moneyline' }],
    ['a page size but no anchor', { limit: '10' }],
    ['a cursor but no anchor', { after: '4374' }],
    ['a count request but no anchor', { count: 'exact' }],
    ['anchors present but blank', { participantId: '   ', gameId: '' }],
  ])('refuses %s with FILTER_REQUIRED and reads nothing', async (_why, query) => {
    const { status, body, fake } = await call(query);
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'FILTER_REQUIRED' });
    expect(fake.requests).toHaveLength(0);
  });

  /**
   * The negative control the refusals above are worthless without: each anchor
   * ALONE is accepted. A handler broken to refuse everything passes every case
   * in the block above.
   */
  it.each([
    ['participantId', { participantId: PARTICIPANT }],
    ['gameId', { gameId: GAME }],
    ['slateDate', { slateDate: '2026-08-27' }],
  ])('accepts %s on its own', async (_why, query) => {
    const { status, body, fake } = await call(query);
    expect(status).toBe(200);
    expectReached(fake);
    expect(rowsOf(body).length).toBeGreaterThan(0);
  });

  it('accepts sport and market as REFINEMENTS of an anchor', async () => {
    const { status, body } = await call({ participantId: PARTICIPANT, market: 'spread' });
    expect(status).toBe(200);
    expect(rowsOf(body).length).toBeGreaterThan(0);
    expect(rowsOf(body).every((r) => r.market === 'spread')).toBe(true);
  });

  it.each([
    ['an unknown market', { participantId: PARTICIPANT, market: 'parlay' }],
    ['a market differing only in case', { participantId: PARTICIPANT, market: 'Spread' }],
    ['a malformed slateDate', { participantId: PARTICIPANT, slateDate: '27-08-2026' }],
    // Shape-valid, calendar-impossible. Each of these used to pass the regex,
    // reach Postgres as a 22008 and come back a 500 — on a purely malformed
    // request. `parseSlateDate`'s own matrix covers the calendar; these three pin
    // that the HANDLER consults it.
    ['February 30th', { participantId: PARTICIPANT, slateDate: '2026-02-30' }],
    ['a leap day in a non-leap year', { participantId: PARTICIPANT, slateDate: '2026-02-29' }],
    ['year zero', { participantId: PARTICIPANT, slateDate: '0000-01-01' }],
    ['a non-integer limit', { participantId: PARTICIPANT, limit: '25abc' }],
    ['a fractional limit', { participantId: PARTICIPANT, limit: '25.9' }],
    ['a zero limit', { participantId: PARTICIPANT, limit: '0' }],
    ['an over-cap limit', { participantId: PARTICIPANT, limit: '101' }],
    ['a negative limit', { participantId: PARTICIPANT, limit: '-5' }],
    ['a non-integer cursor', { participantId: PARTICIPANT, after: 'abc' }],
  ])('refuses %s with INVALID_PARAM and reads nothing', async (_why, query) => {
    const { status, body, fake } = await call(query);
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'INVALID_PARAM' });
    expect(fake.requests).toHaveLength(0);
  });

  /**
   * `planned` and `estimated` are refused deliberately, not accidentally.
   *
   * Measured against production 2026-09-21 on a scope whose true total is 1095:
   * `count=planned` answers a Content-Range total of 1, and `count=estimated`
   * answers 1001. Both are ACCEPTED by PostgREST and both are wrong by orders of
   * magnitude, and 1 is the dangerous one because it reads as a small result
   * rather than as an error. So the endpoint offers exact or nothing.
   */
  it.each([['planned'], ['estimated'], ['true'], ['1']])(
    'refuses count=%s — exact is the only publishable count',
    async (value) => {
      const { status, body } = await call({ participantId: PARTICIPANT, count: value });
      expect(status).toBe(400);
      expect(body).toMatchObject({ code: 'INVALID_PARAM' });
    },
  );

  /**
   * A cursor is shape-checked AND magnitude-checked.
   *
   * `/^\d+$/` accepts a 20-digit string, `Number` turns it into something past
   * `Number.MAX_SAFE_INTEGER`, and PostgREST interpolates it into
   * `source_decision_id=lt.1e+21` — which Postgres refuses on a bigint column
   * with 22P02 or 22003. Neither is a schema-drift code, so before the fix this
   * answered 500 INTERNAL_ERROR while every sibling param answered 400. The
   * 17-digit case is the quieter half: `Number` ROUNDS it, so the walk would page
   * from a number the caller never sent.
   */
  it.each([
    ['past Number.MAX_SAFE_INTEGER', '10000000000000000000'],
    ['past int8 entirely', '1000000000000000000000'],
    ['silently rounded by Number', '90071992547409911'],
  ])('refuses a cursor %s with 400 rather than 500', async (_why, after) => {
    const { status, body, fake } = await call({ participantId: PARTICIPANT, after });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'INVALID_PARAM' });
    expect(fake.requests).toHaveLength(0);
  });

  it('accepts a cursor inside the safe range — the control for the refusals above', async () => {
    const { status, body } = await call({ participantId: PARTICIPANT, after: '4374' });
    expect(status).toBe(200);
    expect(rowsOf(body).length).toBeGreaterThan(0);
  });

  /**
   * `sport` goes through the SAME validator as the three sibling endpoints.
   *
   * Taken raw, `?sport=MLB` and `?sport=typo` both became `sport=eq.<literal>` and
   * answered 200 with an empty page — one param name behaving differently across
   * sibling endpoints and failing SILENTLY. `all` must mean "no sport filter"
   * here, which is `/benchmark/picks`'s reading and deliberately not
   * `/benchmark/stats`'s, where `all` is a real stored value.
   */
  it('case-folds sport rather than filtering on the raw spelling', async () => {
    const { status, body, fake } = await call({ participantId: PARTICIPANT, sport: 'MLB', limit: '100' });
    expect(status).toBe(200);
    expect(requestTo(fake, LEDGER)?.params.get('sport')).toBe('eq.mlb');
    // The discriminating half: raw handling sends eq.MLB, which matches nothing.
    expect(rowsOf(body).length).toBeGreaterThan(0);
  });

  it('treats sport=all as no sport filter, not as a literal', async () => {
    const { status, body, fake } = await call({ participantId: PARTICIPANT, sport: 'all', limit: '100' });
    expect(status).toBe(200);
    expect(requestTo(fake, LEDGER)?.params.get('sport')).toBeNull();
    expect(body.filters).toMatchObject({ sport: null });
    expect(rowsOf(body).length).toBeGreaterThan(0);
  });

  it('refuses an unknown sport instead of serving an empty page', async () => {
    const { status, body, fake } = await call({ participantId: PARTICIPANT, sport: 'quidditch' });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'INVALID_PARAM' });
    expect(String(body.error)).toContain('sport');
    expect(fake.requests).toHaveLength(0);
  });

  it('accepts a real leap day — the control the calendar refusals need', async () => {
    const { status } = await call({ participantId: PARTICIPANT, slateDate: '2024-02-29' });
    expect(status).toBe(200);
  });

  /**
   * The second half of the calendar blocker, and the worse half.
   *
   * With the gate unset the handler short-circuits before reading, so an
   * impossible date used to answer `200` with an empty page — a malformed request
   * reported as "nothing published", which is the reading a client is least
   * likely to question. Validation runs BEFORE the gate precisely so this cannot
   * happen, and this case is what holds that ordering in place: it passes on a
   * build that validates the calendar and on no other.
   */
  it('refuses an impossible date even when the gate is unset, rather than answering 200', async () => {
    const { status, body, fake } = await call(
      { participantId: PARTICIPANT, slateDate: '2026-02-30' },
      undefined,
      { benchmarkPublicMinSlateDate: undefined },
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'INVALID_PARAM' });
    expect(body.rows).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });

  it('serves an empty page with no read at all when the gate is unset', async () => {
    const { status, body, fake } = await call(
      { participantId: PARTICIPANT },
      undefined,
      { benchmarkPublicMinSlateDate: undefined },
    );
    expect(status).toBe(200);
    expect(rowsOf(body)).toEqual([]);
    expect(body.minSlateDate).toBeNull();
    expect(pageOf(body)).toMatchObject({ returned: 0, hasMore: false, nextAfter: null });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('ledger — the filters reach the database', () => {
  it('pushes the publication gate down rather than filtering after the read', async () => {
    const { fake } = await call({ participantId: PARTICIPANT });
    expectReached(fake);
    const req = requestTo(fake, LEDGER);
    expect(req?.params.get('slate_date')).toBe(`gte.${MIN_SLATE}`);
  });

  it('pushes every supplied filter down, and the network scope with them', async () => {
    const { fake } = await call({
      participantId: PARTICIPANT,
      gameId: GAME,
      slateDate: '2026-08-27',
      market: 'spread',
      sport: 'mlb',
    });
    const req = requestTo(fake, LEDGER);
    expect(req?.params.get('participant_id')).toBe(`eq.${PARTICIPANT}`);
    expect(req?.params.get('game_id')).toBe(`eq.${GAME}`);
    expect(req?.params.get('market')).toBe('eq.spread');
    expect(req?.params.get('sport')).toBe('eq.mlb');
    expect(req?.params.get('network')).toBe('eq.polygon');
    // An explicit slateDate and the gate are both `slate_date` predicates; both
    // must survive, so the raw query carries two of them.
    expect((req?.rawQuery.match(/slate_date=/g) ?? []).length).toBe(2);
  });

  /**
   * A pushed-down anchor actually EXCLUDES, which the fake proves by filtering.
   *
   * The fixture puts one row under a different participant and one under a
   * different game precisely so "the handler filtered" and "the fixture happened
   * to be homogeneous" are different observations.
   */
  it('excludes another participant’s rows', async () => {
    const { body } = await call({ participantId: PARTICIPANT, limit: '100' });
    expect(rowsOf(body).length).toBe(11);
    expect(rowsOf(body).some((r) => r.participantId === OTHER_PARTICIPANT)).toBe(false);
  });

  it('excludes another game’s rows', async () => {
    const { body } = await call({ gameId: GAME, limit: '100' });
    const games = new Set(rowsOf(body).map((r) => (r.game as Record<string, unknown>).gameId));
    expect(games).toEqual(new Set([GAME]));
  });

  it('narrows to one slate day', async () => {
    const { body } = await call({ slateDate: '2026-08-28', limit: '100' });
    expect(rowsOf(body).length).toBe(5);
    expect(rowsOf(body).every((r) => r.slateDate === '2026-08-28')).toBe(true);
  });

  it('orders newest decision first, descending', async () => {
    const { fake, body } = await call({ participantId: PARTICIPANT, limit: '100' });
    expect(requestTo(fake, LEDGER)?.params.get('order')).toBe('source_decision_id.desc');
    const ids = rowsOf(body).map((r) => r.decisionId as number);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(ids[0]).toBe(4374);
  });
});

describe('ledger — paging', () => {
  it('asks for one row MORE than it serves, which is the hasMore probe', async () => {
    const { fake, body } = await call({ participantId: PARTICIPANT, limit: '4' });
    // 26 would be the default; 5 is limit+1 for an explicit limit of 4. A build
    // that asked for a plain `limit` cannot know there is another page.
    expect(requestTo(fake, LEDGER)?.params.get('limit')).toBe('5');
    expect(pageOf(body)).toMatchObject({ limit: 4, returned: 4, hasMore: true });
    expect(rowsOf(body)).toHaveLength(4);
  });

  it('defaults to 25 and therefore asks for 26', async () => {
    const { fake, body } = await call({ participantId: PARTICIPANT });
    expect(requestTo(fake, LEDGER)?.params.get('limit')).toBe('26');
    expect(pageOf(body).limit).toBe(25);
  });

  it('reports no next page when the result fits, and a null cursor with it', async () => {
    const { body } = await call({ gameId: OTHER_GAME, limit: '10' });
    expect(pageOf(body)).toMatchObject({ hasMore: false, nextAfter: null, returned: 1 });
  });

  /**
   * The cursor is a VALUE, and the second page must not repeat or skip.
   *
   * The ids are non-contiguous, so a handler that treated `after` as an offset
   * would produce a different second page than a handler that treated it as a
   * key — which is the whole point of the fixture's irregular steps.
   */
  it('walks the whole scope with no repeats and no gaps', async () => {
    const seen: number[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const q: Record<string, string> = { participantId: PARTICIPANT, limit: '4' };
      if (after !== undefined) q.after = after;
      const { body, fake } = await call(q);
      if (after !== undefined) {
        // The cursor is on the wire as a `lt`, not as an offset.
        expect(requestTo(fake, LEDGER)?.params.get('source_decision_id')).toBe(`lt.${after}`);
        expect(requestTo(fake, LEDGER)?.params.get('offset')).toBeNull();
      }
      seen.push(...rowsOf(body).map((r) => r.decisionId as number));
      const next = pageOf(body).nextAfter;
      if (next === null) break;
      after = String(next);
    }
    // Eleven rows belong to this participant, every one seen exactly once.
    expect(seen).toHaveLength(11);
    expect(new Set(seen).size).toBe(11);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
  });

  it('carries the LAST SERVED row as the cursor, not the probe row', async () => {
    const { body } = await call({ participantId: PARTICIPANT, limit: '4' });
    const ids = rowsOf(body).map((r) => r.decisionId as number);
    // The probe row was fetched and discarded; the cursor is the 4th served id,
    // so the next page starts below it rather than below the 5th.
    expect(pageOf(body).nextAfter).toBe(ids[ids.length - 1]);
  });

  /**
   * The keyset is only sound while `source_decision_id` is unique per row.
   * Measured true over the largest live scope (1,095 of 1,095 distinct), and
   * ENFORCED here rather than assumed, because a `lt` cursor over a non-unique
   * key skips rows across the page boundary — silently.
   */
  /**
   * THE case that carries the discrimination, and the one the first version of
   * this suite did not have.
   *
   * Ids [100, 99, 98, 97, 97] at `limit: 4`. The handler fetches five, serves the
   * first four — [100, 99, 98, 97], all distinct — and discards the second 97 as
   * the probe row. A guard that scanned only the SERVED slice sees nothing wrong,
   * answers 200, and sets `nextAfter: 97`; the next page's strict `lt.97` then
   * excludes the second 97 from that page and from every later one, so the row is
   * unreachable for the whole walk. That is the only duplicate arrangement that
   * loses a row, because ties are adjacent under a descending order — and it is
   * exactly the arrangement `served` cannot see.
   *
   * Five independent lenses of an adversarial pass found that hole. The test
   * below it could not, and the reason is worth keeping: its limit was larger
   * than its fixture, so `hasMore` was false, `served === fetched`, and the two
   * builds were indistinguishable.
   */
  it('refuses a duplicate decisionId straddling the page boundary', async () => {
    const ids = [100, 99, 98, 97, 97];
    const dupes = ids.map((id, i) => row({ source_decision_id: id, game_id: `g${String(i)}` }));
    const { status, body } = await call({ participantId: PARTICIPANT, limit: '4' }, dupes);
    expect(status).toBe(503);
    expect(body).toMatchObject({ code: 'NOT_READY' });
    expect(String(body.error)).toContain('twice');
    // If this ever answers 200, read `nextAfter`: it will be 97, and the row that
    // was dropped is the other 97.
    expect(body.rows).toBeUndefined();
  });

  /**
   * The same defect wholly INSIDE the page. Kept because it pins the guard's
   * other half, and marked because on its own it proves less than it looks:
   * `limit: 10` over 2 rows makes `hasMore` false, so it passes identically on a
   * build that scans `served` and one that scans `fetched`. The case above is
   * what separates them.
   */
  it('refuses a duplicate decisionId inside the page', async () => {
    const dupes = [row({ source_decision_id: 7 }), row({ source_decision_id: 7, game_id: 'g2' })];
    const { status, body } = await call({ participantId: PARTICIPANT, limit: '10' }, dupes);
    expect(status).toBe(503);
    expect(body).toMatchObject({ code: 'NOT_READY' });
    expect(String(body.error)).toContain('twice');
  });

  it('serves a page whose decisionIds are distinct — the control for the refusal above', async () => {
    const fine = [row({ source_decision_id: 7 }), row({ source_decision_id: 8 })];
    const { status, body } = await call({ participantId: PARTICIPANT, limit: '10' }, fine);
    expect(status).toBe(200);
    expect(rowsOf(body)).toHaveLength(2);
  });
});

describe('ledger — the exact count', () => {
  it('is absent unless asked for, and costs no second read', async () => {
    const { body, fake } = await call({ participantId: PARTICIPANT });
    expect(body.count).toEqual({ exact: null });
    expect(fake.requests.filter((r) => r.path === `/rest/v1/${LEDGER}`)).toHaveLength(1);
  });

  it('is served on request, from a second read', async () => {
    const { body, fake } = await call({ participantId: PARTICIPANT, count: 'exact', limit: '4' });
    expect(body.count).toEqual({ exact: 11 });
    expect(fake.requests.filter((r) => r.path === `/rest/v1/${LEDGER}`)).toHaveLength(2);
  });

  /**
   * The count must describe the SAME population as the page.
   *
   * The two are separately-built query chains, so a filter added to one and
   * forgotten on the other publishes a total that does not match its own rows.
   * The discriminating fixture is a refinement that CHANGES the total: the
   * participant has 11 rows and 4 of them are spreads, so a count chain missing
   * the market filter answers 11 beside 4 served rows.
   */
  it('counts only the filtered population, refinements included', async () => {
    const { body } = await call({
      participantId: PARTICIPANT, market: 'spread', count: 'exact', limit: '100',
    });
    expect(rowsOf(body)).toHaveLength(4);
    expect(body.count).toEqual({ exact: 4 });
  });

  it('applies the gate to the count as well as to the page', async () => {
    const { fake } = await call({ participantId: PARTICIPANT, count: 'exact' });
    const countReq = fake.requests.filter((r) => String(r.headers.prefer ?? '').includes('count=exact'))[0];
    expect(countReq?.params.get('slate_date')).toBe(`gte.${MIN_SLATE}`);
    expect(countReq?.params.get('participant_id')).toBe(`eq.${PARTICIPANT}`);
    expect(countReq?.params.get('network')).toBe('eq.polygon');
  });

  /**
   * The count deliberately does NOT carry the cursor.
   *
   * A total that shrank as the caller paged would be a different number on every
   * page. The fixture makes the two answers differ: with `after` set past the
   * first few rows, the remainder is strictly smaller than the total, so a count
   * chain that inherited the cursor answers a smaller number and this fails.
   */
  it('counts the whole filtered set even on a later page', async () => {
    const { body, fake } = await call({
      participantId: PARTICIPANT, after: '2044', count: 'exact', limit: '4',
    });
    const countReq = fake.requests.filter((r) => String(r.headers.prefer ?? '').includes('count=exact'))[0];
    expect(countReq?.params.get('source_decision_id')).toBeNull();
    // 11 for the participant, not the 5 that remain below the cursor.
    expect(body.count).toEqual({ exact: 11 });
    expect(rowsOf(body).length).toBeLessThan(11);
  });
});

describe('ledger — the row projection', () => {
  it('side-labels a spread and serves no bare line', async () => {
    const { body } = await call({ participantId: PARTICIPANT, market: 'spread', limit: '1' });
    const r = rowsOf(body)[0];
    expect(r).toMatchObject({ line: null, awayLine: 1.5, homeLine: -1.5 });
  });

  /**
   * The CLOSING line is a spread too, and it is the field #85's review caught
   * being served raw. The fixture's close (-2.5) differs from its pick (-1.5)
   * deliberately: with equal values, a build that reused the pick's computed pair
   * for the close would pass.
   */
  it('side-labels the CLOSING spread, from its own value', async () => {
    const { body } = await call({ participantId: PARTICIPANT, market: 'spread', limit: '1' });
    const closing = rowsOf(body)[0]?.closing as Record<string, unknown>;
    expect(closing).toMatchObject({ line: null, awayLine: 2.5, homeLine: -2.5 });
  });

  it('leaves a total’s lines as bare numbers on both the pick and the close', async () => {
    const { body } = await call({ participantId: PARTICIPANT, market: 'total', limit: '1' });
    const r = rowsOf(body)[0];
    expect(r).toMatchObject({ line: 8.5, awayLine: null, homeLine: null });
    expect(r?.closing).toMatchObject({ line: 9, awayLine: null, homeLine: null });
  });

  it.each([
    ['all five present', {}, { valuation: 2, trend: 3, consensus: 4, news: 2, softness: 2 }],
    ['a partial vector keeps its nulls', { axis_trend: null }, { valuation: 2, trend: null, consensus: 4, news: 2, softness: 2 }],
    ['a null valuation does not discard the rest', { axis_valuation: null }, { valuation: null, trend: 3, consensus: 4, news: 2, softness: 2 }],
  ])('axes: %s', async (_why, over, expected) => {
    const { body } = await call(
      { participantId: PARTICIPANT, limit: '1' },
      [row({ source_decision_id: 5000, ...over })],
    );
    expect(rowsOf(body)[0]?.axes).toEqual(expected);
  });

  it('axes: all five null is a null object rather than a zeroed shape', async () => {
    const { body } = await call({ participantId: PARTICIPANT, limit: '1' }, [row({
      source_decision_id: 5000,
      axis_valuation: null, axis_trend: null, axis_consensus: null,
      axis_news: null, axis_softness: null,
    })]);
    expect(rowsOf(body)[0]?.axes).toBeNull();
    expect(body.axisScale).toEqual({ min: 1, max: 5 });
  });

  it.each([[null], [true], [false]])(
    'keeps heldOutOfPrimary as the tri-state %s',
    async (held) => {
      const { body } = await call(
        { participantId: PARTICIPANT, limit: '1' },
        [row({ source_decision_id: 5000, held_out_of_primary: held })],
      );
      expect((rowsOf(body)[0]?.clv as Record<string, unknown>).heldOutOfPrimary).toBe(held);
    },
  );

  it('keeps a real zero net distinct from a pending null', async () => {
    const { body } = await call({ participantId: PARTICIPANT, limit: '100' }, [
      row({ source_decision_id: 5001, result: 'no_fill', net_usdc: 0 }),
      row({ source_decision_id: 5002, result: 'pending', net_usdc: null }),
    ]);
    // Keyed by decisionId rather than by position: the page is ordered
    // `source_decision_id desc`, so 5002 arrives FIRST and a positional
    // expectation fails for a reason that has nothing to do with the zero.
    const byId = new Map(
      rowsOf(body).map((r) => [r.decisionId, (r.execution as Record<string, unknown>).netUsdc]),
    );
    expect(byId.get(5001)).toBe(0);
    expect(byId.get(5002)).toBeNull();
  });

  it('echoes the filters and the gate it applied', async () => {
    const { body } = await call({ participantId: PARTICIPANT, market: 'spread' });
    expect(body.filters).toEqual({
      participantId: PARTICIPANT, gameId: null, slateDate: null, market: 'spread', sport: null,
    });
    expect(body.minSlateDate).toBe(MIN_SLATE);
    expect(body.network).toBe('polygon');
  });
});

describe('ledger — faults', () => {
  it('reports an unapplied migration as NOT_READY rather than a 500', async () => {
    const { status, body } = await call(
      { participantId: PARTICIPANT },
      undefined,
      {},
      () => ({ status: 404, body: { code: 'PGRST205', message: 'relation does not exist', details: null, hint: null } }),
    );
    expect(status).toBe(503);
    expect(body).toMatchObject({ code: 'NOT_READY' });
  });

  it('reports a genuine query failure as a 500', async () => {
    const { status, body } = await call(
      { participantId: PARTICIPANT },
      undefined,
      {},
      () => ({ status: 500, body: { code: 'XX000', message: 'boom', details: null, hint: null } }),
    );
    expect(status).toBe(500);
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('reports a statement timeout on the count read without serving a partial answer', async () => {
    const { status, body } = await call(
      { participantId: PARTICIPANT, count: 'exact' },
      undefined,
      {},
      (req) =>
        String(req.headers.prefer ?? '').includes('count=exact')
          ? { status: 500, body: { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null } }
          : undefined,
    );
    expect(status).toBe(500);
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(body.rows).toBeUndefined();
  });
});
