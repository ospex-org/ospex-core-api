/**
 * The takeable book — `src/mcp/book.ts`. Pure functions over mapped quote
 * bodies; no database, no clock.
 *
 * Each "is not takeable" case changes ONE field of a quote that is otherwise
 * takeable, and the unchanged quote is asserted takeable first, so a refusal
 * here can only be the field under test. Where one field cannot be changed
 * without another check refusing the quote first, the case says which check
 * its fixture reaches and why no other can be the one answering.
 */
import { describe, expect, it } from 'vitest';
import {
  TAKE_MARGIN_MICROS,
  buildBookLines,
  chooseQuote,
  priceLevels,
  takeableQuote,
  type BookLine,
  type MakerBacking,
  type TakeableQuote,
} from '../src/mcp/book.js';
import { sidesOf } from '../src/mcp/words.js';
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
    // 66 bytes where a signature has 65: the first 65 are a well-formed one.
    ['carrying a signature one byte too long', { signature: `${SIGNATURE}5a` }],
    ['carrying a signature one byte short', { signature: `0x${'5a'.repeat(64)}` }],
    ['carrying a signature written without its 0x', { signature: '5a'.repeat(65) }],
    // A well-formed signature after one stray character.
    ['carrying a signature preceded by text', { signature: `x${SIGNATURE}` }],
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
    expect(notTakeable).toHaveLength(29);
  });

  it('takes a signature written in upper-case hex', () => {
    expect(SIGNATURE).toBe(`0x${'5a'.repeat(65)}`);
    const shouting = body({ signature: `0x${'5A'.repeat(65)}` });
    expect(takeableQuote(shouting, NOW_MICROS)).not.toBeNull();
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
    // Signed for a whole number of lots, with 50 base units filled: 5,000,050 left.
    const offGrid = body({ riskAmount: '5000100', filledRiskAmount: '50', remainingRiskAmount: '5000050' });
    expect(takeableQuote(offGrid, NOW_MICROS)?.remainingMakerRisk).toBe(5_000_000n);
  });

  it('refuses a filled amount that is not all digits, and takes one that is', () => {
    // The remaining amount is left well-formed, so only the filled amount can refuse.
    for (const filledRiskAmount of ['-1000000', '1e6', '', ' 0', '0x10']) {
      expect(takeableQuote(body({ filledRiskAmount }), NOW_MICROS)).toBeNull();
    }
    expect(takeableQuote(body({ filledRiskAmount: '0' }), NOW_MICROS)).not.toBeNull();
    expect(takeableQuote(body({ filledRiskAmount: '1000000' }), NOW_MICROS)).not.toBeNull();
  });

  it('refuses a quote with more left than it was signed for, and takes one with exactly that much', () => {
    // Signed for 5,000,000: one base unit more left is impossible for a
    // well-formed row, and is what a filled amount below zero would produce.
    expect(takeableQuote(body({ remainingRiskAmount: '5000001' }), NOW_MICROS)).toBeNull();
    expect(takeableQuote(body({ remainingRiskAmount: '5000100' }), NOW_MICROS)).toBeNull();
    expect(takeableQuote(body({ remainingRiskAmount: '5000000' }), NOW_MICROS)?.remainingMakerRisk).toBe(5_000_000n);
  });

  it('takes a quote with exactly one lot left, and one with a lot and change', () => {
    // 99 is refused above; 100 is the first amount that is.
    expect(takeableQuote(body({ remainingRiskAmount: '100' }), NOW_MICROS)?.remainingMakerRisk).toBe(100n);
    expect(takeableQuote(body({ remainingRiskAmount: '199' }), NOW_MICROS)?.remainingMakerRisk).toBe(100n);
  });
});

/**
 * Keys this file needs that the shared fixture does not carry. Each is
 * keccak256(abi.encode(uint256 contestId, address scorer, int32 lineTicks)) for
 * the fixture's total scorer, computed once with an ABI encoder outside this
 * repo's code and written here as a literal.
 */
const MORE_KEYS = {
  /** Contest 482, total 7.0. */
  'c482-total-70': '0x65462db8e10a3408c3e4e397d68efaeeed2cd7a9da7e2edf5bd20c9b30b737dd',
  /** Contest 0, total 7.0. */
  'c0-total-70': '0x1ffbd0e2701fcaae3b219665e7b1b752fcd2df2ec6847a3e349512800ea3562d',
  /** Contest 99999999999999999999 (twenty digits), total 7.0. */
  'c20digits-total-70': '0x641c58410e40f9c0117afb006d4ce3421473be8f651b973e472108b8d07b47e1',
  /** Contest 100000000000000000000 (twenty-one digits), total 7.0. */
  'c21digits-total-70': '0xbbdb190c53bd04df9667777cc5f93dd998e769e1f36c76e8efe96a69f4d1c3a6',
  /** Contest 481, line ticks 2147483647, the largest an int32 holds. */
  'c481-total-2147483647': '0x9f0782582b2ce790d721e845b7f7fff700d82b371c266b66a0c4469eb534340d',
  /** Contest 481, line ticks -2147483647. */
  'c481-total--2147483647': '0x9372432eec9c220c8d6e7a4ad481b4a6477535159e6a5f5dde5482988f17ea2f',
  /** Contest 481, line ticks -2147483648, the smallest an int32 holds. */
  'c481-total--2147483648': '0xf501ecc39131ec524c67198f00d5c3d3384f6fbca015765dcae0c17b37a95c1c',
  /** Contest 481, total 7.0, under a scorer whose address has letters in it: 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd. */
  'c481-lettered-scorer-70': '0x0068b95e5abb87f19448e26101bdd0baed8818238f029c081a773f31464d3f5c',
  /** Contest 481, total 7.5, under that same lettered scorer. */
  'c481-lettered-scorer-75': '0x034523a0ca693a42fe3136e20e83553c1b4ec8ec310732e169583d0267a91e12',
  /** Contest 481, line ticks 70 under the fixture's SPREAD scorer. */
  'c481-spread-70': '0xf89e0bf5a739d43b309ffb2ccf0c84f61f10f014e1a9f33722ed61a528d11237',
  /** Contest 481, line ticks 0 under the fixture's total scorer. */
  'c481-total-0': '0x87c2dd603f8df8f971266729be3681e6d636ed3c3d9b1eac9ce329f9c13d0bef',
} as const;

/** A value of a type the mapped body does not admit, as a row that is wrong could carry it. */
function mistyped<T>(value: unknown): T {
  return value as T;
}

describe('takeableQuote: the hash that goes into a link', () => {
  const refused: Array<[string, string]> = [
    ['one character short', `0x${'a1'.repeat(31)}a`],
    ['one character too long', `${hash('a1')}a`],
    ['one byte too long', `${hash('a1')}a1`],
    ['not hex', `0x${'g1'.repeat(32)}`],
    ['written without its 0x', 'a1'.repeat(32)],
    ['preceded by text', `x${hash('a1')}`],
    ['followed by a line break', `${hash('a1')}\n`],
    ['a path and a query, not a hash', 'example.invalid/x?y=1#'],
    ['empty', ''],
  ];

  it('takes a hash of 0x and 64 hex characters, in either case', () => {
    expect(hash('a1')).toBe('0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1');
    expect(takeableQuote(body({ commitmentHash: hash('a1') }), NOW_MICROS)?.commitmentHash).toBe(hash('a1'));
    expect(takeableQuote(body({ commitmentHash: hash('A1') }), NOW_MICROS)?.commitmentHash).toBe(
      '0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1',
    );
  });

  for (const [what, commitmentHash] of refused) {
    it(`refuses a quote whose hash is ${what}`, () => {
      // Nothing after the hash check reads the hash, so this check is the only
      // one that can refuse these.
      expect(takeableQuote(body({ commitmentHash }), NOW_MICROS)).toBeNull();
    });
  }
});

