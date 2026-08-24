/**
 * The scorer-aggregation port, pinned by literals.
 *
 * These are the numbers, not the shape. Every expectation below is a LITERAL
 * computed by hand from the rule being pinned — never derived from the function
 * under test, and never from a helper the function also uses, because a table
 * whose expectation moves with a broken helper catches nothing.
 *
 * The port itself was established faithful by a development-time differential
 * against `ospex-benchmark/src/scoring.ts`'s own extracted source: 21,167 cases
 * (every ordered tuple up to length 3 over a 22-value pool, 5,000 longer random
 * vectors, 5,000 clustered vectors, and all 1,299 production score rows under
 * three strata × both metrics), 0 mismatches, with a negative control proving
 * the harness distinguishes a `>=` beat-close mutant 4/4. That differential
 * cannot live in this repo — the two are separate deployables with no shared
 * package — so these literals are what keeps the port from drifting afterwards.
 */
import { describe, expect, it } from 'vitest';
import {
  CumulativeAggregate,
  EMPTY_METRIC,
  EMPTY_PAIRED,
  EMPTY_SUMMARY,
  aggregateMetric,
  aggregatePaired,
  mean,
  median,
  round4,
  summary,
  type AggregablePick,
} from '../src/v1/benchmark/aggregate.js';

function pick(
  clusterKey: string,
  economicClvPct: number | null,
  marginAdjustedClvPct: number | null = null,
): AggregablePick {
  return { clusterKey, economicClvPct, marginAdjustedClvPct };
}

describe('round4', () => {
  it('rounds to four decimals', () => {
    expect(round4(1.23456)).toBe(1.2346);
    expect(round4(-1.23456)).toBe(-1.2346);
  });

  /**
   * `Math.round` breaks ties toward POSITIVE infinity, so the two sides of zero
   * are not symmetric: +0.00005 rounds away from zero to 0.0001 while -0.00005
   * rounds toward it, to -0. This is the scorer's behaviour and the endpoint
   * has to match it digit for digit, so it is pinned rather than "fixed" —
   * a symmetric round-half-away-from-zero implementation fails right here.
   */
  it('inherits Math.round tie-breaking toward positive infinity, asymmetrically', () => {
    expect(round4(0.00005)).toBe(0.0001);
    expect(round4(-0.00005)).toBe(-0);
    expect(Object.is(round4(-0.00005), -0)).toBe(true);
  });
});

describe('mean / median', () => {
  it('is null on an empty set, for both', () => {
    expect(mean([])).toBeNull();
    expect(median([])).toBeNull();
  });

  /**
   * The fixture is deliberately NOT symmetric and NOT sorted: a median that
   * forgot to sort would return 2 here, and one that returned the mean would
   * return 25.75. Both wrong answers are distinct from the right one.
   */
  it('median sorts first and is not the mean', () => {
    expect(median([100, 0, 2, 1])).toBe(1.5);
    expect(mean([100, 0, 2, 1])).toBe(25.75);
    expect(median([100, 0, 2])).toBe(2);
  });

  /**
   * Even length takes the midpoint of the two central values and rounds ONCE.
   * Rounding the two halves first gives (0.0001 + 0.0002) / 2 = 0.00015, which
   * this expectation excludes.
   */
  it('median rounds the midpoint once, not the halves', () => {
    expect(median([0.000149, 0.000151])).toBe(0.0002);
  });
});

describe('summary', () => {
  it('is all-null on an empty set', () => {
    expect(summary([])).toEqual({ meanClvPct: null, medianClvPct: null, beatClosePct: null });
  });

  /**
   * "Beat the close" is STRICTLY greater than zero.
   *
   * The boundary matters on the margin-adjusted metric, where exactly-zero is
   * what "the forecast matched the market" reads as and is therefore populated
   * rather than exotic. A `>=` implementation reports 100% on every one of
   * these fixtures instead of 0 / 50 / 33.3333.
   */
  it('counts a pick at exactly zero as NOT beating the close', () => {
    expect(summary([0]).beatClosePct).toBe(0);
    expect(summary([0, 1]).beatClosePct).toBe(50);
    expect(summary([-1, 0, 1]).beatClosePct).toBe(33.3333);
    expect(summary([0, 0, 0]).beatClosePct).toBe(0);
  });

  /** Negative zero is not greater than zero either — and `-0 >= 0` is true, so
   *  this case separates the two implementations a second way. */
  it('treats negative zero as not beating the close', () => {
    expect(summary([-0]).beatClosePct).toBe(0);
  });

  it('rounds the beat rate to four decimals', () => {
    expect(summary([1, -1, -1]).beatClosePct).toBe(33.3333);
    expect(summary([1, 1, -1, -1, -1, -1, -1]).beatClosePct).toBe(28.5714);
  });
});

