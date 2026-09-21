/**
 * GET /v1/benchmark/pick/:participantId/:gameId/:market — one pick, in full.
 *
 * The detail behind a card on `/v1/benchmark/picks`. Small, because indexer
 * migrations 083 and 086 already did the hard part: `public.benchmark_pick_ledger`
 * is the published projection, and this endpoint is a keyed read of it plus two
 * lookups for things the view does not carry.
 *
 * ## The key identifies at most one row, and that is a property of the view
 *
 * Migration 086 defines `benchmark_pick_ledger_v6` with
 * `row_number() OVER (PARTITION BY participant_id, game_id, market ORDER BY as_of DESC)`
 * and keeps `latest_ordinal = 1`. So there is no "pick the newest snapshot" logic
 * here — the view already did it, and `as_of` is served as the stamp of WHICH
 * snapshot the row is, not as a key the caller has to supply.
 *
 * ## Three states, and why not more
 *
 * The same `WHERE` that takes the latest row also drops any key present in
 * `benchmark_pick_ledger_conflicts`. So a missing row has several causes, and the
 * honest taxonomy is the one the public relations can actually support:
 *
 *   - `published`         — the row was found.
 *   - `withheld_conflict` — the key is in the conflicts view. An affirmative,
 *                           dated, public statement about a key that exists.
 *   - `not_published`     — everything else.
 *
 * `not_published` deliberately conflates causes rather than guessing between
 * them, and the reasons are worth writing down because the temptation is to
 * split it:
 *
 *   - A sealed-but-unrevealed pick produces no reveal row, therefore no key row,
 *     therefore no conflicts row and no ledger row. It is byte-identical to
 *     "never existed" in every relation this endpoint may read. `benchmark_decisions`
 *     would distinguish it — and telling a caller "this arm has a sealed pick on
 *     this game" before the reveal discloses which games an arm picked, which is
 *     the thing the seal exists to withhold. Not split, on purpose.
 *   - A key whose candidates resolve to a non-live cohort is never published and
 *     produces no conflicts row either.
 *   - A slate before `BENCHMARK_PUBLIC_MIN_SLATE_DATE` is not public at all.
 *
 * Reporting one state for those is not a loss of information; claiming to
 * distinguish them would be an invention. A caller that needs more is asking an
 * operator question, not a public-read question.
 *
 * ## The gate is the row's own slate_date, not the standings window
 *
 * `window.ts` is emphatic that the publication gate is one date comparison. The
 * rest of `resolveWindow` — `windowDays`, `activeCohortId`, the sport scope — is
 * not the gate: `windowDays` bounds an AGGREGATE's read cost (which is why
 * `cohortsPublished` is computed BEFORE it, so a bound that bit stays visible),
 * and `activeCohortId` answers "which cohort does a dateless request mean", a
 * question a request naming its own pick does not ask.
 *
 * So the gate here is `.gte('slate_date', minSlateDate)` pushed down onto the
 * ledger read, plus the unset short-circuit. Resolving the window instead would
 * refuse a published pick older than `windowDays` — a false negative on data the
 * operator has published.
 *
 * ## Why the decision read needs no live-cohort filter, which is not obvious
 *
 * core-api connects as `service_role` (`lib/supabase.ts`), and migration 086's
 * live-only scoping is RESTRICTIVE RLS `FOR SELECT TO anon, authenticated`. It
 * does not constrain this process. A base-table read here could therefore return
 * a rehearsal cohort's rows.
 *
 * It cannot, because of the ORDER of the reads rather than a filter: the ledger
 * row is live-only by the view's own body, and the decision read is keyed on
 * THAT row's `source_decision_id`. It can only return the one live decision the
 * published row already named. Reordering these reads, or reading the base table
 * on a key the view did not confirm, would reintroduce the exposure — so the
 * ordering is load-bearing and a test pins it.
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../../lib/env.js';
import { getSupabase } from '../../lib/supabase.js';
import type { ApiError } from '../../middleware/errorHandler.js';
import { BENCHMARK, REVEAL_EMBED, respondToQueryError } from './source.js';
import {
  decimalToAmerican,
  resolveSelectionSide,
  selectionLabel,
  spreadLines,
} from './picks.js';

/** The markets a pick can be on. Rejected early so a typo is a 400, not a 200 with nothing. */
const PICK_MARKETS = new Set(['moneyline', 'spread', 'total']);

