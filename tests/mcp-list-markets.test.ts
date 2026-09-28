/**
 * `list_markets`, run against a database it can actually reach.
 *
 * The harness, the fixture and the clock are in `helpers/mcpTools.ts`.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expectReached, requestTo, type CapturedRequest, type FakeReply } from './helpers/fakePostgrest.js';
import {
  KEYS,
  NOW_MS,
  SCORERS,
  contestRow,
  hash,
  quoteRow,
  speculationRow,
  tableOf,
  type Row,
  type Tables,
} from './helpers/mcpBook.js';
import {
  AWAY_QUOTE,
  BOOK,
  GAME,
  HOME_QUOTE,
  MONEYLINE,
  OVER_QUOTE,
  READ_FAILED,
  TOTAL_7,
  UNDER_QUOTE,
  closeHarnesses,
  harness,
  lines,
  warmTools,
} from './helpers/mcpTools.js';

beforeAll(warmTools, 60_000);
afterEach(closeHarnesses);

const HEADER = 'Ospex: 1 game in the next 48 hours, as of Sun Sep 27, 8:00 am ET.';
const LEGEND =
  'Prices are decimal odds for the person taking the quote, rounded to two places. Amounts are USDC, and "up to" is the most one order can risk at that price.';
const CLOSING =
  'Listing prices places nothing. prepare_order turns one of them into a preview with the amounts paid and won, and a link.';
const INCOMPLETE = 'The book was too large to read completely, so some lines or quotes may be missing.';
const NO_GAMES = lines(
  'No games are open for betting on Ospex in the next 48 hours.',
  'A game appears here once its contest is verified on-chain.',
);
const ALL = { windowHours: 48, sport: undefined };

/** A second game, a day after the first. */
const METS = contestRow({
  contest_id: 482,
  jsonodds_id: '22222222-2222-3333-4444-555555555555',
  away_team: 'New York Mets',
  home_team: 'Washington Nationals',
  start_time: '2026-09-28T17:05:00+00:00',
  effective_start_time: '2026-09-28T17:05:00+00:00',
});
const METS_MONEYLINE = speculationRow({
  speculation_id: 2000,
  contest_id: 482,
  speculation_scorer: SCORERS.moneyline,
  market_type: 'moneyline',
  line_ticks: 0,
});
/** A maker on the Mets at 1.80, 2 USDC: a reader takes the Nationals at 2.25, up to 1.60. */
const NATIONALS_QUOTE = quoteRow({
  commitment_hash: hash('d1'),
  contest_id: 482,
  scorer: SCORERS.moneyline,
  market_type: 'moneyline',
  line_ticks: 0,
  position_type: 'upper',
  odds_tick: 180,
  risk_amount: '2000000',
  speculation_key: KEYS['c482-moneyline'],
});

const DROPPED = 'commitments: open book row carries a number that did not arrive exact — dropped';

const LEFT_OUT_ONE =
  '1 game that starts within two minutes is left out: that is too close to the start to prepare an order.';
const LEFT_OUT_TWO =
  '2 games that start within two minutes are left out: that is too close to the start to prepare an order.';
const LEFT_OUT_THREE =
  '3 games that start within two minutes are left out: that is too close to the start to prepare an order.';
/** Every game the read served was too close to its start. */
const NO_GAMES_ONE_TOO_CLOSE = lines(
  'No games are open for betting on Ospex in the next 48 hours.',
  LEFT_OUT_ONE,
);

/** Both games and their lines. */
const GAMES: Tables = {
  contests_effective: [contestRow(), METS],
  speculations: [...(BOOK.speculations ?? []), METS_MONEYLINE],
};

