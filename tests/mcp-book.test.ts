/**
 * The takeable book — `src/mcp/book.ts`. Pure functions over mapped quote
 * bodies; no database, no clock.
 *
 * Each "is not takeable" case changes ONE field of a quote that is otherwise
 * takeable, and the unchanged quote is asserted takeable first, so a refusal
 * here can only be the field under test.
 */
import { describe, expect, it } from 'vitest';
import {
  TAKE_MARGIN_MICROS,
  buildBookLines,
  chooseQuote,
  priceLevels,
  takeableQuote,
  type MakerBacking,
  type TakeableQuote,
} from '../src/mcp/book.js';
import type { CommitmentBody } from '../src/v1/commitments.js';
import type { Speculation } from '../src/v1/utils/speculations.js';
import { KEYS, MAKER_A, MAKER_B, SCORERS, SIGNATURE, hash } from './helpers/mcpBook.js';

const NOW_MICROS = BigInt(Date.UTC(2026, 8, 27, 12, 0, 0)) * 1000n;
const EXPIRY = '2026-09-27T18:55:00+00:00';

function body(over: Partial<CommitmentBody> = {}): CommitmentBody {
  return {
    commitmentHash: hash('a1'),
    maker: MAKER_A,
    contestId: '481',
    scorer: SCORERS.total,
    lineTicks: 70,
    positionType: 0,
    oddsTick: 205,
    marketType: 'total',
    riskAmount: '5000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '5000000',
    nonce: '1790000000',
    expiry: EXPIRY,
    speculationKey: KEYS['c481-total-70'],
    signature: SIGNATURE,
    status: 'open',
    storedStatus: 'open',
    source: 'agent',
    network: 'polygon',
    nonceInvalidated: false,
    bookVisible: true,
    createdAt: '2026-09-27T02:00:00.123456+00:00',
    ...over,
  };
}

function line(over: Partial<Speculation> = {}): Speculation {
  return {
    speculationId: '1001',
    contestId: '481',
    type: 'total',
    lineTicks: 70,
    line: 7,
    speculationStatus: 0,
    winSide: null,
    settledAt: null,
    voided: false,
    ...over,
  };
}

function quote(over: Partial<TakeableQuote> = {}): TakeableQuote {
  return {
    commitmentHash: hash('a1'),
    maker: MAKER_A,
    makerPositionType: 0,
    makerOddsTick: 205,
    remainingMakerRisk: 5_000_000n,
    expiry: EXPIRY,
    expiryMicros: BigInt(Date.UTC(2026, 8, 27, 18, 55, 0)) * 1000n,
    speculationKey: KEYS['c481-total-70'],
    ...over,
  };
}

