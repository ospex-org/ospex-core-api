/**
 * The contest readers that are not request handlers: `buildContestListItems`,
 * `fetchContestListRows` and `fetchContestListItem` in `src/v1/contests.ts`.
 *
 * The two that read do so through the REAL database client against a fake
 * PostgREST socket, so what is asserted is the request the database received
 * as well as what the reader made of the answer.
 *
 * Every identifier is made up. See `tests/helpers/mcpBook.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  expectReached,
  requestTo,
  type CapturedRequest,
  type FakePostgrest,
  type FakeReply,
} from './helpers/fakePostgrest.js';
import {
  NETWORK,
  NOW_MS,
  SCORERS,
  START,
  configFor,
  contestRow,
  speculationRow,
  startBook,
  tableOf,
  type Row,
  type Tables,
} from './helpers/mcpBook.js';
import type { ContestListQuery, ContestListRow } from '../src/v1/contests.js';
import type { SpeculationRow } from '../src/v1/utils/speculations.js';

const open: FakePostgrest[] = [];

afterEach(async () => {
  for (const fake of open.splice(0)) await fake.close();
  vi.doUnmock('../src/lib/env.js');
  vi.doUnmock('../src/lib/logger.js');
  vi.resetModules();
});

/** A scorer address that is none of the three configured ones. */
const OTHER_SCORER = '0x9999999999999999999999999999999999999999';

/** The second game of the fixture. */
const SECOND_START = '2026-09-27T23:10:00+00:00';
function secondContest(over: Row = {}): Row {
  return contestRow({
    contest_id: 482,
    jsonodds_id: '22222222-3333-4444-5555-666666666666',
    away_team: 'Seattle Mariners',
    home_team: 'Houston Astros',
    start_time: SECOND_START,
    effective_start_time: SECOND_START,
    game_match_time: SECOND_START,
    game_earliest_match_time: SECOND_START,
    game_rundown_match_time: SECOND_START,
    game_sportspage_match_time: SECOND_START,
    ...over,
  });
}

/** Contest 481 as a list item, less its speculations. */
const ITEM_481 = {
  contestId: '481',
  gameId: '11111111-2222-3333-4444-555555555555',
  jsonoddsId: '11111111-2222-3333-4444-555555555555',
  awayTeam: 'Tampa Bay Rays',
  homeTeam: 'Philadelphia Phillies',
  sport: 'mlb',
  sportId: 0,
  matchTime: '2026-09-27T19:05:00+00:00',
  chainStartTime: '2026-09-27T19:05:00+00:00',
  gameMatchTime: '2026-09-27T19:05:00+00:00',
  gameEarliestMatchTime: '2026-09-27T19:05:00+00:00',
  gameRundownMatchTime: '2026-09-27T19:05:00+00:00',
  gameSportspageMatchTime: '2026-09-27T19:05:00+00:00',
  status: 'verified',
};

/** The total 7.0 of contest 481, as served. */
const TOTAL_70 = {
  speculationId: '1001',
  contestId: '481',
  type: 'total',
  lineTicks: 70,
  line: 7,
  speculationStatus: 0,
  winSide: null,
  settledAt: null,
  voided: false,
};

/** The spread of contest 481, away side giving a point and a half, as served. */
const SPREAD_15 = {
  speculationId: '1002',
  contestId: '481',
  type: 'spread',
  lineTicks: -15,
  line: -1.5,
  awayLine: -1.5,
  homeLine: 1.5,
  speculationStatus: 0,
  winSide: null,
  settledAt: null,
  voided: false,
};

/** The moneyline of contest 482, as served. */
const MONEYLINE_482 = {
  speculationId: '2001',
  contestId: '482',
  type: 'moneyline',
  lineTicks: 0,
  line: null,
  speculationStatus: 0,
  winSide: null,
  settledAt: null,
  voided: false,
};

