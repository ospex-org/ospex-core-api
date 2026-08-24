/**
 * The standings payload, projected from already-fetched rows.
 *
 * Pure. Everything here is testable without a socket, and the handler beside it
 * does nothing but fetch and hand over — the split exists because the
 * aggregation is where a wrong number would be published, and a wrong number is
 * what this endpoint exists not to publish.
 *
 * ## The stratum, which is the easiest thing to get wrong
 *
 * A pick contributes a VALUE to the primary estimate when
 * `held_out_of_primary !== true` and the metric column is non-null. `refused`
 * is a COUNTER and is never consulted in the metric path.
 *
 * That is not a stylistic choice. The scorer's `clusterByGame` skips a row on
 * `!inPrimaryStratum` alone, and the two predicates are not the same
 * population: measured on production, 80 rows carry the hold-out tag, 24 of
 * them are also refused, and **56 carry a value AND are excluded from the
 * primary metric**. Gating on `refused=false` instead moves Claude Fable 5's
 * published headline — per-pick n 134→142, mean −2.5031→−2.5155, beat
 * 27.6119→28.1690 — by exactly the schedule-change stratum that exists to keep
 * it out.
 *
 * `!== true` rather than `=== false`, because both columns are NULLABLE in
 * migration 073 (0 nulls today). A null means "no determinable comparison",
 * which the scorer KEEPS in the primary estimate; `=== false` would silently
 * drop it.
 *
 * ## Markets are POOLED here, and split beside
 *
 * The scorer's `clusterByGame` groups on the game alone, so all three of a
 * participant's markets on one game collapse into one game mean. Ruling 2's
 * "run-line picks are measurement-only" scopes the pick COUNT on the picks
 * endpoint; applying it here changes the published number. Measured on the work
 * order's own acceptance case (run `watch-v0-2026-08-15-0b0658`, Claude Fable
 * 5): moneyline −1.2351, spread +0.3059, total refused — and the acceptance
 * figure of −0.4646% is the mean of the first two. A moneyline-only aggregate
 * serves −1.2351 and fails.
 *
 * The per-market split ships alongside because migration 073 names its absence
 * a read-path bug in as many words: "Publishing a pooled figure without that
 * split is a read-path bug; this schema makes the split available, it cannot
 * make a consumer use it."
 *
 * ## Arms come from the ROSTER, never from the scores
 *
 * An arm that failed every call has no decisions and no scores. Measured: in
 * cohort `watch-v0-2026-08-15`, `google-gemini-3.1-pro-preview` is on the
 * roster with both attempt rows at `outcome = 'invalid_schema'` and zero of
 * each. A scores-driven list renders a four-model benchmark as three and
 * deletes precisely the arm that failed — which is the failure mode the
 * benchmark exists to measure.
 *
 * The same reasoning gives every arm an `eligible` denominator from
 * `benchmark_arm_attempts` rather than from its own pick count. Pooled across
 * cohorts the four arms answered 294 / 291 / 288 / 273 of an identical 294
 * supplied markets each, so using picks as the denominator computes a beat rate
 * over a self-selected subset and rewards an arm for declining to answer.
 *
 * ## There is ONE summation order, and every figure uses it
 *
 * `mean()` sums in array order and float addition is not associative, so the
 * order picks are fed in is part of the number. The published order is: cohorts
 * oldest slate first, and within a cohort the order the scored artifact was
 * written in (`benchmark_scores.id` ascending). That is the order the per-day
 * series accumulates in, and it is now the order the top-level aggregate and
 * the per-market split sum in too — {@link orderByCohort} applies it once,
 * before anything reads the rows.
 *
 * It was not always one order. The rows arrive in id order across the whole
 * window, and an EARLIER cohort re-scored or backfilled later carries HIGHER
 * ids than a later cohort's — so the headline summed "later cohort, then
 * earlier" while the series summed "earlier, then later", and the two rounded
 * differently in the fourth decimal (review measured −9.4200 against −9.4201).
 * Sorting by cohort restores the README's contract — the last series point IS
 * the headline — by construction rather than by luck, and leaves a single
 * cohort-day slice (`?date=`) in exactly the artifact's own order, which is
 * the one slice that is field-for-field comparable to the scorer.
 */

import { createHash } from 'node:crypto';
import type { HeadlineBasis } from '../../lib/env.js';
import {
  CumulativeAggregate,
  EMPTY_PAIRED,
  aggregatePaired,
  type AggregablePick,
  type ClvSummary,
  type PairedAggregate,
} from './aggregate.js';
import type { ExecutedSummary } from './executed.js';

