/**
 * The benchmark scorer's aggregation, reproduced.
 *
 * Pure functions, no I/O. Every rule here is a PORT of a specific expression in
 * `ospex-benchmark`, named at its definition, because the published scorecard
 * and this endpoint have to agree digit for digit: the acceptance for this
 * surface is that an auditor's query against the API reproduces the scorecard's
 * own numbers. Two implementations of one rule is the hazard; naming the
 * original at each site is the mitigation, since nothing in this repo can
 * import from that one (separate deployables, no shared package — the same
 * reasoning `src/v1/games.ts` applies to its RFC3339 grammar).
 *
 * ## Why aggregating the stored rows is EXACT rather than approximate
 *
 * The per-pick CLV is already rounded where it is computed — `clv.ts`'s
 * `economic = (qClose) => round4(100 * (entryDecimal * qClose - 1))` — so the
 * `numeric(12,6)` value in `benchmark_scores` is bit-for-bit the number the
 * scorer aggregates. This module therefore starts from the same inputs, and
 * only has to apply the same operations in the same order.
 *
 * ## The two clusterings are both published, and neither is a default
 *
 * `scoring.ts:clusterByGame` yields per-pick values AND per-game means, and
 * `aggregateByParticipant` publishes a summary over each. Game-level is the
 * scorer's PRIMARY (equal weight per game, so a slate where one game drew four
 * picks does not outvote three single-pick games); per-pick is secondary. Both
 * ship, always, for the same reason both CLV metrics ship: a reader who is
 * handed one of a pair cannot tell which one they were handed.
 *
 * ## The rounding is applied TWICE on the game-level path, deliberately
 *
 * `clusterByGame` builds `gameMeans` by calling `mean()` per game — which
 * rounds — and `summary()` then rounds the mean of those. Collapsing that into
 * one rounding at the end produces a different number in the last place:
 * buckets `[0.00005, 0.00005]` and `[1.0]` give 0.5001 with the inner round and
 * 0.5 without. The test file pins it.
 *
 * ## Input ORDER is part of the contract
 *
 * `mean()` sums in array order and float addition is not associative. Measured
 * over 20,000 random vectors of 3-42 four-decimal CLV values, 1.65% produced a
 * DIFFERENT `round4` result when the same values were summed in a different
 * order. So the caller must feed picks in a deterministic order — the read path
 * uses `benchmark_scores.id` ascending, which is the order the scored artifact
 * was written in — and the cluster buckets are a `Map`, whose iteration order
 * is first-appearance, matching the scorer's `[...byGame.values()]`. A plain
 * object would reorder integer-like keys and a `Set`-of-keys sort would reorder
 * everything.
 */

/** `scoring.ts:round4`. */
export function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/** `scoring.ts:mean` — null on an empty set, rounded. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return round4(values.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * `scoring.ts:median` — null on an empty set, rounded. Even-length takes the
 * unrounded midpoint of the two central values and rounds once, which is what
 * the scorer does; rounding the halves first would drift.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return round4(value);
}

/** `scoring.ts:ClvSummary`. */
export interface ClvSummary {
  meanClvPct: number | null;
  medianClvPct: number | null;
  beatClosePct: number | null;
}

/**
 * Frozen because these are shared singletons on a hot read path: an arm with no
 * scoreable picks gets the SAME object as every other such arm, so one caller
 * mutating it in place would rewrite every other arm's numbers in the same
 * response. Freezing turns that into a throw in strict mode instead of a
 * silent cross-contamination.
 */
export const EMPTY_SUMMARY: ClvSummary = Object.freeze({
  meanClvPct: null,
  medianClvPct: null,
  beatClosePct: null,
});

/**
 * `scoring.ts:summary`.
 *
 * "Beat the close" is STRICTLY greater than zero. A pick that exactly matched
 * the close did not beat it, and on the margin-adjusted metric exactly-zero is
 * the common case rather than a rarity — it is what "the forecast matched the
 * market" reads as — so `>=` here would systematically inflate every beat rate
 * on the metric where the boundary is populated.
 */
export function summary(values: readonly number[]): ClvSummary {
  return {
    meanClvPct: mean(values),
    medianClvPct: median(values),
    beatClosePct:
      values.length === 0
        ? null
        : round4((values.filter((v) => v > 0).length / values.length) * 100),
  };
}