describe('buildContestListItems', () => {
  async function build(contests: Row[], speculations: Row[]): Promise<Array<Record<string, unknown>>> {
    const { buildContestListItems } = await import('../src/v1/contests.js');
    return buildContestListItems(
      contests as unknown as ContestListRow[],
      speculations as unknown as SpeculationRow[],
      { ...SCORERS },
      null,
    ) as unknown as Array<Record<string, unknown>>;
  }

  /**
   * Two lines on contest 481 and one on 482, every speculation id different,
   * in an order that goes 481, 482, 481. Two more rows that are not lines of
   * a configured scorer sit among them, each with a market type that is a real
   * one, so only the scorer can be what drops them.
   */
  const INTERLEAVED: Row[] = [
    speculationRow({ speculation_id: 1001, contest_id: 481 }),
    speculationRow({
      speculation_id: 2001,
      contest_id: 482,
      speculation_scorer: SCORERS.moneyline,
      market_type: 'moneyline',
      line_ticks: 0,
    }),
    speculationRow({
      speculation_id: 1003,
      contest_id: 481,
      speculation_scorer: OTHER_SCORER,
      market_type: 'moneyline',
      line_ticks: 0,
    }),
    speculationRow({ speculation_id: 2002, contest_id: 482, speculation_scorer: null, market_type: 'total', line_ticks: 85 }),
    // The contest id as digits in a string, which the database client may also hand over.
    speculationRow({
      speculation_id: 1002,
      contest_id: '481',
      speculation_scorer: SCORERS.spread,
      market_type: 'spread',
      line_ticks: -15,
    }),
  ];

  it('the fixture interleaves two contests, with five different speculation ids', () => {
    expect(INTERLEAVED.map((row) => String(row['contest_id']))).toEqual(['481', '482', '481', '482', '481']);
    expect(new Set(INTERLEAVED.map((row) => row['speculation_id'])).size).toBe(5);
    expect(Object.values(SCORERS)).not.toContain(OTHER_SCORER);
  });

  it('gives each contest its own lines and no other contest a share of them', async () => {
    const items = await build([contestRow(), secondContest()], INTERLEAVED);
    expect(items.map((item) => item['contestId'])).toEqual(['481', '482']);
    expect(items[0]!['speculations']).toEqual([TOTAL_70, SPREAD_15]);
    expect(items[1]!['speculations']).toEqual([MONEYLINE_482]);
    // The first case to import the module pays for it. Measured at about 0.4 s on a laptop.
  }, 15_000);

  it('gives the same lines when the contests are passed in the opposite order', async () => {
    const items = await build([secondContest(), contestRow()], INTERLEAVED);
    expect(items.map((item) => item['contestId'])).toEqual(['482', '481']);
    expect(items[0]!['speculations']).toEqual([MONEYLINE_482]);
    expect(items[1]!['speculations']).toEqual([TOTAL_70, SPREAD_15]);
  });

  it('drops a speculation whose scorer is not one of the three configured, and one whose scorer is null', async () => {
    const items = await build([contestRow(), secondContest()], INTERLEAVED);
    const served = items.flatMap((item) =>
      (item['speculations'] as Array<{ speculationId: string }>).map((speculation) => speculation.speculationId),
    );
    expect(served).toEqual(['1001', '1002', '2001']);
    expect(served).not.toContain('1003');
    expect(served).not.toContain('2002');
  });

  it('answers a contest with no lines an empty list, and every other field of the item', async () => {
    const items = await build([contestRow(), secondContest()], [speculationRow({ speculation_id: 1001, contest_id: 481 })]);
    expect(items[0]).toEqual({ ...ITEM_481, speculations: [TOTAL_70] });
    expect(items[1]!['speculations']).toEqual([]);
    expect(items[1]!['contestId']).toBe('482');
    expect(items[1]!['awayTeam']).toBe('Seattle Mariners');
  });

  it('leaves a speculation of a contest that was not passed out of every item', async () => {
    const items = await build([secondContest()], INTERLEAVED);
    expect(items).toHaveLength(1);
    expect(items[0]!['speculations']).toEqual([MONEYLINE_482]);
  });

  it('serves each of the six times from its own column', async () => {
    // Six different instants, one per column, so a column read from its
    // neighbour shows.
    const items = await build(
      [
        contestRow({
          start_time: '2026-09-27T19:05:00+00:00',
          effective_start_time: '2026-09-27T19:01:00+00:00',
          game_match_time: '2026-09-27T19:02:00+00:00',
          game_earliest_match_time: '2026-09-27T19:01:00.000001+00:00',
          game_rundown_match_time: '2026-09-27T19:03:00+00:00',
          game_sportspage_match_time: '2026-09-27T19:04:00+00:00',
        }),
      ],
      [],
    );
    expect(items[0]).toEqual({
      ...ITEM_481,
      chainStartTime: '2026-09-27T19:05:00+00:00',
      matchTime: '2026-09-27T19:01:00+00:00',
      gameMatchTime: '2026-09-27T19:02:00+00:00',
      gameEarliestMatchTime: '2026-09-27T19:01:00.000001+00:00',
      gameRundownMatchTime: '2026-09-27T19:03:00+00:00',
      gameSportspageMatchTime: '2026-09-27T19:04:00+00:00',
      speculations: [],
    });
  });

  it('serves the sport id from its own column, and a missing one as 0', async () => {
    // 4 is not the 0 a missing id is served as, so a sport id that was not
    // read from the row shows.
    const items = await build([contestRow({ jsonodds_sport_id: 4 }), secondContest({ jsonodds_sport_id: null })], []);
    expect(items.map((item) => item['sportId'])).toEqual([4, 0]);
  });

  it('serves a missing game identity as null, and a missing time or name as an empty string', async () => {
    const items = await build(
      [
        // An empty identity is served as null, the same as no identity at all.
        contestRow({ jsonodds_id: '' }),
        contestRow({
          contest_id: 483,
          jsonodds_id: null,
          away_team: null,
          home_team: null,
          sport_slug: null,
          jsonodds_sport_id: null,
          start_time: null,
          effective_start_time: null,
          game_match_time: null,
          game_earliest_match_time: null,
          game_rundown_match_time: null,
          game_sportspage_match_time: null,
          contest_status: null,
        }),
      ],
      [],
    );
    expect(items[0]).toEqual({ ...ITEM_481, gameId: null, jsonoddsId: null, speculations: [] });
    expect(items[1]).toEqual({
      contestId: '483',
      gameId: null,
      jsonoddsId: null,
      awayTeam: '',
      homeTeam: '',
      sport: '',
      sportId: 0,
      matchTime: '',
      chainStartTime: '',
      gameMatchTime: '',
      gameEarliestMatchTime: '',
      gameRundownMatchTime: '',
      gameSportspageMatchTime: '',
      status: '',
      speculations: [],
    });
  });

  it('adds gameFinalType only when given a finality map, and then to every item', async () => {
    const { buildContestListItems } = await import('../src/v1/contests.js');
    const contests = [contestRow(), secondContest(), contestRow({ contest_id: 483, jsonodds_id: null })] as unknown as ContestListRow[];
    const finality = new Map([['11111111-2222-3333-4444-555555555555', 'Finished']]);

    const dated = buildContestListItems(contests, [], { ...SCORERS }, finality);
    expect(dated.map((item) => item.gameFinalType)).toEqual(['Finished', '', '']);

    const forward = buildContestListItems(contests, [], { ...SCORERS }, null);
    expect(forward.map((item) => 'gameFinalType' in item)).toEqual([false, false, false]);
  });
});