/** What the caller asked about, echoed on every answer including the empty ones. */
interface PickIdentity {
  network: string;
  participantId: string;
  gameId: string;
  market: string;
}

type PickState = 'published' | 'withheld_conflict' | 'not_published';

/** The ledger row, named exactly as the view serves it. */
interface LedgerRow {
  participant_id: string;
  participant_name: string;
  lab_id: string | null;
  cohort_id: string;
  slate_date: string;
  game_id: string;
  away_team_name: string;
  away_team_abbreviation: string;
  home_team_name: string;
  home_team_abbreviation: string;
  start_time: string | null;
  game_status: string | null;
  away_score: number | null;
  home_score: number | null;
  sport: string;
  market: string;
  selection: string | null;
  line: number | null;
  pick_price_decimal: number | null;
  closing_line: number | null;
  closing_price_decimal: number | null;
  closing_captured_at: string | null;
  clv_pct: number | null;
  margin_adjusted_clv_pct: number | null;
  unscored_reason: string | null;
  scoring_policy_version: string | null;
  clv_scored_at: string | null;
  held_out_of_primary: boolean | null;
  primary_axis: string | null;
  axis_valuation: number | null;
  axis_trend: number | null;
  axis_consensus: number | null;
  axis_news: number | null;
  axis_softness: number | null;
  primary_expectation: string | null;
  fill_tx_hash: string | null;
  filled_at: string | null;
  stake_usdc: number | null;
  fill_price_decimal: number | null;
  result: string | null;
  net_usdc: number | null;
  settlement_tx_hash: string | null;
  claim_tx_hash: string | null;
  as_of: string;
  source_decision_id: number;
  run_id: string | null;
  forecast_digest: string | null;
  rationale_digest: string | null;
  seal_source_sha256: string | null;
  reveal_source_sha256: string | null;
}

const LEDGER_SELECT = [
  'participant_id', 'participant_name', 'lab_id', 'cohort_id', 'slate_date', 'game_id',
  'away_team_name', 'away_team_abbreviation', 'home_team_name', 'home_team_abbreviation',
  'start_time', 'game_status', 'away_score', 'home_score', 'sport', 'market',
  'selection', 'line', 'pick_price_decimal', 'closing_line', 'closing_price_decimal',
  'closing_captured_at', 'clv_pct', 'margin_adjusted_clv_pct', 'unscored_reason',
  'scoring_policy_version', 'clv_scored_at', 'held_out_of_primary', 'primary_axis',
  'axis_valuation', 'axis_trend', 'axis_consensus', 'axis_news', 'axis_softness',
  'primary_expectation', 'fill_tx_hash', 'filled_at', 'stake_usdc', 'fill_price_decimal',
  'result', 'net_usdc', 'settlement_tx_hash', 'claim_tx_hash', 'as_of',
  'source_decision_id', 'run_id', 'forecast_digest', 'rationale_digest',
  'seal_source_sha256', 'reveal_source_sha256',
].join(', ');

/** The no-pick body, shared by every state that has no row to serve. */
function withoutPick(
  identity: PickIdentity,
  state: PickState,
  conflict: Record<string, unknown> | null,
): Record<string, unknown> {
  return { ...identity, state, pick: null, conflict, axisScale: { min: 1, max: 5 } };
}

/**
 * The served pick.
 *
 * Every nullable field is passed through as the DDL stores it. Three of those
 * are load-bearing distinctions rather than missing data, and normalising any of
 * them would erase a state `#72` requires stay visible:
 *
 *   - `netUsdc` is null only while `result` is `pending`; a push, void or no-fill
 *     carries a REAL zero.
 *   - `clvPct` null WITH `unscoredReason` set is the scorer refusing; null with
 *     both null is not-yet-scored.
 *   - `heldOutOfPrimary` stays tri-state. `?? false` here would turn "not tagged"
 *     into "not held" — the exact `3g-nullish` collapse that a sibling repo's
 *     stratum predicate was caught on.
 */