// What the good quotes on both games come to. Every stored quote the cases
// below put among them is priced at a maker price of 1.50 or 1.25, a taker
// price of 3.00 or 5.00, which would be the best on the Under and printed
// first on that line.
const GOOD_QUOTES_ONLY = lines(
  'Ospex: 2 games in the next 48 hours, as of Sun Sep 27, 8:00 am ET.',
  LEGEND,
  '',
  `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
  '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
  '   Moneyline',
  '     Tampa Bay Rays (away) to win: 2.67 (up to 1.80 USDC)',
  '     Philadelphia Phillies (home) to win: 1.67 (up to 6.00 USDC)',
  '   Spread',
  '     Tampa Bay Rays (away) -1.5: no quote posted',
  '     Philadelphia Phillies (home) +1.5: no quote posted',
  '   Total 7.0',
  '     Over 7.0: 2.10 (up to 9.10 USDC)',
  '     Under 7.0: 1.95 (up to 5.25 USDC)',
  '',
  '2. New York Mets @ Washington Nationals — MLB — Mon Sep 28, 1:05 pm ET — contest_id 482',
  '   New York Mets is the away team, Washington Nationals is the home team.',
  '   Moneyline',
  '     New York Mets (away) to win: no quote posted',
  '     Washington Nationals (home) to win: 2.25 (up to 1.60 USDC)',
  '',
  CLOSING,
);

/** The good quotes on both games, with `rows` among them. `0xb0…` sorts after 481's and before 482's. */
function bookWith(rows: Row[]): Tables {
  return { ...GAMES, commitments: [...(BOOK.commitments ?? []), ...rows, NATIONALS_QUOTE] };
}

/**
 * Answer the contest read with `rows` whatever it asked for. The read filters
 * by start in the database, so this is how a row its filter would not have
 * served is put in front of the tool. Every other read is answered as usual.
 */
function contestsAnswered(rows: Row[]): (request: CapturedRequest) => FakeReply | undefined {
  return (request) =>
    tableOf(request) === 'contests_effective'
      ? { status: 200, body: rows, contentRange: `0-${String(rows.length - 1)}/${String(rows.length)}` }
      : undefined;
}

/**
 * Answer the contest read with `rows`, counted as `total` rows in the window:
 * what the database says when its read stopped at the cap with more to come.
 */
function contestsCounted(rows: Row[], total: number): (request: CapturedRequest) => FakeReply | undefined {
  return (request) =>
    tableOf(request) === 'contests_effective'
      ? { status: 200, body: rows, contentRange: `0-${String(rows.length - 1)}/${String(total)}` }
      : undefined;
}

function startingAt(start: string | null): Row {
  return contestRow({ start_time: '2026-09-27T19:05:00+00:00', effective_start_time: start });
}

describe('list_markets', () => {
  it('lists the game, its lines, and the price a reader gets on each side', async () => {
    const h = await harness(BOOK);
    const result = await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    expectReached(h.fake, 3);

    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      lines(
        'Ospex: 1 game in the next 48 hours, as of Sun Sep 27, 8:00 am ET.',
        'Prices are decimal odds for the person taking the quote, rounded to two places. Amounts are USDC, and "up to" is the most one order can risk at that price.',
        '',
        `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
        '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
        '   Moneyline',
        '     Tampa Bay Rays (away) to win: 2.67 (up to 1.80 USDC)',
        '     Philadelphia Phillies (home) to win: 1.67 (up to 6.00 USDC)',
        '   Spread',
        '     Tampa Bay Rays (away) -1.5: no quote posted',
        '     Philadelphia Phillies (home) +1.5: no quote posted',
        '   Total 7.0',
        '     Over 7.0: 2.10 (up to 9.10 USDC)',
        '     Under 7.0: 1.95 (up to 5.25 USDC)',
        '',
        'Listing prices places nothing. prepare_order turns one of them into a preview with the amounts paid and won, and a link.',
      ),
    );
  });

  it('reads contests, then lines, then quotes, and nothing else', async () => {
    const h = await harness(BOOK);
    await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
  });

  it('asks only for verified games inside the window, in a stable order, capped', async () => {
    const h = await harness(BOOK);
    await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    const request = requestTo(h.fake, 'contests_effective');
    expect(request?.params.get('network')).toBe('eq.polygon');
    expect(request?.params.get('contest_status')).toBe('eq.verified');
    expect(request?.params.get('start_time')).toBe('not.is.null');
    expect(request?.params.getAll('effective_start_time')).toEqual([
      'gte.2026-09-27T12:00:00.000Z',
      'lte.2026-09-29T12:00:00.000Z',
    ]);
    expect(request?.params.get('order')).toBe('effective_start_time.asc,contest_id.asc');
    expect(request?.params.get('limit')).toBe('25');
    expect(request?.params.get('offset')).toBe('0');
    expect(request?.params.has('sport_slug')).toBe(false);
  });

  it('asks only for quotes that are open, visible, valid and unexpired', async () => {
    const h = await harness(BOOK);
    await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    const request = requestTo(h.fake, 'commitments');
    expect(request?.params.get('network')).toBe('eq.polygon');
    expect(request?.params.get('contest_id')).toBe('in.(481)');
    expect(request?.params.get('status')).toBe('in.(open,partially_filled)');
    expect(request?.params.get('book_visible')).toBe('eq.true');
    expect(request?.params.get('nonce_invalidated')).toBe('eq.false');
    expect(request?.params.get('expiry')).toBe('gt.2026-09-27T12:00:00.000Z');
    expect(request?.params.get('order')).toBe('commitment_hash.asc');
    expect(request?.params.get('limit')).toBe('999');
    expect(request?.params.get('select')).not.toContain('*');
  });

  it('shows up to three price levels on a side, best first, each sized by its largest quote', async () => {
    const levels: Tables = {
      ...BOOK,
      commitments: [
        UNDER_QUOTE,
        quoteRow({ commitment_hash: hash('b1'), odds_tick: 205, risk_amount: '2000000' }),
        quoteRow({ commitment_hash: hash('b2'), odds_tick: 210, risk_amount: '20000000' }),
        quoteRow({ commitment_hash: hash('b3'), odds_tick: 220, risk_amount: '1000000' }),
        quoteRow({ commitment_hash: hash('b4'), odds_tick: 230, risk_amount: '1000000' }),
      ],
    };
    const h = await harness(levels);
    const result = await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    // 205 -> 1.95, 210 -> 1.91, 220 -> 1.83. The fourth level, 230 -> 1.77, is not shown.
    expect(result.text).toContain('     Under 7.0: 1.95 (up to 5.25 USDC), 1.91 (up to 22.00 USDC), 1.83 (up to 1.20 USDC)');
    expect(result.text).not.toContain('1.77');
  });

  it('counts a partially filled quote at what it has left', async () => {
    const partly: Tables = {
      ...BOOK,
      commitments: [quoteRow({ status: 'partially_filled', filled_risk_amount: '1904700' })],
    };
    const h = await harness(partly);
    const result = await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    // 3_095_300 left at 2.05 absorbs 3_250_065.
    expect(result.text).toContain('     Under 7.0: 1.95 (up to 3.25 USDC)');
  });

  it('says so in plain words when no game is in the window', async () => {
    const h = await harness({ ...BOOK, contests_effective: [] });
    const result = await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    expectReached(h.fake);
    expect(result).toEqual({
      isError: false,
      text: lines(
        'No games are open for betting on Ospex in the next 48 hours.',
        'A game appears here once its contest is verified on-chain.',
      ),
    });
    // Nothing to look up lines or quotes for.
    expect(h.fake.tables()).toEqual(['contests_effective']);
  });

  it('says so when a game has no line on-chain', async () => {
    const h = await harness({ ...BOOK, speculations: [] });
    const result = await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    expect(result.text).toBe(
      lines(
        'Ospex: 1 game in the next 48 hours, as of Sun Sep 27, 8:00 am ET.',
        'Prices are decimal odds for the person taking the quote, rounded to two places. Amounts are USDC, and "up to" is the most one order can risk at that price.',
        'No quotes are posted on any of these games right now.',
        '',
        `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
        '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
        '   No line exists on-chain for this game yet.',
        '',
        'Listing prices places nothing. prepare_order turns one of them into a preview with the amounts paid and won, and a link.',
      ),
    );
  });

  it('says so when lines exist and nothing is quoted on them', async () => {
    const h = await harness({ ...BOOK, commitments: [] });
    const result = await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    expect(result.text).toContain('No quotes are posted on any of these games right now.');
    expect(result.text).toContain('     Over 7.0: no quote posted');
    expect(result.text).toContain('     Under 7.0: no quote posted');
    // The legend explains "up to"; no side carries an amount.
    expect(result.text).not.toContain('(up to');
    expect(result.text).not.toContain('USDC)');
  });

  it('never shows a quote on a line that does not exist on-chain', async () => {
    const orphan = quoteRow({
      commitment_hash: hash('c1'),
      line_ticks: 75,
      odds_tick: 150,
      speculation_key: KEYS['c481-total-75'],
    });
    const h = await harness({ ...BOOK, commitments: [UNDER_QUOTE, orphan] });
    const result = await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    expect(result.text).toContain('   Total 7.0');
    expect(result.text).not.toContain('7.5');
    // 150 would have been a taker price of 3.00.
    expect(result.text).not.toContain('3.00');
  });

  it('shows nothing from a settled line', async () => {
    const settled = speculationRow({ speculation_id: 1001, speculation_status: 'closed', win_side: 'under' });
    const h = await harness({ ...BOOK, speculations: [settled, MONEYLINE] });
    const result = await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    expect(result.text).toContain('   Moneyline');
    expect(result.text).not.toContain('Total');
  });

  it('lists games in start order and numbers them', async () => {
    const later = contestRow({
      contest_id: 482,
      away_team: 'New York Mets',
      home_team: 'Washington Nationals',
      start_time: '2026-09-28T17:05:00+00:00',
      effective_start_time: '2026-09-28T17:05:00+00:00',
    });
    const h = await harness({ ...BOOK, contests_effective: [later, contestRow()] });
    const result = await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    expect(result.text).toContain('Ospex: 2 games in the next 48 hours');
    expect(result.text.indexOf('1. Tampa Bay Rays')).toBeGreaterThan(0);
    expect(result.text.indexOf('2. New York Mets @ Washington Nationals — MLB — Mon Sep 28, 1:05 pm ET — contest_id 482')).toBeGreaterThan(
      result.text.indexOf('1. Tampa Bay Rays'),
    );
    expect(requestTo(h.fake, 'commitments')?.params.get('contest_id')).toBe('in.(481,482)');
  });

  it('says how many games were left out when the window holds more than one call lists', async () => {
    const many: Row[] = [];
    for (let index = 0; index < 26; index += 1) {
      const minute = String(index).padStart(2, '0');
      many.push(
        contestRow({
          contest_id: 500 + index,
          start_time: `2026-09-27T20:${minute}:00+00:00`,
          effective_start_time: `2026-09-27T20:${minute}:00+00:00`,
        }),
      );
    }
    const h = await harness({ contests_effective: many, speculations: [], commitments: [] });
    const result = await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    expect(result.text).toContain('Ospex: 25 games in the next 48 hours');
    expect(result.text).toContain('contest_id 524');
    expect(result.text).not.toContain('contest_id 525');
    expect(result.text).toContain(
      'Showing the first 25 of 26 games by start time. Ask for one sport or a shorter window to see the rest.',
    );
  });

  it('filters by sport, whatever case it was written in', async () => {
    const h = await harness(BOOK);
    const result = await h.listMarkets({ windowHours: 24, sport: ' MLB ' }, h.ctx);
    expect(requestTo(h.fake, 'contests_effective')?.params.get('sport_slug')).toBe('eq.mlb');
    expect(result.text).toContain('Ospex: 1 MLB game in the next 24 hours');
  });

  it('names the sport when there is none of it', async () => {
    const h = await harness(BOOK);
    const result = await h.listMarkets({ windowHours: 48, sport: 'nhl' }, h.ctx);
    expect(result.text).toContain('No NHL games are open for betting on Ospex in the next 48 hours.');
  });

  it('refuses a sport it does not know, before reading anything', async () => {
    const h = await harness(BOOK);
    const result = await h.listMarkets({ windowHours: 48, sport: 'cricket' }, h.ctx);
    expect(result).toEqual({ isError: true, text: 'sport must be one of: mlb, nba, ncaab, ncaaf, nfl, nhl.' });
    expect(h.fake.requests).toHaveLength(0);
  });

  it('refuses a window outside 1 to 168 hours, before reading anything', async () => {
    const h = await harness(BOOK);
    for (const windowHours of [0, 169, 1.5, -1, Number.NaN]) {
      expect(await h.listMarkets({ windowHours, sport: undefined }, h.ctx)).toEqual({
        isError: true,
        text: 'window_hours must be a whole number from 1 to 168.',
      });
    }
    expect(h.fake.requests).toHaveLength(0);
    // Both ends of the range are accepted.
    expect((await h.listMarkets({ windowHours: 1, sport: undefined }, h.ctx)).isError).toBe(false);
    expect((await h.listMarkets({ windowHours: 168, sport: undefined }, h.ctx)).isError).toBe(false);
  });

  it('answers with fixed words when the contest read fails, and logs the cause', async () => {
    const h = await harness(BOOK, {
      override: (request) =>
        tableOf(request) === 'contests_effective'
          ? { status: 500, body: { message: 'relation exploded at db.internal' } }
          : undefined,
    });
    const result = await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    expectReached(h.fake);
    expect(result).toEqual({ isError: true, text: READ_FAILED });
    expect(result.text).not.toContain('exploded');
    expect(h.log.error).toHaveBeenCalledWith(
      { err: 'relation exploded at db.internal', stage: 'contests' },
      'mcp: list_markets contest read failed',
    );
  });

  it('answers with fixed words when the quote read fails', async () => {
    const h = await harness(BOOK, {
      override: (request) =>
        tableOf(request) === 'commitments' ? { status: 500, body: { message: 'quotes unavailable' } } : undefined,
    });
    const result = await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    expect(result).toEqual({ isError: true, text: READ_FAILED });
    expect(h.log.error).toHaveBeenCalledWith({ err: 'quotes unavailable' }, 'mcp: list_markets open book read failed');
  });

  it('refuses when the service has no scorer addresses, before reading anything', async () => {
    const h = await harness(BOOK, { context: { scorers: undefined } });
    const result = await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    expect(result).toEqual({
      isError: true,
      text: 'This Ospex service is not configured to read markets. Nothing was placed.',
    });
    expect(h.fake.requests).toHaveLength(0);
  });
});

describe('list_markets reads', () => {
  it('asks only for the lines of the games it listed, on its own network', async () => {
    const h = await harness(BOOK);
    await h.listMarkets(ALL, h.ctx);
    const request = requestTo(h.fake, 'speculations');
    expect(request?.params.get('network')).toBe('eq.polygon');
    expect(request?.params.get('contest_id')).toBe('in.(481)');
  });

  it('answers with fixed words when the lines read fails, lists nothing, and logs the cause', async () => {
    const h = await harness(BOOK, {
      override: (request) =>
        tableOf(request) === 'speculations'
          ? { status: 500, body: { message: 'lines unavailable at db.internal' } }
          : undefined,
    });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: true, text: READ_FAILED });
    // The contest read succeeded and served the game. The quotes were never asked for.
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations']);
    expect(h.log.error).toHaveBeenCalledWith(
      { err: 'lines unavailable at db.internal', stage: 'speculations' },
      'mcp: list_markets contest read failed',
    );
  });
});

describe('list_markets on a game too close to its start', () => {
  // The fixture's lines and quotes are on contest 481, so a listed game shows them.
  const LISTED_AT_8_02 = lines(
    'Ospex: 1 game in the next 48 hours, as of Sun Sep 27, 8:00 am ET.',
    LEGEND,
    '',
    `1. ${GAME} — MLB — Sun Sep 27, 8:02 am ET — contest_id 481`,
    '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
    '   Moneyline',
    '     Tampa Bay Rays (away) to win: 2.67 (up to 1.80 USDC)',
    '     Philadelphia Phillies (home) to win: 1.67 (up to 6.00 USDC)',
    '   Spread',
    '     Tampa Bay Rays (away) -1.5: no quote posted',
    '     Philadelphia Phillies (home) +1.5: no quote posted',
    '   Total 7.0',
    '     Over 7.0: 2.10 (up to 9.10 USDC)',
    '     Under 7.0: 1.95 (up to 5.25 USDC)',
    '',
    CLOSING,
  );

  it('leaves out a game that starts exactly two minutes from now, and says why', async () => {
    const start = '2026-09-27T12:02:00+00:00';
    expect(Date.parse(start) - NOW_MS).toBe(120_000);
    const h = await harness(BOOK, { override: contestsAnswered([startingAt(start)]) });
    const result = await h.listMarkets(ALL, h.ctx);
    // The game was served, and its lines and quotes were read: the tool is what left it out.
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
    expect(result).toEqual({ isError: false, text: NO_GAMES_ONE_TOO_CLOSE });
  });

  it('lists a game that starts one microsecond more than two minutes from now', async () => {
    const h = await harness(BOOK, { override: contestsAnswered([startingAt('2026-09-27T12:02:00.000001+00:00')]) });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: LISTED_AT_8_02 });
  });

  it('leaves out a game that starts now', async () => {
    const start = '2026-09-27T12:00:00+00:00';
    expect(Date.parse(start)).toBe(NOW_MS);
    const h = await harness(BOOK, { override: contestsAnswered([startingAt(start)]) });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
    expect(result).toEqual({ isError: false, text: NO_GAMES_ONE_TOO_CLOSE });
  });

  it('leaves out a game that started an hour ago', async () => {
    // The read asks only for games that start from now on, so this row is one
    // it would not have served. The tool counts it with the games too close to
    // their start.
    const start = '2026-09-27T11:00:00+00:00';
    expect(Date.parse(start) - NOW_MS).toBe(-3_600_000);
    const h = await harness(BOOK, { override: contestsAnswered([startingAt(start)]) });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
    expect(result).toEqual({ isError: false, text: NO_GAMES_ONE_TOO_CLOSE });
  });

  it('leaves out a game whose start cannot be read, without counting it as too close', async () => {
    const h = await harness(BOOK, { override: contestsAnswered([startingAt(null)]) });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
    expect(result).toEqual({ isError: false, text: NO_GAMES });
  });

  it('names the sport and the window asked for when every game is left out', async () => {
    const h = await harness(BOOK, { override: contestsAnswered([startingAt('2026-09-27T12:02:00+00:00')]) });
    const result = await h.listMarkets({ windowHours: 24, sport: 'mlb' }, h.ctx);
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
    expect(result).toEqual({
      isError: false,
      text: lines('No MLB games are open for betting on Ospex in the next 24 hours.', LEFT_OUT_ONE),
    });
  });

  it('says three games were left out when every game read was that close to its start', async () => {
    const rows = [
      contestRow({ contest_id: 484, effective_start_time: '2026-09-27T12:00:30+00:00' }),
      contestRow({ contest_id: 485, effective_start_time: '2026-09-27T12:01:00+00:00' }),
      contestRow({ contest_id: 486, effective_start_time: '2026-09-27T12:02:00+00:00' }),
    ];
    const h = await harness(BOOK, { override: contestsAnswered(rows) });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines('No games are open for betting on Ospex in the next 48 hours.', LEFT_OUT_THREE),
    });
  });

  it('lists the other games and says three were left out, before its other notes', async () => {
    const rows = [
      contestRow({ contest_id: 484, effective_start_time: '2026-09-27T12:00:30+00:00' }),
      contestRow({ contest_id: 485, effective_start_time: '2026-09-27T12:01:00+00:00' }),
      contestRow({ contest_id: 486, effective_start_time: '2026-09-27T12:02:00+00:00' }),
      METS,
    ];
    const h = await harness(
      { ...BOOK, speculations: [METS_MONEYLINE], commitments: [NATIONALS_QUOTE] },
      { override: contestsAnswered(rows) },
    );
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        HEADER,
        LEGEND,
        '',
        '1. New York Mets @ Washington Nationals — MLB — Mon Sep 28, 1:05 pm ET — contest_id 482',
        '   New York Mets is the away team, Washington Nationals is the home team.',
        '   Moneyline',
        '     New York Mets (away) to win: no quote posted',
        '     Washington Nationals (home) to win: 2.25 (up to 1.60 USDC)',
        '',
        LEFT_OUT_THREE,
        CLOSING,
      ),
    });
  });

  it('counts and numbers only the games it lists', async () => {
    const rows = [
      startingAt('2026-09-27T11:00:00+00:00'),
      contestRow({ contest_id: 483, start_time: '2026-09-27T19:05:00+00:00', effective_start_time: null }),
      contestRow({ contest_id: 484, effective_start_time: '2026-09-27T12:02:00+00:00' }),
      METS,
    ];
    const h = await harness(
      { ...BOOK, speculations: [TOTAL_7, METS_MONEYLINE], commitments: [UNDER_QUOTE, NATIONALS_QUOTE] },
      { override: contestsAnswered(rows) },
    );
    const result = await h.listMarkets(ALL, h.ctx);
    expect(requestTo(h.fake, 'commitments')?.params.get('contest_id')).toBe('in.(481,483,484,482)');
    // Two are counted as too close: the one that started and 484. 483, whose
    // start cannot be read, is left out without being counted.
    expect(result).toEqual({
      isError: false,
      text: lines(
        HEADER,
        LEGEND,
        '',
        '1. New York Mets @ Washington Nationals — MLB — Mon Sep 28, 1:05 pm ET — contest_id 482',
        '   New York Mets is the away team, Washington Nationals is the home team.',
        '   Moneyline',
        '     New York Mets (away) to win: no quote posted',
        '     Washington Nationals (home) to win: 2.25 (up to 1.60 USDC)',
        '',
        LEFT_OUT_TWO,
        CLOSING,
      ),
    });
  });

  it('counts games shown, not rows read, when the window holds more than one call lists', async () => {
    // Twenty-six games in the window: one at 8:01 am, then twenty-five from
    // 4:00 pm a minute apart. The read takes the first twenty-five, and the
    // first of those is too close to its start to be shown.
    const many: Row[] = [contestRow({ contest_id: 499, effective_start_time: '2026-09-27T12:01:00+00:00' })];
    for (let index = 0; index < 25; index += 1) {
      const minute = String(index).padStart(2, '0');
      many.push(contestRow({ contest_id: 500 + index, effective_start_time: `2026-09-27T20:${minute}:00+00:00` }));
    }
    const h = await harness({ contests_effective: many, speculations: [], commitments: [] });
    const result = await h.listMarkets(ALL, h.ctx);
    const text = result.text.split('\n');
    expect(text[0]).toBe('Ospex: 24 games in the next 48 hours, as of Sun Sep 27, 8:00 am ET.');
    expect(text).toContain(`24. ${GAME} — MLB — Sun Sep 27, 4:23 pm ET — contest_id 523`);
    expect(result.text).not.toContain('contest_id 499');
    expect(result.text).not.toContain('contest_id 524');
    expect(result.text).not.toContain('25. ');
    expect(text.slice(-4)).toEqual([
      '',
      LEFT_OUT_ONE,
      'Showing the first 24 of 26 games by start time. Ask for one sport or a shorter window to see the rest.',
      CLOSING,
    ]);
  });
});

describe('list_markets on a contest that is not open for betting', () => {
  // The read asks for verified contests with a start on-chain, so none of these
  // rows would be served by it. Each is served here by answering the read
  // directly, beside the fixture's verified game.
  const ROWS = [
    contestRow({ contest_id: 485, contest_status: 'unverified' }),
    contestRow({ contest_id: 486, contest_status: 'scored' }),
    contestRow({ contest_id: 487, start_time: null }),
    // Unverified and one minute from its start: skipped, not counted as too close.
    contestRow({ contest_id: 488, contest_status: 'unverified', effective_start_time: '2026-09-27T12:01:00+00:00' }),
  ];

  it('skips a contest that is not verified or has no start on-chain, and lists its verified twin', async () => {
    const h = await harness(BOOK, { override: contestsAnswered([...ROWS, contestRow()]) });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(requestTo(h.fake, 'commitments')?.params.get('contest_id')).toBe('in.(485,486,487,488,481)');
    expect(result).toEqual({
      isError: false,
      text: lines(
        HEADER,
        LEGEND,
        '',
        `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
        '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
        '   Moneyline',
        '     Tampa Bay Rays (away) to win: 2.67 (up to 1.80 USDC)',
        '     Philadelphia Phillies (home) to win: 1.67 (up to 6.00 USDC)',
        '   Spread',
        '     Tampa Bay Rays (away) -1.5: no quote posted',
        '     Philadelphia Phillies (home) +1.5: no quote posted',
        '   Total 7.0',
        '     Over 7.0: 2.10 (up to 9.10 USDC)',
        '     Under 7.0: 1.95 (up to 5.25 USDC)',
        '',
        CLOSING,
      ),
    });
  });

  it('says only that no game is open when every contest read is one of those', async () => {
    const h = await harness(BOOK, { override: contestsAnswered(ROWS) });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
    expect(result).toEqual({ isError: false, text: NO_GAMES });
  });

  it('skips each kind on its own', async () => {
    for (const row of ROWS) {
      const h = await harness(BOOK, { override: contestsAnswered([row]) });
      expect(await h.listMarkets(ALL, h.ctx)).toEqual({ isError: false, text: NO_GAMES });
    }
  });
});