describe('takeableQuote: the side the maker holds', () => {
  it('takes 0 and 1', () => {
    expect(takeableQuote(body({ positionType: 0 }), NOW_MICROS)?.makerPositionType).toBe(0);
    expect(takeableQuote(body({ positionType: 1 }), NOW_MICROS)?.makerPositionType).toBe(1);
  });

  // `undefined` is what a position written in a word the mapping does not know
  // arrives as. The strings and `true` are here because a loose comparison
  // would read them as 0 or 1.
  const refused: Array<[string, unknown]> = [
    ['2', 2],
    ['-1', -1],
    ['0.5', 0.5],
    ['true', true],
    ['false', false],
    ['the string 0', '0'],
    ['the string 1', '1'],
    ['the word upper', 'upper'],
    ['undefined', undefined],
  ];

  for (const [what, positionType] of refused) {
    it(`refuses a quote whose side is ${what}`, () => {
      const wrong = body({ positionType: mistyped<CommitmentBody['positionType']>(positionType) });
      expect(takeableQuote(wrong, NOW_MICROS)).toBeNull();
    });
  }
});

describe('takeableQuote: the amount the quote was signed for', () => {
  it('takes an amount that is whole lots, one lot either side of the default', () => {
    expect(takeableQuote(body({ riskAmount: '5000000' }), NOW_MICROS)?.remainingMakerRisk).toBe(5_000_000n);
    expect(takeableQuote(body({ riskAmount: '5000100' }), NOW_MICROS)?.remainingMakerRisk).toBe(5_000_000n);
    expect(
      takeableQuote(body({ riskAmount: '4999900', remainingRiskAmount: '4999900' }), NOW_MICROS)?.remainingMakerRisk,
    ).toBe(4_999_900n);
  });

  // What is LEFT stays at 5000000 in each, whole lots, so the check on what is
  // left cannot be the one refusing.
  for (const riskAmount of ['5000001', '4999999', '5000099', '5000050']) {
    it(`refuses a quote signed for ${riskAmount}, which is not whole lots`, () => {
      expect(takeableQuote(body({ riskAmount }), NOW_MICROS)).toBeNull();
    });
  }

  // Each of these reads as 5000000 to BigInt, whole lots, so the lot check
  // would take it; only the check that the amount is written in digits refuses.
  const notDigits: Array<[string, string]> = [
    ['with a space in front', ' 5000000'],
    ['with a line break after it', '5000000\n'],
    ['written in hex', '0x4c4b40'],
  ];

  for (const [what, riskAmount] of notDigits) {
    it(`refuses a quote whose signed amount is ${what}`, () => {
      expect(BigInt(riskAmount)).toBe(5_000_000n);
      expect(takeableQuote(body({ riskAmount }), NOW_MICROS)).toBeNull();
    });
  }
});

/**
 * The three signed fields the key is made from are checked for shape, then the
 * key is derived from them and compared with the one the quote is filed under.
 *
 * A quote with a changed contest, scorer or line has a different correct key,
 * so left alone the comparison would refuse every one of these and the shape
 * checks would never be seen. Each fixture below therefore falls in one of two
 * groups, and says which:
 *
 *   - KEYED: the fixture carries the key its own fields derive to. The
 *     comparison passes it, so the shape check is the only thing refusing.
 *   - UNENCODABLE: no key exists for the fixture, because the encoder throws on
 *     it. The shape check answers null before the encoder is reached; nothing
 *     after it answers null for this input.
 */