/** The three markets a benchmark decision can be on. */
export const MARKETS = ['moneyline', 'spread', 'total'] as const;
export type Market = (typeof MARKETS)[number];

/** One scored pick, as the projection needs it. */
export interface ScoredPickRow {
  cohortId: string;
  participantId: string;
  gameId: string;
  market: string;
  /** `benchmark_scores.held_out_of_primary`, verbatim including null. */
  heldOutOfPrimary: boolean | null;
  refused: boolean;
  refusalReason: string | null;
  economicClvPct: number | null;
  marginAdjustedClvPct: number | null;
}

/** One roster entry for a contributing cohort. */
export interface RosterEntry {
  cohortId: string;
  participantId: string;
  kind: string;
  displayName: string;
  labId: string | null;
  modelId: string | null;
}

/** `benchmark_arm_attempts` at `attempt_ordinal = 0`. */
export interface ArmAttemptRow {
  cohortId: string;
  participantId: string;
  gameId: string;
  suppliedMarkets: string[];
  outcome: string;
}

/** `benchmark_cohort_wallets`. */
export interface WalletBinding {
  cohortId: string;
  participantId: string;
  walletAddress: string;
}

/** `benchmark_scoring_runs`, the operator's published coverage + ranking brake. */
export interface ScoringRunRow {
  cohortId: string;
  scoringPolicyVersion: string;
  eligible: number;
  scored: number;
  refused: number;
  scheduleHeldOut: number;
  refusalReasons: Record<string, number>;
  rankingAllowed: boolean;
  rankingReason: string;
  costPerPickComparable: boolean | null;
}

// ── wire shapes ────────────────────────────────────────────────────────────

/** A `ClvSummary` with its own denominator attached. */
export interface WireSummary extends ClvSummary {
  /**
   * Values behind THIS summary. Inside the object rather than beside it,
   * because a per-pick `n` printed next to a game-level rate is a number a
   * reader can divide back into nonsense — 26.2295% "over 134" when the rate
   * was computed over 61 game buckets.
   */
  n: number;
}

/**
 * The two vig figures, at one clustering.
 *
 * Closed-form from the two published means, not a new estimate. Writing the
 * entry price as a HOLD `v` on the fair (de-vigged) price —
 * `D_entry = (1 − v) / q_fair` — the scorer's own two metrics are related by
 *
 *   economic = (1 − v)(1 + marginAdjusted) − 1
 *
 * which rearranges twice, with `ma` and `econ` the two means as fractions:
 *
 *   breakEvenPct = ma / (1 + ma)                 (set economic = 0)
 *   observedPct  = 1 − (1 + econ) / (1 + ma)     (solve for v)
 *
 * ## What each one answers
 *
 * `breakEvenPct` is the uniform vig at which this arm's mean CLV crosses zero:
 * pay less and the picks were profitable, pay more and they were not. A
 * NEGATIVE value is meaningful and is served as such — it says the arm loses
 * even at zero vig, i.e. it did not beat the close on a fair number at all.
 *
 * `observedPct` is the vig actually paid, implied by the gap between the two
 * means. Measured across the nine live cohorts it lands on 3.5456 / 3.5419 /
 * 3.5451 / 3.5451 for the four arms — near-identical because they all price off
 * the same board, which is a useful self-check on the derivation.
 *
 * ## The bound on the claim
 *
 * `v` is the book's HOLD — `margin / (1 + margin)`, the fraction of stake the
 * margin costs — which is the convention a market maker's quoted spread
 * converts to, and is what makes "find a maker under this number" actionable.
 * It is a UNIFORM vig applied to every pick, solved from the published means;
 * the real per-pick margin varies, so this is the constant-vig reading of the
 * pair rather than a per-pick measurement. Both inputs sit beside it in the
 * payload, so a reader can re-derive it.
 *
 * Null when either mean is null, and `breakEvenPct` additionally null when
 * `1 + ma <= 0` (a mean at or below −100%, where the expression has no root).
 */
export interface WireVig {
  observedPct: number | null;
  breakEvenPct: number | null;
}

export interface WireMetric {
  perPick: WireSummary;
  gameLevel: WireSummary;
}

export interface WirePaired {
  economic: WireMetric;
  marginAdjusted: WireMetric;
  /** Observed and break-even vig, at each clustering. See {@link WireVig}. */
  vig: { perPick: WireVig; gameLevel: WireVig };
}

export interface WireMarketSplit {
  market: Market;
  /** Opportunities: this market appearing in a dispatched arm-game's supplied set. */
  eligible: number;
  picks: number;
  scoreable: number;
  metrics: WirePaired;
}