describe('list_markets on a read it could not finish', () => {
  /** The `index`-th hash in ascending order. */
  function nthHash(index: number): string {
    return `0x${index.toString(16).padStart(64, '0')}`;
  }

  /** `count` copies of the default quote, each under its own hash. */
  function bookOf(count: number): Tables {
    const commitments: Row[] = [];
    for (let index = 1; index <= count; index += 1) commitments.push(quoteRow({ commitment_hash: nthHash(index) }));
    return { contests_effective: [contestRow()], speculations: [TOTAL_7], commitments };
  }

  /** One open line and `count - 1` settled ones, none of which is printed. */
  function linesOf(count: number): Tables {
    const speculations: Row[] = [TOTAL_7];
    for (let index = 1; index < count; index += 1) {
      speculations.push(
        speculationRow({
          speculation_id: 5000 + index,
          line_ticks: 1000 + index,
          speculation_status: 'closed',
          win_side: 'over',
        }),
      );
    }
    return { contests_effective: [contestRow()], speculations, commitments: [UNDER_QUOTE] };
  }

  const LISTING = [
    HEADER,
    LEGEND,
    '',
    `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
    '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
    '   Total 7.0',
    '     Over 7.0: no quote posted',
    '     Under 7.0: 1.95 (up to 5.25 USDC)',
    '',
  ];
  const WHOLE = lines(...LISTING, CLOSING);
  const IN_PART = lines(...LISTING, INCOMPLETE, CLOSING);

  /** The cursor of the eighth request: the hash of quote 6,993, the last of seven pages of 999. */
  const AFTER_SEVEN_PAGES = `gt.0x${'0'.repeat(60)}1b51`;

  // The three cases that read eight pages measured 1.5 s to 2.9 s each on a
  // busy machine, most of it the fake database filtering and sorting about
  // 8,000 rows eight times. The limit leaves room for a slower runner.
  it(
    'says the book may be missing quotes when one more is open than eight pages of 999 hold',
    async () => {
      const book = bookOf(7993);
      expect(book.commitments).toHaveLength(7993);
      const h = await harness(book);
      const result = await h.listMarkets(ALL, h.ctx);
      expect(h.fake.tables().filter((table) => table === 'commitments')).toHaveLength(8);
      expect(requestTo(h.fake, 'commitments', 7)?.params.get('limit')).toBe('999');
      expect(requestTo(h.fake, 'commitments', 7)?.params.get('commitment_hash')).toBe(AFTER_SEVEN_PAGES);
      expect(result).toEqual({ isError: false, text: IN_PART });
      expect(h.log.warn).toHaveBeenCalledWith(
        { network: 'polygon', contests: 1, rows: 7992 },
        'commitments: open book drain ran out of pages, book is incomplete',
      );
    },
    20_000,
  );

  // A full last page cannot be told from one that was cut, so it is not read as the end.
  it(
    'says so as well when the open quotes fill the eighth page exactly',
    async () => {
      const book = bookOf(7992);
      expect(book.commitments).toHaveLength(7992);
      const h = await harness(book);
      const result = await h.listMarkets(ALL, h.ctx);
      expect(h.fake.tables().filter((table) => table === 'commitments')).toHaveLength(8);
      expect(result).toEqual({ isError: false, text: IN_PART });
    },
    20_000,
  );

  it(
    'says nothing of the kind when the eighth page comes back one quote short of full',
    async () => {
      const book = bookOf(7991);
      expect(book.commitments).toHaveLength(7991);
      const h = await harness(book);
      const result = await h.listMarkets(ALL, h.ctx);
      expect(h.fake.tables().filter((table) => table === 'commitments')).toHaveLength(8);
      expect(requestTo(h.fake, 'commitments', 7)?.params.get('commitment_hash')).toBe(AFTER_SEVEN_PAGES);
      expect(result).toEqual({ isError: false, text: WHOLE });
      expect(h.log.warn).not.toHaveBeenCalled();
    },
    20_000,
  );

  // Two pages over 1,000 rows: measured 0.4 s on the same machine.
  it(
    'reads on past a dropped quote that ends a full page, and drops it once',
    async () => {
      // 1,000 copies of the default quote. The 999th, the last of the first
      // page, carries an amount that did not arrive exact.
      const book = bookOf(1000);
      book.commitments?.splice(998, 1, quoteRow({ commitment_hash: nthHash(999), risk_amount: 1e21 }));
      expect(book.commitments?.[998]?.risk_amount).toBe(1e21);
      const h = await harness(book);
      const result = await h.listMarkets(ALL, h.ctx);
      expect(h.fake.tables().filter((table) => table === 'commitments')).toHaveLength(2);
      // The second page starts after the dropped quote, whose hash ends in 3e7 (999).
      expect(requestTo(h.fake, 'commitments', 1)?.params.get('commitment_hash')).toBe(`gt.0x${'0'.repeat(61)}3e7`);
      expect(h.log.warn.mock.calls).toEqual([[{ commitmentHash: nthHash(999) }, DROPPED]]);
      expect(result).toEqual({ isError: false, text: WHOLE });
    },
    20_000,
  );

  it('says lines may be missing when the lines read answered 1,000 rows', async () => {
    const book = linesOf(1000);
    expect(book.speculations).toHaveLength(1000);
    const h = await harness(book);
    const result = await h.listMarkets(ALL, h.ctx);
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
    expect(result).toEqual({ isError: false, text: IN_PART });
  });

  it('puts the note on a game too close to its start before the note on lines that may be missing', async () => {
    const book = linesOf(1000);
    const close = contestRow({ contest_id: 484, effective_start_time: '2026-09-27T12:01:00+00:00' });
    const h = await harness(book, { override: contestsAnswered([close, contestRow()]) });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: lines(...LISTING, LEFT_OUT_ONE, INCOMPLETE, CLOSING) });
  });

  it('says nothing of the kind when the lines read answered 999 rows', async () => {
    const book = linesOf(999);
    expect(book.speculations).toHaveLength(999);
    const h = await harness(book);
    const result = await h.listMarkets(ALL, h.ctx);
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
    expect(result).toEqual({ isError: false, text: WHOLE });
  });
});

describe('list_markets on a quote whose numbers did not arrive exact', () => {
  it('lists every good quote beside one whose amount arrived as the number 1e21', async () => {
    // A maker price of 1.50 is a taker price of 3.00, which no other quote has.
    const bad = quoteRow({ commitment_hash: hash('b0'), odds_tick: 150, risk_amount: 1e21 });
    expect(JSON.stringify(bad.risk_amount)).toBe('1e+21');
    const h = await harness(bookWith([bad]));
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: GOOD_QUOTES_ONLY });
    expect(h.log.warn.mock.calls).toEqual([[{ commitmentHash: hash('b0') }, DROPPED]]);
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it('lists every good quote beside one whose filled amount arrived as the number 1e21', async () => {
    const bad = quoteRow({
      commitment_hash: hash('b0'),
      odds_tick: 150,
      status: 'partially_filled',
      filled_risk_amount: 1e21,
    });
    const h = await harness(bookWith([bad]));
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: GOOD_QUOTES_ONLY });
    expect(h.log.warn.mock.calls).toEqual([[{ commitmentHash: hash('b0') }, DROPPED]]);
  });

  it('shows nothing from a quote whose nonce arrived as a number of 2^53 or more', async () => {
    // Both numbers are ones a double holds, so they arrive as written. Neither
    // is one a double is sure of: 2^53 + 1 would have arrived as 2^53 too.
    const atLimit = quoteRow({ commitment_hash: hash('b0'), odds_tick: 150, nonce: 9007199254740992 });
    const above = quoteRow({ commitment_hash: hash('b1'), odds_tick: 125, nonce: 9007199254740994 });
    expect(JSON.stringify([atLimit.nonce, above.nonce])).toBe('[9007199254740992,9007199254740994]');
    const h = await harness(bookWith([atLimit, above]));
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: GOOD_QUOTES_ONLY });
    expect(h.log.warn.mock.calls).toEqual([
      [{ commitmentHash: hash('b0') }, DROPPED],
      [{ commitmentHash: hash('b1') }, DROPPED],
    ]);
  });

  it('shows nothing from a quote whose filled amount arrived below zero, as a number or as text', async () => {
    // 5 USDC less a filled amount of minus 1 USDC would leave 6 USDC, and at a
    // maker price of 1.50 that would be listed as 3.00 (up to 3.00 USDC).
    const asNumber = quoteRow({
      commitment_hash: hash('b0'),
      odds_tick: 150,
      status: 'partially_filled',
      filled_risk_amount: -1000000,
    });
    const asText = quoteRow({
      commitment_hash: hash('b1'),
      odds_tick: 150,
      status: 'partially_filled',
      filled_risk_amount: '-1000000',
    });
    expect(JSON.stringify([asNumber.filled_risk_amount, asText.filled_risk_amount])).toBe('[-1000000,"-1000000"]');
    const h = await harness(bookWith([asNumber, asText]));
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: GOOD_QUOTES_ONLY });
    expect(h.log.warn.mock.calls).toEqual([
      [{ commitmentHash: hash('b0') }, DROPPED],
      [{ commitmentHash: hash('b1') }, DROPPED],
    ]);
  });

  it('shows nothing from a quote whose filled amount arrived as text that is not all digits', async () => {
    // BigInt reads both of these (as 1,907,260 and 1,904,700), so the check on
    // the digits is the only thing that refuses them. Either would leave about
    // 3.09 USDC, listed at a maker price of 1.50 as 3.00 (up to 1.54 USDC).
    const hex = quoteRow({ commitment_hash: hash('b0'), odds_tick: 150, status: 'partially_filled', filled_risk_amount: '0x1d1a3c' });
    const spaced = quoteRow({ commitment_hash: hash('b1'), odds_tick: 150, status: 'partially_filled', filled_risk_amount: ' 1904700' });
    expect([BigInt('0x1d1a3c'), BigInt(' 1904700')]).toEqual([1907260n, 1904700n]);
    const h = await harness(bookWith([hex, spaced]));
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: GOOD_QUOTES_ONLY });
    expect(h.log.warn.mock.calls).toEqual([
      [{ commitmentHash: hash('b0') }, DROPPED],
      [{ commitmentHash: hash('b1') }, DROPPED],
    ]);
  });

  it('shows nothing from a quote filled past the amount it was signed for, and its partly filled twin', async () => {
    // Six USDC filled of five leaves nothing to take. The twin, one USDC filled
    // of five, leaves four: 2.00 at a maker price of 1.50.
    const over = quoteRow({ commitment_hash: hash('b0'), odds_tick: 150, status: 'partially_filled', filled_risk_amount: '6000000' });
    const twin = quoteRow({ commitment_hash: hash('b1'), odds_tick: 150, status: 'partially_filled', filled_risk_amount: '1000000' });
    const overOnly = await harness(bookWith([over]));
    expect(await overOnly.listMarkets(ALL, overOnly.ctx)).toEqual({ isError: false, text: GOOD_QUOTES_ONLY });
    expect(overOnly.log.warn).not.toHaveBeenCalled();

    const h = await harness(bookWith([twin]));
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result.text.split('\n')).toContain('     Under 7.0: 3.00 (up to 2.00 USDC), 1.95 (up to 5.25 USDC)');
  });

  it('shows a quote whose numbers arrived as numbers small enough to be exact', async () => {
    const exact = quoteRow({
      commitment_hash: hash('b0'),
      odds_tick: 150,
      risk_amount: 1000000,
      filled_risk_amount: 0,
      nonce: 9007199254740991,
    });
    const h = await harness(bookWith([exact]));
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result.isError).toBe(false);
    // 1.000000 USDC at 1.50 absorbs 0.50.
    expect(result.text.split('\n')).toContain('     Under 7.0: 3.00 (up to 0.50 USDC), 1.95 (up to 5.25 USDC)');
    expect(h.log.warn).not.toHaveBeenCalled();
  });

  it('shows a quote whose filled amount and nonce arrived null, at the whole amount it was signed for', async () => {
    // A null filled amount reads as nothing filled, so all 1 USDC is left.
    const unset = quoteRow({
      commitment_hash: hash('b0'),
      odds_tick: 150,
      risk_amount: '1000000',
      filled_risk_amount: null,
      nonce: null,
    });
    expect([unset.filled_risk_amount, unset.nonce]).toEqual([null, null]);
    const h = await harness(bookWith([unset]));
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result.isError).toBe(false);
    expect(result.text.split('\n')).toContain('     Under 7.0: 3.00 (up to 0.50 USDC), 1.95 (up to 5.25 USDC)');
    expect(h.log.warn).not.toHaveBeenCalled();
  });
});

describe('list_markets on a stored quote that cannot be taken as it stands', () => {
  // Each row is otherwise a good quote at a maker price of 1.50, so each is
  // refused by one check only.

  it('lists every good quote beside quotes priced outside the range the protocol takes', async () => {
    // 1.00 pays nothing and 101.01 is past the top of the range. Neither has a
    // taker price that can be worked out.
    const free = quoteRow({ commitment_hash: hash('b0'), odds_tick: 100 });
    const tooLong = quoteRow({ commitment_hash: hash('b1'), odds_tick: 10101 });
    const h = await harness(bookWith([free, tooLong]));
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: GOOD_QUOTES_ONLY });
  });

  it('shows nothing from a quote signed for an amount that is not a whole number of lots', async () => {
    // 5.000050 USDC. Its whole lots, 5 USDC at 1.50, would be listed as 3.00 (up to 2.50 USDC).
    const partLot = quoteRow({ commitment_hash: hash('b0'), odds_tick: 150, risk_amount: '5000050' });
    const h = await harness(bookWith([partLot]));
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: GOOD_QUOTES_ONLY });
  });

  it('shows nothing from a quote whose hash is not the shape of a hash', async () => {
    // Thirty-two bytes, the last of them not hex, so a check of the length
    // alone would take it. 5 USDC at 1.50 would be listed as 3.00 (up to 2.50 USDC).
    const notHex = quoteRow({ commitment_hash: `0x${'b0'.repeat(31)}gg`, odds_tick: 150 });
    expect(String(notHex.commitment_hash)).toHaveLength(66);
    const h = await harness(bookWith([notHex]));
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: GOOD_QUOTES_ONLY });
  });
});

describe('list_markets on a quote close to its expiry', () => {
  // The read asks only for quotes that expire after now, so both of these are
  // served. The first expires exactly two minutes from now.
  function expiringAt(expiry: string): Tables {
    return { ...BOOK, commitments: [quoteRow({ expiry }), OVER_QUOTE, HOME_QUOTE, AWAY_QUOTE] };
  }

  const listing = (under: string): string =>
    lines(
      HEADER,
      LEGEND,
      '',
      `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
      '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
      '   Moneyline',
      '     Tampa Bay Rays (away) to win: 2.67 (up to 1.80 USDC)',
      '     Philadelphia Phillies (home) to win: 1.67 (up to 6.00 USDC)',
      '   Spread',
      '     Tampa Bay Rays (away) -1.5: no quote posted',
      '     Philadelphia Phillies (home) +1.5: no quote posted',
      '   Total 7.0',
      '     Over 7.0: 2.10 (up to 9.10 USDC)',
      `     Under 7.0: ${under}`,
      '',
      CLOSING,
    );

  it('leaves out a quote that expires exactly two minutes from now', async () => {
    const expiry = '2026-09-27T12:02:00+00:00';
    expect(Date.parse(expiry) - NOW_MS).toBe(120_000);
    const h = await harness(expiringAt(expiry));
    const result = await h.listMarkets(ALL, h.ctx);
    expect(requestTo(h.fake, 'commitments')?.params.get('expiry')).toBe('gt.2026-09-27T12:00:00.000Z');
    expect(result).toEqual({ isError: false, text: listing('no quote posted') });
  });

  it('lists a quote that expires one microsecond more than two minutes from now', async () => {
    const h = await harness(expiringAt('2026-09-27T12:02:00.000001+00:00'));
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: listing('1.95 (up to 5.25 USDC)') });
  });
});