describe('takeableQuote', () => {
  it('maps an open quote to what a reader could take', () => {
    expect(takeableQuote(body(), NOW_MICROS)).toEqual({
      commitmentHash: hash('a1'),
      maker: MAKER_A,
      makerPositionType: 0,
      makerOddsTick: 205,
      remainingMakerRisk: 5_000_000n,
      expiry: EXPIRY,
      expiryMicros: 1_790_535_300_000_000n,
      speculationKey: KEYS['c481-total-70'],
    });
  });

  it('takes a partially filled quote for what it has left', () => {
    const partly = body({ status: 'partially_filled', filledRiskAmount: '1904700', remainingRiskAmount: '3095300' });
    expect(takeableQuote(partly, NOW_MICROS)?.remainingMakerRisk).toBe(3_095_300n);
  });

  it('lowercases the maker and the key it groups on', () => {
    const shouting = body({ maker: MAKER_A.toUpperCase().replace('0X', '0x'), speculationKey: KEYS['c481-total-70'].toUpperCase().replace('0X', '0x') });
    const mapped = takeableQuote(shouting, NOW_MICROS);
    expect(mapped?.maker).toBe(MAKER_A);
    expect(mapped?.speculationKey).toBe(KEYS['c481-total-70']);
  });

  const notTakeable: Array<[string, Partial<CommitmentBody>]> = [
    ['hidden from the book', { bookVisible: false }],
    ['nonce-invalidated', { nonceInvalidated: true }],
    ['filled', { status: 'filled' }],
    ['cancelled', { status: 'cancelled' }],
    ['expired by status', { status: 'expired' }],
    ['in a status nobody defined', { status: 'pending' }],
    ['missing its signature', { signature: null }],
    ['carrying a signature of the wrong length', { signature: '0x5a5a' }],
    ['carrying a signature that is not hex', { signature: `0x${'zz'.repeat(65)}` }],
    ['missing its contest', { contestId: null }],
    ['missing its scorer', { scorer: null }],
    ['missing its line', { lineTicks: null }],
    ['missing its side', { positionType: null }],
    ['missing its price', { oddsTick: null }],
    ['missing its expiry', { expiry: null }],
    ['missing its speculation key', { speculationKey: null }],
    ['priced below the protocol range', { oddsTick: 100 }],
    ['priced above the protocol range', { oddsTick: 10_101 }],
    ['carrying a risk amount that is not a number', { riskAmount: 'lots' }],
    ['carrying a nonce that is not a number', { nonce: '-1' }],
    ['carrying a remaining amount that is not a number', { remainingRiskAmount: '1e6' }],
    ['with nothing left', { remainingRiskAmount: '0' }],
    ['with less than one lot left', { remainingRiskAmount: '99' }],
    ['with an expiry that cannot be read', { expiry: '2026-02-30T00:00:00Z' }],
    ['already past its expiry', { expiry: '2026-09-27T11:59:59+00:00' }],
  ];

  it('the unchanged quote is takeable, so each refusal below is the field it names', () => {
    expect(takeableQuote(body(), NOW_MICROS)).not.toBeNull();
    expect(notTakeable).toHaveLength(25);
  });

  for (const [what, change] of notTakeable) {
    it(`refuses a quote ${what}`, () => {
      expect(takeableQuote(body(change), NOW_MICROS)).toBeNull();
    });
  }

  it('stops offering a quote two minutes before it expires', () => {
    expect(TAKE_MARGIN_MICROS).toBe(120_000_000n);
    // Expiry 12:02:00.000000, exactly the margin away: not offered.
    expect(takeableQuote(body({ expiry: '2026-09-27T12:02:00+00:00' }), NOW_MICROS)).toBeNull();
    // One microsecond further: offered.
    expect(takeableQuote(body({ expiry: '2026-09-27T12:02:00.000001+00:00' }), NOW_MICROS)).not.toBeNull();
  });

  it('floors remaining risk that is off the lot grid', () => {
    expect(takeableQuote(body({ remainingRiskAmount: '5000050' }), NOW_MICROS)?.remainingMakerRisk).toBe(5_000_000n);
  });
});

