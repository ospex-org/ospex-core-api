/**
 * `prepare_order`, run against a database it can actually reach.
 *
 * The harness, the fixture and the clock are in `helpers/mcpTools.ts`.
 *
 * Every amount expected here was worked out by hand from the fill rule in
 * `src/mcp/takeMath.ts`, and the working is written beside it:
 *
 *     profit ticks = posted price in ticks - 100
 *     fill         = ceil(asked * 100 / profit ticks), rounded DOWN to a multiple of 100
 *     pays         = floor(fill * profit ticks / 100), and never more than asked
 *     wins         = fill
 *
 * Amounts in the working are USDC base units, six decimals. A preview's
 * headline shows what is paid rounded half up to the cent, and what is won
 * rounded DOWN to the cent, so the win it names is never more than the chain
 * would pay out.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PrepareOrderArgs } from '../src/mcp/tools/prepareOrder.js';
import { expectReached, requestTo } from './helpers/fakePostgrest.js';
import {
  EXPIRY,
  KEYS,
  MAKER_A,
  MAKER_B,
  SCORERS,
  START,
  contestRow,
  fundingRow,
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
  OVER_QUOTE,
  PLACED_NOTHING,
  READ_FAILED,
  TOTAL_7,
  UNDER_2,
  UNDER_QUOTE,
  closeHarnesses,
  harness,
  lines,
  warmTools,
  type Harness,
} from './helpers/mcpTools.js';

beforeAll(warmTools, 60_000);
afterEach(closeHarnesses);

const STARTS = 'Sun Sep 27, 3:05 pm ET';
const NOT_YET_PLACED =
  'Nothing has been placed. The order is placed only when you open the link and confirm in your wallet.';
/** The fixture's clock, 12:00:00 UTC, as the preview writes it: to the second. */
const PREPARED = 'Prepared Sun Sep 27, 8:00:00 am ET. A fill made at or before then is not this order.';
/** A sentence that must not be said: the contract fills a take after the start. */
const OLD_UNDER_WAY = 'Ospex takes no bets';
const NOT_EXACT_WARN = 'commitments: open book row carries a number that did not arrive exact — dropped';
const TOTAL_7_PUSH = 'A combined score of exactly 7 is a push: the stake is returned.';
const TIE_PUSH = 'A tie is a push: the stake is returned.';
const EXPIRES = 'Quote expires Sun Sep 27, 2:55 pm ET.';
const FUNDS_NOT_CONFIRMED =
  "The maker's funds could not be confirmed just now. If they are short the transaction fails and only gas is spent.";
const EITHER_TEAM = 'Pass away for Tampa Bay Rays, or home for Philadelphia Phillies.';
const SIDE_NOT_READ = `side was not read as one of the two teams. Pass a team's name by itself, with nothing after it. ${EITHER_TEAM}`;
const TOTAL_SIDES = 'For a total, side is over or under, by itself.';
const BAD_CONTEST_ID = 'contest_id must be the number list_markets shows for the game.';

/** 3 USDC on the moneyline; a case adds the side. */
const MONEYLINE_3 = { contestId: '481', market: 'moneyline', riskUsdc: 3, line: undefined } as const;

/** 2 USDC on the Under, taken from a quote posted at 2.05 under the hash of `byte`. */
function underTwoAt205(byte: string): string {
  return lines(
    `Under 7.0 — ${GAME}, ${STARTS}.`,
    'Risk 2.00 USDC to win 1.90 at 1.95.',
    TOTAL_7_PUSH,
    EXPIRES,
    'Exact amounts: you pay 1.999935 USDC and win 1.904700 USDC.',
    '',
    `Take link: https://ospex.org/take/${hash(byte)}?risk=2`,
    NOT_YET_PLACED,
    PREPARED,
    '',
    'contest_id: 481',
    `commitment_hash: ${hash(byte)}`,
    'market: total',
    'line: 7.0',
    'side: under',
    'risk_usdc: 2',
  );
}

/** The 2 USDC Under on the default quote, which most cases answer with. */
const UNDER_2_PREVIEW = underTwoAt205('a1');

/** Every argument of every call to the three log levels, as they were made. */
function logged(h: Harness): { info: unknown[][]; warn: unknown[][]; error: unknown[][] } {
  return { info: h.log.info.mock.calls, warn: h.log.warn.mock.calls, error: h.log.error.mock.calls };
}

const NOTHING_LOGGED = { info: [], warn: [], error: [] };

/** The hash of the `index`th of many quotes: a counter, zero-padded to 64 hex digits. */
const nth = (index: number): string => `0x${index.toString(16).padStart(64, '0')}`;

