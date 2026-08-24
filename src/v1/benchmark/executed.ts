/**
 * The executed record: what a model arm's on-chain fills actually settled to.
 *
 * Pure — callers pass already-fetched rows. The chain-side outcome of a
 * benchmark pick is NOT on `benchmark_execution_fills`; the fill row carries
 * the identity (`speculation_id`, `taker_address`, `tx_hash`, `stake_usdc`) and
 * the verdict has to be read off the protocol's own tables.
 *
 * ## Why this is not `derivePositionStatus`
 *
 * `v1/ownState/positionStatus.ts` answers a different question — "what can this
 * wallet DO next" — and short-circuits on `claimed`: a claimed position returns
 * `status: 'claimed'` with NO `result`. That is right for a lifecycle event and
 * useless for a record, because claiming is what a winner does. Measured
 * against production 2026-08-24 over the 462 taker positions on the 89
 * on-chain contests that correspond to benchmark cohort games: 174 are
 * `claimed`, so reading the record off `derivePositionStatus().result` reports
 * them as verdict-less. A record must survive a claim, so this derivation never
 * consults it.
 *
 * ## Two paths to a verdict, and the second one is not optional
 *
 * `speculations.win_side` is `'tbd'` until someone calls `settleSpeculation`,
 * and on this population nobody has for most of them: measured, all 89 contests
 * are `contest_status = 'scored'` while only 63 of 178 speculations are
 * `closed`. **153 of 462 positions (33%) have a decided outcome that exists
 * only by replaying the scorer against the contest scores.** An implementation
 * reading `win_side` alone reports a third of a real record as pending.
 *
 * The replay is `lib/speculation.ts:predictWinSide`, the same code the
 * own-state stream and the positions snapshot use — one implementation, not a
 * third copy.
 *
 * ## The push trap, which decides the arithmetic
 *
 * A push returns the STAKE, not the stake plus profit — and push rows carry a
 * non-zero `profit_amount`, because profit is the counterparty's stake and
 * exists regardless of how the market resolved. Measured: 11 push positions
 * carrying 8.6444 USDC of profit between them. Any shortcut of the form
 * "credit `profit_amount` when the position resolved in our favour" silently
 * banks that. `push` and `void` are therefore both resolved BEFORE `didWin` is
 * consulted, which is also why `didWin`'s own docstring says so.
 *
 * ## The cross-check is a second WITNESS, not a second formula
 *
 * The stake arrives twice from two producers — the operator's executor writes
 * it onto the benchmark receipt, and the indexer projects it from the chain
 * event — so comparing them is independent evidence rather than the same number
 * read twice. It is reported as `stakeDisagreements` and never used to correct
 * the derivation: a discrepancy is something an operator must see, not
 * something a read path should paper over.
 */

import { didWin, predictWinSide, type MarketType, type WinSide } from '../../lib/speculation.js';

/** What a fill settled to. `pending` means no verdict EXISTS yet, not "unknown to us". */
export type ExecutedResult = 'won' | 'lost' | 'push' | 'void' | 'pending';

/** Where the verdict came from — the protocol said so, or we replayed the scorer. */
export type VerdictSource = 'settled' | 'predicted' | 'undecided';

/** Projection of the `speculations` row for one fill. */
export interface ExecutedSpeculation {
  speculationStatus: 'open' | 'closed';
  winSide: WinSide;
  marketType: MarketType;
  /** int32 in the 10x domain; null for moneyline. */
  lineTicks: number | null;
}

/** Projection of the `contests` row. Null when the contest is not joined. */
export interface ExecutedContest {
  contestStatus: 'unverified' | 'verified' | 'scored' | 'voided';
  awayScore: number | null;
  homeScore: number | null;
}

/**
 * The taker's side of ONE fill, read off the immutable `position_fills` event
 * rather than the mutable aggregate `positions` row.
 *
 * There is deliberately no `claimed` field. Claiming happens after the outcome
 * and cannot change it, so a record has no use for it — and its absence here
 * makes "a claim cannot erase the verdict" structural rather than a rule this
 * module has to remember. See the file header for why that matters: 174 of 462
 * live taker positions are claimed, and they are precisely the winners.
 */
