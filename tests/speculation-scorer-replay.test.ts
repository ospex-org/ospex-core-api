/**
 * `predictWinSide` / `didWin` — the on-chain scorer replay, swept at its
 * boundaries.
 *
 * These two were private copies in `v1/ownState/positionStatus.ts` and
 * `v1/utils/positionFetch.ts` (identical to the byte, verified before the
 * collapse) and are now one exported pair in `lib/speculation.ts`. Both callers
 * reach them only through `derivePositionStatus` / `fetchCategorizedPositions`,
 * which is why a real gap survived there: a mutation flipping the SPREAD push
 * boundary from `>` to `>=` — turning every spread push into an away win —
 * passed `ownState-positionStatus`, `positionFetch`, `positions-handlers` and
 * `ownState-hub` together, 57/57. Measured 2026-08-24.
 *
 * So the sweep is per-market and boundary-first: for each market the
 * strictly-above, exactly-equal and strictly-below cases, because only the
 * exactly-equal one separates `>` from `>=`. An extreme value satisfies every
 * candidate rule and would leave the same hole.
 */
import { describe, expect, it } from 'vitest';
import { didWin, predictWinSide } from '../src/lib/speculation.js';
import type { WinSide } from '../src/lib/speculation.js';

describe('predictWinSide — moneyline', () => {
  it('resolves by score, and an exact tie is a push', () => {
    expect(predictWinSide('moneyline', 5, 3, null)).toBe('away');
    expect(predictWinSide('moneyline', 3, 5, null)).toBe('home');
    expect(predictWinSide('moneyline', 4, 4, null)).toBe('push');
  });

  it('ignores lineTicks entirely', () => {
    expect(predictWinSide('moneyline', 4, 4, 999)).toBe('push');
    expect(predictWinSide('moneyline', 5, 3, -999)).toBe('away');
  });
});

describe('predictWinSide — spread', () => {
  /**
   * The handicap is applied to the AWAY side in the 10x domain:
   * `away*10 + lineTicks` against `home*10`. A -1.5 line is `lineTicks = -15`.
   */
  it('applies the away handicap in the 10x domain', () => {
    expect(predictWinSide('spread', 5, 3, -15)).toBe('away'); // 50-15=35 > 30
    expect(predictWinSide('spread', 4, 3, -15)).toBe('home'); // 40-15=25 < 30
    expect(predictWinSide('spread', 6, 3, -15)).toBe('away'); // 60-15=45 > 30
  });

  /**
   * THE CASE THAT WAS MISSING. Exactly on the number is a PUSH, and it is the
   * only input that separates `>` from `>=`: a whole-number line landed
   * exactly. `away*10 + lineTicks === home*10` — here 50 - 20 = 30.
   */
  it('is a push when the handicapped away score lands exactly on the home score', () => {
    expect(predictWinSide('spread', 5, 3, -20)).toBe('push');
    expect(predictWinSide('spread', 3, 5, 20)).toBe('push');
    expect(predictWinSide('spread', 4, 4, 0)).toBe('push');
  });

  it('is null without a line, because a spread has no verdict without one', () => {
    expect(predictWinSide('spread', 5, 3, null)).toBeNull();
  });
});

describe('predictWinSide — total', () => {
  it('compares the combined score in the 10x domain', () => {
    expect(predictWinSide('total', 5, 4, 85)).toBe('over'); // 90 > 85
    expect(predictWinSide('total', 4, 4, 85)).toBe('under'); // 80 < 85
  });

  /** The other `>`/`>=` boundary: a whole-number total landing exactly. */
  it('is a push when the combined score lands exactly on the line', () => {
    expect(predictWinSide('total', 5, 4, 90)).toBe('push');
  });

  it('is null without a line', () => {
    expect(predictWinSide('total', 5, 4, null)).toBeNull();
  });
});

describe('didWin', () => {
  /**
   * The full cross product of both position types against every `WinSide`
   * value, as a frozen table. `push` and `void` are false for BOTH sides,
   * which is the trap the callers' ordering exists to avoid — a caller that
   * consults `didWin` before handling push reads a push as a loss.
   */
  const TABLE: Array<[WinSide, boolean, boolean]> = [
    // winSide,  upper(0) wins, lower(1) wins
    ['away', true, false],
    ['over', true, false],
    ['home', false, true],
    ['under', false, true],
    ['push', false, false],
    ['void', false, false],
    ['tbd', false, false],
  ];

  for (const [winSide, upperWins, lowerWins] of TABLE) {
    it(`${winSide}: upper=${String(upperWins)} lower=${String(lowerWins)}`, () => {
      expect(didWin(0, winSide)).toBe(upperWins);
      expect(didWin(1, winSide)).toBe(lowerWins);
    });
  }

  it('never reports both sides winning, for any win side', () => {
    for (const [winSide] of TABLE) {
      expect(didWin(0, winSide) && didWin(1, winSide)).toBe(false);
    }
  });
});