describe('buildBookLines', () => {
  const lines = [
    line({ speculationId: '1000', type: 'moneyline', lineTicks: 0, line: null }),
    line({ speculationId: '1001', type: 'total', lineTicks: 70, line: 7 }),
    line({ speculationId: '1002', type: 'spread', lineTicks: -15, line: -1.5 }),
  ];

  it('puts each quote on the side the READER gets, which is not the side its maker holds', () => {
    const quotes = [
      // Maker on the Over: the reader gets the Under.
      body({ commitmentHash: hash('a1'), positionType: 0 }),
      // Maker on the Under: the reader gets the Over.
      body({ commitmentHash: hash('a2'), positionType: 1, oddsTick: 191, maker: MAKER_B }),
    ];
    const [total] = buildBookLines('481', [lines[1]!], quotes, SCORERS, NOW_MICROS);
    expect(total?.quotes.under.map((q) => q.commitmentHash)).toEqual([hash('a1')]);
    expect(total?.quotes.over.map((q) => q.commitmentHash)).toEqual([hash('a2')]);
    expect(total?.quotes.away).toEqual([]);
    expect(total?.quotes.home).toEqual([]);
  });

  it('does the same for teams: a maker on the away team gives the reader the home team', () => {
    const quotes = [
      body({
        commitmentHash: hash('a3'),
        scorer: SCORERS.moneyline,
        marketType: 'moneyline',
        lineTicks: 0,
        positionType: 0,
        speculationKey: KEYS['c481-moneyline'],
      }),
    ];
    const [moneyline] = buildBookLines('481', [lines[0]!], quotes, SCORERS, NOW_MICROS);
    expect(moneyline?.quotes.home.map((q) => q.commitmentHash)).toEqual([hash('a3')]);
    expect(moneyline?.quotes.away).toEqual([]);
  });

  it('orders the lines moneyline, spread, total, whatever order they arrived in', () => {
    const built = buildBookLines('481', [lines[1]!, lines[2]!, lines[0]!], [], SCORERS, NOW_MICROS);
    expect(built.map((l) => l.market)).toEqual(['moneyline', 'spread', 'total']);
    expect(built.map((l) => l.speculationId)).toEqual(['1000', '1002', '1001']);
  });

  it('orders two lines of one market by their line', () => {
    const two = [line({ speculationId: '1005', lineTicks: 75, line: 7.5 }), line({ speculationId: '1001' })];
    expect(buildBookLines('481', two, [], SCORERS, NOW_MICROS).map((l) => l.lineTicks)).toEqual([70, 75]);
  });

  it('leaves out a quote on a line that does not exist on-chain', () => {
    // Total 7.5 has a quote and no speculation. Taking it would create the line.
    const orphan = body({ commitmentHash: hash('b1'), lineTicks: 75, speculationKey: KEYS['c481-total-75'] });
    const built = buildBookLines('481', [lines[1]!], [orphan, body()], SCORERS, NOW_MICROS);
    expect(built).toHaveLength(1);
    expect(built[0]?.lineTicks).toBe(70);
    expect(built[0]?.quotes.under.map((q) => q.commitmentHash)).toEqual([hash('a1')]);
  });

  it('attaches a quote by its key, not by the line it claims', () => {
    // Says total 7.0, keyed to total 7.5: it belongs to 7.5 or to nothing.
    const mislabelled = body({ commitmentHash: hash('b2'), lineTicks: 70, speculationKey: KEYS['c481-total-75'] });
    const built = buildBookLines('481', [lines[1]!], [mislabelled], SCORERS, NOW_MICROS);
    expect(built[0]?.quotes.under).toEqual([]);
  });

  it('leaves out a settled line and a line with no line value', () => {
    const settled = line({ speculationId: '1001', speculationStatus: 1, winSide: 'under' });
    const blank = line({ speculationId: '1009', lineTicks: null, line: null });
    expect(buildBookLines('481', [settled, blank], [body()], SCORERS, NOW_MICROS)).toEqual([]);
  });

  it('leaves out lines and quotes of another contest', () => {
    const other = line({ speculationId: '2001', contestId: '482', lineTicks: 85, line: 8.5 });
    const foreign = body({ commitmentHash: hash('c1'), contestId: '482' });
    const built = buildBookLines('481', [lines[1]!, other], [foreign], SCORERS, NOW_MICROS);
    expect(built.map((l) => l.speculationId)).toEqual(['1001']);
    expect(built[0]?.quotes.under).toEqual([]);
  });

  it('sorts a side best price first, then larger, then by hash', () => {
    const quotes = [
      body({ commitmentHash: hash('d4'), oddsTick: 210 }),
      body({ commitmentHash: hash('d2'), oddsTick: 205, remainingRiskAmount: '2000000' }),
      body({ commitmentHash: hash('d3'), oddsTick: 205, remainingRiskAmount: '9000000' }),
      body({ commitmentHash: hash('d1'), oddsTick: 205, remainingRiskAmount: '2000000' }),
    ];
    const [total] = buildBookLines('481', [lines[1]!], quotes, SCORERS, NOW_MICROS);
    expect(total?.quotes.under.map((q) => q.commitmentHash)).toEqual([hash('d3'), hash('d1'), hash('d2'), hash('d4')]);
  });
});