export interface WireSeriesPoint {
  slateDate: string;
  cohortId: string;
  /** That day alone. */
  daily: WirePaired;
  /**
   * Every eligible pick up to and including this day, RE-AGGREGATED from
   * scratch — re-clustered by game with both rounding sites applied.
   *
   * Never a running average of the daily means: measured on Claude Fable 5 the
   * pooled game-level mean is −2.3888 while the mean of daily means is −2.1226,
   * an 11% relative gap, because one cohort contributed a single game and
   * another fifteen. The hero area chart sits directly under the headline
   * number, so a running average visibly disagrees with the figure above it.
   * The last point of this series equals the arm's top-level aggregate by
   * construction — both sum the same rows in the same order (see the file
   * header) — and a test with a backfilled earlier cohort asserts it.
   */
  cumulative: WirePaired;
}

export interface WireArm {
  participantId: string;
  displayName: string;
  modelId: string | null;
  lab: string | null;
  kind: string;
  /**
   * Per-cohort, because the binding is per cohort-day by design: migration 079
   * keyed it `(cohort_id, participant_id)` so a public attribution of an
   * on-chain fill cannot be moved between models after the fact. Collapsing it
   * to one scalar across a multi-day window would have no defined value.
   */
  wallets: Array<{ cohortId: string; walletAddress: string }>;
  sample: {
    /** Opportunities: supplied markets summed over dispatched arm-games. */
    eligible: number;
    /** Score rows at the served policy version. */
    picks: number;
    /** Picks carrying a primary economic value — the metric's denominator. */
    scoreable: number;
    /** Distinct game buckets behind the game-level figures (economic clustering). */
    gamesScoreable: number;
    refused: number;
    /** Tagged AND carrying a value: what the hold-out actually withheld. */
    scheduleHeldOut: number;
    /** Carrying the tag at all, refused or not — the raw stratum size. */
    scheduleHeldOutTagged: number;
    refusalReasons: Record<string, number>;
    /** `benchmark_arm_attempts.outcome` at `attempt_ordinal = 0`. */
    armOutcomes: Record<string, number>;
  };
  metrics: WirePaired;
  byMarket: WireMarketSplit[];
  /**
   * The figures the front end renders large, all at the clustering `basis`
   * names.
   *
   * Under the default `marginAdjusted.*` basis, `beatClosePct` answers "how
   * often did this arm beat the closing line on a number with no vig" and
   * `vig.breakEvenPct` answers "at what vig does that stop being profitable".
   * Those two, beside `vig.observedPct`, are the whole reading: a maker quoting
   * under the break-even number is worth taking, and the board is not.
   */
  headline: {
    basis: HeadlineBasis;
    beatClosePct: number | null;
    clvPct: number | null;
    n: number;
    vig: WireVig;
  };
  executed: WireExecuted;
  series: WireSeriesPoint[];
  /** Server-computed direction of the last two cumulative headline points. */
  trend: 'up' | 'flat' | 'down' | null;
}

export interface WireExecuted {
  fills: number;
  /** null when there are no fills — `0` would assert a measured zero. */
  stakedUsdc: number | null;
  netUsdc: number | null;
  pendingStakeUsdc: number | null;
  record: { won: number; lost: number; push: number; void: number; pending: number } | null;
  /** How many verdicts the protocol settled vs how many were replayed from scores. */
  verdictSource: { settled: number; predicted: number; undecided: number } | null;
  /** Fills where the receipt and the chain event disagree on the stake. */
  stakeDisagreements: number;
  /** Published receipts this service could not identify a unique fill for. */
  unresolvedFills: number;
}

export const EMPTY_WIRE_EXECUTED: WireExecuted = Object.freeze({
  fills: 0,
  stakedUsdc: null,
  netUsdc: null,
  pendingStakeUsdc: null,
  record: null,
  verdictSource: null,
  stakeDisagreements: 0,
  unresolvedFills: 0,
});

// ── helpers ────────────────────────────────────────────────────────────────

const EMPTY_WIRE_SUMMARY: WireSummary = Object.freeze({
  meanClvPct: null,
  medianClvPct: null,
  beatClosePct: null,
  n: 0,
});

function wireMetric(paired: PairedAggregate, which: 'economic' | 'marginAdjusted'): WireMetric {
  const m = paired[which];
  return {
    perPick: { ...m.perPick, n: m.scoreable },
    gameLevel: { ...m.gameLevel, n: m.gamesScoreable },
  };
}