function toPickBody(row: LedgerRow, writeup: string | null, sealedAt: string | null, revealedAt: string | null): Record<string, unknown> {
  const american = decimalToAmerican(row.pick_price_decimal);
  const away = { name: row.away_team_name, abbreviation: row.away_team_abbreviation };
  const home = { name: row.home_team_name, abbreviation: row.home_team_abbreviation };
  const side = resolveSelectionSide(row.selection, away, home);
  // Same convention the picks endpoint serves: a spread carries the side-labelled
  // pair and a null `line`, because the stored value is the HOME handicap.
  const spread = row.market === 'spread' ? spreadLines(row.line) : { awayLine: null, homeLine: null };

  return {
    participantId: row.participant_id,
    displayName: row.participant_name,
    lab: row.lab_id,
    cohortId: row.cohort_id,
    slateDate: row.slate_date,
    sport: row.sport,
    market: row.market,
    game: {
      gameId: row.game_id,
      awayTeam: away,
      homeTeam: home,
      startTime: row.start_time,
      status: row.game_status,
      awayScore: row.away_score,
      homeScore: row.home_score,
    },
    selection: row.selection,
    selectionLabel: selectionLabel(row.market, row.selection, row.line, american, side),
    selectionSide: side,
    line: row.market === 'spread' ? null : row.line,
    awayLine: spread.awayLine,
    homeLine: spread.homeLine,
    priceDecimal: row.pick_price_decimal,
    priceAmerican: american,
    closing: {
      line: row.closing_line,
      priceDecimal: row.closing_price_decimal,
      priceAmerican: decimalToAmerican(row.closing_price_decimal),
      capturedAt: row.closing_captured_at,
      // Close readiness as its own field rather than an inferred null: a null
      // `capturedAt` and "no close was taken" are the same bytes otherwise.
      ready: row.closing_captured_at !== null,
    },
    clv: {
      pct: row.clv_pct,
      marginAdjustedPct: row.margin_adjusted_clv_pct,
      unscoredReason: row.unscored_reason,
      scoringPolicyVersion: row.scoring_policy_version,
      scoredAt: row.clv_scored_at,
      heldOutOfPrimary: row.held_out_of_primary,
    },
    axes: row.axis_valuation === null
      ? null
      : {
          valuation: row.axis_valuation,
          trend: row.axis_trend ?? 0,
          consensus: row.axis_consensus ?? 0,
          news: row.axis_news ?? 0,
          softness: row.axis_softness ?? 0,
        },
    primaryAxis: row.primary_axis,
    primaryExpectation: row.primary_expectation,
    execution: {
      result: row.result,
      fillTxHash: row.fill_tx_hash,
      filledAt: row.filled_at,
      stakeUsdc: row.stake_usdc,
      fillPriceDecimal: row.fill_price_decimal,
      netUsdc: row.net_usdc,
      settlementTxHash: row.settlement_tx_hash,
      claimTxHash: row.claim_tx_hash,
    },
    writeup,
    digests: {
      // Named so a verifier does not have to guess which function produced them.
      algorithm: 'sha256',
      forecast: row.forecast_digest,
      rationale: row.rationale_digest,
      sealSource: row.seal_source_sha256,
      revealSource: row.reveal_source_sha256,
    },
    timeline: { sealedAt, revealedAt },
    decisionId: row.source_decision_id,
    runId: row.run_id,
    asOf: row.as_of,
  };
}