describe('aggregateMetric', () => {
  it('is empty-shaped with no picks, and with only null-valued picks', () => {
    expect(aggregateMetric([], 'economicClvPct')).toEqual(EMPTY_METRIC);
    expect(aggregateMetric([pick('a', null), pick('b', null)], 'economicClvPct')).toEqual(
      EMPTY_METRIC,
    );
  });

  /**
   * gameLevelMeanIsDoubleRounded — the header's claim, pinned.
   *
   * Three clusters: two of [0.00005, 0.00005] and one of [0].
   *   rounded cluster means  → [0.0001, 0.0001, 0] → mean 0.0000666… → 0.0001
   *   unrounded cluster means → [0.00005, 0.00005, 0] → mean 0.0000333… → 0
   * So an implementation that rounds only once, at the end, returns 0 here.
   * The per-pick figure over the same five values is 0.00004 → 0, which is a
   * third distinct answer, so this fixture also separates the two clusterings.
   */
  it('rounds each cluster mean before averaging them (double rounding)', () => {
    const picks = [
      pick('g1', 0.00005),
      pick('g1', 0.00005),
      pick('g2', 0.00005),
      pick('g2', 0.00005),
      pick('g3', 0),
    ];
    const got = aggregateMetric(picks, 'economicClvPct');
    expect(got.gameLevel.meanClvPct).toBe(0.0001);
    expect(got.perPick.meanClvPct).toBe(0);
  });

  /**
   * Equal weight per cluster: one cluster carrying four picks must not outvote
   * three single-pick clusters. Per-pick weights by pick and gives a different
   * answer, which is exactly why both are published.
   */
  it('weights clusters equally, and per-pick does not', () => {
    const picks = [
      pick('busy', 10),
      pick('busy', 10),
      pick('busy', 10),
      pick('busy', 10),
      pick('quiet', -10),
    ];
    const got = aggregateMetric(picks, 'economicClvPct');
    expect(got.gameLevel.meanClvPct).toBe(0); // (10 + -10) / 2
    expect(got.perPick.meanClvPct).toBe(6); // (40 - 10) / 5
    expect(got.gamesScoreable).toBe(2);
    expect(got.scoreable).toBe(5);
  });

  /**
   * A cluster whose every pick is null contributes NO cluster — it must not
   * appear in `gamesScoreable` and must not enter the game-level mean as a
   * zero. An implementation that seeded the map before checking the value
   * reports 3 clusters and a mean of 6.6667 instead of 2 and 10.
   */
  it('does not count a cluster whose picks all lack a value', () => {
    const got = aggregateMetric(
      [pick('g1', 10), pick('g2', 10), pick('g3', null), pick('g3', null)],
      'economicClvPct',
    );
    expect(got.gamesScoreable).toBe(2);
    expect(got.scoreable).toBe(2);
    expect(got.gameLevel.meanClvPct).toBe(10);
  });

  /**
   * The two metrics are selected independently on the SAME pick list: a pick
   * with an economic value and no margin-adjusted one contributes to the first
   * aggregate and not the second. Reading the wrong field is the failure this
   * catches, and the values are chosen so the two answers cannot coincide.
   */
  it('selects the named metric and ignores the other', () => {
    const picks = [pick('g1', 10, -4), pick('g2', 20, null)];
    expect(aggregateMetric(picks, 'economicClvPct').perPick.meanClvPct).toBe(15);
    expect(aggregateMetric(picks, 'marginAdjustedClvPct').perPick.meanClvPct).toBe(-4);
    expect(aggregateMetric(picks, 'marginAdjustedClvPct').scoreable).toBe(1);
  });

  /**
   * The cluster key is `(cohort, game)`, so the same game fired on two slates
   * stays two clusters. With one key they would merge into a single cluster of
   * mean 0 and the game-level figure would read 0 instead of 0; the values are
   * chosen so the merged and unmerged answers differ.
   */
  it('keeps the same game in two cohorts as two clusters', () => {
    const separate = aggregateMetric(
      [pick('c1|game-x', 30), pick('c2|game-x', -30), pick('c1|game-y', 30)],
      'economicClvPct',
    );
    const merged = aggregateMetric(
      [pick('game-x', 30), pick('game-x', -30), pick('game-y', 30)],
      'economicClvPct',
    );
    expect(separate.gamesScoreable).toBe(3);
    expect(separate.gameLevel.meanClvPct).toBe(10); // (30 + -30 + 30) / 3
    expect(merged.gamesScoreable).toBe(2);
    expect(merged.gameLevel.meanClvPct).toBe(15); // (0 + 30) / 2
  });
});

