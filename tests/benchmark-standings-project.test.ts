/**
 * Pure cases on the standings projection and the policy-version rule — the
 * pieces the handler suite drives only through production-shaped fixtures,
 * which cannot reach the inputs below.
 */
import { describe, expect, it } from 'vitest';
import {
  orderByCohort,
  projectArms,
  type ArmAttemptRow,
  type RosterEntry,
  type ScoredPickRow,
} from '../src/v1/benchmark/standingsProject.js';
import { resolvePolicyVersion } from '../src/v1/benchmark/standings.js';

const ARM = 'anthropic-claude-fable-5';

function row(cohortId: string, gameId: string, v: number): ScoredPickRow {
  return {
    cohortId,
    participantId: ARM,
    gameId,
    market: 'moneyline',
    heldOutOfPrimary: false,
    refused: false,
    refusalReason: null,
    economicClvPct: v,
    marginAdjustedClvPct: v,
  };
}

const ROSTER: RosterEntry[] = [
  { cohortId: 'c-a', participantId: ARM, kind: 'model', displayName: 'Fable', labId: 'anthropic', modelId: 'fable' },
];
const ATTEMPTS: ArmAttemptRow[] = [];

describe('orderByCohort', () => {
  it('orders by the cohort rank and keeps the fetched order within a cohort', () => {
    const rows = [row('c-b', 'g2', 1), row('c-a', 'g1', 2), row('c-b', 'g3', 3), row('c-a', 'g0', 4)];
    const out = orderByCohort(rows, ['c-a', 'c-b']);
    expect(out.map((r) => r.gameId)).toEqual(['g1', 'g0', 'g2', 'g3']);
    // The same objects, not copies — a caller comparing by identity still can.
    expect(out[0]).toBe(rows[1]);
  });

  /**
   * A cohort the order does not name sorts LAST, in fetched order, and is
   * never dropped: a caller that produced one sees it in the numbers rather
   * than losing it silently.
   */
  it('keeps a row whose cohort is not in the order, after every known cohort', () => {
    const rows = [row('c-z', 'gz', 1), row('c-a', 'g1', 2)];
    expect(orderByCohort(rows, ['c-a']).map((r) => r.cohortId)).toEqual(['c-a', 'c-z']);
  });

  it('ranks a repeated cohort id once, at its first position', () => {
    const rows = [row('c-b', 'g2', 1), row('c-a', 'g1', 2)];
    expect(orderByCohort(rows, ['c-a', 'c-b', 'c-a']).map((r) => r.cohortId)).toEqual(['c-a', 'c-b']);
  });
});

describe('projectArms — the series folds each cohort once', () => {
  /**
   * `resolveWindow` derives the order from a Map so it cannot repeat an id;
   * this pins that the projection does not DEPEND on that. With the id
   * repeated, the day would otherwise fold into the running aggregate twice
   * and the last point would drift off the headline.
   */
  it('does not fold a day twice when the cohort order repeats an id', () => {
    const [arm] = projectArms({
      roster: ROSTER,
      scores: [row('c-a', 'g1', -4), row('c-b', 'g2', -1)],
      attempts: ATTEMPTS,
      wallets: [],
      executed: new Map(),
      cohortOrder: ['c-a', 'c-a', 'c-b'],
      slateDateByCohort: new Map([
        ['c-a', '2026-08-15'],
        ['c-b', '2026-08-16'],
      ]),
      headlineBasis: 'marginAdjusted.gameLevel',
    });
    expect(arm?.series.map((p) => p.cohortId)).toEqual(['c-a', 'c-b']);
    const last = arm?.series[1]?.cumulative.marginAdjusted.gameLevel;
    expect(last?.meanClvPct).toBe(arm?.metrics.marginAdjusted.gameLevel.meanClvPct);
    expect(last?.n).toBe(2);
    expect(last?.meanClvPct).toBe(-2.5);
  });
});

describe('resolvePolicyVersion — coverage first, recency second', () => {
  const at = (
    id: number,
    cohort: string,
    version: string,
    scoredAt: string,
  ): Parameters<typeof resolvePolicyVersion>[0][number] => ({
    id,
    scoring_policy_version: version,
    held_out_of_primary: false,
    refused: false,
    refusal_reason: null,
    economic_clv_pct: 1,
    margin_adjusted_clv_pct: 1,
    scored_at: scoredAt,
    benchmark_decisions: { cohort_id: cohort, participant_id: ARM, game_id: 'g', market: 'moneyline' },
  });

  /**
   * The docstring's own failure case: a re-score campaign that starts with
   * ONE cohort must not displace the version covering all of them, however
   * recent it is. Every handler fixture has both versions on the same single
   * cohort, so coverage ties there and only the recency tiebreak is exercised
   * — a recency-first comparator survived the suite. This fixture is the one
   * where the two rules disagree.
   */
  it('prefers the version covering more cohorts over a more recent partial one', () => {
    const rows = [
      at(1, 'c-a', 'scoring-v0.6.1', '2026-08-16T00:00:00+00:00'),
      at(2, 'c-b', 'scoring-v0.6.1', '2026-08-17T00:00:00+00:00'),
      at(3, 'c-a', 'scoring-v0.6.2', '2026-09-01T00:00:00+00:00'),
    ];
    const { version, available } = resolvePolicyVersion(rows);
    expect(version).toBe('scoring-v0.6.1');
    expect(available.map((v) => [v.version, v.cohortCount])).toEqual([
      ['scoring-v0.6.1', 2],
      ['scoring-v0.6.2', 1],
    ]);
  });

  /** Negative control: with coverage tied, the more recent version wins. */
  it('breaks a coverage tie toward the latest scored_at', () => {
    const rows = [
      at(1, 'c-a', 'scoring-v0.6.1', '2026-08-16T00:00:00+00:00'),
      at(2, 'c-a', 'scoring-v0.6.2', '2026-09-01T00:00:00+00:00'),
    ];
    expect(resolvePolicyVersion(rows).version).toBe('scoring-v0.6.2');
  });
});