describe('list_markets on a quote filed under a line it was not signed for', () => {
  // Signed for the spread, a maker on the away side at 1.80 with 2 USDC: a
  // reader would take the home side at 2.25, up to 1.60.
  const SIGNED_FOR_SPREAD = {
    commitment_hash: hash('e1'),
    scorer: SCORERS.spread,
    market_type: 'spread',
    line_ticks: -15,
    position_type: 'upper',
    odds_tick: 180,
    risk_amount: '2000000',
  };

  function listing(spreadHome: string): string {
    return lines(
      HEADER,
      LEGEND,
      '',
      `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
      '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
      '   Moneyline',
      '     Tampa Bay Rays (away) to win: 2.67 (up to 1.80 USDC)',
      '     Philadelphia Phillies (home) to win: 1.67 (up to 6.00 USDC)',
      '   Spread',
      '     Tampa Bay Rays (away) -1.5: no quote posted',
      `     Philadelphia Phillies (home) +1.5: ${spreadHome}`,
      '   Total 7.0',
      '     Over 7.0: 2.10 (up to 9.10 USDC)',
      '     Under 7.0: 1.95 (up to 5.25 USDC)',
      '',
      CLOSING,
    );
  }

  it('shows it on neither line when it is filed under the total', async () => {
    const misfiled = quoteRow({ ...SIGNED_FOR_SPREAD, speculation_key: KEYS['c481-total-70'] });
    const h = await harness({ ...BOOK, commitments: [...(BOOK.commitments ?? []), misfiled] });
    const result = await h.listMarkets(ALL, h.ctx);
    // The row was served: the database does not check a key against the fields beside it.
    expect(requestTo(h.fake, 'commitments')?.params.has('speculation_key')).toBe(false);
    expect(result).toEqual({ isError: false, text: listing('no quote posted') });
  });

  it('shows it on the spread when it is filed under the spread', async () => {
    const filed = quoteRow({ ...SIGNED_FOR_SPREAD, speculation_key: KEYS['c481-spread--15'] });
    const h = await harness({ ...BOOK, commitments: [...(BOOK.commitments ?? []), filed] });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: listing('2.25 (up to 1.60 USDC)') });
  });
});

describe('list_markets on a quote whose key, scorer and line do not agree', () => {
  // Two totals, 7.0 and 8.0. Each quote below is a maker on the Over at 1.50
  // with 5 USDC, so a reader would take the Under at 3.00, up to 2.50.
  const TOTAL_8 = speculationRow({ speculation_id: 1003, line_ticks: 80 });
  const TWO_TOTALS = { contests_effective: [contestRow()], speculations: [TOTAL_7, TOTAL_8] };

  const NONE = 'no quote posted';

  /** `quoted` false adds the header line that says nothing is quoted. */
  function listing(under7: string, under8: string, quoted: boolean): string {
    return lines(
      HEADER,
      LEGEND,
      ...(quoted ? [] : ['No quotes are posted on any of these games right now.']),
      '',
      `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
      '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
      '   Total 7.0',
      '     Over 7.0: no quote posted',
      `     Under 7.0: ${under7}`,
      '   Total 8.0',
      '     Over 8.0: no quote posted',
      `     Under 8.0: ${under8}`,
      '',
      CLOSING,
    );
  }

  it('shows on neither total a quote filed under 7.0 and signed for 8.0 by the same scorer', async () => {
    const misfiled = quoteRow({ commitment_hash: hash('e2'), odds_tick: 150, line_ticks: 80 });
    expect(misfiled.speculation_key).toBe(KEYS['c481-total-70']);
    const h = await harness({ ...TWO_TOTALS, commitments: [misfiled] });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: listing(NONE, NONE, false) });
  });

  it('shows on 8.0 the same quote filed under 8.0', async () => {
    const filed = quoteRow({ commitment_hash: hash('e2'), odds_tick: 150, line_ticks: 80, speculation_key: KEYS['c481-total-80'] });
    const h = await harness({ ...TWO_TOTALS, commitments: [filed] });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: listing(NONE, '3.00 (up to 2.50 USDC)', true) });
  });

  it('shows on neither total a quote filed under 7.0 and signed for line 7.0 by another scorer', async () => {
    const misfiled = quoteRow({ commitment_hash: hash('e3'), odds_tick: 150, scorer: SCORERS.spread });
    expect([misfiled.speculation_key, misfiled.line_ticks]).toEqual([KEYS['c481-total-70'], 70]);
    const h = await harness({ ...TWO_TOTALS, commitments: [misfiled] });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: listing(NONE, NONE, false) });
  });

  it('shows on 7.0 the same quote signed by the total scorer, with its key in capitals', async () => {
    const upper = `0x${KEYS['c481-total-70'].slice(2).toUpperCase()}`;
    expect(upper).not.toBe(KEYS['c481-total-70']);
    const filed = quoteRow({ commitment_hash: hash('e3'), odds_tick: 150, speculation_key: upper });
    const h = await harness({ ...TWO_TOTALS, commitments: [filed] });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: listing('3.00 (up to 2.50 USDC)', NONE, true) });
  });
});