describe('priceLevels', () => {
  it('groups quotes by price and sizes a level by its LARGEST quote, not their sum', () => {
    const levels = priceLevels([
      quote({ makerOddsTick: 205, remainingMakerRisk: 5_000_000n }),
      quote({ makerOddsTick: 205, remainingMakerRisk: 2_000_000n, commitmentHash: hash('a2') }),
      quote({ makerOddsTick: 210, remainingMakerRisk: 1_000_000n, commitmentHash: hash('a3') }),
    ]);
    expect(levels).toEqual([
      // 5_000_000 * 105 / 100. The sum would have been 7_350_000.
      { makerOddsTick: 205, maxTakerRisk: 5_250_000n, quotes: 2 },
      { makerOddsTick: 210, maxTakerRisk: 1_100_000n, quotes: 1 },
    ]);
  });

  it('finds the largest quote wherever it sits in the level', () => {
    const levels = priceLevels([
      quote({ remainingMakerRisk: 2_000_000n }),
      quote({ remainingMakerRisk: 5_000_000n, commitmentHash: hash('a2') }),
    ]);
    expect(levels).toEqual([{ makerOddsTick: 205, maxTakerRisk: 5_250_000n, quotes: 2 }]);
  });

  it('has no levels for no quotes', () => {
    expect(priceLevels([])).toEqual([]);
  });
});