describe('takeableQuote: the shape of the contest, the scorer and the line', () => {
  it('takes a contest id of twenty digits, and of one', () => {
    // KEYED. The longest id taken, and the shortest.
    const twenty = body({ contestId: '99999999999999999999', speculationKey: MORE_KEYS['c20digits-total-70'] });
    expect(takeableQuote(twenty, NOW_MICROS)?.speculationKey).toBe(MORE_KEYS['c20digits-total-70']);
    const zero = body({ contestId: '0', speculationKey: MORE_KEYS['c0-total-70'] });
    expect(takeableQuote(zero, NOW_MICROS)?.speculationKey).toBe(MORE_KEYS['c0-total-70']);
  });

  const contestIds: Array<[string, string, string]> = [
    // KEYED: twenty-one digits still fit the uint256 the key is made from.
    ['of twenty-one digits', '100000000000000000000', MORE_KEYS['c21digits-total-70']],
    // KEYED: each of the next five reads as a number to BigInt. The empty
    // string reads as 0, the rest as 481.
    ['that is empty', '', MORE_KEYS['c0-total-70']],
    ['with a plus sign', '+481', KEYS['c481-total-70']],
    ['with a space in front', ' 481', KEYS['c481-total-70']],
    ['with a line break after it', '481\n', KEYS['c481-total-70']],
    ['written in hex', '0x1e1', KEYS['c481-total-70']],
    // UNENCODABLE: a negative number is no uint256, and BigInt reads no decimal point.
    ['with a minus sign', '-481', KEYS['c481-total-70']],
    ['with a decimal point', '481.0', KEYS['c481-total-70']],
  ];

  for (const [what, contestId, speculationKey] of contestIds) {
    it(`refuses a contest id ${what}`, () => {
      expect(takeableQuote(body({ contestId, speculationKey }), NOW_MICROS)).toBeNull();
    });
  }

  it('takes a scorer of 0x and 40 hex characters', () => {
    expect(SCORERS.total).toBe('0x3333333333333333333333333333333333333333');
    expect(takeableQuote(body({ scorer: SCORERS.total }), NOW_MICROS)).not.toBeNull();
  });

  it('takes a scorer whose letters are written in upper case or mixed case', () => {
    // The fixture scorers are digits only, so this one has letters. The key is
    // derived from the lowercased address, so the case the row carries does
    // not change it; the mixed-case form is not a checksummed address, which
    // the encoder would refuse if it were handed it as written.
    const upper = body({ scorer: '0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD', speculationKey: MORE_KEYS['c481-lettered-scorer-70'] });
    expect(takeableQuote(upper, NOW_MICROS)?.speculationKey).toBe(MORE_KEYS['c481-lettered-scorer-70']);
    const mixed = body({ scorer: '0xABCDEFabcdefabcdefabcdefabcdefabcdefabcd', speculationKey: MORE_KEYS['c481-lettered-scorer-70'] });
    expect(takeableQuote(mixed, NOW_MICROS)?.speculationKey).toBe(MORE_KEYS['c481-lettered-scorer-70']);
    const lower = body({ scorer: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', speculationKey: MORE_KEYS['c481-lettered-scorer-70'] });
    expect(takeableQuote(lower, NOW_MICROS)?.speculationKey).toBe(MORE_KEYS['c481-lettered-scorer-70']);
  });

  const scorers: Array<[string, string]> = [
    // KEYED: the encoder reads 40 hex characters as the same address with or
    // without the 0x, so the fixture's own key is this one's too.
    ['without its 0x', '3333333333333333333333333333333333333333'],
    // UNENCODABLE: none of these is an address.
    ['of 39 hex characters', '0x333333333333333333333333333333333333333'],
    ['of 41 hex characters', '0x33333333333333333333333333333333333333333'],
    ['that is not hex', '0x333333333333333333333333333333333333333g'],
    ['preceded by text', 'x0x3333333333333333333333333333333333333333'],
  ];

  for (const [what, scorer] of scorers) {
    it(`refuses a scorer ${what}`, () => {
      expect(takeableQuote(body({ scorer }), NOW_MICROS)).toBeNull();
    });
  }

  it('takes the widest line an int32 holds, either way, when the key is that line\'s', () => {
    // KEYED.
    const widest = body({ lineTicks: 2_147_483_647, speculationKey: MORE_KEYS['c481-total-2147483647'] });
    expect(takeableQuote(widest, NOW_MICROS)?.speculationKey).toBe(MORE_KEYS['c481-total-2147483647']);
    const widestBelow = body({ lineTicks: -2_147_483_647, speculationKey: MORE_KEYS['c481-total--2147483647'] });
    expect(takeableQuote(widestBelow, NOW_MICROS)?.speculationKey).toBe(MORE_KEYS['c481-total--2147483647']);
  });

  it('refuses a line of -2147483648, which an int32 holds and the limit does not', () => {
    // KEYED: the encoder takes this value, so without the limit the quote
    // would be offered.
    const below = body({ lineTicks: -2_147_483_648, speculationKey: MORE_KEYS['c481-total--2147483648'] });
    expect(takeableQuote(below, NOW_MICROS)).toBeNull();
  });

  // UNENCODABLE, every one: none is an int32.
  const lines: Array<[string, number]> = [
    ['1.5', 1.5],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['infinite and negative', Number.NEGATIVE_INFINITY],
    ['2147483648', 2_147_483_648],
  ];

  for (const [what, lineTicks] of lines) {
    it(`refuses a line that is ${what}`, () => {
      expect(takeableQuote(body({ lineTicks }), NOW_MICROS)).toBeNull();
    });
  }
});

describe('takeableQuote: the key is the key of the signed fields', () => {
  it('takes the right key written in upper case or mixed case, and answers it in lower case', () => {
    expect(KEYS['c481-total-70']).toBe('0x09da056ea908a649656a37d2c1b2a71bf629855eb8226256fda3b9a3e71dd6f8');
    const upper = body({ speculationKey: '0x09DA056EA908A649656A37D2C1B2A71BF629855EB8226256FDA3B9A3E71DD6F8' });
    expect(takeableQuote(upper, NOW_MICROS)?.speculationKey).toBe(KEYS['c481-total-70']);
    const mixed = body({ speculationKey: '0x09DA056EA908A649656A37D2C1B2A71Bf629855eb8226256fda3b9a3e71dd6f8' });
    expect(takeableQuote(mixed, NOW_MICROS)?.speculationKey).toBe(KEYS['c481-total-70']);
  });

  const wrongKeys: Array<[string, string]> = [
    ['another line of the same contest', KEYS['c481-total-75']],
    ['the same line of another contest', MORE_KEYS['c482-total-70']],
    ['another market of the same contest', KEYS['c481-moneyline']],
    ['no line at all', hash('00')],
  ];

  for (const [what, speculationKey] of wrongKeys) {
    it(`refuses a quote for total 7.0 filed under the key of ${what}`, () => {
      expect(takeableQuote(body({ speculationKey }), NOW_MICROS)).toBeNull();
    });
  }

  it('reads the line from the signed fields: each key is taken with its own line and no other', () => {
    expect(takeableQuote(body({ lineTicks: 75, speculationKey: KEYS['c481-total-75'] }), NOW_MICROS)).not.toBeNull();
    expect(takeableQuote(body({ lineTicks: 75, speculationKey: KEYS['c481-total-70'] }), NOW_MICROS)).toBeNull();
    expect(takeableQuote(body({ lineTicks: 80, speculationKey: KEYS['c481-total-80'] }), NOW_MICROS)).not.toBeNull();
    expect(takeableQuote(body({ lineTicks: 80, speculationKey: KEYS['c481-total-75'] }), NOW_MICROS)).toBeNull();
  });

  it('reads the sign of the line: a spread of -1.5 and one of +1.5 are two keys', () => {
    const awayGives = { scorer: SCORERS.spread, marketType: 'spread' as const, lineTicks: -15 };
    const homeGives = { scorer: SCORERS.spread, marketType: 'spread' as const, lineTicks: 15 };
    expect(takeableQuote(body({ ...awayGives, speculationKey: KEYS['c481-spread--15'] }), NOW_MICROS)).not.toBeNull();
    expect(takeableQuote(body({ ...homeGives, speculationKey: KEYS['c481-spread-15'] }), NOW_MICROS)).not.toBeNull();
    expect(takeableQuote(body({ ...awayGives, speculationKey: KEYS['c481-spread-15'] }), NOW_MICROS)).toBeNull();
    expect(takeableQuote(body({ ...homeGives, speculationKey: KEYS['c481-spread--15'] }), NOW_MICROS)).toBeNull();
  });

  it('reads the contest from the signed fields', () => {
    expect(takeableQuote(body({ contestId: '482', speculationKey: MORE_KEYS['c482-total-70'] }), NOW_MICROS)).not.toBeNull();
    expect(takeableQuote(body({ contestId: '482', speculationKey: KEYS['c481-total-70'] }), NOW_MICROS)).toBeNull();
  });

  it('reads the scorer from the signed fields', () => {
    const moneyline = { scorer: SCORERS.moneyline, marketType: 'moneyline' as const, lineTicks: 0 };
    expect(takeableQuote(body({ ...moneyline, speculationKey: KEYS['c481-moneyline'] }), NOW_MICROS)).not.toBeNull();
    // The same contest and line under the total scorer is another key.
    expect(takeableQuote(body({ ...moneyline, scorer: SCORERS.total, speculationKey: KEYS['c481-moneyline'] }), NOW_MICROS)).toBeNull();
  });

  it('reads a line of -0 as the line 0', () => {
    const moneyline = { scorer: SCORERS.moneyline, marketType: 'moneyline' as const, lineTicks: -0 };
    expect(Object.is(moneyline.lineTicks, -0)).toBe(true);
    expect(takeableQuote(body({ ...moneyline, speculationKey: KEYS['c481-moneyline'] }), NOW_MICROS)?.speculationKey).toBe(
      KEYS['c481-moneyline'],
    );
    // The same -0 under the total scorer, filed under the key of total 0.
    const total = { lineTicks: -0, speculationKey: MORE_KEYS['c481-total-0'] };
    expect(takeableQuote(body(total), NOW_MICROS)?.speculationKey).toBe(MORE_KEYS['c481-total-0']);
    // Nearest refusal: -0 filed under the key of total 7.0.
    expect(takeableQuote(body({ lineTicks: -0 }), NOW_MICROS)).toBeNull();
  });
});

describe('takeableQuote: a field that is not a string', () => {
  // A list holding the right text and an object that answers the right text
  // both read as that text to a pattern test, and the object also answers it
  // from its own toLowerCase. So without the check on the type the object is
  // taken as the right value, and the list either is taken or throws.
  const fields: Array<[string, keyof CommitmentBody, string]> = [
    ['hash', 'commitmentHash', hash('a1')],
    ['maker', 'maker', MAKER_A],
    ['scorer', 'scorer', SCORERS.total],
    ['speculation key', 'speculationKey', KEYS['c481-total-70']],
  ];

  for (const [what, field, right] of fields) {
    it(`takes the quote whose ${what} is the text it should be`, () => {
      expect(takeableQuote(body({ [field]: right }), NOW_MICROS)).not.toBeNull();
    });

    const wrong: Array<[string, unknown]> = [
      ['a number', 481],
      ['null', null],
      ['undefined', undefined],
      ['a list holding the right text', [right]],
      ['an object that answers the right text', { toString: () => right, toLowerCase: () => right }],
    ];

    for (const [shape, value] of wrong) {
      it(`refuses, without throwing, a quote whose ${what} is ${shape}`, () => {
        let answer: TakeableQuote | null | undefined;
        expect(() => {
          answer = takeableQuote(body({ [field]: mistyped<string>(value) }), NOW_MICROS);
        }).not.toThrow();
        expect(answer).toBeNull();
      });
    }
  }
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

  it('orders two lines of one market by their line before their id', () => {
    // The lower line has the higher id here, so ordering by id alone would put
    // 7.5 first.
    const higherLineLowerId = line({ speculationId: '1001', lineTicks: 75, line: 7.5 });
    const lowerLineHigherId = line({ speculationId: '1005', lineTicks: 70, line: 7 });
    for (const arrived of [
      [higherLineLowerId, lowerLineHigherId],
      [lowerLineHigherId, higherLineLowerId],
    ]) {
      expect(buildBookLines('481', arrived, [], SCORERS, NOW_MICROS).map((l) => [l.speculationId, l.lineTicks])).toEqual([
        ['1005', 70],
        ['1001', 75],
      ]);
    }
  });

  it('leaves out a quote on a line that does not exist on-chain', () => {
    // Total 7.5 has a quote and no speculation. Taking it would create the line.
    const orphan = body({ commitmentHash: hash('b1'), lineTicks: 75, speculationKey: KEYS['c481-total-75'] });
    const built = buildBookLines('481', [lines[1]!], [orphan, body()], SCORERS, NOW_MICROS);
    expect(built).toHaveLength(1);
    expect(built[0]?.lineTicks).toBe(70);
    expect(built[0]?.quotes.under.map((q) => q.commitmentHash)).toEqual([hash('a1')]);
  });

  it('puts a quote signed for one line and filed under another on neither', () => {
    // Signed for total 7.0, filed under the key of total 7.5. Both lines are
    // open, and a well-formed quote is on 7.5, so an empty side is the quote
    // being left out and not the line being missing.
    const mislabelled = body({ commitmentHash: hash('b2'), lineTicks: 70, speculationKey: KEYS['c481-total-75'] });
    const onSevenAndAHalf = body({ commitmentHash: hash('b3'), lineTicks: 75, speculationKey: KEYS['c481-total-75'] });
    const both = [lines[1]!, line({ speculationId: '1005', lineTicks: 75, line: 7.5 })];
    const built = buildBookLines('481', both, [mislabelled, onSevenAndAHalf], SCORERS, NOW_MICROS);
    expect(built.map((l) => l.lineTicks)).toEqual([70, 75]);
    expect(built[0]?.quotes.under).toEqual([]);
    expect(built[1]?.quotes.under.map((q) => q.commitmentHash)).toEqual([hash('b3')]);
  });

  it('leaves out a settled line and a line with no line value', () => {
    const settled = line({ speculationId: '1001', speculationStatus: 1, winSide: 'under' });
    const blank = line({ speculationId: '1009', lineTicks: null, line: null });
    expect(buildBookLines('481', [settled, blank], [body()], SCORERS, NOW_MICROS)).toEqual([]);
  });

  it('leaves out lines and quotes of another contest', () => {
    const other = line({ speculationId: '2001', contestId: '482', lineTicks: 85, line: 8.5 });
    // A well-formed quote on total 7.0 of contest 482, filed under that
    // contest's key, so it is takeable and is left out for its contest alone.
    const foreign = body({ commitmentHash: hash('c1'), contestId: '482', speculationKey: MORE_KEYS['c482-total-70'] });
    expect(takeableQuote(foreign, NOW_MICROS)).not.toBeNull();
    const built = buildBookLines('481', [lines[1]!, other], [foreign], SCORERS, NOW_MICROS);
    expect(built.map((l) => l.speculationId)).toEqual(['1001']);
    expect(built[0]?.quotes.under).toEqual([]);
  });

  it('orders two lines with the same market and line by their id, whatever order they arrived in', () => {
    const first = line({ speculationId: '1001' });
    const second = line({ speculationId: '1002' });
    expect(buildBookLines('481', [second, first], [], SCORERS, NOW_MICROS).map((l) => l.speculationId)).toEqual(['1001', '1002']);
    expect(buildBookLines('481', [first, second], [], SCORERS, NOW_MICROS).map((l) => l.speculationId)).toEqual(['1001', '1002']);
  });

  it('sorts a side best price first, then larger, then by hash', () => {
    const quotes = [
      body({ commitmentHash: hash('d4'), oddsTick: 210 }),
      body({ commitmentHash: hash('d2'), oddsTick: 205, remainingRiskAmount: '2000000' }),
      body({ commitmentHash: hash('d3'), oddsTick: 205, riskAmount: '9000000', remainingRiskAmount: '9000000' }),
      body({ commitmentHash: hash('d1'), oddsTick: 205, remainingRiskAmount: '2000000' }),
    ];
    const [total] = buildBookLines('481', [lines[1]!], quotes, SCORERS, NOW_MICROS);
    expect(total?.quotes.under.map((q) => q.commitmentHash)).toEqual([hash('d3'), hash('d1'), hash('d2'), hash('d4')]);
  });

  it('sorts the other side the same way', () => {
    // The same four quotes with their makers on the Under, so the reader gets the Over.
    const quotes = [
      body({ commitmentHash: hash('d4'), positionType: 1, oddsTick: 210 }),
      body({ commitmentHash: hash('d2'), positionType: 1, oddsTick: 205, remainingRiskAmount: '2000000' }),
      body({ commitmentHash: hash('d3'), positionType: 1, oddsTick: 205, riskAmount: '9000000', remainingRiskAmount: '9000000' }),
      body({ commitmentHash: hash('d1'), positionType: 1, oddsTick: 205, remainingRiskAmount: '2000000' }),
    ];
    const [total] = buildBookLines('481', [lines[1]!], quotes, SCORERS, NOW_MICROS);
    expect(total?.quotes.over.map((q) => q.commitmentHash)).toEqual([hash('d3'), hash('d1'), hash('d2'), hash('d4')]);
    expect(total?.quotes.under).toEqual([]);
  });
});

/** Each line as its id and the hashes on each of its four sides. */
function sidesByLine(built: readonly BookLine[]): Array<[string, string[], string[], string[], string[]]> {
  const hashes = (quotes: readonly TakeableQuote[]): string[] => quotes.map((q) => q.commitmentHash);
  return built.map((l) => [l.speculationId, hashes(l.quotes.away), hashes(l.quotes.home), hashes(l.quotes.over), hashes(l.quotes.under)]);
}

describe('buildBookLines: a quote goes where it is filed only when it was signed for that line', () => {
  const total70 = line({ speculationId: '1001', type: 'total', lineTicks: 70, line: 7 });
  const total75 = line({ speculationId: '1005', type: 'total', lineTicks: 75, line: 7.5 });
  const spread70 = line({ speculationId: '1007', type: 'spread', lineTicks: 70, line: 7 });

  it('attaches a quote filed under total 7.0 and signed for total 7.5 to neither line', () => {
    // Filed under one open line and signed for the other: matching on the key
    // alone puts it on 7.0, matching on the signed line alone puts it on 7.5.
    const crossed = body({ commitmentHash: hash('c7'), lineTicks: 75, speculationKey: KEYS['c481-total-70'] });
    const on70 = body({ commitmentHash: hash('c8') });
    const on75 = body({ commitmentHash: hash('c9'), lineTicks: 75, speculationKey: KEYS['c481-total-75'] });
    expect(takeableQuote(crossed, NOW_MICROS)).toBeNull();
    expect(takeableQuote(on70, NOW_MICROS)).not.toBeNull();
    expect(takeableQuote(on75, NOW_MICROS)).not.toBeNull();

    expect(sidesByLine(buildBookLines('481', [total70, total75], [crossed], SCORERS, NOW_MICROS))).toEqual([
      ['1001', [], [], [], []],
      ['1005', [], [], [], []],
    ]);
    expect(sidesByLine(buildBookLines('481', [total70, total75], [crossed, on70, on75], SCORERS, NOW_MICROS))).toEqual([
      ['1001', [], [], [], [hash('c8')]],
      ['1005', [], [], [], [hash('c9')]],
    ]);
  });

  it('attaches a quote filed under total 7.0 and signed with the spread scorer to nothing, and its twin to total 7.0', () => {
    // A spread line of 70 is open too, so matching on the scorer and the line
    // while ignoring the key would put the quote there.
    const otherScorer = body({ commitmentHash: hash('ca'), scorer: SCORERS.spread, lineTicks: 70, speculationKey: KEYS['c481-total-70'] });
    const twin = body({ commitmentHash: hash('cb'), scorer: SCORERS.total, lineTicks: 70, speculationKey: KEYS['c481-total-70'] });
    const onSpread = body({
      commitmentHash: hash('cc'),
      scorer: SCORERS.spread,
      marketType: 'spread',
      lineTicks: 70,
      speculationKey: MORE_KEYS['c481-spread-70'],
    });
    expect(takeableQuote(otherScorer, NOW_MICROS)).toBeNull();

    expect(sidesByLine(buildBookLines('481', [total70, spread70], [otherScorer], SCORERS, NOW_MICROS))).toEqual([
      ['1007', [], [], [], []],
      ['1001', [], [], [], []],
    ]);
    // The maker of each holds the upper side, so the reader gets home on the
    // spread and the under on the total.
    expect(sidesByLine(buildBookLines('481', [total70, spread70], [otherScorer, twin, onSpread], SCORERS, NOW_MICROS))).toEqual([
      ['1007', [], [hash('cc')], [], []],
      ['1001', [], [], [], [hash('cb')]],
    ]);
  });

  it('attaches a quote of -0 to a line of 0, and a quote of 0 to a line stored as -0', () => {
    const moneyline0 = line({ speculationId: '1000', type: 'moneyline', lineTicks: 0, line: null });
    const moneylineNeg0 = line({ speculationId: '1000', type: 'moneyline', lineTicks: -0, line: null });
    const fields = { scorer: SCORERS.moneyline, marketType: 'moneyline' as const, speculationKey: KEYS['c481-moneyline'] };
    const negZero = body({ ...fields, commitmentHash: hash('cd'), lineTicks: -0 });
    const zero = body({ ...fields, commitmentHash: hash('ce'), lineTicks: 0 });
    expect(Object.is(negZero.lineTicks, -0)).toBe(true);
    expect(Object.is(moneylineNeg0.lineTicks, -0)).toBe(true);
    expect(sidesByLine(buildBookLines('481', [moneyline0], [negZero], SCORERS, NOW_MICROS))).toEqual([['1000', [], [hash('cd')], [], []]]);
    expect(sidesByLine(buildBookLines('481', [moneylineNeg0], [zero], SCORERS, NOW_MICROS))).toEqual([['1000', [], [hash('ce')], [], []]]);
    // Nearest refusal: the same -0 quote filed under the key of total 0.
    const misfiled = body({ ...fields, commitmentHash: hash('cf'), lineTicks: -0, speculationKey: MORE_KEYS['c481-total-0'] });
    expect(sidesByLine(buildBookLines('481', [moneyline0], [misfiled], SCORERS, NOW_MICROS))).toEqual([['1000', [], [], [], []]]);
  });
});

describe('buildBookLines: a line with an outcome is not open, whatever its status says', () => {
  // Every case keeps speculationStatus at 0, the open status, so the check on
  // the status cannot be the one leaving the line out.
  const decided: Array<[string, Partial<Speculation>]> = [
    ['a winner', { winSide: 'under' }],
    ['a push', { winSide: 'push' }],
    ['void as its outcome', { winSide: 'void' }],
    ['voided and no outcome', { voided: true }],
    ['voided and void as its outcome', { winSide: 'void', voided: true }],
  ];

  it('keeps the open twin, with its quote', () => {
    expect(line().speculationStatus).toBe(0);
    expect(sidesByLine(buildBookLines('481', [line()], [body()], SCORERS, NOW_MICROS))).toEqual([['1001', [], [], [], [hash('a1')]]]);
  });

  for (const [what, change] of decided) {
    it(`leaves out a line with status open and ${what}`, () => {
      const closed = line({ ...change, speculationStatus: 0 });
      expect(buildBookLines('481', [closed], [body()], SCORERS, NOW_MICROS)).toEqual([]);
      // Beside an open line of another value, only the open one is listed.
      const open75 = line({ speculationId: '1005', lineTicks: 75, line: 7.5 });
      expect(buildBookLines('481', [closed, open75], [body()], SCORERS, NOW_MICROS).map((l) => l.speculationId)).toEqual(['1005']);
    });
  }

  it('leaves out a line whose status is closed though it carries no outcome', () => {
    // The mirror of the cases above: only the status says this line is closed.
    const closed = line({ speculationStatus: 1, winSide: null, voided: false });
    expect(buildBookLines('481', [closed], [body()], SCORERS, NOW_MICROS)).toEqual([]);
  });
});

/**
 * buildBookLines hashes each line once and matches quotes to it by where they
 * are filed and what they were signed for; takeableQuote hashes each quote.
 * The two must reach the same answer: a quote is on some line exactly when
 * takeableQuote takes it and a line with its signed contest, scorer and line
 * value exists.
 *
 * The total scorer here is an address with letters, written in mixed case in
 * the scorer config, so a comparison that does not fold case shows. Each row
 * names the line the quote belongs on, or null; that literal is checked
 * against both functions.
 */
describe('buildBookLines agrees with takeableQuote', () => {
  const LETTERED = '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD';
  const LETTERED_LOWER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const scorers = { moneyline: SCORERS.moneyline, spread: SCORERS.spread, total: LETTERED };
  /** The scorer of each market as the lines are signed for, lower case. */
  const scorerOf: Record<Speculation['type'], string> = {
    moneyline: '0x1111111111111111111111111111111111111111',
    spread: '0x2222222222222222222222222222222222222222',
    total: LETTERED_LOWER,
  };
  const lines = [
    line({ speculationId: '1000', type: 'moneyline', lineTicks: 0, line: null }),
    line({ speculationId: '1002', type: 'spread', lineTicks: -15, line: -1.5 }),
    line({ speculationId: '1001', type: 'total', lineTicks: 70, line: 7 }),
    line({ speculationId: '1005', type: 'total', lineTicks: 75, line: 7.5 }),
  ];
  const base: Partial<CommitmentBody> = { scorer: LETTERED_LOWER, lineTicks: 70, speculationKey: MORE_KEYS['c481-lettered-scorer-70'] };
  const moneyline = { scorer: SCORERS.moneyline, marketType: 'moneyline' as const, lineTicks: 0, speculationKey: KEYS['c481-moneyline'] };
  const spread = { scorer: SCORERS.spread, marketType: 'spread' as const, lineTicks: -15, speculationKey: KEYS['c481-spread--15'] };

  const rows: Array<[string, Partial<CommitmentBody>, string | null]> = [
    ['total 7.0 under its own key', {}, '1001'],
    ['its scorer in upper case', { scorer: '0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD' }, '1001'],
    ['its scorer in the mixed case the config writes', { scorer: LETTERED }, '1001'],
    ['its key in upper case', { speculationKey: '0x0068B95E5ABB87F19448E26101BDD0BAED8818238F029C081A773F31464D3F5C' }, '1001'],
    ['total 7.5 under its own key', { lineTicks: 75, speculationKey: MORE_KEYS['c481-lettered-scorer-75'] }, '1005'],
    ['signed for 7.5 and filed under the key of 7.0', { lineTicks: 75 }, null],
    ['signed for 7.0 and filed under the key of 7.5', { speculationKey: MORE_KEYS['c481-lettered-scorer-75'] }, null],
    ['signed with the spread scorer and filed under the key of total 7.0', { scorer: SCORERS.spread }, null],
    // Takeable: the key is its own. No line is on that scorer.
    ['signed with a scorer no line uses, under that scorer\'s own key', { scorer: SCORERS.total, speculationKey: KEYS['c481-total-70'] }, null],
    // Takeable: the key is its own. The lines are of contest 481.
    ['of contest 482, under that contest\'s key', { contestId: '482', scorer: SCORERS.total, speculationKey: MORE_KEYS['c482-total-70'] }, null],
    ['of contest 481, filed under a key of contest 482', { speculationKey: MORE_KEYS['c482-total-70'] }, null],
    // Filed under the key of an open line of contest 481, with that line's
    // scorer and value: only its contest keeps it off that line.
    ['of contest 482, filed under the key of total 7.0 of contest 481', { contestId: '482' }, null],
    ['a moneyline under its own key', { ...moneyline }, '1000'],
    ['a moneyline of -0 under the key of 0', { ...moneyline, lineTicks: -0 }, '1000'],
    ['a moneyline filed under the key of total 0', { ...moneyline, speculationKey: MORE_KEYS['c481-total-0'] }, null],
    ['a spread of -1.5 under its own key', { ...spread }, '1002'],
    // Takeable: the key is its own. No spread of +1.5 is open.
    ['a spread of +1.5 under its own key', { ...spread, lineTicks: 15, speculationKey: KEYS['c481-spread-15'] }, null],
    ['a spread of -1.5 filed under the key of +1.5', { ...spread, speculationKey: KEYS['c481-spread-15'] }, null],
    ['its key followed by a line break', { speculationKey: `${MORE_KEYS['c481-lettered-scorer-70']}\n` }, null],
    ['no key', { speculationKey: null }, null],
    ['a key that is a number', { speculationKey: mistyped<string>(70) }, null],
    ['its key inside a list', { speculationKey: mistyped<string>([MORE_KEYS['c481-lettered-scorer-70']]) }, null],
    ['its scorer inside a list', { scorer: mistyped<string>([LETTERED_LOWER]) }, null],
    ['a scorer of 39 hex characters', { scorer: '0xabcdefabcdefabcdefabcdefabcdefabcdefabc' }, null],
    ['a hash that is a number', { commitmentHash: mistyped<string>(42) }, null],
    ['its hash inside a list', { commitmentHash: mistyped<string>([hash('a1')]) }, null],
    ['a maker that is a number', { maker: mistyped<string>(170) }, null],
    ['a maker that is an object answering the maker', { maker: mistyped<string>({ toLowerCase: () => MAKER_A }) }, null],
    ['a line of 1.5 ticks', { lineTicks: 1.5 }, null],
    ['no signature', { signature: null }, null],
    ['an expiry two minutes away', { expiry: '2026-09-27T12:02:00+00:00' }, null],
    ['hidden from the book', { bookVisible: false }, null],
  ];

  it('the table holds takeable quotes on lines, takeable quotes on no line, and quotes not takeable', () => {
    expect(rows).toHaveLength(32);
    expect(rows.filter(([, , on]) => on !== null)).toHaveLength(8);
    // Takeable and on no line: the three rows marked so above.
    const takenOffLine = rows.filter(([, change, on]) => on === null && takeableQuote(body({ ...base, ...change }), NOW_MICROS) !== null);
    expect(takenOffLine.map(([what]) => what)).toEqual([
      'signed with a scorer no line uses, under that scorer\'s own key',
      'of contest 482, under that contest\'s key',
      'a spread of +1.5 under its own key',
    ]);
  });

  for (const [what, change, expected] of rows) {
    it(`puts a quote with ${what} on ${expected ?? 'no line'}, by both functions`, () => {
      const quote = body({ ...base, ...change });
      let taken: TakeableQuote | null | undefined;
      expect(() => {
        taken = takeableQuote(quote, NOW_MICROS);
      }).not.toThrow();
      // A line with the quote's signed fields, found without either function.
      const signedLine =
        taken === null || taken === undefined
          ? undefined
          : lines.find((l) => l.contestId === quote.contestId && scorerOf[l.type] === String(quote.scorer).toLowerCase() && l.lineTicks === quote.lineTicks);
      expect(signedLine?.speculationId ?? null).toBe(expected);

      const built = buildBookLines('481', lines, [quote], scorers, NOW_MICROS);
      const attached = built.filter((l) => sidesOf(l.market).some((side) => l.quotes[side].length > 0)).map((l) => l.speculationId);
      expect(attached).toEqual(expected === null ? [] : [expected]);
    });
  }

  it('puts every row on its line when all of them are in one book', () => {
    // Each row gets a hash of its own, unless the row is about its hash.
    const quotes = rows.map(([, change], index) => body({ ...base, commitmentHash: hash((0x10 + index).toString(16)), ...change }));
    const built = buildBookLines('481', lines, quotes, scorers, NOW_MICROS);
    const onLine = (id: string): string[] => {
      const found = built.find((l) => l.speculationId === id);
      return found === undefined ? [] : sidesOf(found.market).flatMap((side) => found.quotes[side].map((q) => q.commitmentHash)).sort();
    };
    expect(built.map((l) => l.speculationId)).toEqual(['1000', '1002', '1001', '1005']);
    expect(onLine('1000')).toEqual([hash('1c'), hash('1d')]);
    expect(onLine('1002')).toEqual([hash('1f')]);
    expect(onLine('1001')).toEqual([hash('10'), hash('11'), hash('12'), hash('13')]);
    expect(onLine('1005')).toEqual([hash('14')]);
  });

  it('refuses a contest id written with a leading zero in both functions, and takes its canonical twin in both', () => {
    // `0481` hashes to contest 481's key, so only the shape of the id can
    // refuse it; compared as text it is not contest `481`.
    const attachedIn = (built: ReturnType<typeof buildBookLines>): boolean =>
      built.some((l) => sidesOf(l.market).some((side) => l.quotes[side].length > 0));

    const padded = body({ ...base, contestId: '0481' });
    expect(takeableQuote(padded, NOW_MICROS)).toBeNull();
    expect(attachedIn(buildBookLines('481', lines, [padded], scorers, NOW_MICROS))).toBe(false);
    expect(attachedIn(buildBookLines('0481', lines, [padded], scorers, NOW_MICROS))).toBe(false);

    const canonical = body({ ...base, contestId: '481' });
    expect(takeableQuote(canonical, NOW_MICROS)).not.toBeNull();
    expect(attachedIn(buildBookLines('481', lines, [canonical], scorers, NOW_MICROS))).toBe(true);
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
    // At 2.50 alone the same 3_000_000 would have won 2_000_000.
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

  it('has nothing to choose when no quote can be taken for any amount', () => {
    // Neither too small nor unfunded: nothing left, and a price outside the range.
    const empty = quote({ commitmentHash: hash('f7'), remainingMakerRisk: 0n });
    const unpriced = quote({ commitmentHash: hash('f8'), makerOddsTick: 100 });
    expect(chooseQuote([empty], 2_000_000n, nothingKnown)).toEqual({ ok: false, reason: 'no_quotes' });
    expect(chooseQuote([empty, unpriced], 2_000_000n, nothingKnown)).toEqual({ ok: false, reason: 'no_quotes' });
  });

  it('measures "the most of it" by what the taker risks, not by the maker risk consumed', () => {
    // The two measures disagree here. At 1.50 a taker risks half the maker
    // risk taken; at 3.00, twice it.
    const moreMakerRisk = quote({ commitmentHash: hash('e9'), makerOddsTick: 150, remainingMakerRisk: 4_000_000n });
    const absorbsMore = quote({ commitmentHash: hash('ea'), makerOddsTick: 300, remainingMakerRisk: 3_000_000n });
    // Each alone: 4_000_000 * 50 / 100 = 2_000_000 and 3_000_000 * 200 / 100 = 6_000_000.
    expect(chooseQuote([moreMakerRisk], 10_000_000n, nothingKnown)).toMatchObject({
      ok: true,
      plan: { reduced: true, takerRisk: 2_000_000n, fillMakerRisk: 4_000_000n },
    });
    expect(chooseQuote([absorbsMore], 10_000_000n, nothingKnown)).toMatchObject({
      ok: true,
      plan: { reduced: true, takerRisk: 6_000_000n, fillMakerRisk: 3_000_000n },
    });
    // Together, in either order: the one with LESS maker risk, which absorbs more.
    for (const both of [
      [moreMakerRisk, absorbsMore],
      [absorbsMore, moreMakerRisk],
    ]) {
      expect(chooseQuote(both, 10_000_000n, nothingKnown)).toMatchObject({
        ok: true,
        quote: { commitmentHash: hash('ea') },
        plan: { reduced: true, takerRisk: 6_000_000n, fillMakerRisk: 3_000_000n },
      });
    }
  });

  it('reports the unfunded maker when one quote is too small for the amount and the other is unfunded', () => {
    const at205 = quote({ commitmentHash: hash('f5'), maker: MAKER_A, makerOddsTick: 205 });
    const at150 = quote({ commitmentHash: hash('f6'), maker: MAKER_B, makerOddsTick: 150 });
    const short = new Map<string, MakerBacking>([[MAKER_B, { backing: 0n, fresh: true }]]);
    // 60 is under the 104 that fills a lot at 2.05.
    expect(chooseQuote([at205], 60n, short)).toEqual({ ok: false, reason: 'too_small', minTakerRisk: 104n });
    // At 1.50 it fills one lot, from a maker with the funds or with none known.
    expect(chooseQuote([at150], 60n, nothingKnown)).toMatchObject({
      ok: true,
      plan: { fillMakerRisk: 100n, takerRisk: 50n, reduced: false },
    });
    // The same quote from a maker known to have nothing.
    expect(chooseQuote([at150], 60n, short)).toEqual({ ok: false, reason: 'maker_unfunded' });
    // Both apply. 104 would be the wrong thing to say: a funded maker at 1.50 takes 60.
    expect(chooseQuote([at205, at150], 60n, short)).toEqual({ ok: false, reason: 'maker_unfunded' });
    expect(chooseQuote([at150, at205], 60n, short)).toEqual({ ok: false, reason: 'maker_unfunded' });
  });
});

/**
 * `better`: the best-priced quote that was passed over for being too small to
 * fill the amount asked.
 *
 * The better-priced quotes below are posted at 1.80 or 1.50, not 2.00, so the
 * most a taker can risk against one is NOT the maker risk it has left: at 1.80
 * it is 80% of it. Every case also asserts the quote chosen and its whole
 * plan, which are what they are without the better-priced quote in the list.
 */
describe('chooseQuote: a better price that was passed over', () => {
  const nothingKnown = new Map<string, MakerBacking>();

  const smaller = quote({ commitmentHash: hash('b1'), maker: MAKER_A, makerOddsTick: 180, remainingMakerRisk: 5_000_000n });
  const deep = quote({ commitmentHash: hash('b2'), maker: MAKER_B, makerOddsTick: 205, remainingMakerRisk: 50_000_000n });

  /**
   * 6_000_000 against the deep quote at 2.05, by the contract's rule:
   * ceil(6_000_000 * 100 / 105) = 5_714_286, down to the lot 5_714_200, and
   * 5_714_200 * 105 / 100 = 5_999_910.
   */
  const deepPlan = {
    requestedTakerRisk: 6_000_000n,
    takerDesiredRisk: 6_000_000n,
    fillMakerRisk: 5_714_200n,
    takerRisk: 5_999_910n,
    takerProfit: 5_714_200n,
    reduced: false,
    takerOddsTick: 195,
  };

  it('the fixture is what the cases below take it to be', () => {
    // The smaller quote absorbs 5_000_000 * 80 / 100 = 4_000_000 and no more.
    expect(chooseQuote([smaller], 6_000_000n, nothingKnown)).toMatchObject({
      ok: true,
      quote: { commitmentHash: hash('b1') },
      plan: { reduced: true, takerDesiredRisk: 4_000_000n, takerRisk: 4_000_000n, fillMakerRisk: 5_000_000n },
    });
    // The deep one fills 6_000_000 whole, and alone has nothing better to report.
    expect(chooseQuote([deep], 6_000_000n, nothingKnown)).toEqual({
      ok: true,
      quote: deep,
      plan: deepPlan,
      fundingConfirmed: false,
      better: undefined,
    });
  });

  it('is reported when a better-priced quote could not fill the amount', () => {
    for (const both of [
      [smaller, deep],
      [deep, smaller],
    ]) {
      expect(chooseQuote(both, 6_000_000n, nothingKnown)).toEqual({
        ok: true,
        quote: deep,
        plan: deepPlan,
        fundingConfirmed: false,
        better: { makerOddsTick: 180, maxTakerRisk: 4_000_000n },
      });
    }
  });

  it('is absent when the best price is the one chosen', () => {
    // 4_000_000 is exactly what the smaller quote absorbs: 4_000_000 * 100 / 80 = 5_000_000.
    const choice = chooseQuote([smaller, deep], 4_000_000n, nothingKnown);
    expect(choice).toEqual({
      ok: true,
      quote: smaller,
      plan: {
        requestedTakerRisk: 4_000_000n,
        takerDesiredRisk: 4_000_000n,
        fillMakerRisk: 5_000_000n,
        takerRisk: 4_000_000n,
        takerProfit: 5_000_000n,
        reduced: false,
        takerOddsTick: 225,
      },
      fundingConfirmed: false,
      better: undefined,
    });
    expect(choice.ok && choice.better).toBeUndefined();
  });

  it('is absent when the better-priced maker is known to be short of what is left', () => {
    // Taking all of the smaller quote needs 5_000_000 from its maker.
    const oneShort = new Map<string, MakerBacking>([[MAKER_A, { backing: 4_999_999n, fresh: true }]]);
    const choice = chooseQuote([smaller, deep], 6_000_000n, oneShort);
    expect(choice).toEqual({ ok: true, quote: deep, plan: deepPlan, fundingConfirmed: false, better: undefined });
    expect(choice.ok && choice.better).toBeUndefined();
  });

  it('is reported when that maker has exactly what is left, or when the snapshot is too old to say', () => {
    const exact = new Map<string, MakerBacking>([[MAKER_A, { backing: 5_000_000n, fresh: true }]]);
    expect(chooseQuote([smaller, deep], 6_000_000n, exact)).toEqual({
      ok: true,
      quote: deep,
      plan: deepPlan,
      fundingConfirmed: false,
      better: { makerOddsTick: 180, maxTakerRisk: 4_000_000n },
    });
    const shortButStale = new Map<string, MakerBacking>([[MAKER_A, { backing: 4_999_999n, fresh: false }]]);
    expect(chooseQuote([smaller, deep], 6_000_000n, shortButStale)).toEqual({
      ok: true,
      quote: deep,
      plan: deepPlan,
      fundingConfirmed: false,
      better: { makerOddsTick: 180, maxTakerRisk: 4_000_000n },
    });
  });

  it('is absent when the better-priced quote has less than one lot left', () => {
    const underOneLot = quote({ commitmentHash: hash('b3'), makerOddsTick: 180, remainingMakerRisk: 99n });
    const choice = chooseQuote([underOneLot, deep], 6_000_000n, nothingKnown);
    expect(choice).toEqual({ ok: true, quote: deep, plan: deepPlan, fundingConfirmed: false, better: undefined });
    expect(choice.ok && choice.better).toBeUndefined();
    const nothingLeft = quote({ commitmentHash: hash('b4'), makerOddsTick: 180, remainingMakerRisk: 0n });
    expect(chooseQuote([nothingLeft, deep], 6_000_000n, nothingKnown)).toEqual({
      ok: true,
      quote: deep,
      plan: deepPlan,
      fundingConfirmed: false,
      better: undefined,
    });
  });

  it('is reported when the better-priced quote has exactly one lot left', () => {
    // 100 * 80 / 100 = 80.
    const oneLot = quote({ commitmentHash: hash('b5'), makerOddsTick: 180, remainingMakerRisk: 100n });
    expect(chooseQuote([oneLot, deep], 6_000_000n, nothingKnown)).toEqual({
      ok: true,
      quote: deep,
      plan: deepPlan,
      fundingConfirmed: false,
      better: { makerOddsTick: 180, maxTakerRisk: 80n },
    });
  });

  it('is the best-priced of two that were passed over, not the larger and not the last', () => {
    // 1_000_000 * 50 / 100 = 500_000 at 1.50; 2_000_000 * 80 / 100 = 1_600_000 at 1.80.
    const at150 = quote({ commitmentHash: hash('b6'), makerOddsTick: 150, remainingMakerRisk: 1_000_000n });
    const at180 = quote({ commitmentHash: hash('b7'), makerOddsTick: 180, remainingMakerRisk: 2_000_000n });
    for (const three of [
      [at150, at180, deep],
      [at180, deep, at150],
      [deep, at180, at150],
    ]) {
      expect(chooseQuote(three, 6_000_000n, nothingKnown)).toEqual({
        ok: true,
        quote: deep,
        plan: deepPlan,
        fundingConfirmed: false,
        better: { makerOddsTick: 150, maxTakerRisk: 500_000n },
      });
    }
  });

  it('skips a better-priced maker who is short and reports the next best price', () => {
    const at150 = quote({ commitmentHash: hash('b6'), maker: MAKER_A, makerOddsTick: 150, remainingMakerRisk: 1_000_000n });
    const at180 = quote({ commitmentHash: hash('b7'), maker: MAKER_B, makerOddsTick: 180, remainingMakerRisk: 2_000_000n });
    const funded = quote({ commitmentHash: hash('b8'), maker: '0xdddddddddddddddddddddddddddddddddddddddd', makerOddsTick: 205, remainingMakerRisk: 50_000_000n });
    const short = new Map<string, MakerBacking>([[MAKER_A, { backing: 999_999n, fresh: true }]]);
    expect(chooseQuote([at150, at180, funded], 6_000_000n, short)).toEqual({
      ok: true,
      quote: funded,
      plan: deepPlan,
      fundingConfirmed: false,
      better: { makerOddsTick: 180, maxTakerRisk: 1_600_000n },
    });
  });

  describe('when the chosen quote is itself a partial take', () => {
    const larger = quote({ commitmentHash: hash('b9'), maker: MAKER_B, makerOddsTick: 205, remainingMakerRisk: 5_000_000n });
    /** Everything the larger quote has left: 5_000_000 * 105 / 100 = 5_250_000. */
    const largerPlan = {
      requestedTakerRisk: 10_000_000n,
      takerDesiredRisk: 5_250_000n,
      fillMakerRisk: 5_000_000n,
      takerRisk: 5_250_000n,
      takerProfit: 5_000_000n,
      reduced: true,
      takerOddsTick: 195,
    };

    it('the larger quote alone is a partial take with nothing better to report', () => {
      expect(chooseQuote([larger], 10_000_000n, nothingKnown)).toEqual({
        ok: true,
        quote: larger,
        plan: largerPlan,
        fundingConfirmed: false,
        better: undefined,
      });
    });

    it('reports a better-priced quote that absorbs less', () => {
      // 1_000_000 * 80 / 100 = 800_000 at 1.80, against 5_250_000 at 2.05.
      const small = quote({ commitmentHash: hash('ba'), maker: MAKER_A, makerOddsTick: 180, remainingMakerRisk: 1_000_000n });
      for (const both of [
        [small, larger],
        [larger, small],
      ]) {
        expect(chooseQuote(both, 10_000_000n, nothingKnown)).toEqual({
          ok: true,
          quote: larger,
          plan: largerPlan,
          fundingConfirmed: false,
          better: { makerOddsTick: 180, maxTakerRisk: 800_000n },
        });
      }
    });

    it('reports nothing when the smaller quote is at a worse price', () => {
      const worse = quote({ commitmentHash: hash('bb'), maker: MAKER_A, makerOddsTick: 250, remainingMakerRisk: 1_000_000n });
      const choice = chooseQuote([worse, larger], 10_000_000n, nothingKnown);
      expect(choice).toEqual({ ok: true, quote: larger, plan: largerPlan, fundingConfirmed: false, better: undefined });
      expect(choice.ok && choice.better).toBeUndefined();
    });

    it('reports nothing when the smaller quote is at the same price: the price must be strictly better', () => {
      const same = quote({ commitmentHash: hash('bc'), maker: MAKER_A, makerOddsTick: 205, remainingMakerRisk: 1_000_000n });
      const choice = chooseQuote([same, larger], 10_000_000n, nothingKnown);
      expect(choice).toEqual({ ok: true, quote: larger, plan: largerPlan, fundingConfirmed: false, better: undefined });
      expect(choice.ok && choice.better).toBeUndefined();
    });
  });
});