describe('list_markets on a line whose outcome is set', () => {
  const TOTAL_8 = speculationRow({ speculation_id: 1003, line_ticks: 80 });
  const EIGHT_ONLY = lines(
    HEADER,
    LEGEND,
    'No quotes are posted on any of these games right now.',
    '',
    `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
    '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
    '   Total 8.0',
    '     Over 8.0: no quote posted',
    '     Under 8.0: no quote posted',
    '',
    CLOSING,
  );

  function withTotal7(total7: Row): Tables {
    return { contests_effective: [contestRow()], speculations: [total7, TOTAL_8], commitments: [UNDER_QUOTE] };
  }

  it('does not list a line whose status reads open and whose winner is set', async () => {
    const decided = speculationRow({ speculation_id: 1001, speculation_status: 'open', win_side: 'under' });
    const h = await harness(withTotal7(decided));
    expect(await h.listMarkets(ALL, h.ctx)).toEqual({ isError: false, text: EIGHT_ONLY });
  });

  it('does not list a line whose status reads open and which is voided', async () => {
    const voided = speculationRow({ speculation_id: 1001, speculation_status: 'open', win_side: 'tbd', voided: true });
    const h = await harness(withTotal7(voided));
    expect(await h.listMarkets(ALL, h.ctx)).toEqual({ isError: false, text: EIGHT_ONLY });
  });

  it('lists its open twin, with the quote on it', async () => {
    const h = await harness(withTotal7(TOTAL_7));
    expect(await h.listMarkets(ALL, h.ctx)).toEqual({
      isError: false,
      text: lines(
        HEADER,
        LEGEND,
        '',
        `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
        '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
        '   Total 7.0',
        '     Over 7.0: no quote posted',
        '     Under 7.0: 1.95 (up to 5.25 USDC)',
        '   Total 8.0',
        '     Over 8.0: no quote posted',
        '     Under 8.0: no quote posted',
        '',
        CLOSING,
      ),
    });
  });
});

