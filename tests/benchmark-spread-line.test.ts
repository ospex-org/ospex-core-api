/**
 * The spread handicap's side, and the label that renders it — `ospex-core-api#71`.
 *
 * Pure functions, no I/O, split from `benchmark-picks-stats-handler.test.ts` the
 * same way `benchmark-standings-project.test.ts` is split from its handler file.
 *
 * ## What cannot be tested here, stated rather than implied
 *
 * `EXECUTED_MARKETS` in `src/v1/benchmark/picks.ts` contains `moneyline` and
 * `total` only, and the handler skips every other market, so **no handler-level
 * case can observe the spread branch at all**. `resolveSelectionSide` does run on
 * every served pick — a broken team lookup would 500 the endpoint, and the handler
 * file asserts that it does not — but its RESULT is consumed only by the spread
 * branch. So the sign logic below is unit-proven and install-unproven, which is
 * the honest position (`verification-discipline.md` 3i-install) and is why the
 * handler file also pins that no spread row is served and that `awayLine` /
 * `homeLine` are null on everything that is. When spread is enabled, that
 * assertion goes red and points whoever did it here.
 */
import { describe, expect, it } from 'vitest';

import {
  resolveSelectionSide,
  selectionLabel,
  spreadLines,
  type PickSide,
} from '../src/v1/benchmark/picks.js';

/**
 * The same two teams the handler fixture uses, on purpose — `New York Yankees`
 * away and `Toronto Blue Jays` home is the shape a real reveal carries, and the
 * away team is the one the benchmark's default selection names.
 */
const AWAY = { name: 'New York Yankees', abbreviation: 'NYY' };
const HOME = { name: 'Toronto Blue Jays', abbreviation: 'TOR' };

/**
 * BOTH sides at BOTH signs, which is the whole point of the table.
 *
 * One row cannot discriminate. A home row at `-1.5` is satisfied by "use the
 * stored value" AND by "negate it twice"; an away row at `-1.5` alone is
 * satisfied by "negate" AND by "always print the positive". Only the four
 * together leave "the away handicap is the negation of the stored home
 * handicap, and the home handicap is the stored one" as the single rule that
 * fits — which is what `ospex-benchmark/src/prompt.ts` says the producer stores.
 *
 * Every expectation is a literal. The label, the side and the pair are asserted
 * separately against literals rather than one being derived from another, so a
 * broken implementation cannot satisfy them by being consistently wrong.
 */
const SPREAD_MATRIX: Array<{
  homeLine: number;
  selection: string;
  side: PickSide;
  label: string;
  pair: { awayLine: number; homeLine: number };
}> = [
  // Away pick, home favoured. The #71 case: the old code printed `-1.5` here,
  // which names the opposite bet.
  { homeLine: -1.5, selection: 'New York Yankees', side: 'away', label: 'New York Yankees +1.5', pair: { awayLine: 1.5, homeLine: -1.5 } },
  // Away pick, home underdog. Same rule, other sign — this is the row that
  // refuses "always print a plus for the away side".
  { homeLine: 1.5, selection: 'New York Yankees', side: 'away', label: 'New York Yankees -1.5', pair: { awayLine: -1.5, homeLine: 1.5 } },
  // Home picks keep the stored value. These refuse "negate unconditionally".
  { homeLine: -1.5, selection: 'Toronto Blue Jays', side: 'home', label: 'Toronto Blue Jays -1.5', pair: { awayLine: 1.5, homeLine: -1.5 } },
  { homeLine: 1.5, selection: 'Toronto Blue Jays', side: 'home', label: 'Toronto Blue Jays +1.5', pair: { awayLine: -1.5, homeLine: 1.5 } },
  // A pick-em line is neutral on both sides.
  { homeLine: 0, selection: 'New York Yankees', side: 'away', label: 'New York Yankees 0', pair: { awayLine: 0, homeLine: 0 } },
  { homeLine: 0, selection: 'Toronto Blue Jays', side: 'home', label: 'Toronto Blue Jays 0', pair: { awayLine: 0, homeLine: 0 } },
];

