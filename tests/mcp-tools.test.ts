/**
 * The connector's three tools, run against a database they can actually reach.
 *
 * Each case stands the REAL `@supabase/supabase-js` client against a fake
 * PostgREST socket, calls the tool function with a fixed clock, and asserts two
 * things: the text the tool answered with, as a literal, and the requests the
 * database received, as captured on its side of the wire.
 *
 * The second matters as much as the first. The tools' safety rests on filters
 * a chainable stub would happily ignore — `book_visible`, `nonce_invalidated`,
 * `expiry`, `contest_status` — so they are asserted where they arrive.
 *
 * The clock is an argument, not a fake timer: `NOW_MS` is 8:00 am Eastern on
 * Sunday 27 September 2026, and first pitch in the fixture is 3:05 pm.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectReached, requestTo, type CapturedRequest, type FakePostgrest, type FakeReply } from './helpers/fakePostgrest.js';
import {
  EXPIRY,
  KEYS,
  MAKER_A,
  MAKER_B,
  NETWORK,
  NOW_MS,
  SCORERS,
  TAKER,
  configFor,
  contestRow,
  fillRow,
  fundingRow,
  hash,
  quoteRow,
  speculationRow,
  startBook,
  tableOf,
  type Row,
  type Tables,
} from './helpers/mcpBook.js';

const open: FakePostgrest[] = [];

afterEach(async () => {
  for (const fake of open.splice(0)) await fake.close();
  vi.doUnmock('../src/lib/env.js');
  vi.doUnmock('../src/lib/logger.js');
  vi.resetModules();
});

interface Harness {
  fake: FakePostgrest;
  log: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  ctx: import('../src/mcp/context.js').ToolContext;
  listMarkets: typeof import('../src/mcp/tools/listMarkets.js').listMarkets;
  prepareOrder: typeof import('../src/mcp/tools/prepareOrder.js').prepareOrder;
  getOrderStatus: typeof import('../src/mcp/tools/getOrderStatus.js').getOrderStatus;
}

async function harness(
  tables: Tables,
  options: {
    override?: (request: CapturedRequest, index: number) => FakeReply | undefined;
    config?: Row;
    context?: Partial<import('../src/mcp/context.js').ToolContext>;
  } = {},
): Promise<Harness> {
  const fake = await startBook(tables, options.override);
  open.push(fake);
  const config = configFor(fake, options.config);
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

  // A fresh module graph per case: the database client is memoised, and the
  // one from the last case points at a socket that has since closed.
  vi.resetModules();
  vi.doMock('../src/lib/env.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/lib/env.js')>()),
    loadConfig: () => config,
  }));
  vi.doMock('../src/lib/logger.js', () => ({ logger: log, formatError: String }));

  const { getSupabase } = await import('../src/lib/supabase.js');
  const { listMarkets } = await import('../src/mcp/tools/listMarkets.js');
  const { prepareOrder } = await import('../src/mcp/tools/prepareOrder.js');
  const { getOrderStatus } = await import('../src/mcp/tools/getOrderStatus.js');

  return {
    fake,
    log,
    ctx: {
      sb: getSupabase(),
      network: NETWORK,
      scorers: { ...SCORERS },
      takeLinkBaseUrl: 'https://ospex.org',
      nowMs: NOW_MS,
      ...options.context,
    },
    listMarkets,
    prepareOrder,
    getOrderStatus,
  };
}

// ── the fixture ────────────────────────────────────────────────────────
//
// One game, three lines, four quotes. Every quote has its own price and its
// own size, so an answer that read the wrong one shows a wrong number.

const MONEYLINE = speculationRow({
  speculation_id: 1000,
  speculation_scorer: SCORERS.moneyline,
  market_type: 'moneyline',
  line_ticks: 0,
});
const TOTAL_7 = speculationRow({ speculation_id: 1001 });
const SPREAD = speculationRow({
  speculation_id: 1002,
  speculation_scorer: SCORERS.spread,
  market_type: 'spread',
  line_ticks: -15,
});

/** Maker A on the Over at 2.05, 5 USDC: a reader takes the Under at 1.95, up to 5.25. */
const UNDER_QUOTE = quoteRow();
/** Maker B on the Under at 1.91, 10 USDC: a reader takes the Over at 2.10, up to 9.10. */
const OVER_QUOTE = quoteRow({
  commitment_hash: hash('a2'),
  maker: MAKER_B,
  position_type: 'lower',
  odds_tick: 191,
  risk_amount: '10000000',
});
/** Maker A on the away team at 2.50, 4 USDC: a reader takes the home team at 1.67, up to 6.00. */
const HOME_QUOTE = quoteRow({
  commitment_hash: hash('a3'),
  scorer: SCORERS.moneyline,
  market_type: 'moneyline',
  line_ticks: 0,
  position_type: 'upper',
  odds_tick: 250,
  risk_amount: '4000000',
  speculation_key: KEYS['c481-moneyline'],
});
/** Maker A on the home team at 1.60, 3 USDC: a reader takes the away team at 2.67, up to 1.80. */
const AWAY_QUOTE = quoteRow({
  commitment_hash: hash('a4'),
  scorer: SCORERS.moneyline,
  market_type: 'moneyline',
  line_ticks: 0,
  position_type: 'lower',
  odds_tick: 160,
  risk_amount: '3000000',
  speculation_key: KEYS['c481-moneyline'],
});

