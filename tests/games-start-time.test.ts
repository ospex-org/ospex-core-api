/**
 * `/v1/games` serves a MINIMUM, not a raw feed value.
 *
 * Before this, the endpoint carried exactly one temporal field — the raw
 * `games.match_time` — so a pre-contest caller had nothing to minimise over.
 * `/v1/contests*` was not a substitute, because a contest row does not exist
 * until creation, which is the whole of the pre-contest window.
 *
 * `matchTime` is now `LEAST(match_time, earliest_match_time)`, matching the
 * derivation the contest-shaped surfaces apply, with both raw inputs published
 * alongside it so the gap is explicable from the body rather than only from the
 * README.
 *
 * THE DOUBLE HONOURS THE SELECT PROJECTION. PostgREST returns only requested
 * columns, so a fake returning whole fixture rows would keep passing if
 * `earliest_match_time` were dropped from GAMES_SELECT — the minimum would
 * silently degrade to the raw value while every assertion stayed green.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const supabaseMock = vi.hoisted(() => ({ getSupabase: vi.fn() }));
vi.mock('../src/lib/supabase.js', () => supabaseMock);
vi.mock('../src/lib/env.js', () => ({
  loadConfig: () => ({ network: 'polygon' }),
}));

const { getGamesHandler } = await import('../src/v1/games.js');

const LATER = '2026-07-31T00:15:00+00:00';
const EARLIER = '2026-07-30T23:10:00+00:00';

interface RawGameRow {
  network: string;
  jsonodds_id: string;
  sportspage_id: string | null;
  rundown_id: string | null;
  sport: string;
  match_time: string;
  earliest_match_time: string | null;
  status: string;
  home_team_id: string;
  away_team_id: string;
  has_odds: boolean;
  contest_created: boolean;
  contest_id: string | number | null;
  slug: string;
  home_probable_pitcher: string | null;
  away_probable_pitcher: string | null;
}

function gameRow(over: Partial<RawGameRow> = {}): RawGameRow {
  return {
    network: 'polygon',
    jsonodds_id: 'game-1',
    sportspage_id: 'sp-1',
    rundown_id: 'rd-1',
    sport: 'mlb',
    match_time: LATER,
    earliest_match_time: LATER,
    status: 'upcoming',
    home_team_id: 'home-uuid',
    away_team_id: 'away-uuid',
    has_odds: true,
    contest_created: false,
    contest_id: null,
    slug: 'nyy-chc-2026-07-31',
    home_probable_pitcher: null,
    away_probable_pitcher: null,
    ...over,
  };
}

function project<T extends object>(rows: T[], select: string): Array<Record<string, unknown>> {
  const cols = select
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const c of cols) if (c in r) out[c] = (r as Record<string, unknown>)[c];
    return out;
  });
}

function makeSupabase(games: RawGameRow[]): { selects: Record<string, string> } {
  const selects: Record<string, string> = {};
  const client = {
    from(table: string) {
      let select = '';
      const builder: Record<string, unknown> = {
        select(s: string) {
          select = s;
          selects[table] = s;
          return builder;
        },
        eq: () => builder,
        gte: () => builder,
        lte: () => builder,
        not: () => builder,
        or: () => builder,
        in: () => builder,
        order: () => builder,
        range: () =>
          Promise.resolve({
            data: table === 'games' ? project(games, select) : [],
            error: null,
            count: table === 'games' ? games.length : 0,
          }),
        then(resolve: (v: { data: unknown; error: null; count: number }) => unknown) {
          const data =
            table === 'teams'
              ? project(
                  [
                    { id: 'home-uuid', name: 'Chicago Cubs', abbrev: 'CHC' },
                    { id: 'away-uuid', name: 'New York Yankees', abbrev: 'NYY' },
                  ],
                  select,
                )
              : project(games, select);
          return Promise.resolve({ data, error: null, count: games.length }).then(resolve);
        },
      };
      return builder;
    },
  };
  supabaseMock.getSupabase.mockReturnValue(client);
  return { selects };
}

interface WireGame {
  gameId: string;
  matchTime: string;
  gameMatchTime: string;
  earliestMatchTime: string | null;
}

function makeRes(): { statusCode: number; body: unknown; status: (c: number) => unknown; json: (b: unknown) => unknown } {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

async function fetchGames(rows: RawGameRow[]): Promise<{ games: WireGame[]; selects: Record<string, string> }> {
  const { selects } = makeSupabase(rows);
  const res = makeRes();
  await getGamesHandler(
    { query: {} } as never,
    res as never,
    (() => undefined) as never,
  );
  const body = res.body as { games: WireGame[] };
  return { games: body.games, selects };
}

beforeEach(() => {
  supabaseMock.getSupabase.mockReset();
});

describe('GET /v1/games — matchTime is a minimum over two inputs', () => {
  it('serves the FLOOR when it is earlier than the raw feed value', async () => {
    const { games } = await fetchGames([
      gameRow({ match_time: LATER, earliest_match_time: EARLIER }),
    ]);
    expect(games[0]?.matchTime).toBe(EARLIER);
  });

  it('publishes both raw inputs so the gap is explicable from the body', async () => {
    const { games } = await fetchGames([
      gameRow({ match_time: LATER, earliest_match_time: EARLIER }),
    ]);
    expect(games[0]?.gameMatchTime).toBe(LATER);
    expect(games[0]?.earliestMatchTime).toBe(EARLIER);
  });

  // NEGATIVE CONTROL. Without this the suite would pass on a handler that
  // always serves earliest_match_time, or always serves the earlier-looking
  // string, regardless of which is actually smaller.
  it('NEGATIVE CONTROL — serves match_time when the floor is NOT earlier', async () => {
    const { games } = await fetchGames([
      gameRow({ match_time: EARLIER, earliest_match_time: LATER }),
    ]);
    expect(games[0]?.matchTime).toBe(EARLIER);
    expect(games[0]?.gameMatchTime).toBe(EARLIER);
  });

  it('equal inputs serve that value (the ordinary case — a floor cannot be raised)', async () => {
    const { games } = await fetchGames([
      gameRow({ match_time: LATER, earliest_match_time: LATER }),
    ]);
    expect(games[0]?.matchTime).toBe(LATER);
  });

  // Degrade to the raw value, never to null. The column is fully populated on
  // production today, but a null must not erase matchTime for affected rows.
  it('a null floor degrades to match_time, not to null', async () => {
    const { games } = await fetchGames([
      gameRow({ match_time: LATER, earliest_match_time: null }),
    ]);
    expect(games[0]?.matchTime).toBe(LATER);
    expect(games[0]?.earliestMatchTime).toBeNull();
  });

  it('an unparseable floor degrades to match_time', async () => {
    const { games } = await fetchGames([
      gameRow({ match_time: LATER, earliest_match_time: 'not-a-date' }),
    ]);
    expect(games[0]?.matchTime).toBe(LATER);
  });

  // Compares INSTANTS, not strings. These two inputs are chosen so the two
  // comparisons DISAGREE — an earlier calendar date carrying a negative offset
  // is the LATER instant:
  //
  //   earliest  2026-07-30T20:10:00-05:00  ==  2026-07-31T01:10:00Z   (later)
  //   match     2026-07-31T00:15:00+00:00  ==  2026-07-31T00:15:00Z   (earlier)
  //
  // Lexicographically "2026-07-30…" sorts first, so a string comparison would
  // wrongly serve the floor and report a start an hour BEFORE the real one.
  // An obvious-looking case like Z-vs-+00:00 on the same day agrees under both
  // and proves nothing — a mutation to `earliest < matchTime` survived it.
  it('compares INSTANTS, not strings — an earlier date can be the later instant', async () => {
    const { games } = await fetchGames([
      gameRow({
        match_time: '2026-07-31T00:15:00+00:00',
        earliest_match_time: '2026-07-30T20:10:00-05:00',
      }),
    ]);
    expect(games[0]?.matchTime).toBe('2026-07-31T00:15:00+00:00');
  });

  // The mirror: an offset making a LATER-sorting string the EARLIER instant,
  // which must still be served. Without this, "always return matchTime" passes
  // the case above.
  it('…and still serves the floor when the offset makes it genuinely earlier', async () => {
    const { games } = await fetchGames([
      gameRow({
        match_time: '2026-07-31T00:15:00+00:00',
        earliest_match_time: '2026-07-31T04:10:00+09:00', // == 2026-07-30T19:10Z
      }),
    ]);
    expect(games[0]?.matchTime).toBe('2026-07-31T04:10:00+09:00');
  });
});

describe('GET /v1/games — the query requests the column the minimum needs', () => {
  it('selects earliest_match_time', async () => {
    const { selects } = await fetchGames([gameRow()]);
    // Not a style assertion: the double above returns ONLY selected columns, so
    // dropping this from GAMES_SELECT makes every row read as a null floor and
    // the minimum silently degrades to the raw value.
    expect(selects['games']).toContain('earliest_match_time');
  });

  it('still selects match_time and the identity columns', async () => {
    const { selects } = await fetchGames([gameRow()]);
    for (const col of ['match_time', 'jsonodds_id', 'slug', 'sport']) {
      expect(selects['games']).toContain(col);
    }
  });
});

describe('GET /v1/games — unparseable input degrades to the raw value', () => {
  // These pin what used to be a separate `Number.isFinite` guard. That guard
  // was removed because no mutation of it could turn a test red: `Date.parse`
  // yields NaN and every `<` against NaN is false, so the comparison already
  // falls through. The behaviour is real and is asserted here directly.
  it('an unparseable match_time is served as-is rather than replaced', async () => {
    const { games } = await fetchGames([
      gameRow({ match_time: 'not-a-date', earliest_match_time: EARLIER }),
    ]);
    expect(games[0]?.matchTime).toBe('not-a-date');
    expect(games[0]?.gameMatchTime).toBe('not-a-date');
  });

  it('both unparseable still yields the raw match_time', async () => {
    const { games } = await fetchGames([
      gameRow({ match_time: 'nope', earliest_match_time: 'also-nope' }),
    ]);
    expect(games[0]?.matchTime).toBe('nope');
  });
});