export interface ExecutedPosition {
  /** 0 = upper, 1 = lower. From the event's `taker_position_type`, not inferred. */
  positionType: 0 | 1;
  /** wei6 — THIS fill's taker risk, summed over the transaction's events. */
  riskWei6: bigint;
  /** wei6 — the counterparty's stake on this fill. Non-zero on pushes too. */
  profitWei6: bigint;
  /**
   * wei6 — the same stake as the operator's executor recorded it, or null when
   * no receipt figure is available.
   *
   * A genuine second witness: the receipt comes from the executor on the
   * operator's box and `riskWei6` from the indexer's projection of the chain
   * event, so agreement is evidence and disagreement is an operator signal. It
   * is never used to CORRECT the derivation — see `stakeDisagreements`.
   */
  receiptStakeWei6: bigint | null;
}

export interface ExecutedVerdict {
  result: ExecutedResult;
  source: VerdictSource;
  /**
   * wei6 returned to the taker at settlement, or null while `pending`. A LOSS
   * pays zero — that is a real value, distinct from "not yet known".
   */
  payoutWei6: bigint | null;
}

/**
 * The winning side, or null when no verdict exists yet.
 *
 * `closed` is authoritative — the protocol has spoken. Otherwise a `scored`
 * contest with both scores present is enough to replay the scorer, which is the
 * path a third of this population takes; and a `voided` contest is enough to
 * know the answer is `void`. Anything else is genuinely undecided.
 *
 * ## Why an open speculation on a voided contest is NOT pending
 *
 * `ContestStatus.Voided` is terminal: `setScores` reverts on any status other
 * than `Verified`, so a voided contest can never be scored, and the only
 * branch `settleSpeculation` can still take on it writes `WinSide.Void`
 * (`SpeculationModule.sol`, the cooldown path). The verdict is decided the
 * moment the contest voids; only the block at which the stake becomes
 * claimable is not. Reporting it as pending would hold the stake in
 * `pendingStakeUsdc` on a bet the protocol has already refunded in principle —
 * caught in review.
 */
function resolveWinSide(
  speculation: ExecutedSpeculation,
  contest: ExecutedContest | null,
): { winSide: WinSide | null; source: VerdictSource } {
  if (speculation.speculationStatus === 'closed' && speculation.winSide !== 'tbd') {
    return { winSide: speculation.winSide, source: 'settled' };
  }
  // The contest's terminal void decides, whatever the speculation row says —
  // including a closed row still reading `tbd`, which the contract cannot
  // produce but which must not read as pending if it ever did.
  if (contest !== null && contest.contestStatus === 'voided') {
    return { winSide: 'void', source: 'predicted' };
  }
  if (speculation.speculationStatus === 'closed') {
    // `tbd` on a closed speculation is a shouldn't-happen. It is reported as
    // undecided rather than guessed at — the alternative, treating it as a
    // loss the way the own-state derivation defensively does, would put a
    // fabricated loss into a published record.
    return { winSide: null, source: 'undecided' };
  }
  if (
    contest !== null &&
    contest.contestStatus === 'scored' &&
    contest.awayScore !== null &&
    contest.homeScore !== null
  ) {
    const predicted = predictWinSide(
      speculation.marketType,
      contest.awayScore,
      contest.homeScore,
      speculation.lineTicks,
    );
    if (predicted !== null) return { winSide: predicted, source: 'predicted' };
  }
  return { winSide: null, source: 'undecided' };
}

/**
 * One fill's verdict and payout.
 *
 * `claimed` is deliberately never consulted: claiming is a wallet action taken
 * AFTER the outcome, and a record that forgets a win the moment it is collected
 * is not a record.
 */
export function deriveExecutedVerdict(
  position: ExecutedPosition,
  speculation: ExecutedSpeculation,
  contest: ExecutedContest | null,
): ExecutedVerdict {
  const { winSide, source } = resolveWinSide(speculation, contest);
  if (winSide === null) return { result: 'pending', source, payoutWei6: null };
  // void and push BEFORE didWin: both return the stake to both sides, and
  // didWin only knows about away/over vs home/under, so it reads either as a
  // loss for one of the two participants.
  if (winSide === 'void') return { result: 'void', source, payoutWei6: position.riskWei6 };
  if (winSide === 'push') return { result: 'push', source, payoutWei6: position.riskWei6 };
  if (didWin(position.positionType, winSide)) {
    return {
      result: 'won',
      source,
      payoutWei6: position.riskWei6 + position.profitWei6,
    };
  }
  return { result: 'lost', source, payoutWei6: 0n };
}

