/**
 * `list_markets`, run against a database it can actually reach.
 *
 * The harness, the fixture and the clock are in `helpers/mcpTools.ts`.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expectReached, requestTo } from './helpers/fakePostgrest.js';
import {
  KEYS,
  contestRow,
  hash,
  quoteRow,
  speculationRow,
  tableOf,
  type Row,
  type Tables,
} from './helpers/mcpBook.js';
import {
  BOOK,
  GAME,
  MONEYLINE,
  READ_FAILED,
  UNDER_QUOTE,
  closeHarnesses,
  harness,
  lines,
  warmTools,
} from './helpers/mcpTools.js';

beforeAll(warmTools, 60_000);
afterEach(closeHarnesses);

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
