/**
 * Scorer-address ↔ market-type mapping. Pure functions — the caller
 * supplies the configured scorer addresses (so this module isn't
 * coupled to the env layer and works for any network).
 *
 * On the contracts side: each market type has a dedicated scorer
 * contract (Moneyline / Spread / Total). A speculation row's
 * `speculation_scorer` column stores one of those three addresses;
 * this maps it back to a human-readable market type.
 */

export type MarketType = 'moneyline' | 'spread' | 'total';

/**
 * On-chain `WinSide` enum values as projected onto the `speculations.win_side`
 * column (Postgres enum, NOT NULL, default `'tbd'`). `'tbd'` is the
 * pre-settlement sentinel; the settle handler flips it to a concrete value
 * atomically with `speculation_status='closed'` and `settled_at`.
 */
export type WinSide = 'tbd' | 'away' | 'home' | 'over' | 'under' | 'push' | 'void';

/**
 * A settled `WinSide` — every value except the `'tbd'` sentinel. This is what
 * the wire exposes as `Speculation.winSide` once `'tbd'` is mapped to `null`.
 */
export type SettledWinSide = Exclude<WinSide, 'tbd'>;

export interface ScorerAddresses {
  moneyline: string;
  spread: string;
  total: string;
}

/**
 * Map a speculationScorer address to a market type. Case-insensitive.
 */
export function scorerToType(
  scorerAddress: string,
  scorers: ScorerAddresses,
): MarketType | null {
  const addr = scorerAddress.toLowerCase();
  if (addr === scorers.moneyline.toLowerCase()) return 'moneyline';
  if (addr === scorers.spread.toLowerCase()) return 'spread';
  if (addr === scorers.total.toLowerCase()) return 'total';
  return null;
}

/**
 * Replays the on-chain scorer logic in TS — mirrors
 * `MoneylineScorerModule._scoreMoneyline`, `SpreadScorerModule._scoreSpread`
 * and `TotalScorerModule._scoreTotal`.
 *
 * `lineTicks` semantics (from the speculation, not the contest's stored
 * default odds):
 *   - moneyline: ignored
 *   - spread:    int32 in 10x domain (away-side adjustment); push if
 *                `awayScore*10 + lineTicks == homeScore*10`
 *   - total:     int32 in 10x domain; push if `(away+home)*10 == lineTicks`
 *
 * Returns `null` if the inputs are inconsistent (e.g. scores missing even
 * though contest_status='scored'). Callers skip the row in that case rather
 * than emitting a misleading prediction.
 *
 * ## Why it lives here
 *
 * It was duplicated, byte for byte, in `v1/ownState/positionStatus.ts` and
 * `v1/utils/positionFetch.ts` — each carrying a comment telling the reader it
 * "must match" the other, which is a rule a comment cannot enforce. A third
 * consumer (the benchmark executed-record projection) made the third copy the
 * moment to collapse them: the two originals were verified identical before the
 * move, and the ownState and positionFetch suites are the control that the move
 * changed nothing.
 */
export function predictWinSide(
  market: MarketType,
  awayScore: number,
  homeScore: number,
  lineTicks: number | null,
): 'away' | 'home' | 'over' | 'under' | 'push' | null {
  if (market === 'moneyline') {
    if (awayScore > homeScore) return 'away';
    if (homeScore > awayScore) return 'home';
    return 'push';
  }
  if (market === 'spread') {
    if (lineTicks == null) return null;
    const scaledAway = awayScore * 10;
    const scaledHome = homeScore * 10;
    const adjustedAway = scaledAway + lineTicks;
    if (adjustedAway > scaledHome) return 'away';
    if (adjustedAway < scaledHome) return 'home';
    return 'push';
  }
  // total
  if (lineTicks == null) return null;
  const scaledTotal = (awayScore + homeScore) * 10;
  if (scaledTotal > lineTicks) return 'over';
  if (scaledTotal < lineTicks) return 'under';
  return 'push';
}

/**
 * Did this position win?
 *   upper (0) wins on win_side in {away, over}
 *   lower (1) wins on win_side in {home, under}
 *
 * `push` and `void` are NOT wins and are not losses either — a caller must
 * handle both BEFORE consulting this predicate, or a push reads as a loss.
 */
export function didWin(positionType: 0 | 1, winSide: WinSide): boolean {
  if (positionType === 0) return winSide === 'away' || winSide === 'over';
  return winSide === 'home' || winSide === 'under';
}

/**
 * Inverse of `scorerToType`.
 */
export function typeToScorer(marketType: MarketType, scorers: ScorerAddresses): string {
  if (marketType === 'moneyline') return scorers.moneyline;
  if (marketType === 'spread') return scorers.spread;
  return scorers.total;
}

/**
 * Convert `line_ticks` (10x-scaled int32, 0 for moneyline) to a
 * human-readable line.
 *
 *   spread:    -35  →  -3.5
 *   total:     2250 →  225.0
 *   moneyline: 0    →  null
 *
 * The 10x scale is documented in the contract interfaces
 * (`IPositionModule.sol`, `IScorerModule.sol`, `ISpeculationModule.sol`):
 * "The line number (10x format, 0 for moneyline)". A previous version of
 * this helper used an older half-integer convention (`+ 0.5` / `- 0.5`)
 * which produced wrong values against the 10x scale — fixed.
 */
export function lineTicksToLine(type: MarketType, lineTicks: number | null): number | null {
  if (lineTicks === null) return null;
  if (type === 'moneyline') return null;
  return lineTicks / 10;
}