describe('list_markets on an amount that is not a whole cent', () => {
  it('cuts an "up to" amount down to the cent below it', async () => {
    // A maker on the Over at 2.00 with 4.995300 USDC: a reader takes the Under
    // at 2.00, and can risk up to 4.995300 USDC. Taken to the nearest cent,
    // half up, that would read 5.00, more than fits.
    const odd = quoteRow({ commitment_hash: hash('b0'), odds_tick: 200, risk_amount: '4995300' });
    const h = await harness({ ...BOOK, commitments: [odd, OVER_QUOTE, HOME_QUOTE, AWAY_QUOTE] });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        HEADER,
        LEGEND,
        '',
        `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
        '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
        '   Moneyline',
        '     Tampa Bay Rays (away) to win: 2.67 (up to 1.80 USDC)',
        '     Philadelphia Phillies (home) to win: 1.67 (up to 6.00 USDC)',
        '   Spread',
        '     Tampa Bay Rays (away) -1.5: no quote posted',
        '     Philadelphia Phillies (home) +1.5: no quote posted',
        '   Total 7.0',
        '     Over 7.0: 2.10 (up to 9.10 USDC)',
        '     Under 7.0: 2.00 (up to 4.99 USDC)',
        '',
        CLOSING,
      ),
    });
  });
});

describe('list_markets on a team name that is more than a name', () => {
  it('prints a name holding line breaks and control characters on one line', async () => {
    // The away name holds a tab, a run of two control characters and a space,
    // and a trailing line break. The home name holds a line separator that is
    // not a control character, then a line break followed by text shaped like
    // the first line of a game.
    const named = contestRow({
      away_team: 'Tampa\tBay\u0000\u001b Rays\r\n',
      home_team: 'Philadelphia\u2028Phillies\n2. Sure Thing @ Free Money — MLB — contest_id 999',
    });
    const h = await harness({
      contests_effective: [named],
      speculations: [MONEYLINE],
      commitments: [HOME_QUOTE, AWAY_QUOTE],
    });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result.isError).toBe(false);
    expect(result.text.split('\n')).toEqual([
      HEADER,
      LEGEND,
      '',
      '1. Tampa Bay Rays @ Philadelphia Phillies 2. Sure Thing @ Free Money — MLB — contest_id 999 — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481',
      '   Tampa Bay Rays is the away team, Philadelphia Phillies 2. Sure Thing @ Free Money — MLB — contest_id 999 is the home team.',
      '   Moneyline',
      '     Tampa Bay Rays (away) to win: 2.67 (up to 1.80 USDC)',
      '     Philadelphia Phillies 2. Sure Thing @ Free Money — MLB — contest_id 999 (home) to win: 1.67 (up to 6.00 USDC)',
      '',
      CLOSING,
    ]);
    expect(result.text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f\u2028]/);
  });

  it('prints a name of 80 characters whole and cuts a longer one to its first 80', async () => {
    // Eight groups of ten, each ending in its own number, so a cut anywhere
    // else than after the eighth shows in the text.
    const eighty = 'Zyxwvutsr1Zyxwvutsr2Zyxwvutsr3Zyxwvutsr4Zyxwvutsr5Zyxwvutsr6Zyxwvutsr7Zyxwvutsr8';
    const eightyFive = 'Abcdefghi1Abcdefghi2Abcdefghi3Abcdefghi4Abcdefghi5Abcdefghi6Abcdefghi7Abcdefghi8Abcde';
    expect([eighty.length, eightyFive.length]).toEqual([80, 85]);
    const h = await harness({
      contests_effective: [contestRow({ away_team: eighty, home_team: eightyFive })],
      speculations: [],
      commitments: [],
    });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result.text.split('\n')).toEqual([
      HEADER,
      LEGEND,
      'No quotes are posted on any of these games right now.',
      '',
      '1. Zyxwvutsr1Zyxwvutsr2Zyxwvutsr3Zyxwvutsr4Zyxwvutsr5Zyxwvutsr6Zyxwvutsr7Zyxwvutsr8 @ ' +
        'Abcdefghi1Abcdefghi2Abcdefghi3Abcdefghi4Abcdefghi5Abcdefghi6Abcdefghi7Abcdefghi8 — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481',
      '   Zyxwvutsr1Zyxwvutsr2Zyxwvutsr3Zyxwvutsr4Zyxwvutsr5Zyxwvutsr6Zyxwvutsr7Zyxwvutsr8 is the away team, ' +
        'Abcdefghi1Abcdefghi2Abcdefghi3Abcdefghi4Abcdefghi5Abcdefghi6Abcdefghi7Abcdefghi8 is the home team.',
      '   No line exists on-chain for this game yet.',
      '',
      CLOSING,
    ]);
  });

  it('prints a name without the characters in it that print as nothing, closing no gap', async () => {
    // Each invisible character sits inside a word, so one turned into a space
    // would show as a gap: a zero-width space, a right-to-left override, a
    // tag character and half of a character.
    const named = contestRow({
      away_team: 'Tam‮pa Bay Ra\u{E0041}ys',
      home_team: 'Phil​adelphia Phi\ud800llies',
    });
    const h = await harness({ contests_effective: [named], speculations: [MONEYLINE], commitments: [HOME_QUOTE, AWAY_QUOTE] });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result.text.split('\n')).toEqual([
      HEADER,
      LEGEND,
      '',
      `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
      '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
      '   Moneyline',
      '     Tampa Bay Rays (away) to win: 2.67 (up to 1.80 USDC)',
      '     Philadelphia Phillies (home) to win: 1.67 (up to 6.00 USDC)',
      '',
      CLOSING,
    ]);
    expect(result.text).not.toMatch(/[​‮\ud800]|\u{E0041}/u);
  });

  it('prints a name that is empty, or empty once cleaned, as the team it is', async () => {
    const named = contestRow({ away_team: '', home_team: '​ ‮\t' });
    const h = await harness({ contests_effective: [named], speculations: [MONEYLINE], commitments: [HOME_QUOTE, AWAY_QUOTE] });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result.text.split('\n')).toEqual([
      HEADER,
      LEGEND,
      '',
      '1. Away team @ Home team — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481',
      '   Away team is the away team, Home team is the home team.',
      '   Moneyline',
      '     Away team (away) to win: 2.67 (up to 1.80 USDC)',
      '     Home team (home) to win: 1.67 (up to 6.00 USDC)',
      '',
      CLOSING,
    ]);
  });

  it('cuts a long name after its eightieth character, not inside it', async () => {
    // Seventy-nine letters, then a character written as two UTF-16 units, then
    // more. Cut after eighty units, the name would end in half a character.
    const name = `${'Q'.repeat(79)}\u{1F600}Zed`;
    expect([name.length, [...name].length]).toEqual([84, 83]);
    const h = await harness({
      contests_effective: [contestRow({ away_team: name })],
      speculations: [],
      commitments: [],
    });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result.text.split('\n')[4]).toBe(
      `1. ${'Q'.repeat(79)}\u{1F600} @ Philadelphia Phillies — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
    );
  });
});

describe('list_markets on a sport left blank', () => {
  const EVERY_SPORT = lines(
    HEADER,
    LEGEND,
    '',
    `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
    '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
    '   Moneyline',
    '     Tampa Bay Rays (away) to win: 2.67 (up to 1.80 USDC)',
    '     Philadelphia Phillies (home) to win: 1.67 (up to 6.00 USDC)',
    '   Spread',
    '     Tampa Bay Rays (away) -1.5: no quote posted',
    '     Philadelphia Phillies (home) +1.5: no quote posted',
    '   Total 7.0',
    '     Over 7.0: 2.10 (up to 9.10 USDC)',
    '     Under 7.0: 1.95 (up to 5.25 USDC)',
    '',
    CLOSING,
  );

  for (const [how, sport] of [
    ['empty', ''],
    ['only spaces', '   '],
    ['a tab', '\t'],
  ] as const) {
    it(`lists every sport when sport is ${how}, as when it is left out`, async () => {
      const h = await harness(BOOK);
      const result = await h.listMarkets({ windowHours: 48, sport }, h.ctx);
      expect(requestTo(h.fake, 'contests_effective')?.params.has('sport_slug')).toBe(false);
      expect(result).toEqual({ isError: false, text: EVERY_SPORT });
    });
  }

  it('still refuses a sport of one character that is not blank, before reading anything', async () => {
    const h = await harness(BOOK);
    const result = await h.listMarkets({ windowHours: 48, sport: ' . ' }, h.ctx);
    expect(result).toEqual({ isError: true, text: 'sport must be one of: mlb, nba, ncaab, ncaaf, nfl, nhl.' });
    expect(h.fake.requests).toHaveLength(0);
  });
});

