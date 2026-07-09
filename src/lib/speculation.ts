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
