/**
 * GET /v1/benchmark/profile/:participantId — one model arm's profile.
 *
 * The last part of #72. The standings table answers "how do the arms compare";
 * this answers "what has this one arm done", scoped by sport and market.
 *
 * ## Parity is structural, not tested into existence
 *
 * #72's binding acceptance criterion is *exact all/all parity* with
 * `/v1/benchmark/standings`: this endpoint's unfiltered figures must equal the
 * standings entry for the same arm. That is not achieved by re-deriving them and
 * then writing a test that compares two numbers — it is achieved by them BEING
 * the same numbers. `assembleStandings` performs the reads, the sport scope, the
 * policy-version choice and `projectArms`, and both handlers consume its output.
 *
 * Re-deriving from `benchmark_model_aggregates` was the obvious alternative and is
 * the wrong one: it would agree on the day it was written and drift afterwards,
 * and a test comparing two derivations that meet at a shared intermediate cannot
 * see the drift (`3d-witness`). A parity test still exists, and what it guards is
 * a future refactor separating the two paths — not today's arithmetic.
 *
 * ## No rank. Ever, while ranking is withheld
 *
 * `standingsProject.ts` states it plainly: an order IS a ranking. `3j-ordering`
 * extends that — a designated winner, a default sort key and a rendered position
 * are the same judgement in different costumes. So this endpoint serves no rank,
 * no position, no percentile and no peer comparison, and it calls neither
 * `orderArms` nor `featuredOf`. It echoes `ranking.allowed` so a consumer knows
 * the state of the gate, and that is the whole of what it says about order.
 *
 * A profile is the surface where a rank would look most harmless — one number, on
 * one arm's own page. It is exactly as much of a published ranking as the table.
 *
 * ## What a `market` filter scopes, and the one thing it cannot
 *
 * It scopes the CLV metric family, because `projectArms` computes a real
 * per-market split (`byMarket`). It ALSO scopes the executed record and the ROI,
 * which the first version of this endpoint left pooled under an honest label.
 *
 * That was a real acceptance gap rather than a labelling choice, and a reviewer
 * was right to block it: #72 requires "filtered risk and ROI denominator", and a
 * label saying the money is pooled does not deliver a filtered figure. The
 * reproduction was stark — 10 risk / +7 net on moneyline beside 30 risk / −30 net
 * on total, and `?market=moneyline` answered the pooled −57.5% rather than +70%.
 *
 * My stated reason was also wrong about the data, not just the outcome: I wrote
 * that "fills carry no market breakdown", which is true of `WireExecuted` and
 * false of `BenchmarkFill`, which has a `market`. Describing a limitation of the
 * projection as a limitation of the source is how a gap gets argued for instead
 * of closed.
 *
 * It is scoped by the SAME function over a SUBSET, not by a second arithmetic.
 * `collectExecuted` now rolls its priced fills up twice from one grouping pass —
 * once per participant and once per (participant, market) — with the same
 * `summarizeExecuted` both times, and this handler reads the market entry and runs
 * it through the same `wireExecuted` conversion the pooled figure uses. The
 * all-markets case still serves `arm.executed` verbatim, so parity with the table
 * is untouched by any of it.
 *
 * A test asserts the three markets SUM to the pooled totals, which is the one
 * assertion that catches a wrong filter, a double count and a divergent conversion
 * together.
 *
 * `series` and `headline` remain pooled and labelled, because those genuinely
 * cannot be split: a series point is a cohort-day's pooled figure and the headline
 * is the basis applied to the whole sample.
 *
 * One quantity has no market and so appears only in the pooled view:
 * `unresolvedFills` counts receipts the identity chain could not bind to a unique
 * priced fill, so they are not in `fills` at all and no market view can contain
 * them. A market-scoped response carries `unattributedFills` to say how many
 * exist, so the market totals not summing to the receipt count is visible rather
 * than puzzling.
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../../lib/env.js';
import { getSupabase } from '../../lib/supabase.js';
import { SPORTS as VALID_SPORTS } from '../../lib/sports.js';
import type { ApiError } from '../../middleware/errorHandler.js';
import {
  ProjectionIntegrityError,
  respondProjectionFault,
  respondToQueryError,
} from './source.js';
import { parseSlateDate, parseSportParam } from './window.js';
import { assembleStandings } from './standings.js';
import { armMarketKey } from './executedFetch.js';

import {
  MARKETS,
  METHODOLOGY,
  wireExecuted,
  type WireArm,
  type WireExecuted,
  type WireMarketSplit,
} from './standingsProject.js';

/**
 * The executed money, with its own denominator served beside it.
 *
 * ## Why the ratio ships with its numerator and denominator
 *
 * #72 asks for "filtered risk and ROI denominator" and pins all/all to "Core API's
 * net / total stake, including pending risk". A bare percentage would leave a
 * consumer to reconstruct which stake that was, and there are two plausible
 * answers one of which double-counts. So all three numbers ship, and the quotient
 * is computed from exactly the two that ship: anyone can verify the division, and
 * a future drift between them is visible rather than silent.
 *
 * ## The denominator is `stakedUsdc` ALONE
 *
 * Verified in `executed.ts:296-307` rather than inferred from the field names:
 * `stakedWei6` accumulates on EVERY fill, unconditionally, while
 * `pendingStakeWei6` accumulates only for fills with no payout yet. So pending
 * risk is a SUBSET of staked, and `staked + pending` would count it twice — the
 * `3d-aggregate` shape where a number silently doubles. #72's "total stake,
 * including pending risk" describes `stakedUsdc`, which already includes it.
 *
 * ## The numerator is DECIDED fills, not settled ones — corrected in review
 *
 * The first version of this label named the numerator as covering only
 * chain-settled fills, and that was false. (Paraphrased rather than quoted, per
 * `3c`: quoting a superseded claim leaves the stale wording in the file, so no
 * grep can ever show it is gone.) `netWei6` accumulates whenever
 * `verdict.payoutWei6` is non-null
 * (`executed.ts:306`), and `deriveExecutedVerdict` produces a payout whenever
 * `winSide` is known — which is a `'settled'` source (`:150`, from the chain's
 * own settlement) OR a `'predicted'` one (`:156`, `:177`, derived from the
 * contest's posted scores before settlement). Only `'undecided'` yields a null
 * payout and lands in pending.
 *
 * So the numerator includes score-predicted payouts, and a reviewer's probe
 * showed exactly that: `+7` net against `verdictSource {settled: 0, predicted: 1}`
 * with no settlement event on the chain at all. The arithmetic is the canonical
 * standings arithmetic and is not changed here; the LABEL was wrong, and it was
 * wrong in the direction that overstates confidence.
 *
 * The lesson for next time is narrow and worth keeping: I read the accumulation
 * at `:296-307` and INFERRED that a non-null payout meant settled, rather than
 * reading `deriveExecutedVerdict` one call down. Verifying one layer and assuming
 * the next is how a definitive word gets into a money label.
 *
 * `verdictSource` ships beside the figures so the split is visible rather than
 * described, and `basis` now names what the numerator actually is.
 */