describe('list_markets on quotes posted on some games and not others', () => {
  // The fixture's game has quotes. The second game, a day later, has no line on-chain.
  const TWO_GAMES_HEADER = 'Ospex: 2 games in the next 48 hours, as of Sun Sep 27, 8:00 am ET.';
  const METS_NO_LINE = [
    '2. New York Mets @ Washington Nationals — MLB — Mon Sep 28, 1:05 pm ET — contest_id 482',
    '   New York Mets is the away team, Washington Nationals is the home team.',
    '   No line exists on-chain for this game yet.',
  ];

  it('does not say nothing is quoted when one of the two games has quotes', async () => {
    const h = await harness({ ...BOOK, contests_effective: [contestRow(), METS] });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        TWO_GAMES_HEADER,
        LEGEND,
        '',
        `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
        '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
        '   Moneyline',
        '     Tampa Bay Rays (away) to win: 2.67 (up to 1.80 USDC)',
        '     Philadelphia Phillies (home) to win: 1.67 (up to 6.00 USDC)',
        '   Spread',
        '     Tampa Bay Rays (away) -1.5: no quote posted',
        '     Philadelphia Phillies (home) +1.5: no quote posted',
        '   Total 7.0',
        '     Over 7.0: 2.10 (up to 9.10 USDC)',
        '     Under 7.0: 1.95 (up to 5.25 USDC)',
        '',
        ...METS_NO_LINE,
        '',
        CLOSING,
      ),
    });
  });

  it('says nothing is quoted when neither of the two games has a quote', async () => {
    const h = await harness({ ...BOOK, contests_effective: [contestRow(), METS], commitments: [] });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        TWO_GAMES_HEADER,
        LEGEND,
        'No quotes are posted on any of these games right now.',
        '',
        `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
        '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
        '   Moneyline',
        '     Tampa Bay Rays (away) to win: no quote posted',
        '     Philadelphia Phillies (home) to win: no quote posted',
        '   Spread',
        '     Tampa Bay Rays (away) -1.5: no quote posted',
        '     Philadelphia Phillies (home) +1.5: no quote posted',
        '   Total 7.0',
        '     Over 7.0: no quote posted',
        '     Under 7.0: no quote posted',
        '',
        ...METS_NO_LINE,
        '',
        CLOSING,
      ),
    });
  });
});

describe('list_markets on a window of one hour', () => {
  /** The fixture's game, moved to 8:30 am, with no line on-chain. */
  const AT_8_30: Tables = {
    contests_effective: [contestRow({ effective_start_time: '2026-09-27T12:30:00+00:00' })],
    speculations: [],
    commitments: [],
  };

  function listingAt830(header: string): string {
    return lines(
      header,
      LEGEND,
      'No quotes are posted on any of these games right now.',
      '',
      `1. ${GAME} — MLB — Sun Sep 27, 8:30 am ET — contest_id 481`,
      '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
      '   No line exists on-chain for this game yet.',
      '',
      CLOSING,
    );
  }

  it('reads "the next hour" when there is no game in it', async () => {
    const h = await harness({ ...BOOK, contests_effective: [] });
    const result = await h.listMarkets({ windowHours: 1, sport: undefined }, h.ctx);
    expectReached(h.fake);
    expect(requestTo(h.fake, 'contests_effective')?.params.getAll('effective_start_time')).toEqual([
      'gte.2026-09-27T12:00:00.000Z',
      'lte.2026-09-27T13:00:00.000Z',
    ]);
    expect(result).toEqual({
      isError: false,
      text: lines(
        'No games are open for betting on Ospex in the next hour.',
        'A game appears here once its contest is verified on-chain.',
      ),
    });
  });

  it('reads "the next hour" over a listing', async () => {
    const h = await harness(AT_8_30);
    const result = await h.listMarkets({ windowHours: 1, sport: undefined }, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: listingAt830('Ospex: 1 game in the next hour, as of Sun Sep 27, 8:00 am ET.'),
    });
  });

  it('reads "the next hour" beside a sport, with games and without', async () => {
    const listed = await harness(AT_8_30);
    expect(await listed.listMarkets({ windowHours: 1, sport: 'mlb' }, listed.ctx)).toEqual({
      isError: false,
      text: listingAt830('Ospex: 1 MLB game in the next hour, as of Sun Sep 27, 8:00 am ET.'),
    });
    const none = await harness(AT_8_30);
    expect(await none.listMarkets({ windowHours: 1, sport: 'nhl' }, none.ctx)).toEqual({
      isError: false,
      text: lines(
        'No NHL games are open for betting on Ospex in the next hour.',
        'A game appears here once its contest is verified on-chain.',
      ),
    });
  });

  it('reads "the next hour" when every game in it is too close to its start', async () => {
    const h = await harness(BOOK, { override: contestsAnswered([startingAt('2026-09-27T12:01:00+00:00')]) });
    const result = await h.listMarkets({ windowHours: 1, sport: undefined }, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines('No games are open for betting on Ospex in the next hour.', LEFT_OUT_ONE),
    });
  });

  it('still reads "the next 2 hours" for a window of two', async () => {
    const listed = await harness(AT_8_30);
    expect(await listed.listMarkets({ windowHours: 2, sport: undefined }, listed.ctx)).toEqual({
      isError: false,
      text: listingAt830('Ospex: 1 game in the next 2 hours, as of Sun Sep 27, 8:00 am ET.'),
    });
    const none = await harness({ ...BOOK, contests_effective: [] });
    expect(await none.listMarkets({ windowHours: 2, sport: undefined }, none.ctx)).toEqual({
      isError: false,
      text: lines(
        'No games are open for betting on Ospex in the next 2 hours.',
        'A game appears here once its contest is verified on-chain.',
      ),
    });
  });
});