describe('resolveSelectionSide', () => {
  it.each(SPREAD_MATRIX)('resolves $selection to the $side side', ({ selection, side }) => {
    expect(resolveSelectionSide(selection, AWAY, HOME)).toBe(side);
  });

  it.each([
    ['NYY', 'away'],
    ['TOR', 'home'],
  ] as Array<[string, PickSide]>)('resolves the abbreviation %s to %s', (selection, side) => {
    expect(resolveSelectionSide(selection, AWAY, HOME)).toBe(side);
  });

  it.each([
    '  New York Yankees  ',
    'new york yankees',
    'NEW YORK YANKEES',
    '  nyy',
  ])('tolerates drift between the bundle copy and teams: %s', (selection) => {
    expect(resolveSelectionSide(selection, AWAY, HOME)).toBe('away');
  });

  it.each([
    ['a third team', 'Boston Red Sox'],
    ['a substring of a real name', 'Yankees'],
    ['a superstring of a real name', 'New York Yankees AL'],
    ['the empty string', ''],
    ['whitespace only', '   '],
  ])('refuses to decide on %s', (_why, selection) => {
    // No fuzzy matching: a partial name is exactly as undecidable as a wrong
    // one. `Yankees` is the case that matters, because it is what a short-name
    // consumer would send and a `includes()` implementation would accept.
    expect(resolveSelectionSide(selection, AWAY, HOME)).toBeNull();
  });

  it('refuses a null selection', () => {
    expect(resolveSelectionSide(null, AWAY, HOME)).toBeNull();
  });

  it('refuses when both sides present the same identity', () => {
    // The one reachable both-sides state: an unresolved team id falls back to the
    // shared UNKNOWN_TEAM sentinel, so a game missing both teams offers two
    // identical sides. Matching both must read as undecidable, not as `away`
    // because it was tested first.
    const unknown = { name: 'Unknown', abbreviation: '???' };
    expect(resolveSelectionSide('Unknown', unknown, unknown)).toBeNull();
    expect(resolveSelectionSide('???', unknown, unknown)).toBeNull();
  });

  it('still resolves the other side when only one team is unknown', () => {
    // Negative control for the case above: a single missing team must not take
    // the whole label down with it.
    const unknown = { name: 'Unknown', abbreviation: '???' };
    expect(resolveSelectionSide('Toronto Blue Jays', unknown, HOME)).toBe('home');
    expect(resolveSelectionSide('New York Yankees', AWAY, unknown)).toBe('away');
  });
});

describe('spreadLines', () => {
  it.each(SPREAD_MATRIX)('derives the pair from a stored home handicap of $homeLine', ({ homeLine, pair }) => {
    expect(spreadLines(homeLine)).toEqual(pair);
  });

  it('carries null through', () => {
    expect(spreadLines(null)).toEqual({ awayLine: null, homeLine: null });
  });

  it('normalises zero rather than negating it into -0', () => {
    // `toEqual` does not separate -0 from 0, so the guard has to say `Object.is`
    // or it is not asserting the thing it was written for.
    expect(Object.is(spreadLines(0).awayLine, 0)).toBe(true);
    expect(Object.is(spreadLines(0).awayLine, -0)).toBe(false);
  });
});

describe('selectionLabel — spread', () => {
  it.each(SPREAD_MATRIX)('labels $selection at a stored $homeLine as $label', ({ homeLine, selection, side, label }) => {
    expect(selectionLabel('spread', selection, homeLine, null, side)).toBe(label);
  });

  it.each([-1.5, 0, 1.5])('appends no number at all when the side is undecided (stored %s)', (homeLine) => {
    // Both signs, because a label that happened to print the right number for one
    // of them would not be distinguishable from one that refused.
    expect(selectionLabel('spread', 'Boston Red Sox', homeLine, null, null)).toBe('Boston Red Sox');
  });

  it('appends no number when the stored handicap is null', () => {
    expect(selectionLabel('spread', 'New York Yankees', null, null, 'away')).toBe('New York Yankees');
  });

  it('returns null for a null selection', () => {
    expect(selectionLabel('spread', null, -1.5, null, 'away')).toBeNull();
  });
});

describe('selectionLabel — the side must not leak into the other markets', () => {
  /**
   * Looks like filler and is not: this is the assertion that catches a
   * `selectionLabel` consulting `side` outside the spread branch. Moneyline
   * renders the American price and total renders a perspective-neutral
   * threshold, so for both of them the side is information the label must
   * ignore — and the invariant is "this input changes nothing".
   */
  it.each([['away'], ['home'], [null]] as Array<[PickSide | null]>)(
    'moneyline renders the same with side %s',
    (side) => {
      expect(selectionLabel('moneyline', 'New York Yankees', null, -124, side)).toBe('New York Yankees -124');
    },
  );

  it.each([['away'], ['home'], [null]] as Array<[PickSide | null]>)(
    'total renders the same with side %s',
    (side) => {
      expect(selectionLabel('total', 'under', 8.5, null, side)).toBe('Under 8.5');
    },
  );

  it('a total line is never negated, whichever side is passed', () => {
    // A total's number is perspective-neutral. If the spread normalisation ever
    // migrated up out of its branch, this is where it would show.
    expect(selectionLabel('total', 'over', -8.5, null, 'away')).toBe('Over -8.5');
  });
});