interface Harness {
  fake: FakePostgrest;
  item: (contestId: string, withSpeculations?: boolean) => Promise<import('../src/v1/contests.js').ContestItemRead>;
  rows: (over?: Partial<ContestListQuery>) => Promise<import('../src/v1/contests.js').ContestListRead>;
}

async function harness(
  tables: Tables,
  override?: (request: CapturedRequest, index: number) => FakeReply | undefined,
): Promise<Harness> {
  const fake = await startBook(tables, override);
  open.push(fake);
  const config = configFor(fake);
  vi.resetModules();
  vi.doMock('../src/lib/env.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/lib/env.js')>()),
    loadConfig: () => config,
  }));
  vi.doMock('../src/lib/logger.js', () => ({
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    formatError: String,
  }));
  const { getSupabase } = await import('../src/lib/supabase.js');
  const contests = await import('../src/v1/contests.js');
  return {
    fake,
    item: (contestId, withSpeculations) =>
      withSpeculations === undefined
        ? contests.fetchContestListItem(getSupabase(), NETWORK, contestId, { ...SCORERS })
        : contests.fetchContestListItem(getSupabase(), NETWORK, contestId, { ...SCORERS }, withSpeculations),
    rows: (over = {}) =>
      contests.fetchContestListRows(getSupabase(), NETWORK, {
        nowMs: NOW_MS,
        windowHours: 48,
        sport: null,
        status: null,
        limit: 100,
        offset: 0,
        datedDay: null,
        tiebreakByContestId: true,
        ...over,
      }),
  };
}

/**
 * Two games on polygon with their lines, and beside them a line of contest 481
 * on the other network. A read that lost its network filter, or its contest
 * filter, is served a line it must not answer with.
 */
const BOOK: Tables = {
  contests_effective: [contestRow(), secondContest()],
  speculations: [
    speculationRow({ speculation_id: 1001, contest_id: 481 }),
    speculationRow({
      speculation_id: 2001,
      contest_id: 482,
      speculation_scorer: SCORERS.moneyline,
      market_type: 'moneyline',
      line_ticks: 0,
    }),
    speculationRow({
      speculation_id: 1002,
      contest_id: 481,
      speculation_scorer: SCORERS.spread,
      market_type: 'spread',
      line_ticks: -15,
    }),
    speculationRow({ network: 'amoy', speculation_id: 7001, contest_id: 481, line_ticks: 95 }),
  ],
};