function roiOf(executed: WireExecuted, scope: 'all-markets' | 'market'): Record<string, unknown> {
  const netUsdc = executed.netUsdc;
  const riskUsdc = executed.stakedUsdc;
  return {
    netUsdc,
    riskUsdc,
    pendingRiskUsdc: executed.pendingStakeUsdc,
    // Null rather than 0 when nothing is at risk: an undefined ratio and a zero
    // return are different states, and #72 requires they stay distinct.
    pct:
      netUsdc === null || riskUsdc === null || riskUsdc === 0
        ? null
        : Math.round((10_000 * netUsdc) / riskUsdc) / 100,
    basis:
      'net over fills with a DECIDED verdict (chain-settled OR score-predicted) / ' +
      'risk over ALL fills, including those still undecided. See verdictSource for the split.',
    scope,
  };
}

/**
 * The per-market split for one market.
 *
 * `projectArms` builds `byMarket` as `MARKETS.map(...)` (standingsProject.ts:582),
 * so every arm carries an entry for EVERY market — zeroed where it made no picks,
 * which is the same roster-driven left join the rest of the projection uses. A
 * market that validated against `MARKETS` therefore always has a split.
 *
 * The first version of this returned `null` for a missing split and the response
 * carried a `marketPresent: false` state for it. That state was unreachable, and
 * the test written for it was CONDITIONAL — `if (marketPresent === false) … else …`
 * — so it passed either way and a mutant flipping the flag survived. Dead code
 * plus an unfalsifiable test reads as coverage and is worse than neither.
 *
 * So an absent split is now an integrity fault rather than a served state: it can
 * only mean `MARKETS` and `projectArms` have stopped agreeing, which is the server
 * answering outside its own contract — the same class `readAllByKeyset` refuses a
 * non-advancing cursor for, and answered the same way.
 */