/** One scored pick, reduced to what an aggregate needs. */
export interface AggregablePick {
  /**
   * The clustering key for the equal-weight game-level aggregate: `(runId,
   * gameId)`.
   *
   * The scorer clusters by `pick.gameId` alone, WITHIN one run file — so all
   * three of a participant's markets on one game (moneyline, spread, total)
   * collapse into a single game mean, which is what makes the game-level figure
   * equal-weight per game rather than per pick. That much is reproduced here
   * exactly.
   *
   * The `runId` half is the generalisation, and it is needed because this
   * aggregate spans runs while the scorer's never does: `fireEligibleGame`
   * mints one run per fired game, so a game postponed on one slate and re-fired
   * on the next appears under two runs and must stay two clusters. Keyed on
   * `gameId` alone the two days would silently merge, halving that game's
   * weight against every other. Measured 2026-08-24: 98 runs, 98 distinct
   * games, none appearing in more than one run or more than one cohort — so
   * today the two keys agree and this is a guard against a state the data does
   * not yet hold, not a fix for one it does.
   *
   * ⚠ The MARKET is deliberately NOT part of the key. Excluding a market — or
   * splitting it out of the cluster — changes the published number: on run
   * `watch-v0-2026-08-15-0b0658`, Claude Fable 5's moneyline scored -1.2351 and
   * its spread +0.3059, and the work order's acceptance figure of -0.4646% is
   * the mean of the two. A moneyline-only aggregate serves -1.2351 and fails.
   */
  clusterKey: string;
  /** `null` when the metric produced no value for this pick. */
  economicClvPct: number | null;
  marginAdjustedClvPct: number | null;
}

/** Both clusterings of one metric. */
export interface MetricAggregate {
  perPick: ClvSummary;
  gameLevel: ClvSummary;
  /** Distinct clusters contributing a value — `ParticipantStats.gamesScoreable`. */
  gamesScoreable: number;
  /** Values contributing — `ParticipantStats.primaryScoreable` for economic. */
  scoreable: number;
}

export const EMPTY_METRIC: MetricAggregate = Object.freeze({
  perPick: EMPTY_SUMMARY,
  gameLevel: EMPTY_SUMMARY,
  gamesScoreable: 0,
  scoreable: 0,
});

/**
 * `scoring.ts:clusterByGame` + the two `summary()` calls that consume it.
 *
 * The caller has already applied the stratum filter — this function sees only
 * picks that belong in the estimate — because the stratum rule lives at the
 * database boundary here (`refused`, `held_out_of_primary`) rather than in a
 * `member` predicate. Keeping the filter OUT of this function is what lets the
 * same code compute the held-out sensitivity stratum by handing it the
 * complement.
 */
export function aggregateMetric(
  picks: readonly AggregablePick[],
  metric: 'economicClvPct' | 'marginAdjustedClvPct',
): MetricAggregate {
  const values: number[] = [];
  const byCluster = new Map<string, number[]>();
  for (const pick of picks) {
    const v = pick[metric];
    if (v === null) continue;
    values.push(v);
    const list = byCluster.get(pick.clusterKey);
    if (list === undefined) byCluster.set(pick.clusterKey, [v]);
    else list.push(v);
  }
  // Each cluster mean is rounded before the outer mean rounds again — see the
  // file header. `mean()` cannot return null here (no cluster is empty), but
  // the filter keeps the types honest without a cast.
  const clusterMeans = [...byCluster.values()]
    .map((vs) => mean(vs))
    .filter((v): v is number => v !== null);
  return {
    perPick: summary(values),
    gameLevel: summary(clusterMeans),
    gamesScoreable: byCluster.size,
    scoreable: values.length,
  };
}

/** Both metrics, both clusterings. Never one without the other. */
export interface PairedAggregate {
  economic: MetricAggregate;
  marginAdjusted: MetricAggregate;
}

export const EMPTY_PAIRED: PairedAggregate = Object.freeze({
  economic: EMPTY_METRIC,
  marginAdjusted: EMPTY_METRIC,
});

/**
 * The pair, together.
 *
 * Exported as a pair rather than as two calls because `benchmark_scores`'
 * table comment states the rule this enforces: "Both metrics are reported side
 * by side, always … Neither replaces the other and a read path must never show
 * one alone." A caller that wants only one has to reach past this function to
 * get it, which is the point.
 */
export function aggregatePaired(picks: readonly AggregablePick[]): PairedAggregate {
  return {
    economic: aggregateMetric(picks, 'economicClvPct'),
    marginAdjusted: aggregateMetric(picks, 'marginAdjustedClvPct'),
  };
}