describe('fetchContestListItem', () => {
  it('the fixture holds lines for the contest asked for, so an empty answer is the reader leaving them out', () => {
    expect(START).toBe('2026-09-27T19:05:00+00:00');
    const mine = (BOOK.speculations ?? []).filter(
      (row) => row['network'] === 'polygon' && String(row['contest_id']) === '481',
    );
    expect(mine.map((row) => row['speculation_id'])).toEqual([1001, 1002]);
  });

  it('makes one read and answers no speculations when asked for the contest alone', async () => {
    const h = await harness(BOOK);
    const result = await h.item('481', false);
    expectReached(h.fake);

    expect(result).toEqual({ ok: true, contest: { ...ITEM_481, speculations: [] } });
    expect(h.fake.tables()).toEqual(['contests_effective']);
    const params = h.fake.requests[0]!.params;
    expect(params.get('network')).toBe('eq.polygon');
    expect(params.get('contest_id')).toBe('eq.481');
    expect(params.get('select')).not.toContain('*');
  });

  it('makes two reads when asked for the speculations, both for that contest on that network', async () => {
    const h = await harness(BOOK);
    const result = await h.item('481', true);
    expectReached(h.fake, 2);

    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations']);
    for (const table of ['contests_effective', 'speculations']) {
      const params = requestTo(h.fake, table)?.params;
      expect(params?.get('network'), table).toBe('eq.polygon');
      expect(params?.get('contest_id'), table).toBe('eq.481');
    }
    expect(result).toEqual({ ok: true, contest: { ...ITEM_481, speculations: [TOTAL_70, SPREAD_15] } });
  });

  it('reads the speculations when it is not told whether to', async () => {
    const h = await harness(BOOK);
    const result = await h.item('481');
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations']);
    expect(result).toEqual({ ok: true, contest: { ...ITEM_481, speculations: [TOTAL_70, SPREAD_15] } });
  });

  it('answers a null contest, without an error and without a second read, for a contest that does not exist', async () => {
    const h = await harness(BOOK);
    expect(await h.item('999', true)).toEqual({ ok: true, contest: null });
    expectReached(h.fake);
    expect(h.fake.tables()).toEqual(['contests_effective']);
    expect(h.fake.requests[0]!.params.get('contest_id')).toBe('eq.999');
    // The contest beside it is answered.
    const beside = await h.item('482', true);
    expect(beside.ok && beside.contest?.contestId).toBe('482');
    expect(beside.ok && beside.contest?.speculations).toEqual([MONEYLINE_482]);
  });

  it('answers not-ok, naming the contests read, when that read fails', async () => {
    // 500, not 503: the database client retries a 503 itself, with a backoff, before reporting it.
    const h = await harness(BOOK, (request) =>
      tableOf(request) === 'contests_effective' ? { status: 500, body: { message: 'contest read failed' } } : undefined,
    );
    expect(await h.item('481', true)).toEqual({ ok: false, stage: 'contests', message: 'contest read failed' });
    expect(h.fake.tables()).toEqual(['contests_effective']);
  });

  it('answers not-ok, naming the speculations read, when that read fails', async () => {
    const h = await harness(BOOK, (request) =>
      tableOf(request) === 'speculations' ? { status: 500, body: { message: 'lines read failed' } } : undefined,
    );
    expect(await h.item('481', true)).toEqual({ ok: false, stage: 'speculations', message: 'lines read failed' });
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations']);
    // The same failing read is never made when the contest alone is asked for.
    expect(await h.item('481', false)).toEqual({ ok: true, contest: { ...ITEM_481, speculations: [] } });
  });
});