describe('prepare_order', () => {
  it('prepares the Under at the posted price, with the amounts the chain will move', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expectReached(h.fake, 4);

    // Posted 2.05, so 105 profit ticks. 2_000_000 asked:
    // ceil(200_000_000 / 105) = 1_904_762, down to 1_904_700.
    // floor(1_904_700 * 105 / 100) = 1_999_935.
    expect(result.isError).toBe(false);
    expect(result.text).toBe(UNDER_2_PREVIEW);
    // A total has no team, so its identifier block names none.
    expect(result.text).not.toContain('team:');
  });

  it('reads the contest, its lines, its quotes and the makers\' funding, in that order', async () => {
    const h = await harness(BOOK);
    await h.prepareOrder(UNDER_2, h.ctx);
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments', 'maker_funding']);
    expect(requestTo(h.fake, 'contests_effective')?.params.get('contest_id')).toBe('eq.481');
    expect(requestTo(h.fake, 'speculations')?.params.get('contest_id')).toBe('eq.481');
    expect(requestTo(h.fake, 'commitments')?.params.get('contest_id')).toBe('in.(481)');
    expect(requestTo(h.fake, 'commitments')?.params.get('book_visible')).toBe('eq.true');
    expect(requestTo(h.fake, 'commitments')?.params.get('nonce_invalidated')).toBe('eq.false');
    expect(requestTo(h.fake, 'commitments')?.params.get('status')).toBe('in.(open,partially_filled)');
    expect(requestTo(h.fake, 'commitments')?.params.get('expiry')).toBe('gt.2026-09-27T12:00:00.000Z');
    // Only the makers on the side being taken.
    expect(requestTo(h.fake, 'maker_funding')?.params.get('maker_address')).toBe(`in.(${MAKER_A})`);
  });

  for (const table of ['contests_effective', 'speculations', 'commitments', 'maker_funding']) {
    it(`asks ${table} for rows on its own network and no other`, async () => {
      // Every fixture row is on polygon, so a read that dropped the filter
      // would answer the same rows. The filter is asserted where it arrives.
      const h = await harness(BOOK);
      const result = await h.prepareOrder(UNDER_2, h.ctx);
      expect(result.text).toBe(UNDER_2_PREVIEW);
      expect(h.fake.requests.filter((request) => tableOf(request) === table)).toHaveLength(1);
      expect(requestTo(h.fake, table)?.params.getAll('network')).toEqual(['eq.polygon']);
    });
  }

  // ── when it was prepared ─────────────────────────────────────────────

  it('writes the time it was prepared from the clock it is given, to the second', async () => {
    // 03:30:07 UTC on the 27th is 11:30:07 pm Eastern on the 26th, so the day
    // and the hour are both Eastern ones, and the seconds are not zero: a time
    // written to the minute reads 11:30, and one with its seconds zeroed reads
    // 11:30:00. The snapshot is thirty seconds old on this clock, as the
    // default one is on the fixture's.
    const clock = Date.UTC(2026, 8, 27, 3, 30, 7);
    const h = await harness(
      { ...BOOK, maker_funding: [fundingRow({ updated_at: '2026-09-27T03:29:37+00:00' })] },
      { context: { nowMs: clock } },
    );
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 2.00 USDC to win 1.90 at 1.95.',
        TOTAL_7_PUSH,
        EXPIRES,
        'Exact amounts: you pay 1.999935 USDC and win 1.904700 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('a1')}?risk=2`,
        NOT_YET_PLACED,
        'Prepared Sat Sep 26, 11:30:07 pm ET. A fill made at or before then is not this order.',
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a1')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 2',
      ),
    });
    // The book was read on the same clock.
    expect(requestTo(h.fake, 'commitments')?.params.get('expiry')).toBe('gt.2026-09-27T03:30:07.000Z');
  });

  // Every way the tool answers without a link. A time of preparing belongs to
  // an order, and none of these is one.
  const NO_LINK: Array<{ name: string; tables: Tables; args: PrepareOrderArgs; scorers?: 'none' }> = [
    { name: 'an amount it cannot read', tables: BOOK, args: { ...UNDER_2, riskUsdc: 0 } },
    { name: 'a contest id that is not one', tables: BOOK, args: { ...UNDER_2, contestId: 'abc' } },
    { name: 'no scorer addresses', tables: BOOK, args: UNDER_2, scorers: 'none' },
    { name: 'a contest that does not exist', tables: BOOK, args: { ...UNDER_2, contestId: '999' } },
    {
      name: 'a contest that is scored',
      tables: { ...BOOK, contests_effective: [contestRow({ contest_status: 'scored' })] },
      args: UNDER_2,
    },
    {
      name: 'a contest with no start on-chain',
      tables: { ...BOOK, contests_effective: [contestRow({ start_time: null })] },
      args: UNDER_2,
    },
    {
      name: 'a start that cannot be read',
      tables: { ...BOOK, contests_effective: [contestRow({ effective_start_time: null })] },
      args: UNDER_2,
    },
    {
      name: 'a game that has started',
      tables: { ...BOOK, contests_effective: [contestRow({ effective_start_time: '2026-09-27T12:00:00+00:00' })] },
      args: UNDER_2,
    },
    {
      name: 'a game too close to its start',
      tables: { ...BOOK, contests_effective: [contestRow({ effective_start_time: '2026-09-27T12:02:00+00:00' })] },
      args: UNDER_2,
    },
    { name: 'a side that is not one', tables: BOOK, args: { ...UNDER_2, side: 'Phillies' } },
    { name: 'a market with no line', tables: { ...BOOK, speculations: [MONEYLINE] }, args: UNDER_2 },
    { name: 'a line the game does not have', tables: BOOK, args: { ...UNDER_2, line: 8.5 } },
    { name: 'a line with two decimals', tables: BOOK, args: { ...UNDER_2, line: 7.25 } },
    { name: 'no quote on that side', tables: { ...BOOK, commitments: [OVER_QUOTE] }, args: UNDER_2 },
    { name: 'an amount too small to take', tables: BOOK, args: { ...UNDER_2, riskUsdc: 0.000103 } },
    {
      name: 'a maker known to be short',
      tables: { ...BOOK, maker_funding: [fundingRow({ backing_wei6: '1904699' })] },
      args: UNDER_2,
    },
  ];
  for (const refused of NO_LINK) {
    it(`writes no time of preparing for ${refused.name}`, async () => {
      const h = await harness(refused.tables, refused.scorers === 'none' ? { context: { scorers: undefined } } : {});
      const result = await h.prepareOrder(refused.args, h.ctx);
      expect(result.text).not.toContain('Take link');
      expect(result.text).not.toContain('Prepared');
      expect(result.text).not.toContain(PREPARED);
      expect(result.text).not.toContain(OLD_UNDER_WAY);
    });
  }

  it('prepares for everything the quote has left when it cannot absorb the amount, and says so', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder({ ...UNDER_2, riskUsdc: 10 }, h.ctx);
    // 10_000_000 asked needs ceil(1_000_000_000 / 105) = 9_523_810 of maker
    // risk and the quote has 5_000_000. Everything it has left is
    // 5_000_000 * 105 / 100 = 5_250_000, which fills 5_000_000.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 5.25 USDC to win 5.00 at 1.95.',
        TOTAL_7_PUSH,
        EXPIRES,
        'This quote can take 5.25 USDC, not the 10 asked for. The order is for 5.25.',
        '',
        `Take link: https://ospex.org/take/${hash('a1')}?risk=5.25`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a1')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 5.25',
      ),
    });
  });

  it('states exact amounts before it says the order was cut down', async () => {
    // 1_234_500 of maker risk at 2.05. Everything it can take is
    // 1_234_500 * 105 / 100 = 1_296_225, which fills ceil(129_622_500 / 105)
    // = 1_234_500 and pays 1_296_225. Neither is a whole cent.
    const small = quoteRow({ commitment_hash: hash('b4'), risk_amount: '1234500' });
    const h = await harness({ ...BOOK, commitments: [small] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 1.30 USDC to win 1.23 at 1.95.',
        TOTAL_7_PUSH,
        EXPIRES,
        'Exact amounts: you pay 1.296225 USDC and win 1.234500 USDC.',
        'This quote can take 1.296225 USDC, not the 2 asked for. The order is for 1.296225.',
        '',
        `Take link: https://ospex.org/take/${hash('b4')}?risk=1.296225`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('b4')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 1.296225',
      ),
    });
  });

  it('takes the Over from the quote whose maker holds the Under', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder({ ...UNDER_2, side: 'Over', riskUsdc: 3 }, h.ctx);
    // Posted 1.91, so 91 profit ticks. 3_000_000 asked:
    // ceil(300_000_000 / 91) = 3_296_704, down to 3_296_700.
    // floor(3_296_700 * 91 / 100) = 2_999_997. The taker's price is 191/91,
    // which is 2.0989, shown as 2.10. The win, 3.2967, is 3.29 rounded down.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Over 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 3.00 USDC to win 3.29 at 2.10.',
        TOTAL_7_PUSH,
        EXPIRES,
        'Exact amounts: you pay 2.999997 USDC and win 3.296700 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('a2')}?risk=3`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a2')}`,
        'market: total',
        'line: 7.0',
        'side: over',
        'risk_usdc: 3',
      ),
    });
    expect(requestTo(h.fake, 'maker_funding')?.params.get('maker_address')).toBe(`in.(${MAKER_B})`);
  });

  // ── the amounts, to the cent ─────────────────────────────────────────

  it('rounds the Risk line from what is paid, not from what was asked', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder({ ...UNDER_2, riskUsdc: 2.005 }, h.ctx);
    // 2_005_000 asked: ceil(200_500_000 / 105) = 1_909_524, down to 1_909_500.
    // floor(1_909_500 * 105 / 100) = 2_004_975, which is 2.00 to the cent.
    // The amount asked, 2.005, is 2.01 to the cent, half up. The win, 1.9095,
    // is 1.90 rounded down.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 2.00 USDC to win 1.90 at 1.95.',
        TOTAL_7_PUSH,
        EXPIRES,
        'Exact amounts: you pay 2.004975 USDC and win 1.909500 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('a1')}?risk=2.005`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a1')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 2.005',
      ),
    });
  });

  it('states exact amounts when only the amount paid is off a whole cent', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder({ ...UNDER_2, riskUsdc: 1.0605 }, h.ctx);
    // 1_060_500 asked: 106_050_000 / 105 = 1_010_000 exactly, a whole cent.
    // 1_010_000 * 105 / 100 = 1_060_500, which is not one.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 1.06 USDC to win 1.01 at 1.95.',
        TOTAL_7_PUSH,
        EXPIRES,
        'Exact amounts: you pay 1.060500 USDC and win 1.010000 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('a1')}?risk=1.0605`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a1')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 1.0605',
      ),
    });
  });

  it('states exact amounts when only the amount won is off a whole cent', async () => {
    // At 2.05 an amount paid that is a whole cent always wins one, so this
    // quote is posted at 3.00: 200 profit ticks, and the taker's price is
    // 300/200, shown as 1.50.
    // 2_010_000 asked: 201_000_000 / 200 = 1_005_000 exactly, half a cent.
    // 1_005_000 * 200 / 100 = 2_010_000, a whole cent. The win is 1.00
    // rounded down, where half up would make it 1.01.
    const atThree = quoteRow({ commitment_hash: hash('b3'), odds_tick: 300 });
    const h = await harness({ ...BOOK, commitments: [atThree] });
    const result = await h.prepareOrder({ ...UNDER_2, riskUsdc: 2.01 }, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 2.01 USDC to win 1.00 at 1.50.',
        TOTAL_7_PUSH,
        EXPIRES,
        'Exact amounts: you pay 2.010000 USDC and win 1.005000 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('b3')}?risk=2.01`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('b3')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 2.01',
      ),
    });
  });

  it('leaves the exact amounts out when both are whole cents', async () => {
    // Posted 3.00 again. 2_000_000 asked fills 1_000_000 and pays 2_000_000.
    const atThree = quoteRow({ commitment_hash: hash('b3'), odds_tick: 300 });
    const h = await harness({ ...BOOK, commitments: [atThree] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 2.00 USDC to win 1.00 at 1.50.',
        TOTAL_7_PUSH,
        EXPIRES,
        '',
        `Take link: https://ospex.org/take/${hash('b3')}?risk=2`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('b3')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 2',
      ),
    });
  });

  // The win is rounded down and the amount paid half up. Posted 3.00, so 200
  // profit ticks, and every amount below fills exactly half of itself:
  //
  //   asked      fill = asked * 100 / 200   pays        headline pays  headline wins
  //   1_990_000  995_000                    1_990_000   1.99           0.99  (half up: 1.00)
  //   1_989_800  994_900                    1_989_800   1.99 (down: 1.98)   0.99
  //   1_999_800  999_900                    1_999_800   2.00 (down: 1.99)   0.99  (half up: 1.00)
  //   2_000_000  1_000_000                  2_000_000   2.00           1.00, both whole cents
  const ROUNDED: Array<{ asked: number; headline: string; exact: string[] }> = [
    {
      asked: 1.99,
      headline: 'Risk 1.99 USDC to win 0.99 at 1.50.',
      exact: ['Exact amounts: you pay 1.990000 USDC and win 0.995000 USDC.'],
    },
    {
      asked: 1.9898,
      headline: 'Risk 1.99 USDC to win 0.99 at 1.50.',
      exact: ['Exact amounts: you pay 1.989800 USDC and win 0.994900 USDC.'],
    },
    {
      asked: 1.9998,
      headline: 'Risk 2.00 USDC to win 0.99 at 1.50.',
      exact: ['Exact amounts: you pay 1.999800 USDC and win 0.999900 USDC.'],
    },
    { asked: 2, headline: 'Risk 2.00 USDC to win 1.00 at 1.50.', exact: [] },
  ];
  for (const row of ROUNDED) {
    it(`rounds the win down and the amount paid half up, asked ${String(row.asked)} at 3.00`, async () => {
      const atThree = quoteRow({ commitment_hash: hash('b3'), odds_tick: 300 });
      const h = await harness({ ...BOOK, commitments: [atThree] });
      expect(await h.prepareOrder({ ...UNDER_2, riskUsdc: row.asked }, h.ctx)).toEqual({
        isError: false,
        text: lines(
          `Under 7.0 — ${GAME}, ${STARTS}.`,
          row.headline,
          TOTAL_7_PUSH,
          EXPIRES,
          ...row.exact,
          '',
          `Take link: https://ospex.org/take/${hash('b3')}?risk=${String(row.asked)}`,
          NOT_YET_PLACED,
          PREPARED,
          '',
          'contest_id: 481',
          `commitment_hash: ${hash('b3')}`,
          'market: total',
          'line: 7.0',
          'side: under',
          `risk_usdc: ${String(row.asked)}`,
        ),
      });
    });
  }

  // ── the team ─────────────────────────────────────────────────────────
  //
  // The two sides of a market are taken from two different quotes, at two
  // different prices, and each names a different team. An answer that swapped
  // the teams, or the quotes, shows the wrong name beside the right hash.

  it('takes a team by name, and names it with its role in the preview', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder({ ...MONEYLINE_3, side: 'Phillies' }, h.ctx);
    // Posted 2.50, so 150 profit ticks: 300_000_000 / 150 = 2_000_000 exactly,
    // which pays 3_000_000. The taker's price is 250/150, shown as 1.67.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Philadelphia Phillies (home) to win — ${GAME}, ${STARTS}.`,
        'Risk 3.00 USDC to win 2.00 at 1.67.',
        TIE_PUSH,
        EXPIRES,
        '',
        `Take link: https://ospex.org/take/${hash('a3')}?risk=3`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a3')}`,
        'market: moneyline',
        'side: home',
        'team: Philadelphia Phillies',
        'risk_usdc: 3',
      ),
    });
  });

  it('prints a team name that holds line breaks and tabs as one line', async () => {
    const h = await harness({
      ...BOOK,
      contests_effective: [
        contestRow({ away_team: 'Tampa Bay\r\n\tRays', home_team: ' Philadelphia\n\nPhillies ' }),
      ],
    });
    const result = await h.prepareOrder({ ...MONEYLINE_3, side: 'home' }, h.ctx);
    // The same fourteen lines as with the names written plainly.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Philadelphia Phillies (home) to win — ${GAME}, ${STARTS}.`,
        'Risk 3.00 USDC to win 2.00 at 1.67.',
        TIE_PUSH,
        EXPIRES,
        '',
        `Take link: https://ospex.org/take/${hash('a3')}?risk=3`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a3')}`,
        'market: moneyline',
        'side: home',
        'team: Philadelphia Phillies',
        'risk_usdc: 3',
      ),
    });
  });

  it('prints a team name that holds control characters as one line', async () => {
    // Next line (U+0085), delete, escape and bell are control characters that
    // are not whitespace, so a rule that folds only whitespace keeps them.
    const away = 'Tampa\u007fBay\u0085Rays';
    const home = 'Philadelphia\u001b\u0007Phillies';
    for (const control of ['\u0085', '\u007f', '\u001b', '\u0007']) expect(/\s/.test(control)).toBe(false);

    const h = await harness({ ...BOOK, contests_effective: [contestRow({ away_team: away, home_team: home })] });
    const result = await h.prepareOrder({ ...MONEYLINE_3, side: 'home' }, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Philadelphia Phillies (home) to win — ${GAME}, ${STARTS}.`,
        'Risk 3.00 USDC to win 2.00 at 1.67.',
        TIE_PUSH,
        EXPIRES,
        '',
        `Take link: https://ospex.org/take/${hash('a3')}?risk=3`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a3')}`,
        'market: moneyline',
        'side: home',
        'team: Philadelphia Phillies',
        'risk_usdc: 3',
      ),
    });
  });

  it('drops characters that print as nothing from a team name, joining the letters around them', async () => {
    // A zero-width space inside "Rays", a direction mark and a byte-order mark
    // at the ends, a tag character inside "Philadelphia", and half of a
    // character inside "Phillies". Turned into spaces instead, "Ra ys" is no
    // longer the word "Rays", and "Rays" below names no team.
    const away = '‎Tampa Bay Ra​ys﻿';
    const home = 'Phila\u{E0064}delphia Phil\ud800lies';
    for (const invisible of ['‎', '​', '﻿', '\u{E0064}']) expect(/^\p{Cf}$/u.test(invisible)).toBe(true);
    expect(/^\p{Cs}$/u.test('\ud800')).toBe(true);

    const h = await harness({ ...BOOK, contests_effective: [contestRow({ away_team: away, home_team: home })] });
    const result = await h.prepareOrder({ ...MONEYLINE_3, side: 'Rays', riskUsdc: 1 }, h.ctx);
    // The same answer as with the names written plainly: see the case below.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Tampa Bay Rays (away) to win — ${GAME}, ${STARTS}.`,
        'Risk 1.00 USDC to win 1.66 at 2.67.',
        TIE_PUSH,
        EXPIRES,
        'Exact amounts: you pay 0.999960 USDC and win 1.666600 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('a4')}?risk=1`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a4')}`,
        'market: moneyline',
        'side: away',
        'team: Tampa Bay Rays',
        'risk_usdc: 1',
      ),
    });
  });

  it('names a team whose name is empty by its role, in every place a name goes', async () => {
    // One name is empty as stored. The other holds only characters that print
    // as nothing and a space, so it is empty once cleaned.
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ away_team: '', home_team: '​⁠ ‎' })],
    });

    // Posted 1.60, so 60 profit ticks. 1_000_000 asked:
    // ceil(100_000_000 / 60) = 1_666_667, down to 1_666_600.
    // floor(1_666_600 * 60 / 100) = 999_960.
    expect(await h.prepareOrder({ ...MONEYLINE_3, side: 'away', riskUsdc: 1 }, h.ctx)).toEqual({
      isError: false,
      text: lines(
        'Away team (away) to win — Away team @ Home team, Sun Sep 27, 3:05 pm ET.',
        'Risk 1.00 USDC to win 1.66 at 2.67.',
        TIE_PUSH,
        EXPIRES,
        'Exact amounts: you pay 0.999960 USDC and win 1.666600 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('a4')}?risk=1`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a4')}`,
        'market: moneyline',
        'side: away',
        'team: Away team',
        'risk_usdc: 1',
      ),
    });

    // Posted 2.50: 3_000_000 asked fills 2_000_000 exactly and pays 3_000_000.
    expect(await h.prepareOrder({ ...MONEYLINE_3, side: 'home' }, h.ctx)).toEqual({
      isError: false,
      text: lines(
        'Home team (home) to win — Away team @ Home team, Sun Sep 27, 3:05 pm ET.',
        'Risk 3.00 USDC to win 2.00 at 1.67.',
        TIE_PUSH,
        EXPIRES,
        '',
        `Take link: https://ospex.org/take/${hash('a3')}?risk=3`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a3')}`,
        'market: moneyline',
        'side: home',
        'team: Home team',
        'risk_usdc: 3',
      ),
    });

    // The sentences about a side name the roles too.
    expect(await h.prepareOrder({ ...MONEYLINE_3, side: 'Yankees' }, h.ctx)).toEqual({
      isError: true,
      text: lines(
        "side was not read as one of the two teams. Pass a team's name by itself, with nothing after it. " +
          'Pass away for Away team, or home for Home team.',
        PLACED_NOTHING,
      ),
    });
    expect(await h.prepareOrder({ ...MONEYLINE_3, side: 'over' }, h.ctx)).toEqual({
      isError: true,
      text: lines(
        'Over and under are sides of a total. For a moneyline, side is a team. ' +
          'Pass away for Away team, or home for Home team.',
        PLACED_NOTHING,
      ),
    });
  });

  it('names the game by its roles when a contest with empty team names is refused', async () => {
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ away_team: '', home_team: '', contest_status: 'scored' })],
    });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines('Away team @ Home team is not open for betting: its contest is scored.', PLACED_NOTHING),
    });
  });

  it('the other team is the other quote', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder({ ...MONEYLINE_3, side: 'away', riskUsdc: 1 }, h.ctx);
    // Posted 1.60, so 60 profit ticks. 1_000_000 asked:
    // ceil(100_000_000 / 60) = 1_666_667, down to 1_666_600.
    // floor(1_666_600 * 60 / 100) = 999_960. The taker's price is 160/60, shown as 2.67.
    // The win, 1.6666, is 1.66 rounded down.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Tampa Bay Rays (away) to win — ${GAME}, ${STARTS}.`,
        'Risk 1.00 USDC to win 1.66 at 2.67.',
        TIE_PUSH,
        EXPIRES,
        'Exact amounts: you pay 0.999960 USDC and win 1.666600 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('a4')}?risk=1`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a4')}`,
        'market: moneyline',
        'side: away',
        'team: Tampa Bay Rays',
        'risk_usdc: 1',
      ),
    });
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
    // Posted 2.00: 1_000_000 asked fills 1_000_000 and pays 1_000_000.
    // A half-point spread has no push.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Tampa Bay Rays (away) -1.5 — ${GAME}, ${STARTS}.`,
        'Risk 1.00 USDC to win 1.00 at 2.00.',
        EXPIRES,
        '',
        `Take link: https://ospex.org/take/${hash('a5')}?risk=1`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a5')}`,
        'market: spread',
        'line: -1.5',
        'side: away',
        'team: Tampa Bay Rays',
        'risk_usdc: 1',
      ),
    });
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
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Philadelphia Phillies (home) +1.5 — ${GAME}, ${STARTS}.`,
        'Risk 1.00 USDC to win 1.00 at 2.00.',
        EXPIRES,
        '',
        `Take link: https://ospex.org/take/${hash('a6')}?risk=1`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a6')}`,
        'market: spread',
        'line: +1.5',
        'side: home',
        'team: Philadelphia Phillies',
        'risk_usdc: 1',
      ),
    });

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

  it('says who pushes a spread on a whole number, from either side of it', async () => {
    // Stored -2.0: the away team gives two runs, so it is the away team
    // winning by exactly two that is a push, whichever side is backed.
    const spread2 = speculationRow({
      speculation_id: 1006,
      speculation_scorer: SCORERS.spread,
      market_type: 'spread',
      line_ticks: -20,
    });
    // The key of a line the shared fixture does not carry, written out as a
    // literal like the ones in `helpers/mcpBook.ts`:
    // keccak256(abi.encode(uint256 481, address 0x2222…2222, int32 -20)).
    const key = '0x2873c99343f55b5dc0284a15e029610c1b6db42f7315f9040acf08dd20f8147f';
    const onAway = quoteRow({
      commitment_hash: hash('a7'),
      scorer: SCORERS.spread,
      market_type: 'spread',
      line_ticks: -20,
      position_type: 'upper',
      odds_tick: 200,
      speculation_key: key,
    });
    const h = await harness({ ...BOOK, speculations: [spread2], commitments: [onAway] });
    const result = await h.prepareOrder(
      { contestId: '481', market: 'spread', side: 'home', riskUsdc: 1, line: 2 },
      h.ctx,
    );
    expect(result.text).toContain(`commitment_hash: ${hash('a7')}`);
    expect(result.text.split('\n')[2]).toBe('Tampa Bay Rays winning by exactly 2 is a push: the stake is returned.');
  });

  // ── which quote ──────────────────────────────────────────────────────

  it('chooses the better price among quotes that can fill the amount', async () => {
    const worse = quoteRow({ commitment_hash: hash('b1'), odds_tick: 215, risk_amount: '50000000' });
    const h = await harness({ ...BOOK, commitments: [worse, UNDER_QUOTE] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    // The best price was chosen, so there is no better one to mention.
    expect(result).toEqual({ isError: false, text: UNDER_2_PREVIEW });
  });

  it('at one price, takes the larger of two quotes that can each fill the amount', async () => {
    // Both are posted at 2.05. The larger, 50 USDC, comes second in hash order,
    // which is the order the book is read in, so taking the first quote read
    // would take the 5 USDC one. The amounts are the same either way.
    const larger = quoteRow({ commitment_hash: hash('b1'), risk_amount: '50000000' });
    const h = await harness({ ...BOOK, commitments: [UNDER_QUOTE, larger] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: underTwoAt205('b1') });
  });

  it('at one price and one size, takes the quote whose hash sorts first', async () => {
    const twin = quoteRow({ commitment_hash: hash('b1') });
    const h = await harness({ ...BOOK, commitments: [twin, UNDER_QUOTE] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: underTwoAt205('a1') });
  });

  it('passes over a better price with only dust left for one that fills the order', async () => {
    // 50_000 of maker risk left at 2.00, which takes 0.05 USDC. It is first in
    // price order, so a link built from the head of the list would carry it.
    const dust = quoteRow({
      commitment_hash: hash('b2'),
      odds_tick: 200,
      risk_amount: '5000000',
      filled_risk_amount: '4950000',
      status: 'partially_filled',
    });
    const h = await harness({ ...BOOK, commitments: [dust, UNDER_QUOTE] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 2.00 USDC to win 1.90 at 1.95.',
        TOTAL_7_PUSH,
        EXPIRES,
        'Exact amounts: you pay 1.999935 USDC and win 1.904700 USDC.',
        'A better price, 2.00, is posted for up to 0.05 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('a1')}?risk=2`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a1')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 2',
      ),
    });
    expect(result.text).not.toContain(hash('b2'));
  });

  // Maker B posts 5 USDC at 2.00: the taker's price is 2.00, for up to
  // 5_000_000 * 100 / 100 = 5.00 USDC. Maker A posts 50 USDC at 2.05: the
  // taker's price is 1.95, for up to 52.50.
  const BETTER = quoteRow({ commitment_hash: hash('b7'), maker: MAKER_B, odds_tick: 200 });
  const LARGER = quoteRow({ commitment_hash: hash('b8'), risk_amount: '50000000' });

  /** 5.01 USDC on the Under, taken from the larger quote at 1.95. */
  function underAtTheLargerQuote(betterPrice: string[]): string {
    // 5_010_000 asked at 2.00 needs 5_010_000 of maker risk and that quote has
    // 5_000_000. At 2.05: ceil(501_000_000 / 105) = 4_771_429, down to
    // 4_771_400. floor(4_771_400 * 105 / 100) = 5_009_970.
    return lines(
      `Under 7.0 — ${GAME}, ${STARTS}.`,
      'Risk 5.01 USDC to win 4.77 at 1.95.',
      TOTAL_7_PUSH,
      EXPIRES,
      'Exact amounts: you pay 5.009970 USDC and win 4.771400 USDC.',
      ...betterPrice,
      '',
      `Take link: https://ospex.org/take/${hash('b8')}?risk=5.01`,
      NOT_YET_PLACED,
      PREPARED,
      '',
      'contest_id: 481',
      `commitment_hash: ${hash('b8')}`,
      'market: total',
      'line: 7.0',
      'side: under',
      'risk_usdc: 5.01',
    );
  }

  it('says a better price is posted when it was passed over for being too small', async () => {
    const h = await harness({ ...BOOK, commitments: [BETTER, LARGER] });
    const result = await h.prepareOrder({ ...UNDER_2, riskUsdc: 5.01 }, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: underAtTheLargerQuote(['A better price, 2.00, is posted for up to 5.00 USDC.']),
    });
    expect(result.text).not.toContain(hash('b7'));
    // Both makers were looked up, best price first.
    expect(requestTo(h.fake, 'maker_funding')?.params.get('maker_address')).toBe(`in.(${MAKER_B},${MAKER_A})`);
  });

  it('gives the better price as the taker\'s, and its size as what a taker can risk', async () => {
    // Posted 1.90, 5 USDC. The taker's price is 190/90, shown as 2.11, and the
    // most a taker can risk is 5_000_000 * 90 / 100 = 4.50. The maker's own
    // figures are 1.90 and 5.00, so neither can stand in for the taker's.
    const atOneNinety = quoteRow({ commitment_hash: hash('b7'), maker: MAKER_B, odds_tick: 190 });
    const h = await harness({ ...BOOK, commitments: [atOneNinety, LARGER] });
    const result = await h.prepareOrder({ ...UNDER_2, riskUsdc: 5.01 }, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: underAtTheLargerQuote(['A better price, 2.11, is posted for up to 4.50 USDC.']),
    });
  });

  it('says nothing of a better price when the best price is the one chosen', async () => {
    const h = await harness({ ...BOOK, commitments: [BETTER, LARGER] });
    // 5_000_000 asked at 2.00 fills 5_000_000, all the quote has, and pays 5_000_000.
    const result = await h.prepareOrder({ ...UNDER_2, riskUsdc: 5 }, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 5.00 USDC to win 5.00 at 2.00.',
        TOTAL_7_PUSH,
        EXPIRES,
        '',
        `Take link: https://ospex.org/take/${hash('b7')}?risk=5`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('b7')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 5',
      ),
    });
  });

  it('says nothing of a better price whose maker is known to be short of it', async () => {
    // All of the better quote is 5_000_000 of maker risk. One base unit short
    // of that and the quote is not mentioned; exactly that and it is.
    const short = await harness({
      ...BOOK,
      commitments: [BETTER, LARGER],
      maker_funding: [fundingRow(), fundingRow({ maker_address: MAKER_B, backing_wei6: '4999999' })],
    });
    expect(await short.prepareOrder({ ...UNDER_2, riskUsdc: 5.01 }, short.ctx)).toEqual({
      isError: false,
      text: underAtTheLargerQuote([]),
    });

    const covered = await harness({
      ...BOOK,
      commitments: [BETTER, LARGER],
      maker_funding: [fundingRow(), fundingRow({ maker_address: MAKER_B, backing_wei6: '5000000' })],
    });
    expect(await covered.prepareOrder({ ...UNDER_2, riskUsdc: 5.01 }, covered.ctx)).toEqual({
      isError: false,
      text: underAtTheLargerQuote(['A better price, 2.00, is posted for up to 5.00 USDC.']),
    });
  });

  it('names the best of the prices it passed over, not the last of them', async () => {
    // Two quotes are too small for 5.2 USDC, at two prices. Posted 2.02 is
    // 202/102 for the taker, shown as 1.98, for up to
    // 5_000_000 * 102 / 100 = 5.10. Posted 2.00 is the better of the two.
    const second = quoteRow({ commitment_hash: hash('b6'), maker: MAKER_B, odds_tick: 202 });
    const h = await harness({ ...BOOK, commitments: [second, BETTER, LARGER] });
    const result = await h.prepareOrder({ ...UNDER_2, riskUsdc: 5.2 }, h.ctx);
    // 5_200_000 asked at 2.05: ceil(520_000_000 / 105) = 4_952_381, down to
    // 4_952_300. floor(4_952_300 * 105 / 100) = 5_199_915.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 5.20 USDC to win 4.95 at 1.95.',
        TOTAL_7_PUSH,
        EXPIRES,
        'Exact amounts: you pay 5.199915 USDC and win 4.952300 USDC.',
        'A better price, 2.00, is posted for up to 5.00 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('b8')}?risk=5.2`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('b8')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 5.2',
      ),
    });
  });

  /** 3 USDC on the Under, taken from 50 USDC posted at 3.01. */
  function underThreeAtThreeOhOne(betterPrice: string[]): string {
    // Posted 3.01, so 201 profit ticks. 3_000_000 asked:
    // ceil(300_000_000 / 201) = 1_492_538, down to 1_492_500.
    // floor(1_492_500 * 201 / 100) = 2_999_925. The taker's price is 301/201,
    // which is 1.4975, shown as 1.50.
    return lines(
      `Under 7.0 — ${GAME}, ${STARTS}.`,
      'Risk 3.00 USDC to win 1.49 at 1.50.',
      TOTAL_7_PUSH,
      EXPIRES,
      'Exact amounts: you pay 2.999925 USDC and win 1.492500 USDC.',
      ...betterPrice,
      '',
      `Take link: https://ospex.org/take/${hash('b8')}?risk=3`,
      NOT_YET_PLACED,
      PREPARED,
      '',
      'contest_id: 481',
      `commitment_hash: ${hash('b8')}`,
      'market: total',
      'line: 7.0',
      'side: under',
      'risk_usdc: 3',
    );
  }
  const AT_THREE_OH_ONE = quoteRow({ commitment_hash: hash('b8'), odds_tick: 301, risk_amount: '50000000' });

  it('says nothing of a better price that shows as the same price at two decimals', async () => {
    // Posted 3.00 with 1 USDC: the taker's price is 300/200 = 1.50, for up to
    // 1_000_000 * 200 / 100 = 2.00. 3 USDC at 3.00 needs
    // ceil(300_000_000 / 200) = 1_500_000 of maker risk, more than it has, so
    // it is passed over for size. It is a better price than 3.01 in ticks, and
    // the same price on the page.
    const atThree = quoteRow({ commitment_hash: hash('b7'), maker: MAKER_B, odds_tick: 300, risk_amount: '1000000' });
    const h = await harness({ ...BOOK, commitments: [atThree, AT_THREE_OH_ONE] });
    expect(await h.prepareOrder({ ...UNDER_2, riskUsdc: 3 }, h.ctx)).toEqual({
      isError: false,
      text: underThreeAtThreeOhOne([]),
    });
    // It was read and weighed: both makers were looked up, it first.
    expect(requestTo(h.fake, 'maker_funding')?.params.get('maker_address')).toBe(`in.(${MAKER_B},${MAKER_A})`);
  });

  it('says a better price is posted when it shows one hundredth better', async () => {
    // Posted 2.98 with 1 USDC: the taker's price is 298/198 = 1.50505, shown
    // as 1.51, for up to 1_000_000 * 198 / 100 = 1.98. 3 USDC at 2.98 needs
    // ceil(300_000_000 / 198) = 1_515_152 of maker risk, more than it has.
    const atTwoNinetyEight = quoteRow({
      commitment_hash: hash('b7'),
      maker: MAKER_B,
      odds_tick: 298,
      risk_amount: '1000000',
    });
    const h = await harness({ ...BOOK, commitments: [atTwoNinetyEight, AT_THREE_OH_ONE] });
    expect(await h.prepareOrder({ ...UNDER_2, riskUsdc: 3 }, h.ctx)).toEqual({
      isError: false,
      text: underThreeAtThreeOhOne(['A better price, 1.51, is posted for up to 1.98 USDC.']),
    });
  });

  it('rounds the size of a better price down to the cent, so that asking for it gets that price', async () => {
    // Posted 2.00 with 4_995_300 of maker risk: the taker's price is 2.00, for
    // up to 4_995_300 * 100 / 100 = 4_995_300, which is 4.99 rounded down and
    // 5.00 rounded half up. 5.01 asked needs 5_010_000 of it.
    const offTheCent = quoteRow({ commitment_hash: hash('b7'), maker: MAKER_B, odds_tick: 200, risk_amount: '4995300' });
    const h = await harness({ ...BOOK, commitments: [offTheCent, LARGER] });
    expect(await h.prepareOrder({ ...UNDER_2, riskUsdc: 5.01 }, h.ctx)).toEqual({
      isError: false,
      text: underAtTheLargerQuote(['A better price, 2.00, is posted for up to 4.99 USDC.']),
    });

    // 4.99 asked at 2.00 fills 4_990_000 of the 4_995_300, and pays 4_990_000:
    // the better price, not cut down, and no better price left to mention.
    expect(await h.prepareOrder({ ...UNDER_2, riskUsdc: 4.99 }, h.ctx)).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 4.99 USDC to win 4.99 at 2.00.',
        TOTAL_7_PUSH,
        EXPIRES,
        '',
        `Take link: https://ospex.org/take/${hash('b7')}?risk=4.99`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('b7')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 4.99',
      ),
    });

    // 5.00, the amount rounded half up, needs 5_000_000 at 2.00 and does not
    // fit. At 2.05: ceil(500_000_000 / 105) = 4_761_905, down to 4_761_900.
    // floor(4_761_900 * 105 / 100) = 4_999_995.
    expect(await h.prepareOrder({ ...UNDER_2, riskUsdc: 5 }, h.ctx)).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 5.00 USDC to win 4.76 at 1.95.',
        TOTAL_7_PUSH,
        EXPIRES,
        'Exact amounts: you pay 4.999995 USDC and win 4.761900 USDC.',
        'A better price, 2.00, is posted for up to 4.99 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('b8')}?risk=5`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('b8')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 5',
      ),
    });
  });

  it('passes over a better price whose maker is known to be short of the fill, for the next one', async () => {
    // Both quotes can fill 2 USDC. At 2.00 the fill is 2_000_000 of maker
    // risk, and that maker is known to hold one base unit less.
    const short = await harness({
      ...BOOK,
      commitments: [BETTER, UNDER_QUOTE],
      maker_funding: [fundingRow(), fundingRow({ maker_address: MAKER_B, backing_wei6: '1999999' })],
    });
    const passedOver = await short.prepareOrder(UNDER_2, short.ctx);
    expect(passedOver).toEqual({ isError: false, text: UNDER_2_PREVIEW });
    expect(passedOver.text).not.toContain(hash('b7'));

    // Holding exactly the fill, the better price is the one prepared.
    const covered = await harness({
      ...BOOK,
      commitments: [BETTER, UNDER_QUOTE],
      maker_funding: [fundingRow(), fundingRow({ maker_address: MAKER_B, backing_wei6: '2000000' })],
    });
    const taken = await covered.prepareOrder(UNDER_2, covered.ctx);
    expect(taken).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 2.00 USDC to win 2.00 at 2.00.',
        TOTAL_7_PUSH,
        EXPIRES,
        '',
        `Take link: https://ospex.org/take/${hash('b7')}?risk=2`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('b7')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 2',
      ),
    });
    expect(taken.text).not.toContain(hash('a1'));
  });

  it('puts the better price after the reduction and before the funding line', async () => {
    // No quote fills 20 USDC. The one that takes the most of it is 10 USDC at
    // 2.05: 10_000_000 * 105 / 100 = 10_500_000, against 5_000_000 at 2.00.
    const ten = quoteRow({ commitment_hash: hash('b8'), risk_amount: '10000000' });
    const h = await harness({ ...BOOK, commitments: [BETTER, ten], maker_funding: [] });
    expect(await h.prepareOrder({ ...UNDER_2, riskUsdc: 20 }, h.ctx)).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 10.50 USDC to win 10.00 at 1.95.',
        TOTAL_7_PUSH,
        EXPIRES,
        'This quote can take 10.5 USDC, not the 20 asked for. The order is for 10.5.',
        'A better price, 2.00, is posted for up to 5.00 USDC.',
        FUNDS_NOT_CONFIRMED,
        '',
        `Take link: https://ospex.org/take/${hash('b8')}?risk=10.5`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('b8')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 10.5',
      ),
    });
  });

  // ── rows that must not be offered ────────────────────────────────────

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
    expect(result).toEqual({ isError: false, text: UNDER_2_PREVIEW });
    // The hidden row was seen, and dropped out loud.
    expect(logged(h)).toEqual({
      info: [],
      warn: [[{ commitmentHash: hash('d1') }, 'commitments: hidden row reached the open book drain — dropped']],
      error: [],
    });
  });

  // Each row below is posted at 3.00 for the taker, a better price than the
  // default quote's 1.95, so a row that was offered would be the one chosen.
  // Posted 1.50, so 50 profit ticks: 200_000_000 / 50 = 4_000_000 exactly,
  // which pays 2_000_000. The taker's price is 150/50.
  function underAtThree(byte: string): string {
    return lines(
      `Under 7.0 — ${GAME}, ${STARTS}.`,
      'Risk 2.00 USDC to win 4.00 at 3.00.',
      TOTAL_7_PUSH,
      EXPIRES,
      '',
      `Take link: https://ospex.org/take/${hash(byte)}?risk=2`,
      NOT_YET_PLACED,
      PREPARED,
      '',
      'contest_id: 481',
      `commitment_hash: ${hash(byte)}`,
      'market: total',
      'line: 7.0',
      'side: under',
      'risk_usdc: 2',
    );
  }
  const NO_UNDER_QUOTE = lines(`No quote is posted for Under 7.0 on ${GAME} right now.`, PLACED_NOTHING);

  it('drops a quote whose amount arrived as a number too large to read, and prepares against the next', async () => {
    // The database answers the amount columns as JSON numbers. 10^21 is
    // written 1e+21 on the wire and no longer reads as digits.
    const unreadable = quoteRow({ commitment_hash: hash('b9'), odds_tick: 150, risk_amount: 1e21 });
    expect(JSON.stringify(unreadable['risk_amount'])).toBe('1e+21');

    const h = await harness({ ...BOOK, commitments: [UNDER_QUOTE, unreadable] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: UNDER_2_PREVIEW });
    expect(logged(h)).toEqual({
      info: [],
      warn: [
        [
          { commitmentHash: hash('b9') },
          NOT_EXACT_WARN,
        ],
      ],
      error: [],
    });

    // By itself, it is no quote at all.
    const alone = await harness({ ...BOOK, commitments: [unreadable] });
    expect(await alone.prepareOrder(UNDER_2, alone.ctx)).toEqual({ isError: false, text: NO_UNDER_QUOTE });
    expect(alone.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
  });

  it('offers a quote whose amount arrived as a number it can read exactly', async () => {
    const readable = quoteRow({ commitment_hash: hash('b9'), odds_tick: 150, risk_amount: 5000000 });
    expect(JSON.stringify(readable['risk_amount'])).toBe('5000000');
    const h = await harness({ ...BOOK, commitments: [UNDER_QUOTE, readable] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: underAtThree('b9') });
    expect(logged(h)).toEqual(NOTHING_LOGGED);
  });

  // The other two columns that arrive as numbers. The twin of each is the
  // same row with a figure that can be read: 1 USDC of the 5 already taken
  // leaves 4_000_000, which is exactly what 2 USDC fills at a posted 1.50.
  const READABLE: Array<[string, number]> = [
    ['filled_risk_amount', 1000000],
    ['nonce', 1790000001],
  ];
  for (const [column, readableValue] of READABLE) {
    it(`drops a quote whose ${column} arrived as a number too large to read, and offers its readable twin`, async () => {
      const unreadable = quoteRow({ commitment_hash: hash('b9'), odds_tick: 150, [column]: 1e21 });
      expect(JSON.stringify(unreadable[column])).toBe('1e+21');
      const h = await harness({ ...BOOK, commitments: [UNDER_QUOTE, unreadable] });
      expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: UNDER_2_PREVIEW });
      expect(logged(h)).toEqual({
        info: [],
        warn: [
          [
            { commitmentHash: hash('b9') },
            NOT_EXACT_WARN,
          ],
        ],
        error: [],
      });

      const readable = quoteRow({ commitment_hash: hash('b9'), odds_tick: 150, [column]: readableValue });
      const twin = await harness({ ...BOOK, commitments: [UNDER_QUOTE, readable] });
      expect(await twin.prepareOrder(UNDER_2, twin.ctx)).toEqual({ isError: false, text: underAtThree('b9') });
      expect(logged(twin)).toEqual(NOTHING_LOGGED);
    });
  }

  // An amount below zero, or text that is not all digits, is dropped the same
  // way. Read as a signed number, 1 USDC taken below zero would leave 6 USDC
  // on a 5 USDC quote. The readable twin of each is offered above.
  //
  // The read refuses these: `fetchOpenBook` in `src/v1/commitments.ts` drops
  // the row, with the warning, before it is turned into a quote. The digit
  // test `takeableQuote` makes in `src/mcp/book.ts` stands behind it and is
  // not reached from here, since the mapping writes every amount it lets
  // through back out as digits. The last three are text `BigInt` reads as
  // 1_000_000, so a read that let them through would offer the quote at 3.00.
  const NOT_EXACT: Array<[string, string, number | string]> = [
    ['filled_risk_amount', 'a negative number', -1000000],
    ['filled_risk_amount', 'text that is not all digits', '-1000000'],
    ['risk_amount', 'a number with a fraction', 5000000.5],
    ['filled_risk_amount', 'text with a plus sign', '+1000000'],
    ['filled_risk_amount', 'text with a leading space', ' 1000000'],
    ['filled_risk_amount', 'text in hex', '0xf4240'],
  ];
  it('holds text that BigInt would read as 1 USDC in the last three of those', () => {
    for (const text of ['+1000000', ' 1000000', '0xf4240']) expect(BigInt(text)).toBe(1_000_000n);
  });
  for (const [column, what, value] of NOT_EXACT) {
    it(`drops a quote whose ${column} arrived as ${what}`, async () => {
      const unreadable = quoteRow({ commitment_hash: hash('b9'), odds_tick: 150, [column]: value });
      const h = await harness({ ...BOOK, commitments: [UNDER_QUOTE, unreadable] });
      expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: UNDER_2_PREVIEW });
      expect(logged(h)).toEqual({
        info: [],
        warn: [
          [
            { commitmentHash: hash('b9') },
            NOT_EXACT_WARN,
          ],
        ],
        error: [],
      });
    });
  }

  it('offers a quote whose line key is written in capitals', async () => {
    // Hex names the same number in either case, so the key is compared
    // without regard to it.
    const capitals = `0x${KEYS['c481-total-70'].slice(2).toUpperCase()}`;
    expect(capitals).not.toBe(KEYS['c481-total-70']);
    const h = await harness({
      ...BOOK,
      commitments: [UNDER_QUOTE, quoteRow({ commitment_hash: hash('c6'), odds_tick: 150, speculation_key: capitals })],
    });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: underAtThree('c6') });
  });

  it('does not offer a quote whose scorer is not an address, and still prepares from the rest', async () => {
    // One hex digit short of an address. The line key is derived from the
    // scorer, and that derivation accepts only an address.
    const short = SCORERS.total.slice(0, -1);
    expect(short).toHaveLength(41);
    const h = await harness({
      ...BOOK,
      commitments: [UNDER_QUOTE, quoteRow({ commitment_hash: hash('c7'), odds_tick: 150, scorer: short })],
    });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: UNDER_2_PREVIEW });

    // All forty digits, and it is the quote taken.
    const twin = await harness({
      ...BOOK,
      commitments: [UNDER_QUOTE, quoteRow({ commitment_hash: hash('c7'), odds_tick: 150, scorer: SCORERS.total })],
    });
    expect(await twin.prepareOrder(UNDER_2, twin.ctx)).toEqual({ isError: false, text: underAtThree('c7') });
  });

  it('does not offer a quote whose line is not a signed 32-bit whole number, and still prepares from the rest', async () => {
    // One past the widest signed 32-bit line, and a line with a fraction. The
    // line key is derived from the line, and that derivation accepts neither.
    // The readable twin is the default quote's line, 70, which is offered in
    // the cases above.
    for (const lineTicks of [2_147_483_648, 70.5]) {
      const h = await harness({
        ...BOOK,
        commitments: [UNDER_QUOTE, quoteRow({ commitment_hash: hash('c8'), odds_tick: 150, line_ticks: lineTicks })],
      });
      expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: UNDER_2_PREVIEW });
    }
  });

  it('does not offer a quote whose signature is not 65 bytes', async () => {
    // One byte short. The taker's transaction carries the signature as it is.
    const short = `0x${'5a'.repeat(64)}`;
    const h = await harness({
      ...BOOK,
      commitments: [UNDER_QUOTE, quoteRow({ commitment_hash: hash('c9'), odds_tick: 150, signature: short })],
    });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: UNDER_2_PREVIEW });

    // All 65 bytes, and it is the quote taken.
    const twin = await harness({
      ...BOOK,
      commitments: [UNDER_QUOTE, quoteRow({ commitment_hash: hash('c9'), odds_tick: 150 })],
    });
    expect(await twin.prepareOrder(UNDER_2, twin.ctx)).toEqual({ isError: false, text: underAtThree('c9') });
  });

  it('offers a quote with funds not confirmed when its maker\'s snapshot cannot be read as a number', async () => {
    const unreadable = fundingRow({ visible_committed_wei6: 1e21 });
    expect(JSON.stringify(unreadable['visible_committed_wei6'])).toBe('1e+21');
    const h = await harness({ ...BOOK, maker_funding: [unreadable] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments', 'maker_funding']);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 2.00 USDC to win 1.90 at 1.95.',
        TOTAL_7_PUSH,
        EXPIRES,
        'Exact amounts: you pay 1.999935 USDC and win 1.904700 USDC.',
        FUNDS_NOT_CONFIRMED,
        '',
        `Take link: https://ospex.org/take/${hash('a1')}?risk=2`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a1')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 2',
      ),
    });
    expect(logged(h)).toEqual({
      info: [],
      warn: [],
      error: [
        [
          { err: 'Cannot convert 1e+21 to a BigInt' },
          'commitments: maker_funding snapshot could not be read — funding unknown',
        ],
      ],
    });

    // The same snapshot with a figure that can be read confirms the funds.
    const readable = await harness({ ...BOOK, maker_funding: [fundingRow({ visible_committed_wei6: 10000000 })] });
    expect(await readable.prepareOrder(UNDER_2, readable.ctx)).toEqual({ isError: false, text: UNDER_2_PREVIEW });
    expect(logged(readable)).toEqual(NOTHING_LOGGED);
  });

  it('does not offer a quote filed under one line and signed for another', async () => {
    // Signed for 7.5 and filed under the key of 7.0. Both lines are on-chain,
    // so either could have taken it in.
    const total75 = speculationRow({ speculation_id: 1005, line_ticks: 75 });
    const misfiled = quoteRow({
      commitment_hash: hash('c1'),
      odds_tick: 150,
      line_ticks: 75,
      speculation_key: KEYS['c481-total-70'],
    });
    const h = await harness({ ...BOOK, speculations: [TOTAL_7, total75], commitments: [misfiled] });
    expect(await h.prepareOrder({ ...UNDER_2, line: 7 }, h.ctx)).toEqual({ isError: false, text: NO_UNDER_QUOTE });
    expect(await h.prepareOrder({ ...UNDER_2, line: 7.5 }, h.ctx)).toEqual({
      isError: false,
      text: lines(`No quote is posted for Under 7.5 on ${GAME} right now.`, PLACED_NOTHING),
    });

    // Signed for 7.0 and filed under 7.0, the same quote is offered.
    const filed = quoteRow({ commitment_hash: hash('c1'), odds_tick: 150 });
    const twin = await harness({ ...BOOK, speculations: [TOTAL_7, total75], commitments: [filed] });
    expect(await twin.prepareOrder({ ...UNDER_2, line: 7 }, twin.ctx)).toEqual({
      isError: false,
      text: underAtThree('c1'),
    });
  });

  it('does not offer a quote filed under a line\'s key and signed by another scorer', async () => {
    // Filed under the key of total 7.0 and signed by the moneyline scorer, or
    // the spread one, on the same contest and line value. The key it was
    // signed for is not the key it is filed under.
    for (const scorer of [SCORERS.moneyline, SCORERS.spread]) {
      const misfiled = quoteRow({ commitment_hash: hash('c1'), odds_tick: 150, scorer });
      const h = await harness({ ...BOOK, commitments: [misfiled] });
      expect(await h.prepareOrder({ ...UNDER_2, line: 7 }, h.ctx)).toEqual({ isError: false, text: NO_UNDER_QUOTE });
      // Nothing was offered, so no maker was looked up.
      expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
    }

    // Signed by the total's scorer, the same quote is offered.
    const filed = quoteRow({ commitment_hash: hash('c1'), odds_tick: 150, scorer: SCORERS.total });
    const twin = await harness({ ...BOOK, commitments: [filed] });
    expect(await twin.prepareOrder({ ...UNDER_2, line: 7 }, twin.ctx)).toEqual({
      isError: false,
      text: underAtThree('c1'),
    });
  });

  it('does not offer a quote signed by another scorer beside one that can be taken', async () => {
    // Posted at 3.00 for the taker, better than the default quote's 1.95, so
    // it would be the one chosen if it were offered.
    const misfiled = quoteRow({ commitment_hash: hash('c1'), odds_tick: 150, scorer: SCORERS.moneyline });
    const h = await harness({ ...BOOK, commitments: [UNDER_QUOTE, misfiled] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: UNDER_2_PREVIEW });
    expect(logged(h)).toEqual(NOTHING_LOGGED);
  });

  it('does not offer a quote signed for an amount that is not a whole number of lots', async () => {
    // 5_000_050 leaves 5_000_000 in whole lots, which would fill the order.
    const offGrid = quoteRow({ commitment_hash: hash('c2'), odds_tick: 150, risk_amount: '5000050' });
    const h = await harness({ ...BOOK, commitments: [offGrid] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: NO_UNDER_QUOTE });

    const onGrid = quoteRow({ commitment_hash: hash('c2'), odds_tick: 150, risk_amount: '5000100' });
    const twin = await harness({ ...BOOK, commitments: [onGrid] });
    expect(await twin.prepareOrder(UNDER_2, twin.ctx)).toEqual({ isError: false, text: underAtThree('c2') });
  });

  it('does not offer a quote with less than one whole lot of maker risk left', async () => {
    // 5_000_000 signed and 4_999_950 taken leaves 50, under the lot of 100.
    // Nothing is offered, so no maker is looked up.
    const underALot = quoteRow({
      commitment_hash: hash('c5'),
      filled_risk_amount: '4999950',
      status: 'partially_filled',
    });
    const h = await harness({ ...BOOK, commitments: [underALot] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: NO_UNDER_QUOTE });
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);

    // 4_999_900 taken leaves exactly one lot. At 2.05 that takes
    // 100 * 105 / 100 = 105 base units, which fills the lot and pays 105.
    const oneLot = quoteRow({ commitment_hash: hash('c5'), filled_risk_amount: '4999900', status: 'partially_filled' });
    const twin = await harness({ ...BOOK, commitments: [oneLot] });
    expect(await twin.prepareOrder(UNDER_2, twin.ctx)).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 0.00 USDC to win 0.00 at 1.95.',
        TOTAL_7_PUSH,
        EXPIRES,
        'Exact amounts: you pay 0.000105 USDC and win 0.000100 USDC.',
        'This quote can take 0.000105 USDC, not the 2 asked for. The order is for 0.000105.',
        '',
        `Take link: https://ospex.org/take/${hash('c5')}?risk=0.000105`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('c5')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 0.000105',
      ),
    });
  });

  it('does not offer a quote whose hash is not a hash', async () => {
    // The hash is written into the link as it is, so only text with the
    // shape of a hash is offered.
    const notAHash = 'example.invalid/x?y=1#';
    const h = await harness({
      ...BOOK,
      commitments: [quoteRow({ commitment_hash: notAHash, odds_tick: 150 })],
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result).toEqual({ isError: false, text: NO_UNDER_QUOTE });

    // Beside a quote that can be taken, it is passed over without a trace.
    const beside = await harness({
      ...BOOK,
      commitments: [UNDER_QUOTE, quoteRow({ commitment_hash: notAHash, odds_tick: 150 })],
    });
    expect(await beside.prepareOrder(UNDER_2, beside.ctx)).toEqual({ isError: false, text: UNDER_2_PREVIEW });

    // One character short of a hash is not one either; all 64 is.
    const short = await harness({
      ...BOOK,
      commitments: [quoteRow({ commitment_hash: hash('c3').slice(0, -1), odds_tick: 150 })],
    });
    expect(await short.prepareOrder(UNDER_2, short.ctx)).toEqual({ isError: false, text: NO_UNDER_QUOTE });
    const twin = await harness({
      ...BOOK,
      commitments: [quoteRow({ commitment_hash: hash('c3'), odds_tick: 150 })],
    });
    expect(await twin.prepareOrder(UNDER_2, twin.ctx)).toEqual({ isError: false, text: underAtThree('c3') });
  });

  it('does not offer a quote whose maker side is not written as upper or lower', async () => {
    // A maker side that cannot be read is no side at all. Read loosely it
    // would count as not-upper and put the reader on the Over, so the Over is
    // what is asked for here.
    const over = { ...UNDER_2, side: 'over' };
    const unread = quoteRow({ commitment_hash: hash('c4'), odds_tick: 150, position_type: 'UPPER' });
    const h = await harness({ ...BOOK, commitments: [unread] });
    expect(await h.prepareOrder(over, h.ctx)).toEqual({
      isError: false,
      text: lines(`No quote is posted for Over 7.0 on ${GAME} right now.`, PLACED_NOTHING),
    });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: NO_UNDER_QUOTE });

    // Written lower, the maker holds the Under and the reader takes the Over.
    // Posted 1.50: 2_000_000 asked fills 4_000_000 and pays 2_000_000.
    const lower = quoteRow({ commitment_hash: hash('c4'), odds_tick: 150, position_type: 'lower' });
    const twin = await harness({ ...BOOK, commitments: [lower] });
    expect(await twin.prepareOrder(over, twin.ctx)).toEqual({
      isError: false,
      text: lines(
        `Over 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 2.00 USDC to win 4.00 at 3.00.',
        TOTAL_7_PUSH,
        EXPIRES,
        '',
        `Take link: https://ospex.org/take/${hash('c4')}?risk=2`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('c4')}`,
        'market: total',
        'line: 7.0',
        'side: over',
        'risk_usdc: 2',
      ),
    });
  });

  it('does not offer a quote with two minutes or less to run', async () => {
    const closing = quoteRow({ expiry: '2026-09-27T12:01:59+00:00' });
    const h = await harness({ ...BOOK, commitments: [closing] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: NO_UNDER_QUOTE });

    const exactly = quoteRow({ expiry: '2026-09-27T12:02:00+00:00' });
    const atTheMargin = await harness({ ...BOOK, commitments: [exactly] });
    expect(await atTheMargin.prepareOrder(UNDER_2, atTheMargin.ctx)).toEqual({
      isError: false,
      text: NO_UNDER_QUOTE,
    });
    // The read returned it: the book was opened and the row was in it.
    expect(atTheMargin.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
  });

  it('offers a quote with one microsecond more than two minutes to run', async () => {
    const open = quoteRow({ expiry: '2026-09-27T12:02:00.000001+00:00' });
    const h = await harness({ ...BOOK, commitments: [open] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 2.00 USDC to win 1.90 at 1.95.',
        TOTAL_7_PUSH,
        'Quote expires Sun Sep 27, 8:02 am ET.',
        'Exact amounts: you pay 1.999935 USDC and win 1.904700 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('a1')}?risk=2`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a1')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 2',
      ),
    });
  });

  // ── when the quote expires ───────────────────────────────────────────

  it('gives the start as the deadline when the quote expires after it', async () => {
    // One microsecond after first pitch.
    const late = quoteRow({ expiry: '2026-09-27T19:05:00.000001+00:00' });
    const h = await harness({ ...BOOK, commitments: [late] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 2.00 USDC to win 1.90 at 1.95.',
        TOTAL_7_PUSH,
        'Take it before the game starts, Sun Sep 27, 3:05 pm ET. The quote itself expires later than that.',
        'Exact amounts: you pay 1.999935 USDC and win 1.904700 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('a1')}?risk=2`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a1')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 2',
      ),
    });
  });

  it('gives the expiry as the deadline when the quote expires at the start', async () => {
    const atStart = quoteRow({ expiry: '2026-09-27T19:05:00+00:00' });
    const h = await harness({ ...BOOK, commitments: [atStart] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.isError).toBe(false);
    expect(result.text.split('\n').slice(0, 5)).toEqual([
      `Under 7.0 — ${GAME}, ${STARTS}.`,
      'Risk 2.00 USDC to win 1.90 at 1.95.',
      TOTAL_7_PUSH,
      'Quote expires Sun Sep 27, 3:05 pm ET.',
      'Exact amounts: you pay 1.999935 USDC and win 1.904700 USDC.',
    ]);
  });

  // ── the maker's funds ────────────────────────────────────────────────

  it('says funding was not confirmed when nothing is known about the maker', async () => {
    const h = await harness({ ...BOOK, maker_funding: [] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`commitment_hash: ${hash('a1')}`);
    expect(result.text).toContain(FUNDS_NOT_CONFIRMED);
  });

  it('says funding was not confirmed when the snapshot is older than two minutes', async () => {
    const h = await harness({
      ...BOOK,
      maker_funding: [fundingRow({ updated_at: '2026-09-27T11:57:59+00:00' })],
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(FUNDS_NOT_CONFIRMED);
  });

  it('does not pass over a quote on a snapshot too old to act on, even one that shows its maker short', async () => {
    // One millisecond past two minutes old, and showing no funds at all. Old
    // is not known: the quote is offered and the funds are not confirmed.
    const h = await harness({
      ...BOOK,
      maker_funding: [fundingRow({ updated_at: '2026-09-27T11:57:59.999+00:00', backing_wei6: '0' })],
    });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 2.00 USDC to win 1.90 at 1.95.',
        TOTAL_7_PUSH,
        EXPIRES,
        'Exact amounts: you pay 1.999935 USDC and win 1.904700 USDC.',
        FUNDS_NOT_CONFIRMED,
        '',
        `Take link: https://ospex.org/take/${hash('a1')}?risk=2`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a1')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 2',
      ),
    });
  });

  it('says nothing about funding when a fresh snapshot covers the fill', async () => {
    const h = await harness({
      ...BOOK,
      // Exactly two minutes old, and exactly the fill.
      maker_funding: [fundingRow({ updated_at: '2026-09-27T11:58:00+00:00', backing_wei6: '1904700' })],
    });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: UNDER_2_PREVIEW });
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

  // ── how many makers' funds are read ──────────────────────────────────
  //
  // One maker to a quote, each posting 5 USDC on the Over of total 7.0. Maker
  // `index` posts at 1.50 + index/100, so maker 0 is the best price and maker
  // 100 the worst. The hashes run the other way, so the book is read worst
  // price first: a cut taken in the order the rows arrive keeps the worst
  // makers, not the best. Every maker has a fresh snapshot showing no funds.

  const makerAt = (index: number): string => `0x${'d'.repeat(36)}${index.toString(16).padStart(4, '0')}`;
  const byMaker = (index: number, hashIndex: number): Row =>
    quoteRow({ commitment_hash: nth(hashIndex), maker: makerAt(index), odds_tick: 150 + index });
  const brokeMakers = (count: number): Row[] =>
    Array.from({ length: count }, (_, index) => fundingRow({ maker_address: makerAt(index), backing_wei6: '0' }));
  const makerList = (from: number, to: number): string =>
    `in.(${Array.from({ length: to - from + 1 }, (_, offset) => makerAt(from + offset)).join(',')})`;

  // 2 USDC against maker 100's quote, posted 2.50, so 150 profit ticks:
  // ceil(200_000_000 / 150) = 1_333_334, down to 1_333_300.
  // floor(1_333_300 * 150 / 100) = 1_999_950, which is 2.00 half up. The win,
  // 1.3333, is 1.33 rounded down. The taker's price is 250/150, shown as 1.67.
  const PAST_THE_CUT = lines(
    `Under 7.0 — ${GAME}, ${STARTS}.`,
    'Risk 2.00 USDC to win 1.33 at 1.67.',
    TOTAL_7_PUSH,
    EXPIRES,
    'Exact amounts: you pay 1.999950 USDC and win 1.333300 USDC.',
    FUNDS_NOT_CONFIRMED,
    '',
    `Take link: https://ospex.org/take/${nth(1)}?risk=2`,
    NOT_YET_PLACED,
    PREPARED,
    '',
    'contest_id: 481',
    `commitment_hash: ${nth(1)}`,
    'market: total',
    'line: 7.0',
    'side: under',
    'risk_usdc: 2',
  );
  // Measured on Windows 11, Node 22: the first case below took 131 to 148 ms
  // with the file run by itself and 164 ms inside the whole suite; the second
  // 57 to 71 ms. 10 seconds is over sixty times the slowest of those.
  const FUNDING_CUT_TIMEOUT = 10_000;
  const ALL_SHORT = lines(
    'A quote is posted for Under 7.0, but its maker does not have the funds behind it right now.',
    PLACED_NOTHING,
  );

  it(
    'reads the funds of the 100 best-priced makers, and offers a quote past them with its funds not confirmed',
    async () => {
      // Maker `index` has hash 101 - index: maker 100 is read first.
      const quotes = Array.from({ length: 101 }, (_, index) => byMaker(index, 101 - index));
      const h = await harness({ ...BOOK, commitments: quotes, maker_funding: brokeMakers(101) });
      const { MAX_FUNDING_MAKERS } = await import('../src/mcp/tools/prepareOrder.js');
      expect(MAX_FUNDING_MAKERS).toBe(100);
      expect(new Set(quotes.map((quote) => quote['maker'])).size).toBe(101);

      // Makers 0 to 99 are known to be short; maker 100's snapshot, which
      // shows it short too, is not read, so its quote is offered.
      expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: PAST_THE_CUT });
      expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments', 'maker_funding']);
      expect(requestTo(h.fake, 'maker_funding')?.params.get('maker_address')).toBe(makerList(0, 99));
      expect(requestTo(h.fake, 'maker_funding')?.params.get('maker_address')).not.toContain(makerAt(100));

      // Without maker 0 the same 100 quotes fit under the cut, maker 100's
      // snapshot is read, and every quote is known to be short.
      const within = await harness({ ...BOOK, commitments: quotes.slice(1), maker_funding: brokeMakers(101) });
      expect(await within.prepareOrder(UNDER_2, within.ctx)).toEqual({ isError: false, text: ALL_SHORT });
      expect(requestTo(within.fake, 'maker_funding')?.params.get('maker_address')).toBe(makerList(1, 100));
    },
    FUNDING_CUT_TIMEOUT,
  );

  it(
    'counts makers, not quotes, toward the 100 whose funds are read',
    async () => {
      // Maker 0 posts a second quote at its own price, so 102 quotes come from
      // 101 makers. The 100 best-priced quotes hold only 99 makers.
      const quotes = [
        ...Array.from({ length: 101 }, (_, index) => byMaker(index, 101 - index)),
        byMaker(0, 200),
      ];
      const h = await harness({ ...BOOK, commitments: quotes, maker_funding: brokeMakers(101) });
      expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: PAST_THE_CUT });
      expect(requestTo(h.fake, 'maker_funding')?.params.get('maker_address')).toBe(makerList(0, 99));
    },
    FUNDING_CUT_TIMEOUT,
  );

  // ── the link ─────────────────────────────────────────────────────────

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

  it('prepares nothing on a game that has started: a start equal to now has started', async () => {
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ effective_start_time: '2026-09-27T12:00:00+00:00' })],
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    // The start is written to the minute; only the preparing time has seconds.
    expect(result).toEqual({
      isError: false,
      text: lines(`${GAME} started Sun Sep 27, 8:00 am ET. No order is prepared on a game under way.`, PLACED_NOTHING),
    });
    // The contract fills a take after the start, so nothing may say Ospex takes no bets then.
    expect(result.text).not.toContain(OLD_UNDER_WAY);
    // Decided from the contest alone.
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations']);
  });

  it('prepares nothing on a game that started one microsecond ago', async () => {
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ effective_start_time: '2026-09-27T11:59:59.999999+00:00' })],
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(`${GAME} started Sun Sep 27, 7:59 am ET. No order is prepared on a game under way.`, PLACED_NOTHING),
    });
    expect(result.text).not.toContain(OLD_UNDER_WAY);
  });

  it('says a game one microsecond from its start is too close to it, not under way', async () => {
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ effective_start_time: '2026-09-27T12:00:00.000001+00:00' })],
    });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(
        `${GAME} starts Sun Sep 27, 8:00 am ET, less than two minutes from now. That is too close to the start to prepare an order.`,
        PLACED_NOTHING,
      ),
    });
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations']);
  });

  it('refuses a game that starts exactly two minutes from now', async () => {
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ effective_start_time: '2026-09-27T12:02:00+00:00' })],
    });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(
        `${GAME} starts Sun Sep 27, 8:02 am ET, less than two minutes from now. That is too close to the start to prepare an order.`,
        PLACED_NOTHING,
      ),
    });
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations']);
  });

  it('takes a game that starts one microsecond more than two minutes from now', async () => {
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ effective_start_time: '2026-09-27T12:02:00.000001+00:00' })],
    });
    // The quote runs until 2:55 pm, long after this start.
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, Sun Sep 27, 8:02 am ET.`,
        'Risk 2.00 USDC to win 1.90 at 1.95.',
        TOTAL_7_PUSH,
        'Take it before the game starts, Sun Sep 27, 8:02 am ET. The quote itself expires later than that.',
        'Exact amounts: you pay 1.999935 USDC and win 1.904700 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('a1')}?risk=2`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a1')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 2',
      ),
    });
  });

  it('gates on the conservative start, not the start written on-chain', async () => {
    // The chain still says 3:05 pm. The game was moved up and is under way.
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ start_time: EXPIRY, effective_start_time: '2026-09-27T11:05:00+00:00' })],
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(`${GAME} started Sun Sep 27, 7:05 am ET. No order is prepared on a game under way.`, PLACED_NOTHING),
    });
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

  it('refuses a contest with no status, and says its state is unknown', async () => {
    const h = await harness({ ...BOOK, contests_effective: [contestRow({ contest_status: null })] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} is not open for betting: its contest is in an unknown state.`, PLACED_NOTHING),
    });
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations']);
  });

  it('refuses a verified contest with no start written on-chain, and says that is why', async () => {
    // The conservative start is still 3:05 pm, so every later check would pass.
    const h = await harness({ ...BOOK, contests_effective: [contestRow({ start_time: null })] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} is not open for betting: its contest has no start time on-chain.`, PLACED_NOTHING),
    });
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations']);
    expect(logged(h)).toEqual(NOTHING_LOGGED);

    // The same contest with its start on-chain is prepared.
    const twin = await harness({ ...BOOK, contests_effective: [contestRow({ start_time: START })] });
    expect(await twin.prepareOrder(UNDER_2, twin.ctx)).toEqual({ isError: false, text: UNDER_2_PREVIEW });
  });

  it('names the status of a scored contest that has no start written on-chain', async () => {
    const h = await harness({ ...BOOK, contests_effective: [contestRow({ start_time: null, contest_status: 'scored' })] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} is not open for betting: its contest is scored.`, PLACED_NOTHING),
    });
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations']);
  });

  it('says a contest does not exist', async () => {
    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, contestId: '999' }, h.ctx)).toEqual({
      isError: true,
      text: lines('There is no contest 999 on Ospex.', PLACED_NOTHING),
    });
  });

  it('names a contest that does not exist as the number it is, not as it was written', async () => {
    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, contestId: ' 0999 ' }, h.ctx)).toEqual({
      isError: true,
      text: lines('There is no contest 999 on Ospex.', PLACED_NOTHING),
    });
    expect(requestTo(h.fake, 'contests_effective')?.params.get('contest_id')).toBe('eq.999');
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
        text: lines(BAD_CONTEST_ID, PLACED_NOTHING),
      });
    }
    expect(h.fake.requests).toHaveLength(0);
  });

  it('refuses a contest id larger than the database can hold, before reading anything', async () => {
    const h = await harness(BOOK);
    // One past the largest 64-bit id, and the largest number twenty digits write.
    for (const contestId of ['9223372036854775808', '99999999999999999999']) {
      expect(await h.prepareOrder({ ...UNDER_2, contestId }, h.ctx)).toEqual({
        isError: true,
        text: lines(BAD_CONTEST_ID, PLACED_NOTHING),
      });
    }
    expect(h.fake.requests).toHaveLength(0);
    expect(logged(h)).toEqual(NOTHING_LOGGED);
  });

  it('reads the largest id the database can hold, and says there is no such contest', async () => {
    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, contestId: '9223372036854775807' }, h.ctx)).toEqual({
      isError: true,
      text: lines('There is no contest 9223372036854775807 on Ospex.', PLACED_NOTHING),
    });
    expect(h.fake.tables()).toEqual(['contests_effective']);
    expect(requestTo(h.fake, 'contests_effective')?.params.get('contest_id')).toBe('eq.9223372036854775807');
    expect(logged(h)).toEqual(NOTHING_LOGGED);
  });

  it('reads a contest id of twenty digits, leading zeros and all, and refuses one of twenty-one', async () => {
    const twenty = '00000000000000000481';
    const twentyOne = '000000000000000000481';
    expect([twenty.length, twentyOne.length]).toEqual([20, 21]);

    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, contestId: twenty }, h.ctx)).toEqual({
      isError: false,
      text: UNDER_2_PREVIEW,
    });

    const refused = await harness(BOOK);
    expect(await refused.prepareOrder({ ...UNDER_2, contestId: twentyOne }, refused.ctx)).toEqual({
      isError: true,
      text: lines(BAD_CONTEST_ID, PLACED_NOTHING),
    });
    expect(refused.fake.requests).toHaveLength(0);
  });

  // ── the side ─────────────────────────────────────────────────────────

  it('says what the sides of the market are when the side is not one of them', async () => {
    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, side: 'Phillies' }, h.ctx)).toEqual({
      isError: true,
      text: lines(TOTAL_SIDES, PLACED_NOTHING),
    });
    expect(await h.prepareOrder({ ...MONEYLINE_3, side: 'under' }, h.ctx)).toEqual({
      isError: true,
      text: lines(
        `Over and under are sides of a total. For a moneyline, side is a team. ${EITHER_TEAM}`,
        PLACED_NOTHING,
      ),
    });
    expect(
      await h.prepareOrder({ contestId: '481', market: 'spread', side: 'over', riskUsdc: 2, line: -1.5 }, h.ctx),
    ).toEqual({
      isError: true,
      text: lines(
        `Over and under are sides of a total. For a spread, side is a team. ${EITHER_TEAM}`,
        PLACED_NOTHING,
      ),
    });
    expect(await h.prepareOrder({ ...MONEYLINE_3, side: 'Yankees' }, h.ctx)).toEqual({
      isError: true,
      text: lines(SIDE_NOT_READ, PLACED_NOTHING),
    });
    // A side is settled before the book is opened.
    expect(h.fake.tables()).not.toContain('commitments');
  });

  // What the sentences above tell a caller to pass, the tool takes. The two
  // moneyline quotes differ in hash and in team, so a form read as the wrong
  // side shows both.
  const TAKEN: Array<[string, PrepareOrderArgs['market'], string, string[]]> = [
    ['away', 'moneyline', 'a4', ['side: away', 'team: Tampa Bay Rays']],
    ['home', 'moneyline', 'a3', ['side: home', 'team: Philadelphia Phillies']],
    ['Tampa Bay Rays', 'moneyline', 'a4', ['side: away', 'team: Tampa Bay Rays']],
    ['Philadelphia Phillies', 'moneyline', 'a3', ['side: home', 'team: Philadelphia Phillies']],
    ['over', 'total', 'a2', ['line: 7.0', 'side: over']],
    ['under', 'total', 'a1', ['line: 7.0', 'side: under']],
    // A leading "the" is dropped, and nothing else is.
    ['the under', 'total', 'a1', ['line: 7.0', 'side: under']],
    ['the Phillies', 'moneyline', 'a3', ['side: home', 'team: Philadelphia Phillies']],
  ];
  for (const [side, market, byte, block] of TAKEN) {
    it(`takes "${side}" as a side of a ${market}`, async () => {
      const h = await harness(BOOK);
      const result = await h.prepareOrder({ contestId: '481', market, side, riskUsdc: 1, line: undefined }, h.ctx);
      expect(result.isError).toBe(false);
      // The identifier block: everything after the second blank line.
      expect(result.text.split('\n\n')[2]?.split('\n')).toEqual([
        'contest_id: 481',
        `commitment_hash: ${hash(byte)}`,
        `market: ${market}`,
        ...block,
        'risk_usdc: 1',
      ]);
    });
  }

  it('takes away and home as sides of a spread', async () => {
    // The fixture posts no quote on its spread, so the answer names what was
    // backed and says nothing is posted for it.
    const h = await harness(BOOK);
    expect(
      await h.prepareOrder({ contestId: '481', market: 'spread', side: 'away', riskUsdc: 1, line: undefined }, h.ctx),
    ).toEqual({
      isError: false,
      text: lines(`No quote is posted for Tampa Bay Rays (away) -1.5 on ${GAME} right now.`, PLACED_NOTHING),
    });
    expect(
      await h.prepareOrder({ contestId: '481', market: 'spread', side: 'home', riskUsdc: 1, line: undefined }, h.ctx),
    ).toEqual({
      isError: false,
      text: lines(`No quote is posted for Philadelphia Phillies (home) +1.5 on ${GAME} right now.`, PLACED_NOTHING),
    });
  });

  // Forms a caller copies out of a listing or a preview. Each carries more
  // than a side, and none is taken.
  const REFUSED: Array<[string, PrepareOrderArgs['market'], string]> = [
    ['Philadelphia Phillies (home)', 'moneyline', SIDE_NOT_READ],
    ['Philadelphia Phillies (home) to win', 'moneyline', SIDE_NOT_READ],
    ['home team', 'moneyline', SIDE_NOT_READ],
    // Part of a word of a name is not the name.
    ['Phil', 'moneyline', SIDE_NOT_READ],
    ['Phillies -1.5', 'spread', SIDE_NOT_READ],
    ['Philadelphia Phillies (home) +1.5', 'spread', SIDE_NOT_READ],
    ['Under 7.0', 'total', TOTAL_SIDES],
  ];
  for (const [side, market, problem] of REFUSED) {
    it(`refuses "${side}" as a side of a ${market}`, async () => {
      const h = await harness(BOOK);
      expect(
        await h.prepareOrder({ contestId: '481', market, side, riskUsdc: 1, line: undefined }, h.ctx),
      ).toEqual({ isError: true, text: lines(problem, PLACED_NOTHING) });
      expect(h.fake.tables()).toEqual(['contests_effective', 'speculations']);
    });
  }

  it('refuses a name both teams answer to, and takes what it then asks for', async () => {
    const mets = quoteRow({
      commitment_hash: hash('e1'),
      scorer: SCORERS.moneyline,
      market_type: 'moneyline',
      line_ticks: 0,
      position_type: 'lower',
      odds_tick: 200,
      speculation_key: KEYS['c481-moneyline'],
    });
    const yankees = quoteRow({
      commitment_hash: hash('e2'),
      scorer: SCORERS.moneyline,
      market_type: 'moneyline',
      line_ticks: 0,
      position_type: 'upper',
      odds_tick: 200,
      speculation_key: KEYS['c481-moneyline'],
    });
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ away_team: 'New York Mets', home_team: 'New York Yankees' })],
      commitments: [mets, yankees],
    });
    expect(await h.prepareOrder({ ...MONEYLINE_3, side: 'New York' }, h.ctx)).toEqual({
      isError: true,
      text: lines(
        'That name fits both teams. Pass away for New York Mets, or home for New York Yankees.',
        PLACED_NOTHING,
      ),
    });

    const away = await h.prepareOrder({ ...MONEYLINE_3, side: 'away' }, h.ctx);
    expect(away.isError).toBe(false);
    expect(away.text.split('\n')[0]).toBe(
      'New York Mets (away) to win — New York Mets @ New York Yankees, Sun Sep 27, 3:05 pm ET.',
    );
    expect(away.text.split('\n\n')[2]?.split('\n')).toEqual([
      'contest_id: 481',
      `commitment_hash: ${hash('e1')}`,
      'market: moneyline',
      'side: away',
      'team: New York Mets',
      'risk_usdc: 3',
    ]);

    const home = await h.prepareOrder({ ...MONEYLINE_3, side: 'home' }, h.ctx);
    expect(home.isError).toBe(false);
    expect(home.text.split('\n\n')[2]?.split('\n')).toEqual([
      'contest_id: 481',
      `commitment_hash: ${hash('e2')}`,
      'market: moneyline',
      'side: home',
      'team: New York Yankees',
      'risk_usdc: 3',
    ]);
  });

  // ── the line ─────────────────────────────────────────────────────────

  it('says the market has no line when it has none', async () => {
    const h = await harness({ ...BOOK, speculations: [MONEYLINE] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} has no total line on-chain yet.`, PLACED_NOTHING),
    });
  });

  it('does not count a settled line as a line, whatever is posted on it', async () => {
    const settled = speculationRow({ speculation_status: 'closed' });
    const h = await harness({ ...BOOK, speculations: [MONEYLINE, settled] });
    // The default quote is still in the book, under this line's key.
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} has no total line on-chain yet.`, PLACED_NOTHING),
    });
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
  });

  // A line whose outcome is written is over, whatever its status column says.
  // Each row below keeps the status open and sets one of the two outcome
  // columns, so only the check of that column can leave it out.
  const DECIDED: Array<[string, Row]> = [
    ['a winning side', { speculation_status: 'open', win_side: 'under', voided: false }],
    ['a void', { speculation_status: 'open', win_side: 'tbd', voided: true }],
  ];
  for (const [what, outcome] of DECIDED) {
    it(`does not count a line that reads open and has ${what} written as a line`, async () => {
      const decided = speculationRow(outcome);
      const h = await harness({ ...BOOK, speculations: [MONEYLINE, decided] });
      // The default quote is still in the book, under this line's key.
      expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
        isError: false,
        text: lines(`${GAME} has no total line on-chain yet.`, PLACED_NOTHING),
      });
      expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);

      // Beside an open 7.5, asking for 7.0 names only the open line.
      const total75 = speculationRow({ speculation_id: 1005, line_ticks: 75 });
      const beside = await harness({ ...BOOK, speculations: [decided, total75] });
      expect(await beside.prepareOrder({ ...UNDER_2, line: 7 }, beside.ctx)).toEqual({
        isError: false,
        text: lines(`${GAME} has no total line at 7.0. Lines on-chain: 7.5.`, PLACED_NOTHING),
      });

      // Its open twin is a line, and the default quote on it is prepared.
      const twin = await harness({ ...BOOK, speculations: [MONEYLINE, speculationRow()] });
      expect(await twin.prepareOrder(UNDER_2, twin.ctx)).toEqual({ isError: false, text: UNDER_2_PREVIEW });
    });
  }

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
    // Lines are held lowest first. The quote is on the HIGHER of the two, so
    // taking the first line instead of the quoted one finds nothing posted.
    const total75 = speculationRow({ speculation_id: 1005, line_ticks: 75 });
    const under75 = quoteRow({
      commitment_hash: hash('b5'),
      line_ticks: 75,
      odds_tick: 190,
      speculation_key: KEYS['c481-total-75'],
    });
    const h = await harness({ ...BOOK, speculations: [TOTAL_7, total75], commitments: [under75] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    // Posted 1.90, so 90 profit ticks. 2_000_000 asked:
    // ceil(200_000_000 / 90) = 2_222_223, down to 2_222_200.
    // floor(2_222_200 * 90 / 100) = 1_999_980. The taker's price is 190/90, shown as 2.11.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Under 7.5 — ${GAME}, ${STARTS}.`,
        'Risk 2.00 USDC to win 2.22 at 2.11.',
        EXPIRES,
        'Exact amounts: you pay 1.999980 USDC and win 2.222200 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('b5')}?risk=2`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('b5')}`,
        'market: total',
        'line: 7.5',
        'side: under',
        'risk_usdc: 2',
      ),
    });
  });

  it('names the lowest line when two lines exist and neither has a quote', async () => {
    const total75 = speculationRow({ speculation_id: 1005, line_ticks: 75 });
    const h = await harness({ ...BOOK, speculations: [total75, TOTAL_7], commitments: [] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: NO_UNDER_QUOTE });
  });

  it('says which lines exist when the one named does not', async () => {
    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, line: 8.5 }, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} has no total line at 8.5. Lines on-chain: 7.0.`, PLACED_NOTHING),
    });
  });

  it('names every line on-chain, lowest first, when the one named is not one of them', async () => {
    const total75 = speculationRow({ speculation_id: 1005, line_ticks: 75 });
    const h = await harness({ ...BOOK, speculations: [total75, TOTAL_7] });
    expect(await h.prepareOrder({ ...UNDER_2, line: 8.5 }, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} has no total line at 8.5. Lines on-chain: 7.0, 7.5.`, PLACED_NOTHING),
    });
  });

  it('reads a total named with a minus sign as the same line', async () => {
    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, line: -7 }, h.ctx)).toEqual({
      isError: false,
      text: UNDER_2_PREVIEW,
    });
    // A total that is not there is named without the sign it was given.
    expect(await h.prepareOrder({ ...UNDER_2, line: -8.5 }, h.ctx)).toEqual({
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
    const result = await h.prepareOrder({ ...MONEYLINE_3, side: 'home', line: 7.5 }, h.ctx);
    expect(result.text).toContain(`commitment_hash: ${hash('a3')}`);
    expect(result.text).not.toContain('line:');
  });

  // ── the quote ────────────────────────────────────────────────────────

  it('says so when nothing is posted on that side', async () => {
    const h = await harness({ ...BOOK, commitments: [OVER_QUOTE] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: NO_UNDER_QUOTE });
    // No quote, so no maker to look up.
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
  });

  it('says an amount is too small, and what the smallest is', async () => {
    const h = await harness(BOOK);
    // One lot fills once ceil(asked * 100 / 105) reaches 100: at 104, not at 103.
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

  // ── the order of the checks ──────────────────────────────────────────
  //
  // Each input fails two checks. The answer is the earlier one's, and the
  // reads show that the later one was never reached.

  const UNREADABLE = { status: 500, body: { message: 'the database is away' } };
  const failing = (table: string) => (request: Parameters<typeof tableOf>[0]) =>
    tableOf(request) === table ? UNREADABLE : undefined;
  const STARTED_GAME = { ...BOOK, contests_effective: [contestRow({ effective_start_time: '2026-09-27T12:00:00+00:00' })] };
  const STARTED_SENTENCE = `${GAME} started Sun Sep 27, 8:00 am ET. No order is prepared on a game under way.`;
  const CONTEST_READS = ['contests_effective', 'speculations'];
  const NO_CHAIN_START = `${GAME} is not open for betting: its contest has no start time on-chain.`;

  const ORDER: Array<{
    first: string;
    second: string;
    tables: Tables;
    override?: ReturnType<typeof failing>;
    args: PrepareOrderArgs;
    isError: boolean;
    text: string;
    reads: string[];
  }> = [
    {
      first: 'the amount',
      second: 'the contest id',
      tables: BOOK,
      args: { ...UNDER_2, riskUsdc: 0, contestId: 'abc' },
      isError: true,
      text: lines('risk_usdc must be more than zero.', PLACED_NOTHING),
      reads: [],
    },
    {
      first: 'the amount',
      second: 'a contest that does not exist',
      tables: BOOK,
      args: { ...UNDER_2, riskUsdc: 0, contestId: '999' },
      isError: true,
      text: lines('risk_usdc must be more than zero.', PLACED_NOTHING),
      reads: [],
    },
    {
      first: 'the contest id',
      second: 'the side',
      tables: BOOK,
      args: { ...UNDER_2, contestId: 'abc', side: 'Phillies' },
      isError: true,
      text: lines(BAD_CONTEST_ID, PLACED_NOTHING),
      reads: [],
    },
    {
      first: 'a contest that does not exist',
      second: 'the side',
      tables: BOOK,
      args: { ...UNDER_2, contestId: '999', side: 'Phillies' },
      isError: true,
      text: lines('There is no contest 999 on Ospex.', PLACED_NOTHING),
      reads: ['contests_effective'],
    },
    {
      first: 'a contest that is scored',
      second: 'a game that has started',
      tables: {
        ...BOOK,
        contests_effective: [
          contestRow({ contest_status: 'scored', effective_start_time: '2026-09-27T12:00:00+00:00' }),
        ],
      },
      args: UNDER_2,
      isError: false,
      text: lines(`${GAME} is not open for betting: its contest is scored.`, PLACED_NOTHING),
      reads: CONTEST_READS,
    },
    {
      first: 'a contest that is scored',
      second: 'a start that cannot be read',
      tables: {
        ...BOOK,
        contests_effective: [contestRow({ contest_status: 'scored', effective_start_time: null })],
      },
      args: UNDER_2,
      isError: false,
      text: lines(`${GAME} is not open for betting: its contest is scored.`, PLACED_NOTHING),
      reads: CONTEST_READS,
    },
    {
      first: 'a contest that is scored',
      second: 'the side',
      tables: { ...BOOK, contests_effective: [contestRow({ contest_status: 'scored' })] },
      args: { ...UNDER_2, side: 'Phillies' },
      isError: false,
      text: lines(`${GAME} is not open for betting: its contest is scored.`, PLACED_NOTHING),
      reads: CONTEST_READS,
    },
    {
      first: 'a contest that is scored',
      second: 'a contest with no start on-chain',
      tables: { ...BOOK, contests_effective: [contestRow({ contest_status: 'scored', start_time: null })] },
      args: UNDER_2,
      isError: false,
      text: lines(`${GAME} is not open for betting: its contest is scored.`, PLACED_NOTHING),
      reads: CONTEST_READS,
    },
    {
      first: 'a contest with no start on-chain',
      second: 'a start that cannot be read',
      tables: { ...BOOK, contests_effective: [contestRow({ start_time: null, effective_start_time: null })] },
      args: UNDER_2,
      isError: false,
      text: lines(NO_CHAIN_START, PLACED_NOTHING),
      reads: CONTEST_READS,
    },
    {
      first: 'a contest with no start on-chain',
      second: 'a game that has started',
      tables: {
        ...BOOK,
        contests_effective: [contestRow({ start_time: null, effective_start_time: '2026-09-27T12:00:00+00:00' })],
      },
      args: UNDER_2,
      isError: false,
      text: lines(NO_CHAIN_START, PLACED_NOTHING),
      reads: CONTEST_READS,
    },
    {
      first: 'a contest with no start on-chain',
      second: 'the side',
      tables: { ...BOOK, contests_effective: [contestRow({ start_time: null })] },
      args: { ...UNDER_2, side: 'Phillies' },
      isError: false,
      text: lines(NO_CHAIN_START, PLACED_NOTHING),
      reads: CONTEST_READS,
    },
    {
      first: 'a start that cannot be read',
      second: 'the side',
      tables: { ...BOOK, contests_effective: [contestRow({ effective_start_time: null })] },
      args: { ...UNDER_2, side: 'Phillies' },
      isError: false,
      text: lines(`${GAME} has no start time Ospex can read, so it cannot be bet on.`, PLACED_NOTHING),
      reads: CONTEST_READS,
    },
    {
      first: 'a game that has started',
      second: 'the side',
      tables: STARTED_GAME,
      args: { ...UNDER_2, side: 'Phillies' },
      isError: false,
      text: lines(STARTED_SENTENCE, PLACED_NOTHING),
      reads: CONTEST_READS,
    },
    {
      first: 'a game too close to its start',
      second: 'the side',
      tables: { ...BOOK, contests_effective: [contestRow({ effective_start_time: '2026-09-27T12:02:00+00:00' })] },
      args: { ...UNDER_2, side: 'Phillies' },
      isError: false,
      text: lines(
        `${GAME} starts Sun Sep 27, 8:02 am ET, less than two minutes from now. That is too close to the start to prepare an order.`,
        PLACED_NOTHING,
      ),
      reads: CONTEST_READS,
    },
    {
      first: 'the side',
      second: 'a book that cannot be read',
      tables: BOOK,
      override: failing('commitments'),
      args: { ...UNDER_2, side: 'Phillies' },
      isError: true,
      text: lines(TOTAL_SIDES, PLACED_NOTHING),
      reads: CONTEST_READS,
    },
    {
      first: 'the side',
      second: 'a market with no line',
      tables: { ...BOOK, speculations: [MONEYLINE] },
      args: { ...UNDER_2, side: 'Phillies' },
      isError: true,
      text: lines(TOTAL_SIDES, PLACED_NOTHING),
      reads: CONTEST_READS,
    },
    {
      first: 'a book that cannot be read',
      second: 'a market with no line',
      tables: { ...BOOK, speculations: [MONEYLINE] },
      override: failing('commitments'),
      args: UNDER_2,
      isError: true,
      text: READ_FAILED,
      reads: [...CONTEST_READS, 'commitments'],
    },
    {
      first: 'a market with no line',
      second: 'a line with two decimals',
      tables: { ...BOOK, speculations: [MONEYLINE] },
      args: { ...UNDER_2, line: 7.25 },
      isError: false,
      text: lines(`${GAME} has no total line on-chain yet.`, PLACED_NOTHING),
      reads: [...CONTEST_READS, 'commitments'],
    },
    {
      first: 'a line with two decimals',
      second: 'a side with no quote',
      tables: { ...BOOK, commitments: [OVER_QUOTE] },
      args: { ...UNDER_2, line: 7.25 },
      isError: true,
      text: lines('line must be a number with at most one decimal place, such as 7.5 or -1.5.', PLACED_NOTHING),
      reads: [...CONTEST_READS, 'commitments'],
    },
    {
      first: 'a line the game does not have',
      second: 'a side with no quote',
      tables: { ...BOOK, commitments: [OVER_QUOTE] },
      args: { ...UNDER_2, line: 8.5 },
      isError: false,
      text: lines(`${GAME} has no total line at 8.5. Lines on-chain: 7.0.`, PLACED_NOTHING),
      reads: [...CONTEST_READS, 'commitments'],
    },
  ];
  for (const pair of ORDER) {
    it(`answers for ${pair.first} before ${pair.second}`, async () => {
      const h = await harness(pair.tables, pair.override === undefined ? {} : { override: pair.override });
      expect(await h.prepareOrder(pair.args, h.ctx)).toEqual({ isError: pair.isError, text: pair.text });
      expect(h.fake.tables()).toEqual(pair.reads);
    });
  }

  it('answers for the amount and for the contest id before it says the service is not configured', async () => {
    const h = await harness(BOOK, { context: { scorers: undefined } });
    expect(await h.prepareOrder({ ...UNDER_2, riskUsdc: 0 }, h.ctx)).toEqual({
      isError: true,
      text: lines('risk_usdc must be more than zero.', PLACED_NOTHING),
    });
    expect(await h.prepareOrder({ ...UNDER_2, contestId: 'abc' }, h.ctx)).toEqual({
      isError: true,
      text: lines(BAD_CONTEST_ID, PLACED_NOTHING),
    });
    expect(h.fake.requests).toHaveLength(0);
  });

  // ── a book too large to read ─────────────────────────────────────────
  //
  // The book is read 999 quotes to a request, for at most 8 requests. Every
  // quote here is the default one under a hash of its own, in the order the
  // read asks for them, except the last, which is posted at the best price.
  // An order prepared from a whole book is prepared against that last quote.

  function bookOf(count: number): Tables {
    const commitments: Row[] = [];
    for (let index = 1; index < count; index += 1) commitments.push(quoteRow({ commitment_hash: nth(index) }));
    commitments.push(quoteRow({ commitment_hash: nth(count), odds_tick: 200 }));
    return { ...BOOK, commitments };
  }
  const TOO_LARGE = lines(`The book on ${GAME} is too large to read completely.`, PLACED_NOTHING);
  const EIGHT_PAGES = [...CONTEST_READS, ...Array.from({ length: 8 }, () => 'commitments')];

  // Measured on Windows 11, Node 22, with the file run by itself: the two
  // refusals took 0.3 to 0.4 seconds each and the prepared order 2.1 to 2.6
  // seconds, most of it building and serving eight pages of rows. 20 seconds
  // is over seven times the slowest of those.
  for (const count of [7993, 7992]) {
    it(
      `refuses to choose from a book of ${String(count)} quotes, which eight requests cannot show the end of`,
      async () => {
        const tables = bookOf(count);
        expect(tables.commitments).toHaveLength(count);
        const h = await harness(tables);
        const result = await h.prepareOrder({ ...UNDER_2, contestId: ' 0481 ', riskUsdc: 2.123456, line: 7 }, h.ctx);

        expect(h.fake.tables()).toEqual(EIGHT_PAGES);
        expect(requestTo(h.fake, 'commitments', 7)?.params.get('commitment_hash')).toBe(`gt.${nth(6993)}`);
        expect(result).toEqual({ isError: true, text: TOO_LARGE });
        expect(result.text).not.toContain('Take link');

        // The contest is named, as the number it is. What was asked for is not.
        expect(logged(h)).toEqual({
          info: [],
          warn: [
            [
              { network: 'polygon', contests: 1, rows: 7992 },
              'commitments: open book drain ran out of pages, book is incomplete',
            ],
            [{ contestId: '481' }, 'mcp: prepare_order could not read a whole book'],
          ],
          error: [],
        });
      },
      20_000,
    );
  }

  it(
    'prepares an order from a book of 7991 quotes, whose last page comes back one short',
    async () => {
      const tables = bookOf(7991);
      expect(tables.commitments).toHaveLength(7991);
      const h = await harness(tables);
      const result = await h.prepareOrder(UNDER_2, h.ctx);

      expect(h.fake.tables()).toEqual([...EIGHT_PAGES, 'maker_funding']);
      // Posted 2.00: 2_000_000 asked fills 2_000_000 and pays 2_000_000. The
      // quote is the last row of the last page.
      expect(result).toEqual({
        isError: false,
        text: lines(
          `Under 7.0 — ${GAME}, ${STARTS}.`,
          'Risk 2.00 USDC to win 2.00 at 2.00.',
          TOTAL_7_PUSH,
          EXPIRES,
          '',
          `Take link: https://ospex.org/take/${nth(7991)}?risk=2`,
          NOT_YET_PLACED,
          PREPARED,
          '',
          'contest_id: 481',
          `commitment_hash: ${nth(7991)}`,
          'market: total',
          'line: 7.0',
          'side: under',
          'risk_usdc: 2',
        ),
      });
      expect(logged(h)).toEqual(NOTHING_LOGGED);
    },
    20_000,
  );

  // ── what is logged ───────────────────────────────────────────────────
  //
  // Each call below names the contest with padding and a leading zero, a side
  // in capitals, an amount and a line that appear nowhere else. The whole of
  // what was logged is compared, so none of them can be in it unseen.

  const TELLTALE = { contestId: ' 0481 ', market: 'total', side: 'UNDER', riskUsdc: 2.123456, line: 7 } as const;

  it('logs nothing when an order is prepared', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder(TELLTALE, h.ctx);
    expect(result.isError).toBe(false);
    expect(result.text).toContain(`Take link: https://ospex.org/take/${hash('a1')}?risk=2.123456`);
    expect(logged(h)).toEqual(NOTHING_LOGGED);
  });

  it('logs nothing when it refuses an argument or finds nothing to offer', async () => {
    const h = await harness({ ...BOOK, commitments: [OVER_QUOTE] });
    expect((await h.prepareOrder({ ...TELLTALE, riskUsdc: 0 }, h.ctx)).isError).toBe(true);
    expect((await h.prepareOrder({ ...TELLTALE, contestId: 'abc' }, h.ctx)).isError).toBe(true);
    expect((await h.prepareOrder({ ...TELLTALE, contestId: '999' }, h.ctx)).isError).toBe(true);
    expect((await h.prepareOrder({ ...TELLTALE, side: 'Phillies' }, h.ctx)).isError).toBe(true);
    expect((await h.prepareOrder({ ...TELLTALE, line: 7.25 }, h.ctx)).isError).toBe(true);
    expect(await h.prepareOrder({ ...TELLTALE, line: 8.5 }, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} has no total line at 8.5. Lines on-chain: 7.0.`, PLACED_NOTHING),
    });
    expect(await h.prepareOrder(TELLTALE, h.ctx)).toEqual({ isError: false, text: NO_UNDER_QUOTE });
    expectReached(h.fake, 12);
    expect(logged(h)).toEqual(NOTHING_LOGGED);
  });

  it('logs nothing when the game has started, is too close to its start, or its contest is scored or has no start on-chain', async () => {
    for (const over of [
      { effective_start_time: '2026-09-27T12:00:00+00:00' },
      { effective_start_time: '2026-09-27T12:02:00+00:00' },
      { contest_status: 'scored' },
      { start_time: null },
    ]) {
      const h = await harness({ ...BOOK, contests_effective: [contestRow(over)] });
      const result = await h.prepareOrder(TELLTALE, h.ctx);
      expect(result.isError).toBe(false);
      expect(result.text).toContain(PLACED_NOTHING);
      expect(h.fake.tables()).toEqual(CONTEST_READS);
      expect(logged(h)).toEqual(NOTHING_LOGGED);
    }
  });

  it('names the contest, and nothing else that was asked for, when its start cannot be read', async () => {
    const h = await harness({ ...BOOK, contests_effective: [contestRow({ effective_start_time: null })] });
    expect(await h.prepareOrder(TELLTALE, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} has no start time Ospex can read, so it cannot be bet on.`, PLACED_NOTHING),
    });
    expect(logged(h)).toEqual({
      info: [],
      warn: [[{ contestId: '481' }, 'mcp: prepare_order found a contest with no readable start time']],
      error: [],
    });
  });

  for (const [table, stage] of [
    ['contests_effective', 'contests'],
    ['speculations', 'speculations'],
  ] as const) {
    it(`answers with fixed words when the ${table} read fails, and logs what the database said`, async () => {
      const h = await harness(BOOK, {
        override: (request) =>
          tableOf(request) === table ? { status: 500, body: { message: `${table} is unavailable` } } : undefined,
      });
      const result = await h.prepareOrder(TELLTALE, h.ctx);
      expectReached(h.fake);
      expect(result).toEqual({ isError: true, text: READ_FAILED });
      expect(logged(h)).toEqual({
        info: [],
        warn: [],
        error: [[{ err: `${table} is unavailable`, stage }, 'mcp: prepare_order contest read failed']],
      });
    });
  }

  it('answers with fixed words when the commitments read fails, and logs what the database said', async () => {
    const h = await harness(BOOK, {
      override: (request) =>
        tableOf(request) === 'commitments'
          ? { status: 500, body: { message: 'commitments is unavailable' } }
          : undefined,
    });
    const result = await h.prepareOrder(TELLTALE, h.ctx);
    expect(h.fake.tables()).toEqual([...CONTEST_READS, 'commitments']);
    expect(result).toEqual({ isError: true, text: READ_FAILED });
    expect(logged(h)).toEqual({
      info: [],
      warn: [],
      error: [[{ err: 'commitments is unavailable' }, 'mcp: prepare_order open book read failed']],
    });
  });

  it('logs what the database said when the funding read fails, and still prepares', async () => {
    const h = await harness(BOOK, {
      override: (request) =>
        tableOf(request) === 'maker_funding' ? { status: 500, body: { message: 'funding unavailable' } } : undefined,
    });
    const result = await h.prepareOrder(TELLTALE, h.ctx);
    // 2_123_456 asked at 2.05: ceil(212_345_600 / 105) = 2_022_340, down to
    // 2_022_300. floor(2_022_300 * 105 / 100) = 2_123_415.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, ${STARTS}.`,
        'Risk 2.12 USDC to win 2.02 at 1.95.',
        TOTAL_7_PUSH,
        EXPIRES,
        'Exact amounts: you pay 2.123415 USDC and win 2.022300 USDC.',
        FUNDS_NOT_CONFIRMED,
        '',
        `Take link: https://ospex.org/take/${hash('a1')}?risk=2.123456`,
        NOT_YET_PLACED,
        PREPARED,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a1')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 2.123456',
      ),
    });
    expect(logged(h)).toEqual({
      info: [],
      warn: [],
      error: [
        [{ err: 'funding unavailable' }, 'commitments: maker_funding lookup failed — fillability degraded to unknown'],
      ],
    });
  });

  it('refuses when the service has no scorer addresses, before reading anything', async () => {
    const h = await harness(BOOK, { context: { scorers: undefined } });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result).toEqual({
      isError: true,
      text: 'This Ospex service is not configured to read markets. Nothing was placed.',
    });
    expect(h.fake.requests).toHaveLength(0);
    expect(logged(h)).toEqual(NOTHING_LOGGED);
  });
});