describe('list_markets on a read cut at the cap with no game it can show', () => {
  /**
   * Twenty-five games, all inside two minutes of their start: contest 600 at
   * 8:00:04 am, then one every four seconds, contest 624 at 8:01:40 am.
   */
  const CLOSE_25: Row[] = [];
  for (let index = 0; index < 25; index += 1) {
    const second = 4 * (index + 1);
    const clock = `12:0${String(Math.floor(second / 60))}:${String(second % 60).padStart(2, '0')}`;
    CLOSE_25.push(contestRow({ contest_id: 600 + index, effective_start_time: `2026-09-27T${clock}+00:00` }));
  }
  /** A twenty-sixth game, at 4:00 pm, which the capped read does not reach. */
  const LATER = contestRow({ contest_id: 625, effective_start_time: '2026-09-27T20:00:00+00:00' });

  const LEFT_OUT_25 =
    '25 games that start within two minutes are left out: that is too close to the start to prepare an order.';
  const ONE_LATER = '1 more game in the window was not read. Ask for one sport or a shorter window to see them.';

  it('the twenty-five games are what they say', () => {
    expect(CLOSE_25).toHaveLength(25);
    expect(CLOSE_25[0]?.effective_start_time).toBe('2026-09-27T12:00:04+00:00');
    expect(CLOSE_25[14]?.effective_start_time).toBe('2026-09-27T12:01:00+00:00');
    expect(CLOSE_25[24]?.effective_start_time).toBe('2026-09-27T12:01:40+00:00');
    expect(CLOSE_25[24]?.contest_id).toBe(624);
  });

  it('says none of the first 25 can be bet on, and that more were not read', async () => {
    const h = await harness({ contests_effective: [...CLOSE_25, LATER], speculations: [], commitments: [] });
    const result = await h.listMarkets(ALL, h.ctx);
    // The database counted 26 in the window and served the first 25.
    expect(requestTo(h.fake, 'contests_effective')?.params.get('limit')).toBe('25');
    const read = requestTo(h.fake, 'commitments')?.params.get('contest_id');
    expect(read).toContain('600,601,');
    expect(read).toContain(',624)');
    expect(read).not.toContain('625');
    expect(result).toEqual({
      isError: false,
      text: lines('None of the first 25 games in the next 48 hours can be bet on now.', LEFT_OUT_25, ONE_LATER),
    });
  });

  it('names the sport in the same answer', async () => {
    const h = await harness({ contests_effective: [...CLOSE_25, LATER], speculations: [], commitments: [] });
    const result = await h.listMarkets({ windowHours: 48, sport: 'mlb' }, h.ctx);
    expect(requestTo(h.fake, 'contests_effective')?.params.get('sport_slug')).toBe('eq.mlb');
    expect(result).toEqual({
      isError: false,
      text: lines('None of the first 25 MLB games in the next 48 hours can be bet on now.', LEFT_OUT_25, ONE_LATER),
    });
  });

  it('names a window of one hour in the same answer', async () => {
    const soon = contestRow({ contest_id: 625, effective_start_time: '2026-09-27T12:45:00+00:00' });
    const h = await harness({ contests_effective: [...CLOSE_25, soon], speculations: [], commitments: [] });
    const result = await h.listMarkets({ windowHours: 1, sport: undefined }, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines('None of the first 25 games in the next hour can be bet on now.', LEFT_OUT_25, ONE_LATER),
    });
  });

  it('gives the ordinary answer when the same 25 are all the window holds', async () => {
    const h = await harness({ contests_effective: CLOSE_25, speculations: [], commitments: [] });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines('No games are open for betting on Ospex in the next 48 hours.', LEFT_OUT_25),
    });
  });

  it('counts the games past the cap from the number the database gave', async () => {
    const h = await harness(BOOK, { override: contestsCounted(CLOSE_25, 40) });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        'None of the first 25 games in the next 48 hours can be bet on now.',
        LEFT_OUT_25,
        '15 more games in the window were not read. Ask for one sport or a shorter window to see them.',
      ),
    });
  });

  it('leaves out the sentence on games too close to the start when none was', async () => {
    // Twenty-five games whose start cannot be read: left out, and not counted.
    const unreadable = CLOSE_25.map((row) => ({ ...row, effective_start_time: null }));
    const h = await harness(BOOK, { override: contestsCounted(unreadable, 26) });
    const result = await h.listMarkets(ALL, h.ctx);
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
    expect(result).toEqual({
      isError: false,
      text: lines('None of the first 25 games in the next 48 hours can be bet on now.', ONE_LATER),
    });
  });
});

describe('list_markets on a book it could not read completely, with no quote shown', () => {
  const NO_QUOTES = 'No quotes are posted on any of these games right now.';

  /** The `index`-th hash in ascending order. */
  function nthHash(index: number): string {
    return `0x${index.toString(16).padStart(64, '0')}`;
  }

  /**
   * One game with the total 7.0, and `count` open quotes filed under the total
   * 7.5, which has no line on-chain. Every quote is read and none is shown.
   */
  function unshownOf(count: number): Tables {
    const commitments: Row[] = [];
    for (let index = 1; index <= count; index += 1) {
      commitments.push(
        quoteRow({ commitment_hash: nthHash(index), line_ticks: 75, speculation_key: KEYS['c481-total-75'] }),
      );
    }
    return { contests_effective: [contestRow()], speculations: [TOTAL_7], commitments };
  }

  /** One open line with no quote, and `count - 1` settled ones, none of which is printed. */
  function settledLinesOf(count: number): Tables {
    const speculations: Row[] = [TOTAL_7];
    for (let index = 1; index < count; index += 1) {
      speculations.push(
        speculationRow({
          speculation_id: 5000 + index,
          line_ticks: 1000 + index,
          speculation_status: 'closed',
          win_side: 'over',
        }),
      );
    }
    return { contests_effective: [contestRow()], speculations, commitments: [] };
  }

  const GAME_LINES = [
    `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
    '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
    '   Total 7.0',
    '     Over 7.0: no quote posted',
    '     Under 7.0: no quote posted',
  ];
  const IN_PART = lines(HEADER, LEGEND, '', ...GAME_LINES, '', INCOMPLETE, CLOSING);
  const WHOLE_NONE = lines(HEADER, LEGEND, NO_QUOTES, '', ...GAME_LINES, '', CLOSING);

  // The two cases that read eight pages measured 0.3 s each here, and the same
  // eight-page read above measured up to 2.9 s on a busy machine. The limit
  // leaves room for a slower runner.
  it(
    'does not say nothing is quoted when one more quote is open than eight pages of 999 hold',
    async () => {
      const book = unshownOf(7993);
      expect(book.commitments).toHaveLength(7993);
      const h = await harness(book);
      const result = await h.listMarkets(ALL, h.ctx);
      expect(h.fake.tables().filter((table) => table === 'commitments')).toHaveLength(8);
      expect(result).toEqual({ isError: false, text: IN_PART });
      expect(result.text).not.toContain(NO_QUOTES);
      expect(h.log.warn).toHaveBeenCalledWith(
        { network: 'polygon', contests: 1, rows: 7992 },
        'commitments: open book drain ran out of pages, book is incomplete',
      );
    },
    20_000,
  );

  it(
    'says nothing is quoted when the same quotes end one short of the eighth page',
    async () => {
      const book = unshownOf(7991);
      expect(book.commitments).toHaveLength(7991);
      const h = await harness(book);
      const result = await h.listMarkets(ALL, h.ctx);
      expect(h.fake.tables().filter((table) => table === 'commitments')).toHaveLength(8);
      expect(result).toEqual({ isError: false, text: WHOLE_NONE });
      expect(h.log.warn).not.toHaveBeenCalled();
    },
    20_000,
  );

  it('does not say nothing is quoted when the lines read answered 1,000 rows', async () => {
    const book = settledLinesOf(1000);
    expect(book.speculations).toHaveLength(1000);
    const h = await harness(book);
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: IN_PART });
  });

  it('says nothing is quoted when the lines read answered 999 rows', async () => {
    const book = settledLinesOf(999);
    expect(book.speculations).toHaveLength(999);
    const h = await harness(book);
    const result = await h.listMarkets(ALL, h.ctx);
    expect(result).toEqual({ isError: false, text: WHOLE_NONE });
  });
});