const BOOK: Tables = {
  contests_effective: [contestRow()],
  speculations: [TOTAL_7, MONEYLINE, SPREAD],
  commitments: [UNDER_QUOTE, OVER_QUOTE, HOME_QUOTE, AWAY_QUOTE],
  maker_funding: [fundingRow(), fundingRow({ maker_address: MAKER_B })],
};

function lines(...text: string[]): string {
  return text.join('\n');
}

const GAME = 'Tampa Bay Rays @ Philadelphia Phillies';
const PLACED_NOTHING = 'No order was prepared, and nothing was placed.';
const READ_FAILED = 'Ospex could not read its order book just now. Nothing was placed. Try again in a moment.';

// ── list_markets ───────────────────────────────────────────────────────

describe('list_markets', () => {
  it('lists the game, its lines, and the price a reader gets on each side', async () => {
    const h = await harness(BOOK);
    const result = await h.listMarkets({ windowHours: 48, sport: undefined }, h.ctx);
    expectReached(h.fake, 3);

    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      lines(
        'Ospex: 1 game in the next 48 hours, as of Sun Sep 27, 8:00 am ET.',
        'Prices are decimal odds for the person taking the quote. Amounts are USDC, and "up to" is the most one order can risk at that price.',
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
        'Listing prices places nothing. prepare_order turns one of them into a preview and a link.',
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
        'Prices are decimal odds for the person taking the quote. Amounts are USDC, and "up to" is the most one order can risk at that price.',
        'No quotes are posted on any of these games right now.',
        '',
        `1. ${GAME} — MLB — Sun Sep 27, 3:05 pm ET — contest_id 481`,
        '   Tampa Bay Rays is the away team, Philadelphia Phillies is the home team.',
        '   No line exists on-chain for this game yet.',
        '',
        'Listing prices places nothing. prepare_order turns one of them into a preview and a link.',
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

// ── prepare_order ──────────────────────────────────────────────────────

const UNDER_2 = { contestId: '481', market: 'total', side: 'under', riskUsdc: 2, line: undefined } as const;

describe('prepare_order', () => {
  it('prepares the Under at the posted price, with the amounts the chain will move', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expectReached(h.fake, 4);

    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      lines(
        `Under 7.0 — ${GAME}, Sun Sep 27, 3:05 pm ET.`,
        'Risk 2.00 USDC to win 1.90 at 1.95.',
        'Exactly 7 is a push.',
        'Quote expires Sun Sep 27, 2:55 pm ET.',
        'Exact amounts: you pay 1.999935 USDC and win 1.904700 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('a1')}?risk=2`,
        'Nothing has been placed. The order is placed only when you open the link and confirm in your wallet.',
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a1')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 2',
      ),
    );
  });

  it('reads the contest, its lines, its quotes and the makers\' funding, in that order', async () => {
    const h = await harness(BOOK);
    await h.prepareOrder(UNDER_2, h.ctx);
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments', 'maker_funding']);
    expect(requestTo(h.fake, 'contests_effective')?.params.get('contest_id')).toBe('eq.481');
    expect(requestTo(h.fake, 'commitments')?.params.get('contest_id')).toBe('in.(481)');
    expect(requestTo(h.fake, 'commitments')?.params.get('book_visible')).toBe('eq.true');
    expect(requestTo(h.fake, 'commitments')?.params.get('nonce_invalidated')).toBe('eq.false');
    expect(requestTo(h.fake, 'commitments')?.params.get('status')).toBe('in.(open,partially_filled)');
    expect(requestTo(h.fake, 'commitments')?.params.get('expiry')).toBe('gt.2026-09-27T12:00:00.000Z');
    // Only the makers on the side being taken.
    expect(requestTo(h.fake, 'maker_funding')?.params.get('maker_address')).toBe(`in.(${MAKER_A})`);
  });

  it('prepares for everything the quote has left when it cannot absorb the amount, and says so', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder({ ...UNDER_2, riskUsdc: 10 }, h.ctx);
    expect(result.text).toBe(
      lines(
        `Under 7.0 — ${GAME}, Sun Sep 27, 3:05 pm ET.`,
        'Risk 5.25 USDC to win 5.00 at 1.95.',
        'Exactly 7 is a push.',
        'Quote expires Sun Sep 27, 2:55 pm ET.',
        'This quote can take 5.25 USDC, not the 10 asked for. The order is for 5.25.',
        '',
        `Take link: https://ospex.org/take/${hash('a1')}?risk=5.25`,
        'Nothing has been placed. The order is placed only when you open the link and confirm in your wallet.',
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a1')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 5.25',
      ),
    );
  });

  it('takes the Over from the quote whose maker holds the Under', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder({ ...UNDER_2, side: 'Over', riskUsdc: 3 }, h.ctx);
    // At 1.91 the taker's price is 191/91. 3_000_000 asked fills 3_296_700 and costs 2_999_997.
    expect(result.text).toContain(`Over 7.0 — ${GAME}, Sun Sep 27, 3:05 pm ET.`);
    expect(result.text).toContain('Risk 3.00 USDC to win 3.30 at 2.10.');
    expect(result.text).toContain('Exact amounts: you pay 2.999997 USDC and win 3.296700 USDC.');
    expect(result.text).toContain(`commitment_hash: ${hash('a2')}`);
    expect(result.text).toContain('side: over');
    expect(requestTo(h.fake, 'maker_funding')?.params.get('maker_address')).toBe(`in.(${MAKER_B})`);
  });

  it('takes a team by name, and names it with its role in the preview', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder(
      { contestId: '481', market: 'moneyline', side: 'Phillies', riskUsdc: 3, line: undefined },
      h.ctx,
    );
    expect(result.text).toBe(
      lines(
        `Philadelphia Phillies (home) to win — ${GAME}, Sun Sep 27, 3:05 pm ET.`,
        'Risk 3.00 USDC to win 2.00 at 1.67.',
        'A tie is a push.',
        'Quote expires Sun Sep 27, 2:55 pm ET.',
        '',
        `Take link: https://ospex.org/take/${hash('a3')}?risk=3`,
        'Nothing has been placed. The order is placed only when you open the link and confirm in your wallet.',
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a3')}`,
        'market: moneyline',
        'side: home',
        'risk_usdc: 3',
      ),
    );
  });

  it('the other team is the other quote', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder(
      { contestId: '481', market: 'moneyline', side: 'away', riskUsdc: 1, line: undefined },
      h.ctx,
    );
    // Posted 1.60: the taker's price is 160/60. 1_000_000 asked fills 1_666_600 and costs 999_960.
    expect(result.text).toContain(`Tampa Bay Rays (away) to win — ${GAME}`);
    expect(result.text).toContain('Risk 1.00 USDC to win 1.67 at 2.67.');
    expect(result.text).toContain('Exact amounts: you pay 0.999960 USDC and win 1.666600 USDC.');
    expect(result.text).toContain(`commitment_hash: ${hash('a4')}`);
  });

  it('names a spread from the side being backed', async () => {
    const onHome = quoteRow({
      commitment_hash: hash('a5'),
      scorer: SCORERS.spread,
      market_type: 'spread',
      line_ticks: -15,
      position_type: 'lower',
      odds_tick: 200,
      risk_amount: '4000000',
      speculation_key: KEYS['c481-spread--15'],
    });
    const h = await harness({ ...BOOK, commitments: [onHome] });
    const result = await h.prepareOrder(
      { contestId: '481', market: 'spread', side: 'Rays', riskUsdc: 1, line: -1.5 },
      h.ctx,
    );
    expect(result.text).toBe(
      lines(
        `Tampa Bay Rays (away) -1.5 — ${GAME}, Sun Sep 27, 3:05 pm ET.`,
        'Risk 1.00 USDC to win 1.00 at 2.00.',
        'Quote expires Sun Sep 27, 2:55 pm ET.',
        '',
        `Take link: https://ospex.org/take/${hash('a5')}?risk=1`,
        'Nothing has been placed. The order is placed only when you open the link and confirm in your wallet.',
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a5')}`,
        'market: spread',
        'line: -1.5',
        'side: away',
        'risk_usdc: 1',
      ),
    );
  });

  it('the home team\'s +1.5 is the same line as the away team\'s -1.5', async () => {
    const onAway = quoteRow({
      commitment_hash: hash('a6'),
      scorer: SCORERS.spread,
      market_type: 'spread',
      line_ticks: -15,
      position_type: 'upper',
      odds_tick: 200,
      risk_amount: '4000000',
      speculation_key: KEYS['c481-spread--15'],
    });
    const h = await harness({ ...BOOK, commitments: [onAway] });
    const result = await h.prepareOrder(
      { contestId: '481', market: 'spread', side: 'home', riskUsdc: 1, line: 1.5 },
      h.ctx,
    );
    expect(result.text).toContain(`Philadelphia Phillies (home) +1.5 — ${GAME}`);
    expect(result.text).toContain('line: +1.5');
    expect(result.text).toContain(`commitment_hash: ${hash('a6')}`);

    // Named with the wrong sign, it is a line this game does not have.
    const wrong = await h.prepareOrder(
      { contestId: '481', market: 'spread', side: 'home', riskUsdc: 1, line: -1.5 },
      h.ctx,
    );
    expect(wrong).toEqual({
      isError: false,
      text: lines(`${GAME} has no spread line at -1.5. Lines on-chain: +1.5.`, PLACED_NOTHING),
    });
  });

  it('chooses the better price among quotes that can fill the amount', async () => {
    const worse = quoteRow({ commitment_hash: hash('b1'), odds_tick: 215, risk_amount: '50000000' });
    const h = await harness({ ...BOOK, commitments: [worse, UNDER_QUOTE] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`commitment_hash: ${hash('a1')}`);
  });

  it('passes over a better price with only dust left for one that fills the order', async () => {
    const dust = quoteRow({
      commitment_hash: hash('b2'),
      odds_tick: 200,
      risk_amount: '5000000',
      filled_risk_amount: '4950000',
      status: 'partially_filled',
    });
    const h = await harness({ ...BOOK, commitments: [dust, UNDER_QUOTE] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`commitment_hash: ${hash('a1')}`);
    expect(result.text).toContain('Risk 2.00 USDC to win 1.90 at 1.95.');
  });

  it('never hands out a quote that is hidden, invalidated, expired or filled, even if the read returned it', async () => {
    // The read is made to return every row whatever its filters said, so the
    // tool's own checks are all that stands between these rows and a link.
    const bad: Row[] = [
      quoteRow({ commitment_hash: hash('d1'), odds_tick: 150, book_visible: false }),
      quoteRow({ commitment_hash: hash('d2'), odds_tick: 151, nonce_invalidated: true }),
      quoteRow({ commitment_hash: hash('d3'), odds_tick: 152, expiry: '2026-09-27T11:00:00+00:00' }),
      quoteRow({ commitment_hash: hash('d4'), odds_tick: 153, status: 'filled', filled_risk_amount: '5000000' }),
      quoteRow({ commitment_hash: hash('d5'), odds_tick: 154, status: 'cancelled' }),
      quoteRow({ commitment_hash: hash('d6'), odds_tick: 155, signature: null }),
    ];
    const h = await harness(BOOK, {
      // In hash order, as the read asks for them: a1, then d1 to d6.
      override: (request) =>
        tableOf(request) === 'commitments' ? { body: [UNDER_QUOTE, ...bad] } : undefined,
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`commitment_hash: ${hash('a1')}`);
    expect(result.text).toContain('at 1.95.');
    for (const row of bad) expect(result.text).not.toContain(String(row['commitment_hash']));
    // The hidden row was seen, and dropped out loud.
    expect(h.log.warn).toHaveBeenCalledWith(
      { commitmentHash: hash('d1') },
      'commitments: hidden row reached the open book drain — dropped',
    );
  });

  it('does not offer a quote with under two minutes to run', async () => {
    const closing = quoteRow({ expiry: '2026-09-27T12:01:59+00:00' });
    const h = await harness({ ...BOOK, commitments: [closing] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(`No quote is posted for Under 7.0 on ${GAME} right now.`, PLACED_NOTHING),
    });
  });

  it('says funding was not confirmed when nothing is known about the maker', async () => {
    const h = await harness({ ...BOOK, maker_funding: [] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`commitment_hash: ${hash('a1')}`);
    expect(result.text).toContain(
      "The maker's funds could not be confirmed just now. If they are short the transaction fails and only gas is spent.",
    );
  });

  it('says funding was not confirmed when the snapshot is older than two minutes', async () => {
    const h = await harness({
      ...BOOK,
      maker_funding: [fundingRow({ updated_at: '2026-09-27T11:57:59+00:00' })],
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain("The maker's funds could not be confirmed just now.");
  });

  it('says nothing about funding when a fresh snapshot covers the fill', async () => {
    const h = await harness({
      ...BOOK,
      // Exactly two minutes old, and exactly the fill.
      maker_funding: [fundingRow({ updated_at: '2026-09-27T11:58:00+00:00', backing_wei6: '1904700' })],
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`commitment_hash: ${hash('a1')}`);
    expect(result.text).not.toContain('could not be confirmed');
  });

  it('prepares nothing on a quote whose maker is known to be short', async () => {
    const h = await harness({ ...BOOK, maker_funding: [fundingRow({ backing_wei6: '1904699' })] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(
        'A quote is posted for Under 7.0, but its maker does not have the funds behind it right now.',
        PLACED_NOTHING,
      ),
    });
  });

  it('still prepares when the funding read fails, and says funding was not confirmed', async () => {
    const h = await harness(BOOK, {
      override: (request) =>
        tableOf(request) === 'maker_funding' ? { status: 500, body: { message: 'funding unavailable' } } : undefined,
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.isError).toBe(false);
    expect(result.text).toContain(`commitment_hash: ${hash('a1')}`);
    expect(result.text).toContain("The maker's funds could not be confirmed just now.");
  });

  it('points the link where it is told to', async () => {
    const h = await harness(BOOK, { context: { takeLinkBaseUrl: 'http://localhost:5173' } });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`Take link: http://localhost:5173/take/${hash('a1')}?risk=2`);
  });

  it('carries an amount with decimals into the link without changing it', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder({ ...UNDER_2, riskUsdc: 2.123456 }, h.ctx);
    expect(result.text).toContain(`?risk=2.123456`);
    expect(result.text).toContain('risk_usdc: 2.123456');
  });

  // ── the game ─────────────────────────────────────────────────────────

  it('refuses a game that has started: a start equal to now has started', async () => {
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ effective_start_time: '2026-09-27T12:00:00+00:00' })],
    });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(
        `${GAME} started Sun Sep 27, 8:00 am ET. Ospex takes no bets on a game under way.`,
        PLACED_NOTHING,
      ),
    });
    // Decided from the contest alone.
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations']);
  });

  it('takes a game that starts one microsecond from now', async () => {
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ effective_start_time: '2026-09-27T12:00:00.000001+00:00' })],
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`commitment_hash: ${hash('a1')}`);
  });

  it('gates on the conservative start, not the start written on-chain', async () => {
    // The chain still says 3:05 pm. The game was moved up and is under way.
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ start_time: EXPIRY, effective_start_time: '2026-09-27T11:05:00+00:00' })],
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`${GAME} started Sun Sep 27, 7:05 am ET.`);
    expect(result.text).not.toContain('Take link');
  });

  it('refuses a game with no readable start instead of treating it as not started', async () => {
    const h = await harness({ ...BOOK, contests_effective: [contestRow({ effective_start_time: null })] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} has no start time Ospex can read, so it cannot be bet on.`, PLACED_NOTHING),
    });
  });

  for (const status of ['unverified', 'scored', 'voided']) {
    it(`refuses a contest that is ${status}`, async () => {
      const h = await harness({ ...BOOK, contests_effective: [contestRow({ contest_status: status })] });
      expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
        isError: false,
        text: lines(`${GAME} is not open for betting: its contest is ${status}.`, PLACED_NOTHING),
      });
    });
  }

  it('refuses a contest with no start written on-chain, whatever its status says', async () => {
    const h = await harness({ ...BOOK, contests_effective: [contestRow({ start_time: null })] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain('is not open for betting');
    expect(result.text).not.toContain('Take link');
  });

  it('says a contest does not exist', async () => {
    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, contestId: '999' }, h.ctx)).toEqual({
      isError: true,
      text: lines('There is no contest 999 on Ospex.', PLACED_NOTHING),
    });
  });

  it('reads a contest id written with leading zeros as the number it is', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder({ ...UNDER_2, contestId: ' 0481 ' }, h.ctx);
    expect(requestTo(h.fake, 'contests_effective')?.params.get('contest_id')).toBe('eq.481');
    expect(result.text).toContain('contest_id: 481');
  });

  // ── the arguments ────────────────────────────────────────────────────

  it('refuses an amount it cannot read exactly, before reading anything', async () => {
    const h = await harness(BOOK);
    const cases: Array<[number, string]> = [
      [0, 'risk_usdc must be more than zero.'],
      [-5, 'risk_usdc must be more than zero.'],
      [1.0000001, 'risk_usdc has more than six decimal places. USDC has six.'],
      [0.1 + 0.2, 'risk_usdc has more than six decimal places. USDC has six.'],
      [1_000_000.5, 'risk_usdc is more than one order may carry (1,000,000 USDC).'],
      [Number.NaN, 'risk_usdc must be a plain number of USDC, such as 10 or 2.5.'],
      [1e-7, 'risk_usdc must be a plain number of USDC, such as 10 or 2.5.'],
    ];
    for (const [riskUsdc, problem] of cases) {
      expect(await h.prepareOrder({ ...UNDER_2, riskUsdc }, h.ctx)).toEqual({
        isError: true,
        text: lines(problem, PLACED_NOTHING),
      });
    }
    expect(h.fake.requests).toHaveLength(0);
  });

  it('refuses a contest id that is not a number, before reading anything', async () => {
    const h = await harness(BOOK);
    for (const contestId of ['', 'abc', '48.1', '-481', '4 81', '9'.repeat(21)]) {
      expect(await h.prepareOrder({ ...UNDER_2, contestId }, h.ctx)).toEqual({
        isError: true,
        text: lines('contest_id must be the number list_markets shows for the game.', PLACED_NOTHING),
      });
    }
    expect(h.fake.requests).toHaveLength(0);
  });

  it('says what the sides of the market are when the side is not one of them', async () => {
    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, side: 'Phillies' }, h.ctx)).toEqual({
      isError: true,
      text: lines('For a total, side is over or under.', PLACED_NOTHING),
    });
    expect(
      await h.prepareOrder({ contestId: '481', market: 'moneyline', side: 'under', riskUsdc: 2, line: undefined }, h.ctx),
    ).toEqual({
      isError: true,
      text: lines(
        'Over and under are sides of a total. For a moneyline, side is Tampa Bay Rays (away) or Philadelphia Phillies (home).',
        PLACED_NOTHING,
      ),
    });
    expect(
      await h.prepareOrder({ contestId: '481', market: 'moneyline', side: 'Yankees', riskUsdc: 2, line: undefined }, h.ctx),
    ).toEqual({
      isError: true,
      text: lines(
        'That is not one of the teams in this game. Side is Tampa Bay Rays (away) or Philadelphia Phillies (home).',
        PLACED_NOTHING,
      ),
    });
  });

  it('refuses a name both teams answer to', async () => {
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ away_team: 'New York Mets', home_team: 'New York Yankees' })],
    });
    expect(
      await h.prepareOrder({ contestId: '481', market: 'moneyline', side: 'New York', riskUsdc: 2, line: undefined }, h.ctx),
    ).toEqual({
      isError: true,
      text: lines('That name fits both teams. Say New York Mets (away) or New York Yankees (home).', PLACED_NOTHING),
    });
  });

  // ── the line ─────────────────────────────────────────────────────────

  it('says the market has no line when it has none', async () => {
    const h = await harness({ ...BOOK, speculations: [MONEYLINE] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} has no total line on-chain yet.`, PLACED_NOTHING),
    });
  });

  it('asks which line when more than one has a quote on that side', async () => {
    const total75 = speculationRow({ speculation_id: 1005, line_ticks: 75 });
    const under75 = quoteRow({
      commitment_hash: hash('b5'),
      line_ticks: 75,
      odds_tick: 190,
      speculation_key: KEYS['c481-total-75'],
    });
    const h = await harness({
      ...BOOK,
      speculations: [TOTAL_7, total75],
      commitments: [UNDER_QUOTE, under75],
    });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: true,
      text: lines('More than one line has a quote: Under 7.0; Under 7.5. Say which with line.', PLACED_NOTHING),
    });

    const chosen = await h.prepareOrder({ ...UNDER_2, line: 7.5 }, h.ctx);
    expect(chosen.text).toContain(`Under 7.5 — ${GAME}`);
    expect(chosen.text).toContain(`commitment_hash: ${hash('b5')}`);
    expect(chosen.text).toContain('line: 7.5');
    // A half-point total has no push.
    expect(chosen.text).not.toContain('push');
  });

  it('uses the one line that has a quote when two lines exist', async () => {
    const total75 = speculationRow({ speculation_id: 1005, line_ticks: 75 });
    const h = await harness({ ...BOOK, speculations: [total75, TOTAL_7], commitments: [UNDER_QUOTE] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`Under 7.0 — ${GAME}`);
  });

  it('says which lines exist when the one named does not', async () => {
    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, line: 8.5 }, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} has no total line at 8.5. Lines on-chain: 7.0.`, PLACED_NOTHING),
    });
  });

  it('refuses a line with more than one decimal place', async () => {
    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, line: 7.25 }, h.ctx)).toEqual({
      isError: true,
      text: lines('line must be a number with at most one decimal place, such as 7.5 or -1.5.', PLACED_NOTHING),
    });
  });

  it('ignores a line given for a moneyline', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder(
      { contestId: '481', market: 'moneyline', side: 'home', riskUsdc: 3, line: 7.5 },
      h.ctx,
    );
    expect(result.text).toContain(`commitment_hash: ${hash('a3')}`);
    expect(result.text).not.toContain('line:');
  });

  // ── the quote ────────────────────────────────────────────────────────

  it('says so when nothing is posted on that side', async () => {
    const h = await harness({ ...BOOK, commitments: [OVER_QUOTE] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(`No quote is posted for Under 7.0 on ${GAME} right now.`, PLACED_NOTHING),
    });
    // No quote, so no maker to look up.
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
  });

  it('says an amount is too small, and what the smallest is', async () => {
    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, riskUsdc: 0.000103 }, h.ctx)).toEqual({
      isError: false,
      text: lines(
        '0.000103 USDC is too small to take any quote for Under 7.0. The smallest is 0.000104 USDC.',
        PLACED_NOTHING,
      ),
    });
    const smallest = await h.prepareOrder({ ...UNDER_2, riskUsdc: 0.000104 }, h.ctx);
    expect(smallest.text).toContain('Exact amounts: you pay 0.000104 USDC and win 0.000100 USDC.');
  });

  // ── reads that fail ──────────────────────────────────────────────────

  for (const table of ['contests_effective', 'speculations', 'commitments']) {
    it(`answers with fixed words when the ${table} read fails`, async () => {
      const h = await harness(BOOK, {
        override: (request) =>
          tableOf(request) === table ? { status: 500, body: { message: `secret detail about ${table}` } } : undefined,
      });
      const result = await h.prepareOrder(UNDER_2, h.ctx);
      expectReached(h.fake);
      expect(result).toEqual({ isError: true, text: READ_FAILED });
      expect(h.log.error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(h.log.error.mock.calls[0])).toContain(`secret detail about ${table}`);
    });
  }

  it('refuses when the service has no scorer addresses, before reading anything', async () => {
    const h = await harness(BOOK, { context: { scorers: undefined } });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not configured');
    expect(h.fake.requests).toHaveLength(0);
  });
});

// ── get_order_status ───────────────────────────────────────────────────

const STATUS_ARGS = { commitmentHash: hash('a1'), takerAddress: undefined };
const LAG = 'A fill is listed once its block is final, usually within about 15 seconds of the transaction confirming.';

describe('get_order_status', () => {
  it('reports a partly taken quote and the fill on it', async () => {
    const h = await harness({
      ...BOOK,
      commitments: [quoteRow({ status: 'partially_filled', filled_risk_amount: '1904700' })],
      position_fills: [fillRow()],
    });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expectReached(h.fake, 3);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Status: partially filled: part has been taken and the rest can be.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 1.9047 of the 5 USDC the maker put up.',
        'Taking it backs: Under 7.0.',
        'Price for the taker: 1.95.',
        'Still takeable: up to 3.250065 USDC of risk.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'Fills on this quote: 1.',
        `1. ${TAKER} risked 1.999935 USDC to win 1.9047 at 1.95, Sun Sep 27, 9:00 am ET. Transaction ${hash('f1')}`,
        '',
        LAG,
      ),
    });
  });

  it('reads the quote, its fills, then its contest', async () => {
    const h = await harness({ ...BOOK, position_fills: [fillRow()] });
    await h.getOrderStatus(STATUS_ARGS, h.ctx);
    // The contest is read for its names, so its lines are not.
    expect(h.fake.tables()).toEqual(['commitments', 'position_fills', 'contests_effective']);
    expect(requestTo(h.fake, 'commitments')?.params.get('commitment_hash')).toBe(`eq.${hash('a1')}`);
    expect(requestTo(h.fake, 'commitments')?.params.get('network')).toBe('eq.polygon');
    const fills = requestTo(h.fake, 'position_fills');
    expect(fills?.params.get('commitment_hash')).toBe(`eq.${hash('a1')}`);
    expect(fills?.params.get('network')).toBe('eq.polygon');
    expect(fills?.params.get('order')).toBe('row_updated_at.asc,id.asc');
    expect(fills?.params.get('limit')).toBe('1000');
    expect(fills?.params.has('taker_address')).toBe(false);
  });

  it('reports an open quote with nothing taken', async () => {
    const h = await harness(BOOK);
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.text).toBe(
      lines(
        `Quote ${hash('a1')}`,
        'Status: open: it can be taken.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Taking it backs: Under 7.0.',
        'Price for the taker: 1.95.',
        'Still takeable: up to 5.25 USDC of risk.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    );
  });

  it('lists only one wallet\'s fills when given its address, in any case', async () => {
    const other = '0xdddddddddddddddddddddddddddddddddddddddd';
    const h = await harness({
      ...BOOK,
      position_fills: [
        fillRow(),
        fillRow({ id: 2, taker_address: other, tx_hash: hash('f2'), taker_risk_amount: '1000000', maker_risk_amount: '952300' }),
      ],
    });
    const result = await h.getOrderStatus(
      { commitmentHash: hash('a1').toUpperCase().replace('0X', '0x'), takerAddress: other.toUpperCase().replace('0X', '0x') },
      h.ctx,
    );
    expect(requestTo(h.fake, 'position_fills')?.params.get('taker_address')).toBe(`eq.${other}`);
    expect(requestTo(h.fake, 'commitments')?.params.get('commitment_hash')).toBe(`eq.${hash('a1')}`);
    expect(result.text).toContain(`Fills on this quote by ${other}: 1.`);
    expect(result.text).toContain(`1. ${other} risked 1 USDC to win 0.9523 at 1.95`);
    expect(result.text).not.toContain(TAKER);
  });

  it('says so when that wallet has no fill on the quote', async () => {
    const h = await harness({ ...BOOK, position_fills: [fillRow()] });
    const stranger = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const result = await h.getOrderStatus({ commitmentHash: hash('a1'), takerAddress: stranger }, h.ctx);
    expect(result.text).toContain(`No fills on this quote by ${stranger} yet.`);
    expect(result.text).toContain(LAG);
  });

  it('shows what was taken from a quote that then expired', async () => {
    const h = await harness({
      ...BOOK,
      commitments: [
        quoteRow({ status: 'partially_filled', filled_risk_amount: '1904700', expiry: '2026-09-27T11:00:00+00:00' }),
      ],
      position_fills: [fillRow()],
    });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.text).toContain('Status: expired: it can no longer be taken.');
    expect(result.text).toContain('Taken so far: 1.9047 of the 5 USDC the maker put up.');
    expect(result.text).toContain('Expired Sun Sep 27, 7:00 am ET.');
    expect(result.text).toContain('Fills on this quote: 1.');
    expect(result.text).not.toContain('Still takeable');
  });

  it('reports a filled quote', async () => {
    const h = await harness({
      ...BOOK,
      commitments: [quoteRow({ status: 'filled', filled_risk_amount: '5000000' })],
    });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.text).toContain('Status: filled: all of it has been taken.');
    expect(result.text).toContain('Taken so far: 5 of the 5 USDC the maker put up.');
    expect(result.text).not.toContain('Still takeable');
  });

  it('shows no price or size for a quote its maker withdrew, and still lists its fills', async () => {
    const h = await harness({
      ...BOOK,
      commitments: [quoteRow({ status: 'partially_filled', filled_risk_amount: '1904700', book_visible: false })],
      position_fills: [fillRow()],
    });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Status: cancelled: it can no longer be taken.',
        `Game: ${GAME} (contest_id 481).`,
        'Its maker withdrew it from the book, so its price and size are not shown.',
        'Taken from it before that: 1.9047 USDC of what the maker put up.',
        '',
        'Fills on this quote: 1.',
        `1. ${TAKER} risked 1.999935 USDC to win 1.9047 at 1.95, Sun Sep 27, 9:00 am ET. Transaction ${hash('f1')}`,
        '',
        LAG,
      ),
    });
    expect(result.text).not.toContain('Still takeable');
    expect(result.text).not.toContain('Price for the taker');
    expect(result.text).not.toContain('Expires');
  });

  it('names the teams on a moneyline quote', async () => {
    const h = await harness({ ...BOOK, commitments: [HOME_QUOTE] });
    const result = await h.getOrderStatus({ commitmentHash: hash('a3'), takerAddress: undefined }, h.ctx);
    expect(result.text).toContain('Taking it backs: Philadelphia Phillies (home) to win.');
    expect(result.text).toContain('Price for the taker: 1.67.');
    expect(result.text).toContain('Still takeable: up to 6 USDC of risk.');
  });

  it('says a hash is unknown', async () => {
    const h = await harness(BOOK);
    const result = await h.getOrderStatus({ commitmentHash: hash('ee'), takerAddress: undefined }, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(`Ospex has no quote with the hash ${hash('ee')}.`, 'Check that the whole hash was copied.'),
    });
    expect(h.fake.tables()).toEqual(['commitments']);
  });

  it('refuses a hash or an address of the wrong shape, before reading anything', async () => {
    const h = await harness(BOOK);
    for (const commitmentHash of ['', '0x1234', hash('a1').slice(0, -1), `${hash('a1')}0`, hash('a1').replace('0x', ''), `0x${'zz'.repeat(32)}`]) {
      expect(await h.getOrderStatus({ commitmentHash, takerAddress: undefined }, h.ctx)).toEqual({
        isError: true,
        text: 'commitment_hash must be 0x followed by 64 hex characters, as prepare_order gave it.',
      });
    }
    for (const takerAddress of ['0x1234', 'vitalik.eth', `0x${'zz'.repeat(20)}`]) {
      expect(await h.getOrderStatus({ commitmentHash: hash('a1'), takerAddress }, h.ctx)).toEqual({
        isError: true,
        text: 'taker_address must be a wallet address: 0x followed by 40 hex characters.',
      });
    }
    expect(h.fake.requests).toHaveLength(0);
  });

  it('treats a blank address as no address', async () => {
    const h = await harness(BOOK);
    const result = await h.getOrderStatus({ commitmentHash: hash('a1'), takerAddress: '  ' }, h.ctx);
    expect(result.isError).toBe(false);
    expect(requestTo(h.fake, 'position_fills')?.params.has('taker_address')).toBe(false);
  });

  it('says the list may be cut short when it reaches the most one call reads', async () => {
    const many: Row[] = [];
    for (let index = 0; index < 1000; index += 1) {
      many.push(fillRow({ id: index + 1, log_index: index, row_updated_at: `2026-09-27T13:00:05.${String(index).padStart(6, '0')}+00:00` }));
    }
    const h = await harness({ ...BOOK, position_fills: many });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.text).toContain('Fills on this quote: 1000 (the first 1000; there may be more).');
  });

  it('does not say the list is cut short one fill below that', async () => {
    const many: Row[] = [];
    for (let index = 0; index < 999; index += 1) many.push(fillRow({ id: index + 1, log_index: index }));
    const h = await harness({ ...BOOK, position_fills: many });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.text).toContain('Fills on this quote: 999.');
    expect(result.text).not.toContain('there may be more');
  });

  it('answers without the names when the contest read fails', async () => {
    const h = await harness(
      { ...BOOK, position_fills: [fillRow()] },
      {
        override: (request) =>
          tableOf(request) === 'contests_effective' ? { status: 500, body: { message: 'names unavailable' } } : undefined,
      },
    );
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.isError).toBe(false);
    expect(result.text).toContain('Status: open: it can be taken.');
    expect(result.text).toContain('Price for the taker: 1.95.');
    expect(result.text).toContain('Fills on this quote: 1.');
    expect(result.text).not.toContain('Game:');
    expect(result.text).not.toContain('Taking it backs');
    expect(h.log.warn).toHaveBeenCalledWith(
      { err: 'names unavailable' },
      'mcp: get_order_status contest read failed, names omitted',
    );
  });

  for (const table of ['commitments', 'position_fills']) {
    it(`answers with fixed words when the ${table} read fails`, async () => {
      const h = await harness(
        { ...BOOK, position_fills: [fillRow()] },
        {
          override: (request) =>
            tableOf(request) === table ? { status: 500, body: { message: `secret detail about ${table}` } } : undefined,
        },
      );
      const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
      expectReached(h.fake);
      expect(result).toEqual({ isError: true, text: READ_FAILED });
      expect(JSON.stringify(h.log.error.mock.calls)).toContain(`secret detail about ${table}`);
    });
  }
});