/** Four decimals, matching every other percentage this surface publishes. */
function pct4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/** {@link WireVig}, from one clustering's pair of means. */
export function vigOf(economicMean: number | null, marginAdjustedMean: number | null): WireVig {
  if (economicMean === null || marginAdjustedMean === null) {
    return { observedPct: null, breakEvenPct: null };
  }
  const econ = economicMean / 100;
  const ma = marginAdjustedMean / 100;
  const denom = 1 + ma;
  // No root below a −100% mean, and the division would flip sign through the
  // singularity rather than fail — so it is refused rather than served.
  if (denom <= 0) return { observedPct: null, breakEvenPct: null };
  return {
    observedPct: pct4(100 * (1 - (1 + econ) / denom)),
    breakEvenPct: pct4(100 * (ma / denom)),
  };
}

function toWirePaired(paired: PairedAggregate): WirePaired {
  const economic = wireMetric(paired, 'economic');
  const marginAdjusted = wireMetric(paired, 'marginAdjusted');
  return {
    economic,
    marginAdjusted,
    vig: {
      perPick: vigOf(economic.perPick.meanClvPct, marginAdjusted.perPick.meanClvPct),
      gameLevel: vigOf(economic.gameLevel.meanClvPct, marginAdjusted.gameLevel.meanClvPct),
    },
  };
}

const EMPTY_WIRE_VIG: WireVig = Object.freeze({ observedPct: null, breakEvenPct: null });

export const EMPTY_WIRE_PAIRED: WirePaired = Object.freeze({
  economic: Object.freeze({ perPick: EMPTY_WIRE_SUMMARY, gameLevel: EMPTY_WIRE_SUMMARY }),
  marginAdjusted: Object.freeze({ perPick: EMPTY_WIRE_SUMMARY, gameLevel: EMPTY_WIRE_SUMMARY }),
  vig: Object.freeze({ perPick: EMPTY_WIRE_VIG, gameLevel: EMPTY_WIRE_VIG }),
});

/**
 * The stratum predicate — the scorer's `inPrimaryStratum`, read off the
 * persisted verdict. See the file header for why `refused` is not in it and
 * why the test is `!== true`.
 */
export function inPrimaryStratum(row: ScoredPickRow): boolean {
  return row.heldOutOfPrimary !== true;
}

/**
 * `(cohortId, gameId)` — the equal-weight clustering key.
 *
 * LENGTH-PREFIXED rather than joined with a separator character. Plain
 * concatenation collides (`watch-v0-2026-08-1` + `5abc` reads the same as
 * `watch-v0-2026-08-15` + `abc`), and a separator is only safe while neither id
 * can contain it — which is true of today's `watch-v0-<date>` cohorts and UUID
 * game ids and is not a property either identifier promises. Two picks landing
 * in one bucket silently halves a game's weight in the game-level mean, with
 * nothing red.
 */
function clusterKey(row: ScoredPickRow): string {
  return `${String(row.cohortId.length)}:${row.cohortId}:${row.gameId}`;
}

function toAggregable(rows: readonly ScoredPickRow[]): AggregablePick[] {
  return rows.filter(inPrimaryStratum).map((r) => ({
    clusterKey: clusterKey(r),
    economicClvPct: r.economicClvPct,
    marginAdjustedClvPct: r.marginAdjustedClvPct,
  }));
}

/**
 * The one summation order — see the file header.
 *
 * A STABLE sort by the cohort's position in `cohortOrder`, so rows keep their
 * fetched (id-ascending) order within a cohort. A row whose cohort is not in
 * the order — which the handler cannot produce, since the rows are fetched by
 * these very cohort ids — sorts after every known cohort rather than being
 * dropped, so a caller that did produce one would see it in the numbers and
 * not lose it silently.
 */