function splitFor(arm: WireArm, market: string): WireMarketSplit {
  const split = arm.byMarket.find((s) => s.market === market);
  if (split === undefined) {
    throw new ProjectionIntegrityError(
      'benchmark_scores',
      `market ${market} validated but the projection served no split for it`,
    );
  }
  return split;
}

export async function getBenchmarkProfileHandler(req: Request, res: Response): Promise<void> {
  const participantId = String(req.params.participantId ?? '').trim();
  if (participantId === '') {
    res.status(400).json({
      error: 'participantId is required.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const bad = (error: string): void => {
    res.status(400).json({ error, code: 'INVALID_PARAM' } satisfies ApiError);
  };

  // Every param through the SHARED validator its siblings use. Taking `sport`
  // raw on the ledger answered 200 with an empty page for `?sport=MLB`, and a
  // shape-only date check answered 500 on `2026-02-30` — both caught in review on
  // the two previous PRs, both because a new endpoint validated for itself.
  const sport = parseSportParam(req.query.sport);
  if (sport === 'invalid') {
    bad(`Invalid "sport". Must be "all" or one of: ${[...VALID_SPORTS].sort().join(', ')}.`);
    return;
  }

  const market = req.query.market === undefined ? null : String(req.query.market).trim();
  if (market !== null && !MARKETS.includes(market as (typeof MARKETS)[number])) {
    bad(`Invalid "market". Must be one of: ${[...MARKETS].sort().join(', ')}.`);
    return;
  }

  const slateDate = parseSlateDate(req.query.date);
  if (slateDate === 'invalid') {
    bad('date must be a real calendar date in YYYY-MM-DD form.');
    return;
  }

  const requestedVersion =
    req.query.scoringPolicyVersion === undefined
      ? undefined
      : String(req.query.scoringPolicyVersion);
  if (requestedVersion !== undefined && requestedVersion.trim() === '') {
    bad('scoringPolicyVersion must be a non-empty version string.');
    return;
  }

  const config = loadConfig();

  const filters = {
    sport: sport === undefined || sport === 'all' ? null : sport,
    market,
    date: slateDate ?? null,
    scoringPolicyVersion: requestedVersion ?? null,
  };

  /** The answer when there is nothing to serve, so an absence is never bare. */
  const without = (reason: string, extra: Record<string, unknown> = {}): void => {
    res.status(200).json({
      network: config.network,
      participantId,
      found: false,
      reason,
      filters,
      arm: null,
      roi: null,
      metrics: null,
      // Absent by contract, not by omission — see the block at the bottom of a
      // found response for why each one is null.
      sources: null,
      notebook: null,
      ...extra,
    });
  };

  // THE PUBLICATION GATE. Unset means nothing is public, answered without reading
  // anything — the same doctrine `window.ts`, `stats.ts`, `pick.ts` and
  // `ledger.ts` follow.
  if (config.benchmarkPublicMinSlateDate === undefined) {
    without('not_published');
    return;
  }

  let assembled;
  try {
    assembled = await assembleStandings(
      getSupabase(),
      {
        network: config.network,
        benchmarkPublicMinSlateDate: config.benchmarkPublicMinSlateDate,
        benchmarkStandingsWindowDays: config.benchmarkStandingsWindowDays,
        benchmarkHeadlineBasis: config.benchmarkHeadlineBasis,
        scorers: config.scorers,
      },
      { sport, slateDate, requestedVersion },
    );
  } catch (err) {
    if (respondProjectionFault(res, err)) return;
    throw err;
  }
  if (assembled.kind === 'queryError') {
    respondToQueryError(res, assembled.error, assembled.context);
    return;
  }
  if (assembled.kind === 'empty') {
    without('no_cohorts_in_window');
    return;
  }

  const arm = assembled.arms.find((a) => a.participantId === participantId);
  if (arm === undefined) {
    // Not on the roster for this window and sport. Distinct from "published but
    // has no picks", which `projectArms` renders as a present arm with zeroes —
    // the roster-driven left join is what keeps those two apart.
    without('not_on_roster');
    return;
  }

  const split = market === null ? null : splitFor(arm, market);

  /**
   * The executed record, scoped to the requested market when there is one.
   *
   * All-markets serves `arm.executed` VERBATIM — the object the standings table
   * publishes — so parity is untouched by anything below. A market scope
   * re-aggregates the same fills with the same `summarizeExecuted` and the same
   * `wireExecuted` conversion, so it is one arithmetic over two populations rather
   * than two arithmetics.
   *
   * `unresolvedFills` is passed as 0 for a market scope on purpose: those receipts
   * were never bound to a priced fill, so they are absent from `fills` and have no
   * market to be filtered by. The pooled count is surfaced as `unattributedFills`
   * instead of being silently attributed to whichever market was asked for.
   */
  const scopedExecuted: WireExecuted =
    market === null
      ? arm.executed
      : wireExecuted(assembled.executedByMarket.get(armMarketKey(participantId, market)));

  res.status(200).json({
    network: config.network,
    participantId,
    found: true,
    filters,
    identity: {
      displayName: arm.displayName,
      modelId: arm.modelId,
      lab: arm.lab,
      kind: arm.kind,
      // Per cohort-day by design: migration 079 keyed the binding
      // `(cohort_id, participant_id)` so a public attribution of an on-chain fill
      // cannot be moved between models afterwards. One scalar across a
      // multi-day window would have no defined value.
      wallets: arm.wallets,
    },
    publication: {
      minSlateDate: assembled.win.minSlateDate,
      cohortsPublished: assembled.win.cohortsPublished,
      cohortsInWindow: assembled.win.cohorts.length,
      cohortsScored: assembled.cohortsWithScores.size,
      windowDays: assembled.win.windowDays,
      standingsThrough: assembled.win.standingsThrough,
    },
    scoringPolicyVersion: assembled.version,
    availableVersions: assembled.available,
    /**
     * The gate's STATE, and nothing derived from it.
     *
     * No rank, no position, no percentile, no peer comparison — see the header.
     * A consumer that wants the comparison reads the table, where the ordering is
     * gated, named and served as the contract.
     */
    ranking: { allowed: assembled.rankingAllowed, withheldBy: assembled.withheldBy },
    methodology: METHODOLOGY,
    headline: { ...arm.headline, scope: 'all-markets' },
    /**
     * The CLV metric family. `market` DOES scope this, because `projectArms`
     * computes a real per-market split. `scope` names which one is being served
     * so the two cases are not one field apart from indistinguishable.
     *
     * A market the arm never picked yields a null `metrics` with
     * `marketPresent: false` — distinct from an arm with no picks at all, and
     * distinct from a zero.
     */
    metrics:
      split === null
        ? { scope: 'all-markets', sample: arm.sample, metrics: arm.metrics }
        : {
            scope: 'market',
            market,
            // A market the arm never picked is a split of ZEROES, not an absence:
            // "0 picks" is a true statement and a more useful one than "no data".
            sample: {
              eligible: split.eligible,
              picks: split.picks,
              scoreable: split.scoreable,
            },
            metrics: split.metrics,
          },
    /** The full split, always, so a market-scoped request still shows the others. */
    byMarket: arm.byMarket,
    executed: {
      ...scopedExecuted,
      scope: market === null ? 'all-markets' : 'market',
      ...(market === null
        ? {}
        : {
            market,
            // Receipts with no resolvable market, which therefore appear in NO
            // market view. Surfaced so the market totals not summing to the
            // receipt count is legible rather than puzzling.
            unattributedFills: arm.executed.unresolvedFills,
          }),
    },
    roi: roiOf(scopedExecuted, market === null ? 'all-markets' : 'market'),
    /** Genuinely pooled: a series point is a cohort-day's figure across markets. */
    series: { scope: 'all-markets', points: arm.series },
    trend: arm.trend,
    /**
     * Absent by contract rather than by omission, and #72 says so itself.
     *
     * `sources` would be published evidence-reference URLs. No benchmark relation
     * carries any: `benchmark_decision_reveals` has none, and an artifact's
     * `source_path` / `source_sha256` are provenance for the file rather than
     * citations a reader can follow. It needs a producer change upstream.
     *
     * `notebook` would be editorial prose scoped to a model and filter.
     * `benchmark_pick_writeups.writeup` is per-PICK prose and is not that. #72's
     * instruction is explicit — keep it absent until editorial data exists, and
     * do not manufacture content to fill the panel.
     */
    sources: null,
    notebook: null,
  });
}