export interface ExecutedRecord {
  won: number;
  lost: number;
  push: number;
  void: number;
  pending: number;
}

export interface ExecutedSummary {
  /** Fills counted. */
  fills: number;
  record: ExecutedRecord;
  /** Total taker-side stake across every fill, wei6. */
  stakedWei6: bigint;
  /**
   * Settled economic result across DECIDED fills only, wei6: payout minus
   * stake, so a win contributes the counterparty's stake and a loss contributes
   * minus our own. Pending fills contribute nothing and are counted separately
   * — folding them in at zero would read as "broke even" on a bet still live.
   *
   * This is the SETTLED result, not cash swept: a decided-but-unclaimed win is
   * counted here while the USDC is still in escrow.
   */
  netWei6: bigint;
  /** Stake riding on fills with no verdict yet, wei6. */
  pendingStakeWei6: bigint;
  /** How many verdicts the protocol itself supplied vs how many we replayed. */
  verdictSource: { settled: number; predicted: number; undecided: number };
  /**
   * Fills where the operator's receipt and the chain event disagree on the
   * stake. Reported, never reconciled: the two have different producers, so a
   * gap is a fact about the pipeline rather than a number to average away.
   */
  stakeDisagreements: number;
  /**
   * Receipts this service could NOT identify a unique priced fill for — the
   * indexer has not caught up, or the transaction carries another wallet's
   * fill, or both position sides. They contribute nothing to any figure.
   *
   * Surfaced rather than swallowed: a record quietly computed over fewer fills
   * than the operator published is a wrong number that looks like a right one,
   * and this is the count that makes the difference visible.
   */
  unresolvedFills: number;
}

export const EMPTY_EXECUTED: ExecutedSummary = Object.freeze({
  fills: 0,
  record: Object.freeze({ won: 0, lost: 0, push: 0, void: 0, pending: 0 }),
  stakedWei6: 0n,
  netWei6: 0n,
  pendingStakeWei6: 0n,
  verdictSource: Object.freeze({ settled: 0, predicted: 0, undecided: 0 }),
  stakeDisagreements: 0,
  unresolvedFills: 0,
});

export interface ExecutedFill {
  position: ExecutedPosition;
  speculation: ExecutedSpeculation;
  contest: ExecutedContest | null;
}

/**
 * Roll a participant's fills into one record.
 *
 * @param unresolvedFills receipts the caller could not identify a unique priced
 *   fill for. Carried through rather than dropped so the payload can say how
 *   much of the published record it is actually pricing.
 */
export function summarizeExecuted(
  fills: readonly ExecutedFill[],
  unresolvedFills = 0,
): ExecutedSummary {
  const record: ExecutedRecord = { won: 0, lost: 0, push: 0, void: 0, pending: 0 };
  const verdictSource = { settled: 0, predicted: 0, undecided: 0 };
  let stakedWei6 = 0n;
  let netWei6 = 0n;
  let pendingStakeWei6 = 0n;
  let stakeDisagreements = 0;

  for (const fill of fills) {
    const verdict = deriveExecutedVerdict(fill.position, fill.speculation, fill.contest);
    record[verdict.result] += 1;
    verdictSource[verdict.source] += 1;
    stakedWei6 += fill.position.riskWei6;
    if (
      fill.position.receiptStakeWei6 !== null &&
      fill.position.receiptStakeWei6 !== fill.position.riskWei6
    ) {
      stakeDisagreements += 1;
    }
    if (verdict.payoutWei6 === null) {
      pendingStakeWei6 += fill.position.riskWei6;
    } else {
      netWei6 += verdict.payoutWei6 - fill.position.riskWei6;
    }
  }

  return {
    fills: fills.length,
    record,
    stakedWei6,
    netWei6,
    pendingStakeWei6,
    verdictSource,
    stakeDisagreements,
    unresolvedFills,
  };
}