export function orderByCohort(
  rows: readonly ScoredPickRow[],
  cohortOrder: readonly string[],
): ScoredPickRow[] {
  const rank = new Map<string, number>();
  cohortOrder.forEach((cohortId, i) => {
    if (!rank.has(cohortId)) rank.set(cohortId, i);
  });
  const unknown = cohortOrder.length;
  return rows
    .map((row, index) => ({ row, index, rank: rank.get(row.cohortId) ?? unknown }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((r) => r.row);
}

function readHeadline(paired: WirePaired, basis: HeadlineBasis): WireArm['headline'] {
  const [metric, clustering] = basis.split('.') as [
    'economic' | 'marginAdjusted',
    'perPick' | 'gameLevel',
  ];
  const summary = paired[metric][clustering];
  return {
    basis,
    beatClosePct: summary.beatClosePct,
    clvPct: summary.meanClvPct,
    n: summary.n,
    vig: paired.vig[clustering],
  };
}

/**
 * Direction of the last two cumulative headline points.
 *
 * Server-side because the sparkline's COLOUR is a classification (rising green,
 * flat gray, falling red) and colour is the only performance signal the mobile
 * layout keeps. Two front-end implementations of "flat" would colour the same
 * arm differently; there is exactly one definition here and it is stated in the
 * README: a move of less than one tenth of a point is flat.
 */
const TREND_EPSILON = 0.1;

function trendOf(series: readonly WireSeriesPoint[], basis: HeadlineBasis): WireArm['trend'] {
  const points = series
    .map((p) => readHeadline(p.cumulative, basis).clvPct)
    .filter((v): v is number => v !== null);
  if (points.length < 2) return null;
  const last = points[points.length - 1] as number;
  const prev = points[points.length - 2] as number;
  const delta = last - prev;
  if (Math.abs(delta) < TREND_EPSILON) return 'flat';
  return delta > 0 ? 'up' : 'down';
}

export interface ProjectStandingsInput {
  roster: readonly RosterEntry[];
  scores: readonly ScoredPickRow[];
  attempts: readonly ArmAttemptRow[];
  wallets: readonly WalletBinding[];
  executed: ReadonlyMap<string, ExecutedSummary>;
  /** Cohort ids in the window, OLDEST FIRST — the series order. */
  cohortOrder: readonly string[];
  slateDateByCohort: ReadonlyMap<string, string>;
  headlineBasis: HeadlineBasis;
}

const WEI6 = 1_000_000;

function wireExecuted(summary: ExecutedSummary | undefined): WireExecuted {
  if (summary === undefined) return EMPTY_WIRE_EXECUTED;
  if (summary.fills === 0) {
    // No PRICED fill, but there may still be receipts this service refused to
    // identify. Those must survive into the payload: an arm whose whole record
    // was unresolvable would otherwise be indistinguishable from one that never
    // traded.
    return { ...EMPTY_WIRE_EXECUTED, unresolvedFills: summary.unresolvedFills };
  }
  return {
    fills: summary.fills,
    stakedUsdc: Number(summary.stakedWei6) / WEI6,
    netUsdc: Number(summary.netWei6) / WEI6,
    pendingStakeUsdc: Number(summary.pendingStakeWei6) / WEI6,
    record: summary.record,
    verdictSource: summary.verdictSource,
    stakeDisagreements: summary.stakeDisagreements,
    unresolvedFills: summary.unresolvedFills,
  };
}

/**
 * Project every roster arm.
 *
 * Roster-driven and LEFT-joined throughout: an arm with no scores renders with
 * zeroes and null summaries, never absent.
 */
export function projectArms(input: ProjectStandingsInput): WireArm[] {
  const {
    roster,
    scores,
    attempts,
    wallets,
    executed,
    cohortOrder,
    slateDateByCohort,
    headlineBasis,
  } = input;

  // One entry per participant, taking the first roster row's identity fields.
  // The roster repeats per cohort-day; the identity is a property of the
  // participant.
  const identity = new Map<string, RosterEntry>();
  for (const r of roster) if (!identity.has(r.participantId)) identity.set(r.participantId, r);

  // The one order, applied before ANY aggregate reads a row — the headline,
  // the per-market split and the series all sum the same sequence.
  const scoresByArm = new Map<string, ScoredPickRow[]>();
  for (const s of orderByCohort(scores, cohortOrder)) {
    const list = scoresByArm.get(s.participantId);
    if (list === undefined) scoresByArm.set(s.participantId, [s]);
    else list.push(s);
  }

  const arms: WireArm[] = [];
  for (const [participantId, id] of identity) {
    const mine = scoresByArm.get(participantId) ?? [];
    const myAttempts = attempts.filter((a) => a.participantId === participantId);

    const eligible = myAttempts.reduce((n, a) => n + a.suppliedMarkets.length, 0);
    const armOutcomes: Record<string, number> = {};
    for (const a of myAttempts) armOutcomes[a.outcome] = (armOutcomes[a.outcome] ?? 0) + 1;

    const refusalReasons: Record<string, number> = {};
    let refused = 0;
    let heldOutTagged = 0;
    let heldOutWithValue = 0;
    for (const s of mine) {
      if (s.refusalReason !== null) {
        refused += 1;
        refusalReasons[s.refusalReason] = (refusalReasons[s.refusalReason] ?? 0) + 1;
      }
      if (s.heldOutOfPrimary === true) {
        heldOutTagged += 1;
        if (s.economicClvPct !== null) heldOutWithValue += 1;
      }
    }

    const paired = mine.length === 0 ? EMPTY_PAIRED : aggregatePaired(toAggregable(mine));
    const metrics = mine.length === 0 ? EMPTY_WIRE_PAIRED : toWirePaired(paired);

    const byMarket: WireMarketSplit[] = MARKETS.map((market) => {
      const rows = mine.filter((s) => s.market === market);
      const marketEligible = myAttempts.reduce(
        (n, a) => n + (a.suppliedMarkets.includes(market) ? 1 : 0),
        0,
      );
      const agg = rows.length === 0 ? EMPTY_PAIRED : aggregatePaired(toAggregable(rows));
      return {
        market,
        eligible: marketEligible,
        picks: rows.length,
        scoreable: agg.economic.scoreable,
        metrics: rows.length === 0 ? EMPTY_WIRE_PAIRED : toWirePaired(agg),
      };
    });

    // The series: one point per cohort in the window, in time order. A day the
    // arm sat out still appears, with nulls — a gap the front end can draw as a
    // gap rather than as a straight line through it.
    //
    // The cumulative figure ACCUMULATES rather than re-aggregating the prefix.
    // The obvious version was quadratic in days and allocated a fresh object
    // per pick per day: measured in review at ~441ms for a 60-day window and
    // ~19.3 SECONDS for the 400-day maximum, on an endpoint one IP may call
    // hundreds of times a minute. `CumulativeAggregate` documents why folding
    // is exact here rather than merely close.
    //
    // Grouping by cohort once, outside the loop, removes the other quadratic
    // term — the old `mine.filter(...)` per day.
    const byDay = new Map<string, ScoredPickRow[]>();
    for (const s of mine) {
      const list = byDay.get(s.cohortId);
      if (list === undefined) byDay.set(s.cohortId, [s]);
      else list.push(s);
    }

    const series: WireSeriesPoint[] = [];
    const running = new CumulativeAggregate();
    let seenAny = false;
    // A cohort id repeated in the order would fold its day into the running
    // aggregate twice. `resolveWindow` derives the order from a Map so it
    // cannot repeat; the Set makes that a property of this function rather
    // than of its caller, and matches `orderByCohort`, which already ranks a
    // repeated id once.
    for (const cohortId of new Set(cohortOrder)) {
      const day = byDay.get(cohortId) ?? [];
      const dayAggregable = toAggregable(day);
      running.addDay(dayAggregable);
      if (dayAggregable.length > 0) seenAny = true;
      const dailyAgg = day.length === 0 ? EMPTY_PAIRED : aggregatePaired(dayAggregable);
      series.push({
        slateDate: slateDateByCohort.get(cohortId) ?? cohortId,
        cohortId,
        daily: day.length === 0 ? EMPTY_WIRE_PAIRED : toWirePaired(dailyAgg),
        cumulative: seenAny ? toWirePaired(running.snapshot()) : EMPTY_WIRE_PAIRED,
      });
    }

    arms.push({
      participantId,
      displayName: id.displayName,
      modelId: id.modelId,
      lab: id.labId,
      kind: id.kind,
      wallets: wallets
        .filter((w) => w.participantId === participantId)
        .map((w) => ({ cohortId: w.cohortId, walletAddress: w.walletAddress }))
        .sort((a, b) => a.cohortId.localeCompare(b.cohortId)),
      sample: {
        eligible,
        picks: mine.length,
        scoreable: paired.economic.scoreable,
        gamesScoreable: paired.economic.gamesScoreable,
        refused,
        scheduleHeldOut: heldOutWithValue,
        scheduleHeldOutTagged: heldOutTagged,
        refusalReasons,
        armOutcomes,
      },
      metrics,
      byMarket,
      headline: readHeadline(metrics, headlineBasis),
      executed: wireExecuted(executed.get(participantId)),
      series,
      trend: trendOf(series, headlineBasis),
    });
  }

  return arms;
}

/** How `arms[]` is ordered — a named contract, because order IS a ranking. */
export type ArmOrdering = 'headline' | 'neutral';

/**
 * Order the arms.
 *
 * ## The order is itself gated, and that is the correction
 *
 * The first cut always performance-sorted and always named a leader, on the
 * reading that `ranking_allowed` gates only a rendered `#` column. That reading
 * does not survive migration 073's own words — *"a UI must not sort
 * participants when it is false"* — because an array served in performance
 * order IS a sort the UI merely has to not disturb, and
 * `featured.leaderParticipantId` IS naming a winner. Handing the front end both
 * and asking it not to render a rank withholds nothing. Caught in review.
 *
 * So `allowed === false` serves a NEUTRAL order and no leader. The metrics all
 * still ship — work-order ruling 4 says the projection "serves metrics with
 * ranking withheld", and this is what withheld means. What the operator gives
 * up until they open the gate is the ordering, not the data.
 *
 * ## Why neutral is a hash and not alphabetical
 *
 * The four participant ids sort `anthropic-…`, `google-…`, `openai-…`,
 * `xai-…`, so ascending order seats the Anthropic arm first on every request,
 * forever, on a public comparison of four labs published through infrastructure
 * Anthropic tooling helped write. A hash of `(participantId, seed)` is
 * deterministic for a given seed, rotates as cohorts advance, carries no
 * meaning, and any reader can recompute it from fields the payload already
 * contains.
 *
 * @param allowed whether the operator has opened the ranking gate
 * @param seed    stable within a cohort-day; the active cohort id
 */
export function orderArms(
  arms: readonly WireArm[],
  allowed: boolean,
  seed: string,
): { arms: WireArm[]; orderedBy: ArmOrdering } {
  if (!allowed) {
    const keyed = arms.map((a) => ({
      arm: a,
      key: createHash('sha256').update(`${a.participantId}|${seed}`).digest('hex'),
    }));
    keyed.sort((x, y) => x.key.localeCompare(y.key));
    return { arms: keyed.map((k) => k.arm), orderedBy: 'neutral' };
  }
  const sorted = [...arms].sort((a, b) => {
    const ab = a.headline.beatClosePct;
    const bb = b.headline.beatClosePct;
    if (ab === null && bb === null) return a.participantId.localeCompare(b.participantId);
    // An arm with no measured performance sorts LAST, never first on a null.
    if (ab === null) return 1;
    if (bb === null) return -1;
    if (ab !== bb) return bb - ab;
    const am = a.headline.clvPct ?? Number.NEGATIVE_INFINITY;
    const bm = b.headline.clvPct ?? Number.NEGATIVE_INFINITY;
    if (am !== bm) return bm - am;
    return a.participantId.localeCompare(b.participantId);
  });
  return { arms: sorted, orderedBy: 'headline' };
}

/**
 * Leader and runner-up — only when the gate is open.
 *
 * Naming a leader is publishing a ranking of one, so it is gated by the same
 * flag as the ordering. With the gate shut both are null and the front end's
 * hero and runner-up slots render nothing, which is its own empty-state
 * doctrine and is the honest state until the operator says the sample supports
 * a ranking.
 */
export function featuredOf(
  ordered: readonly WireArm[],
  allowed: boolean,
): { leaderParticipantId: string | null; runnerUpParticipantId: string | null } {
  if (!allowed) return { leaderParticipantId: null, runnerUpParticipantId: null };
  const ranked = ordered.filter((a) => a.headline.beatClosePct !== null);
  return {
    leaderParticipantId: ranked[0]?.participantId ?? null,
    runnerUpParticipantId: ranked[1]?.participantId ?? null,
  };
}

/**
 * A naive strategy's numbers, as a reference line.
 *
 * These exist to make the model numbers CREDIBLE rather than to compete with
 * them. A reader told that a model beats the closing line 72% of the time will
 * disbelieve it — and should, until they see that "always take the run-line
 * favourite" reaches 71% too once the vig is out. The de-vigged beat rate is
 * not the model being extraordinary; it is what removing a 3.5% hold does to
 * any strategy that is not actively bad, and the baselines are the evidence for
 * that reading. `baseline-underdog-rl` at 18.6% is the other half of it: the
 * de-vig does not rescue everything.
 *
 * Deliberately a SEPARATE block from `arms[]`, three reasons:
 *
 *  - Work-order item 1 asks for "per model arm", and the front-end standings
 *    row is "model (+lab)" — every baseline has `lab_id` and `model_id` NULL.
 *  - They are not comparable arm-to-arm. Each is SINGLE-MARKET by construction
 *    (`*-ml` moneyline, `*-total` total, `*-rl` spread) while a model pools all
 *    three into one game bucket, and vig differs by market: measured, the
 *    moneyline-only baseline shows a 3.28% observed vig against the run-line
 *    baseline's 3.67%.
 *  - Nothing here may be named leader. `featuredOf` runs over `arms[]` only.
 *
 * Lighter than an arm on purpose: no series, no wallets, no executed record. A
 * baseline places no trades and has no wallet to attribute one to.
 */
export interface WireBaseline {
  participantId: string;
  displayName: string;
  /** The markets this baseline actually picked in — one, by construction. */
  markets: string[];
  sample: {
    picks: number;
    scoreable: number;
    gamesScoreable: number;
    refused: number;
    scheduleHeldOut: number;
  };
  metrics: WirePaired;
  headline: WireArm['headline'];
}

export function projectBaselines(
  roster: readonly RosterEntry[],
  scores: readonly ScoredPickRow[],
  headlineBasis: HeadlineBasis,
  /** Same order as the arms — a baseline's mean must not sum differently. */
  cohortOrder: readonly string[],
): WireBaseline[] {
  const identity = new Map<string, RosterEntry>();
  for (const r of roster) if (!identity.has(r.participantId)) identity.set(r.participantId, r);

  const ordered = orderByCohort(scores, cohortOrder);
  const out: WireBaseline[] = [];
  for (const [participantId, id] of identity) {
    const mine = ordered.filter((s) => s.participantId === participantId);
    const paired = mine.length === 0 ? EMPTY_PAIRED : aggregatePaired(toAggregable(mine));
    const metrics = mine.length === 0 ? EMPTY_WIRE_PAIRED : toWirePaired(paired);
    let refused = 0;
    let heldOutWithValue = 0;
    for (const s of mine) {
      if (s.refusalReason !== null) refused += 1;
      if (s.heldOutOfPrimary === true && s.economicClvPct !== null) heldOutWithValue += 1;
    }
    out.push({
      participantId,
      displayName: id.displayName,
      markets: [...new Set(mine.map((s) => s.market))].sort(),
      sample: {
        picks: mine.length,
        scoreable: paired.economic.scoreable,
        gamesScoreable: paired.economic.gamesScoreable,
        refused,
        scheduleHeldOut: heldOutWithValue,
      },
      metrics,
      headline: readHeadline(metrics, headlineBasis),
    });
  }
  return out.sort((a, b) => a.participantId.localeCompare(b.participantId));
}

/**
 * The calculation, in the payload.
 *
 * Every figure this endpoint publishes is a claim about money made under the
 * protocol's name, and the headline one — a beat rate near 70% — is exactly the
 * kind of number a reader is right to disbelieve on sight. So the definitions
 * ship WITH the numbers rather than in a README the reader does not have: a
 * skeptic can re-derive `vig.breakEvenPct` from `marginAdjusted.mean` with the
 * formula in front of them, and see for themselves that the high beat rate is
 * what removing a 3.5% hold does rather than a claim about prescience.
 *
 * Static text, so it costs nothing to serve and cannot drift from the code
 * except by someone editing this constant — which is the point of having one.
 */
export const METHODOLOGY = Object.freeze({
  economicClvPct:
    'Expected ROI at the price actually taken: 100 * (entryDecimal * closeProbability - 1), ' +
    'with the closing probability de-vigged proportionally. Negative for almost every ' +
    'strategy, because the book margin is inside the price you took.',
  marginAdjustedClvPct:
    'The same bet at a fair price: 100 * (closeProbability / entryProbability - 1), with ' +
    'BOTH sides de-vigged proportionally. Zero means the forecast exactly matched the ' +
    'market. This is the "if there were no vig" reading.',
  beatClosePct:
    'Share of scoreable picks with CLV strictly greater than zero. On the margin-adjusted ' +
    'metric 50% is break-even, which the two coin-flip baselines sit on exactly.',
  clustering:
    'gameLevel averages within each game first, then across games, so a game that drew ' +
    'several picks does not outvote one that drew a single pick. perPick weights every ' +
    'pick equally. Both are published; neither replaces the other.',
  stratum:
    'A pick contributes a value when it is not held out of the primary stratum (a ' +
    'schedule change between the forecast and the close) and the metric produced a value. ' +
    'Refused picks are counted and disclosed by reason, never silently dropped.',
  vigObservedPct:
    'The hold actually paid, implied by the two published means: ' +
    '100 * (1 - (1 + economic/100) / (1 + marginAdjusted/100)).',
  vigBreakEvenPct:
    'The uniform hold at which the mean CLV crosses zero: ' +
    '100 * (marginAdjusted/100) / (1 + marginAdjusted/100). Pay less than this and these ' +
    'picks were profitable; pay more and they were not. Negative means the strategy loses ' +
    'even at zero vig. Expressed as hold = margin / (1 + margin), the convention a market ' +
    "maker's quoted spread converts to.",
  devigMethod: 'proportional (the same method the production closing-line capture uses)',
  baselines:
    'Naive reference strategies scored identically to the model arms. They are here so a ' +
    'reader can see what the de-vig alone buys before attributing anything to a model.',
});