describe('chooseQuote', () => {
  const nothingKnown = new Map<string, MakerBacking>();

  it('takes the only quote when it can fill the amount', () => {
    const choice = chooseQuote([quote()], 2_000_000n, nothingKnown);
    expect(choice).toMatchObject({
      ok: true,
      quote: { commitmentHash: hash('a1') },
      plan: { takerRisk: 1_999_935n, fillMakerRisk: 1_904_700n, reduced: false },
      fundingConfirmed: false,
    });
  });

  it('prefers the better price among quotes that can fill the amount', () => {
    const worse = quote({ commitmentHash: hash('e1'), makerOddsTick: 210, remainingMakerRisk: 50_000_000n });
    const better = quote({ commitmentHash: hash('e2'), makerOddsTick: 205, remainingMakerRisk: 5_000_000n });
    const choice = chooseQuote([worse, better], 2_000_000n, nothingKnown);
    expect(choice.ok && choice.quote.commitmentHash).toBe(hash('e2'));
  });

  it('passes over a better price that cannot fill the amount for a worse one that can', () => {
    // Five cents left at the better price, against an order for ten dollars.
    const dust = quote({ commitmentHash: hash('e3'), makerOddsTick: 200, remainingMakerRisk: 50_000n });
    const deep = quote({ commitmentHash: hash('e4'), makerOddsTick: 205, remainingMakerRisk: 50_000_000n });
    const choice = chooseQuote([dust, deep], 10_000_000n, nothingKnown);
    expect(choice).toMatchObject({ ok: true, quote: { commitmentHash: hash('e4') }, plan: { reduced: false } });
  });

  it('when nothing can fill the amount, takes the quote that fills the most of it', () => {
    const small = quote({ commitmentHash: hash('e5'), makerOddsTick: 200, remainingMakerRisk: 1_000_000n });
    const larger = quote({ commitmentHash: hash('e6'), makerOddsTick: 205, remainingMakerRisk: 5_000_000n });
    const choice = chooseQuote([small, larger], 10_000_000n, nothingKnown);
    expect(choice).toMatchObject({
      ok: true,
      quote: { commitmentHash: hash('e6') },
      plan: { reduced: true, takerDesiredRisk: 5_250_000n, takerRisk: 5_250_000n, requestedTakerRisk: 10_000_000n },
    });
  });

  it('between two quotes that fill the same part, takes the better price', () => {
    // 3_000_000 of risk absorbed either way: 3_000_000 * 100/100 and 2_000_000 * 150/100.
    const at200 = quote({ commitmentHash: hash('e7'), makerOddsTick: 200, remainingMakerRisk: 3_000_000n });
    const at250 = quote({ commitmentHash: hash('e8'), makerOddsTick: 250, remainingMakerRisk: 2_000_000n });
    const choice = chooseQuote([at250, at200], 10_000_000n, nothingKnown);
    expect(choice).toMatchObject({
      ok: true,
      quote: { commitmentHash: hash('e7') },
      plan: { reduced: true, takerRisk: 3_000_000n, fillMakerRisk: 3_000_000n },
    });
    // The other way round would have won 2_000_000 for the same 3_000_000.
    expect(chooseQuote([at250], 10_000_000n, nothingKnown)).toMatchObject({
      ok: true,
      plan: { takerRisk: 3_000_000n, fillMakerRisk: 2_000_000n },
    });
  });

  it('passes over a maker known to be short of the fill', () => {
    const short = quote({ commitmentHash: hash('f1'), maker: MAKER_A, makerOddsTick: 205 });
    const funded = quote({ commitmentHash: hash('f2'), maker: MAKER_B, makerOddsTick: 210 });
    const backing = new Map<string, MakerBacking>([
      // The fill is 1_904_700. One base unit short of it.
      [MAKER_A, { backing: 1_904_699n, fresh: true }],
      [MAKER_B, { backing: 1_000_000_000n, fresh: true }],
    ]);
    const choice = chooseQuote([short, funded], 2_000_000n, backing);
    expect(choice).toMatchObject({ ok: true, quote: { commitmentHash: hash('f2') }, fundingConfirmed: true });
  });

  it('takes a maker whose funds exactly cover the fill, and says they are confirmed', () => {
    const backing = new Map<string, MakerBacking>([[MAKER_A, { backing: 1_904_700n, fresh: true }]]);
    expect(chooseQuote([quote()], 2_000_000n, backing)).toMatchObject({ ok: true, fundingConfirmed: true });
  });

  it('does not act on a stale snapshot, in either direction', () => {
    const shortButStale = new Map<string, MakerBacking>([[MAKER_A, { backing: 1n, fresh: false }]]);
    expect(chooseQuote([quote()], 2_000_000n, shortButStale)).toMatchObject({ ok: true, fundingConfirmed: false });
    const richButStale = new Map<string, MakerBacking>([[MAKER_A, { backing: 1_000_000_000n, fresh: false }]]);
    expect(chooseQuote([quote()], 2_000_000n, richButStale)).toMatchObject({ ok: true, fundingConfirmed: false });
  });

  it('says so when every quote is from a maker known to be short', () => {
    const backing = new Map<string, MakerBacking>([[MAKER_A, { backing: 0n, fresh: true }]]);
    expect(chooseQuote([quote()], 2_000_000n, backing)).toEqual({ ok: false, reason: 'maker_unfunded' });
  });

  it('says an amount is too small, with the smallest any quote would take', () => {
    const at205 = quote({ commitmentHash: hash('f3'), makerOddsTick: 205 });
    const at150 = quote({ commitmentHash: hash('f4'), makerOddsTick: 150 });
    // The smallest at 2.05 is 104, at 1.50 it is 50.
    expect(chooseQuote([at205, at150], 40n, nothingKnown)).toEqual({ ok: false, reason: 'too_small', minTakerRisk: 50n });
  });

  it('has nothing to choose from an empty side', () => {
    expect(chooseQuote([], 2_000_000n, nothingKnown)).toEqual({ ok: false, reason: 'no_quotes' });
  });
});