export async function getBenchmarkPickHandler(req: Request, res: Response): Promise<void> {
  const participantId = String(req.params.participantId ?? '').trim();
  const gameId = String(req.params.gameId ?? '').trim();
  const market = String(req.params.market ?? '').trim();

  if (participantId === '' || gameId === '') {
    res.status(400).json({
      error: 'participantId and gameId are required.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  if (!PICK_MARKETS.has(market)) {
    res.status(400).json({
      error: `Invalid "market". Must be one of: ${[...PICK_MARKETS].sort().join(', ')}.`,
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const config = loadConfig();
  const identity: PickIdentity = { network: config.network, participantId, gameId, market };

  // THE PUBLICATION GATE. Unset means nothing is public, answered without
  // reading anything — the same doctrine `window.ts` states and `stats.ts`
  // follows. A request that reached the database anyway would make "nothing is
  // published" cost the same as serving.
  const minSlateDate = config.benchmarkPublicMinSlateDate;
  if (minSlateDate === undefined) {
    res.status(200).json(withoutPick(identity, 'not_published', null));
    return;
  }

  const sb = getSupabase();

  const ledger = await sb
    .from(BENCHMARK.pickLedger)
    .select(LEDGER_SELECT)
    .eq('network', config.network)
    .eq('participant_id', participantId)
    .eq('game_id', gameId)
    .eq('market', market)
    // The gate, pushed down rather than applied after the fact.
    .gte('slate_date', minSlateDate)
    .maybeSingle();
  if (ledger.error) {
    respondToQueryError(res, ledger.error, BENCHMARK.pickLedger);
    return;
  }

  if (ledger.data === null) {
    // No row. Ask the one relation that can turn an absence into a statement.
    const conflict = await sb
      .from(BENCHMARK.pickLedgerConflicts)
      .select('participant_id, game_id, sport, market, slate_date, reason, as_of')
      .eq('participant_id', participantId)
      .eq('game_id', gameId)
      .eq('market', market)
      .gte('slate_date', minSlateDate)
      .maybeSingle();
    if (conflict.error) {
      respondToQueryError(res, conflict.error, BENCHMARK.pickLedgerConflicts);
      return;
    }
    if (conflict.data === null) {
      res.status(200).json(withoutPick(identity, 'not_published', null));
      return;
    }
    const c = conflict.data as unknown as {
      reason: string; as_of: string; sport: string; slate_date: string;
    };
    res.status(200).json(withoutPick(identity, 'withheld_conflict', {
      reason: c.reason,
      asOf: c.as_of,
      sport: c.sport,
      slateDate: c.slate_date,
    }));
    return;
  }

  const row = ledger.data as unknown as LedgerRow;

  // Keyed on the row the view already confirmed live — see the header on why
  // that ordering is what makes these two reads safe without a cohort filter.
  const writeupRes = await sb
    .from(BENCHMARK.pickWriteups)
    .select('writeup')
    .eq('decision_id', row.source_decision_id)
    .maybeSingle();
  if (writeupRes.error) {
    respondToQueryError(res, writeupRes.error, BENCHMARK.pickWriteups);
    return;
  }

  // `sealed_at` and `revealed_at` are the two fields the ledger view does not
  // project — 086 has them in inner subqueries only. The reveal embed NAMES its
  // foreign key and is `!inner`: two constraints join these tables, so an
  // unqualified embed is a hard PGRST201 on every request, and a left embed
  // would admit a sealed-but-unrevealed decision.
  const timeline = await sb
    .from(BENCHMARK.decisions)
    .select(`sealed_at, ${REVEAL_EMBED}!inner(revealed_at)`)
    .eq('id', row.source_decision_id)
    .maybeSingle();
  if (timeline.error) {
    respondToQueryError(res, timeline.error, BENCHMARK.decisions);
    return;
  }
  const t = timeline.data as unknown as
    | { sealed_at: string | null; benchmark_decision_reveals: { revealed_at: string } | null }
    | null;

  const writeup = (writeupRes.data as unknown as { writeup: string | null } | null)?.writeup ?? null;

  res.status(200).json({
    ...identity,
    state: 'published' satisfies PickState,
    conflict: null,
    axisScale: { min: 1, max: 5 },
    pick: toPickBody(row, writeup, t?.sealed_at ?? null, t?.benchmark_decision_reveals?.revealed_at ?? null),
  });
}