describe('fetchContestListRows', () => {
  it('reads the speculations of the contests it listed, on the network named', async () => {
    const h = await harness(BOOK);
    const result = await h.rows();
    expectReached(h.fake, 2);

    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations']);
    expect(requestTo(h.fake, 'contests_effective')?.params.get('network')).toBe('eq.polygon');
    expect(requestTo(h.fake, 'speculations')?.params.get('network')).toBe('eq.polygon');
    expect(requestTo(h.fake, 'speculations')?.params.get('contest_id')).toBe('in.(481,482)');

    expect(result.ok && result.total).toBe(2);
    expect(result.ok && result.rows.map((row) => String(row.contest_id))).toEqual(['481', '482']);
    expect(result.ok && result.specRows.map((row) => String(row.speculation_id)).sort()).toEqual([
      '1001',
      '1002',
      '2001',
    ]);
  });

  it('asks for the window from now to now plus the hours given, both ends included, in start order', async () => {
    // "Now" is 2026-09-27T12:00:00Z; 48 hours on is 2026-09-29T12:00:00Z.
    const h = await harness(BOOK);
    await h.rows({ windowHours: 48 });
    expectReached(h.fake);
    const params = requestTo(h.fake, 'contests_effective')!.params;
    expect(params.getAll('effective_start_time')).toEqual([
      'gte.2026-09-27T12:00:00.000Z',
      'lte.2026-09-29T12:00:00.000Z',
    ]);
    expect(params.get('start_time')).toBe('not.is.null');
    expect(params.get('order')).toBe('effective_start_time.asc,contest_id.asc');
    expect(params.get('offset')).toBe('0');
    expect(params.get('limit')).toBe('100');
    expect(params.has('sport_slug')).toBe(false);
    expect(params.has('contest_status')).toBe(false);
    expect(params.get('select')).not.toContain('*');
    expect(h.fake.requests[0]!.headers['prefer']).toContain('count=exact');
  });

  it('orders on the start alone when not asked to break ties on the contest id', async () => {
    const h = await harness(BOOK);
    await h.rows({ tiebreakByContestId: false });
    expect(requestTo(h.fake, 'contests_effective')!.params.get('order')).toBe('effective_start_time.asc');
  });

  it('asks for the page it was given, and answers the total across every page', async () => {
    // Two contests in the window, a page of one. The fake applies the limit
    // and ignores the offset, so the page is asserted on the request.
    const h = await harness(BOOK);
    const result = await h.rows({ limit: 1, offset: 1 });
    const params = requestTo(h.fake, 'contests_effective')!.params;
    expect(params.get('offset')).toBe('1');
    expect(params.get('limit')).toBe('1');
    expect(result.ok && result.rows).toHaveLength(1);
    expect(result.ok && result.total).toBe(2);
  });

  it('filters on the sport and the status when given them', async () => {
    const h = await harness({
      contests_effective: [contestRow(), secondContest({ sport_slug: 'nfl' }), contestRow({ contest_id: 483, contest_status: 'scored' })],
      speculations: [],
    });
    const result = await h.rows({ sport: 'mlb', status: 'verified' });
    const params = requestTo(h.fake, 'contests_effective')!.params;
    expect(params.get('sport_slug')).toBe('eq.mlb');
    expect(params.get('contest_status')).toBe('eq.verified');
    expect(result.ok && result.rows.map((row) => String(row.contest_id))).toEqual(['481']);
  });

  it('asks for the day given instead of the forward window, the end of the day excluded', async () => {
    const h = await harness(BOOK);
    await h.rows({ datedDay: { gte: '2026-09-27T00:00:00.000Z', lt: '2026-09-28T00:00:00.000Z' }, tiebreakByContestId: false });
    const params = requestTo(h.fake, 'contests_effective')!.params;
    expect(params.getAll('effective_start_time')).toEqual([
      'gte.2026-09-27T00:00:00.000Z',
      'lt.2026-09-28T00:00:00.000Z',
    ]);
    // A day is listed whole, so its ties are always broken.
    expect(params.get('order')).toBe('effective_start_time.asc,contest_id.asc');
  });

  it('reads no speculations when no contest was listed', async () => {
    const h = await harness({ contests_effective: [], speculations: BOOK.speculations ?? [] });
    expect(await h.rows()).toEqual({ ok: true, rows: [], specRows: [], total: 0 });
    expectReached(h.fake);
    expect(h.fake.tables()).toEqual(['contests_effective']);
  });

  it('answers not-ok, naming the contests read, when that read fails', async () => {
    const h = await harness(BOOK, (request) =>
      tableOf(request) === 'contests_effective' ? { status: 500, body: { message: 'contest read failed' } } : undefined,
    );
    expect(await h.rows()).toEqual({ ok: false, stage: 'contests', message: 'contest read failed' });
    expect(h.fake.tables()).toEqual(['contests_effective']);
  });

  it('answers not-ok, naming the speculations read, when that read fails', async () => {
    const h = await harness(BOOK, (request) =>
      tableOf(request) === 'speculations' ? { status: 500, body: { message: 'lines read failed' } } : undefined,
    );
    expect(await h.rows()).toEqual({ ok: false, stage: 'speculations', message: 'lines read failed' });
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations']);
  });
});