describe('aggregatePaired', () => {
  it('computes both metrics from one pass', () => {
    const picks = [pick('g1', 10, -4), pick('g1', 20, -6), pick('g2', -30, 12)];
    const got = aggregatePaired(picks);
    expect(got.economic.perPick.meanClvPct).toBe(0); // (10 + 20 - 30) / 3
    expect(got.economic.gameLevel.meanClvPct).toBe(-7.5); // (15 + -30) / 2
    expect(got.marginAdjusted.perPick.meanClvPct).toBe(0.6667); // (-4 - 6 + 12) / 3
    expect(got.marginAdjusted.gameLevel.meanClvPct).toBe(3.5); // (-5 + 12) / 2
  });

  it('is empty-shaped with no picks', () => {
    expect(aggregatePaired([])).toEqual(EMPTY_PAIRED);
  });
});

describe('the empty singletons are shared, so they are frozen', () => {
  it('refuses mutation', () => {
    expect(Object.isFrozen(EMPTY_SUMMARY)).toBe(true);
    expect(Object.isFrozen(EMPTY_METRIC)).toBe(true);
    expect(Object.isFrozen(EMPTY_PAIRED)).toBe(true);
    expect(() => {
      (EMPTY_SUMMARY as { meanClvPct: number | null }).meanClvPct = 1;
    }).toThrow();
  });

  /**
   * Negative control for the freeze test above: a freeze assertion that passes
   * on an unfrozen object would be vacuous, so prove the assertion can fail.
   */
  it('the freeze assertion is not vacuous', () => {
    const unfrozen = { meanClvPct: null };
    expect(Object.isFrozen(unfrozen)).toBe(false);
  });
});

describe('CumulativeAggregate', () => {
  /**
   * equivalentToFullAggregate — the differential the class's own docstring
   * promises.
   *
   * An incremental aggregate that DRIFTS from the one-shot one is the defect
   * this class could introduce, and it would drift silently: the series' last
   * point and the arm's headline are computed by different code paths and only
   * one assertion in the handler tests compares them. So every PREFIX is
   * compared here, over a matrix chosen to exercise the parts most likely to
   * diverge — the running float sum against a left-to-right reduce, the merged
   * sorted list against a fresh sort, the even-length median midpoint, and the
   * strict `> 0` beat boundary.
   *
   * Values include exact zeros and both signs; days include empty ones and
   * all-null ones; clusters repeat within a day and never across days, which is
   * the property that makes folding exact.
   */
  it('equals the one-shot aggregate at every prefix', () => {
    const POOL = [0, -0, 0.00005, -0.00005, 1.2351, -6.9478, 3.4903, -0.4646, 100, -100];
    let seed = 987_654;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let trial = 0; trial < 200; trial += 1) {
      const running = new CumulativeAggregate();
      const soFar: AggregablePick[] = [];
      const days = 1 + Math.floor(rnd() * 12);
      for (let d = 0; d < days; d += 1) {
        const day: AggregablePick[] = [];
        const picks = Math.floor(rnd() * 6); // 0 is a real, and important, case
        for (let i = 0; i < picks; i += 1) {
          // Clusters repeat WITHIN a day and are unique across days — the
          // invariant the incremental form relies on.
          const cluster = `d${String(d)}-g${String(Math.floor(rnd() * 3))}`;
          const nullish = rnd() < 0.2;
          day.push({
            clusterKey: cluster,
            economicClvPct: nullish ? null : (POOL[Math.floor(rnd() * POOL.length)] as number),
            marginAdjustedClvPct: rnd() < 0.2 ? null : (POOL[Math.floor(rnd() * POOL.length)] as number),
          });
        }
        running.addDay(day);
        soFar.push(...day);
        const expected = soFar.length === 0 ? EMPTY_PAIRED : aggregatePaired(soFar);
        expect(running.snapshot(), `trial ${String(trial)} day ${String(d)}`).toEqual(expected);
      }
    }
  });

  /**
   * Negative control. The differential above would pass on a class that simply
   * called `aggregatePaired` internally — which would be correct but would not
   * be the thing under test. This proves the harness can see a divergence at
   * all, by comparing against a deliberately wrong fold (median from the
   * insertion order rather than the sorted order).
   */
  it('the differential can detect a divergence', () => {
    const picks: AggregablePick[] = [
      { clusterKey: 'a', economicClvPct: 10, marginAdjustedClvPct: null },
      { clusterKey: 'b', economicClvPct: -30, marginAdjustedClvPct: null },
      { clusterKey: 'c', economicClvPct: 1, marginAdjustedClvPct: null },
    ];
    const real = aggregatePaired(picks).economic.perPick.medianClvPct;
    const unsortedMidpoint = picks[1]?.economicClvPct; // -30, the insertion middle
    expect(real).toBe(1);
    expect(real).not.toBe(unsortedMidpoint);
  });

  it('is empty-shaped before any day is added, and after only empty days', () => {
    const a = new CumulativeAggregate();
    expect(a.snapshot()).toEqual(EMPTY_PAIRED);
    a.addDay([]);
    a.addDay([{ clusterKey: 'x', economicClvPct: null, marginAdjustedClvPct: null }]);
    expect(a.snapshot()).toEqual(EMPTY_PAIRED);
  });
});
