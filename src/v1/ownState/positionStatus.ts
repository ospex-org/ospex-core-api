/**
 * `positionStatus` event derivation (spec §2.1.3, deferred from M4a).
 *
 * Maps a (positions, speculations, contests) join into a canonical
 * `PositionStatusEventBody`. Pure — callers pass already-fetched rows; this
 * module never touches the DB. The OwnStateHub re-runs this per matched
 * positions row each tick; the SSE handler also runs it during initial
 * snapshot delivery and catch-up replay.
 *
 * The spec enum is wider than the on-chain claim path:
 *
 *   - `active`        — speculation open, contest not yet scored
 *   - `pendingSettle` — speculation open, contest scored, predicted winner
 *                       or push (settling makes payout > 0)
 *   - `claimable`     — speculation closed (`settleSpeculation` called),
 *                       payout > 0, not yet claimed
 *   - `claimed`       — `claimed=true` regardless of speculation state
 *   - `settledLost`   — terminal-lost: speculation closed with a losing
 *                       win_side (or predicted-lost while open) — payout
 *                       will be zero and `claimPosition` would revert.
 *                       First-class so the MM closes lifecycle instead of
 *                       waiting on a `claimable` event that never arrives.
 *   - `void`          — terminal-void: speculation voided. Payout equals
 *                       stake; `claimPosition` still reverts with NoPayout
 *                       when payout is zero (impossible here), so it
 *                       behaves like `claimable` in terms of claim
 *                       mechanics but lifecycle-wise the MM treats it as
 *                       terminal: no further state transition.
 *
 * Inputs are the joined raw values from each table — the caller picks
 * them out of whatever it has in hand. The dedup contract (spec §2.1.2)
 * keys positionStatus events on
 *   `(address, speculationId, positionType, status, sourceUpdatedAt)`
 * so `sourceUpdatedAt` MUST be the MAX of every source row that
 * contributes to the derivation — `max(positions.row_updated_at,
 * speculations.row_updated_at, contests.row_updated_at)` — preserved
 * verbatim with microsecond precision (use `compareIsoTimestamptz` /
 * `maxIsoTimestamptz` from `timestamps.ts`, NOT `Date.parse` which
 * truncates to ms and would collapse same-ms parent transitions).
 * Callers compute the max once and pass it in here; this module just
 * propagates it.
 *
 * Same scorer logic as `positionFetch.ts` so the SSE-derived status
 * agrees with the snapshot's categorization. The duplication is
 * intentional: the snapshot helper returns BUCKETED rows (already
 * filtered to active/pendingSettle/claimable) while this returns the
 * canonical enum INCLUDING terminal losers, which the snapshot
 * intentionally drops. Sharing the predicate function avoids
 * scorer-logic drift.
 */

import type { MarketType } from '../../lib/speculation.js';

/** Spec §2.1.3 canonical enum. */
export type PositionStatus =
  | 'active'
  | 'pendingSettle'
  | 'claimable'
  | 'claimed'
  | 'settledLost'
  | 'void';

/** Forward-rank for the SDK reducer's backwards-transition guard (spec §2.5.1). */
export function positionStatusRank(s: PositionStatus): number {
  switch (s) {
    case 'active':
      return 1;
    case 'pendingSettle':
      return 2;
    case 'claimable':
      return 3;
    case 'claimed':
    case 'settledLost':
    case 'void':
      return 4; // terminal — equally far forward
  }
}

export interface PositionStatusEventBody {
  address: string;
  speculationId: string;
  positionType: 0 | 1;
  status: PositionStatus;
  /** Advisory categorical result. Omitted when `status === 'active'`. */
  result?: 'won' | 'lost' | 'push' | 'void';
  /** Present only when payout > 0 and not yet claimed (status in {pendingSettle, claimable, void}). wei6 decimal string. */
  claimableAmount?: string;
  sourceUpdatedAt: string;
}

/** Input projection from the `positions` table. */
export interface PositionInput {
  speculationId: string;
  /** Maker/taker address (case-canonicalized by caller — typically lowercased). */
  address: string;
  positionType: 0 | 1;
  /** wei6 risk as a decimal string or bigint. `null`/missing treated as 0n. */
  riskAmount: string | bigint | null | undefined;
  /** wei6 profit. `null`/missing treated as 0n. */
  profitAmount: string | bigint | null | undefined;
  claimed: boolean;
}

/** Input projection from the `speculations` table. */
export interface SpeculationInput {
  speculationStatus: 'open' | 'closed';
  winSide: 'tbd' | 'away' | 'home' | 'over' | 'under' | 'push' | 'void';
  marketType: MarketType;
  /** int32 in 10× domain (spread / total only); null for moneyline. */
  lineTicks: number | null;
}

/** Input projection from the `contests` table — null when no contest is joined. */
export interface ContestInput {
  contestStatus: 'unverified' | 'verified' | 'scored' | 'voided';
  awayScore: number | null;
  homeScore: number | null;
}

/**
 * Replays the on-chain scorer logic — must match `positionFetch.ts:predictWinSide`
 * exactly so the SSE stream and the snapshot agree on transitions. See
 * `positionFetch.ts` comment for the lineTicks domain notes.
 */
function predictWinSide(
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

function didWin(positionType: 0 | 1, winSide: SpeculationInput['winSide']): boolean {
  if (positionType === 0) return winSide === 'away' || winSide === 'over';
  return winSide === 'home' || winSide === 'under';
}

function toBig(v: string | bigint | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === 'bigint') return v;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

/**
 * Derive the canonical `positionStatus` event body for one position.
 *
 * Notes:
 *   - `claimed=true` overrides every other state — the position is
 *     terminal regardless of what the speculation looks like now.
 *   - For `speculation_status='closed'`, `win_side='void'` produces
 *     `void` (terminal); `win_side='tbd'` is shouldn't-happen and
 *     produces `settledLost` defensively.
 *   - For `speculation_status='open'` with a scored contest, the
 *     predictive scorer determines pendingSettle vs settledLost.
 *   - `contest === null` paths fall through to `active` because there
 *     is no scoring data to predict on yet.
 *   - `claimableAmount` is populated for `pendingSettle`, `claimable`,
 *     and `void`. The wei6 value mirrors `positionFetch.ts:payoutWei6`.
 */
export function derivePositionStatus(
  position: PositionInput,
  speculation: SpeculationInput,
  contest: ContestInput | null,
  sourceUpdatedAt: string,
): PositionStatusEventBody {
  const base = {
    address: position.address,
    speculationId: position.speculationId,
    positionType: position.positionType,
    sourceUpdatedAt,
  } as const;

  if (position.claimed) {
    return { ...base, status: 'claimed' };
  }

  const riskWei6 = toBig(position.riskAmount);
  const profitWei6 = toBig(position.profitAmount);

  if (speculation.speculationStatus === 'closed') {
    if (speculation.winSide === 'void') {
      const payoutWei6 = riskWei6; // stake returned on void
      return {
        ...base,
        status: 'void',
        result: 'void',
        ...(payoutWei6 > 0n ? { claimableAmount: payoutWei6.toString() } : {}),
      };
    }
    if (speculation.winSide === 'tbd') {
      // shouldn't happen for closed; treat as terminal-lost defensively.
      return { ...base, status: 'settledLost', result: 'lost' };
    }
    if (speculation.winSide === 'push') {
      // Push pays everyone the stake back regardless of position type. Must
      // be handled BEFORE `didWin` (which is upper/away vs lower/home only).
      const payoutWei6 = riskWei6;
      if (riskWei6 === 0n || payoutWei6 === 0n) {
        return { ...base, status: 'settledLost', result: 'lost' };
      }
      return {
        ...base,
        status: 'claimable',
        result: 'push',
        claimableAmount: payoutWei6.toString(),
      };
    }
    if (didWin(position.positionType, speculation.winSide)) {
      const payoutWei6 = riskWei6 + profitWei6;
      // riskAmount==0 || payout==0 → claimPosition reverts. Surface as
      // settledLost so the MM's lifecycle closes; the position is
      // forever-unclaimable. (riskWei6==0 typically means a
      // secondary-market transfer drained the stake.)
      if (riskWei6 === 0n || payoutWei6 === 0n) {
        return { ...base, status: 'settledLost', result: 'lost' };
      }
      return {
        ...base,
        status: 'claimable',
        result: 'won',
        claimableAmount: payoutWei6.toString(),
      };
    }
    // closed + not a winner (and not void/tbd/push) → loss.
    return { ...base, status: 'settledLost', result: 'lost' };
  }

  // speculation open: try predictive bucket if contest is scored.
  if (
    contest &&
    contest.contestStatus === 'scored' &&
    contest.awayScore != null &&
    contest.homeScore != null
  ) {
    const predicted = predictWinSide(
      speculation.marketType,
      contest.awayScore,
      contest.homeScore,
      speculation.lineTicks,
    );
    if (predicted != null) {
      if (predicted === 'push') {
        const payoutWei6 = riskWei6;
        if (riskWei6 === 0n || payoutWei6 === 0n) {
          return { ...base, status: 'settledLost', result: 'lost' };
        }
        return {
          ...base,
          status: 'pendingSettle',
          result: 'push',
          claimableAmount: payoutWei6.toString(),
        };
      }
      const isWinner =
        (position.positionType === 0 && (predicted === 'away' || predicted === 'over')) ||
        (position.positionType === 1 && (predicted === 'home' || predicted === 'under'));
      if (isWinner) {
        const payoutWei6 = riskWei6 + profitWei6;
        if (riskWei6 === 0n || payoutWei6 === 0n) {
          return { ...base, status: 'settledLost', result: 'lost' };
        }
        return {
          ...base,
          status: 'pendingSettle',
          result: 'won',
          claimableAmount: payoutWei6.toString(),
        };
      }
      // Predicted loser — terminal-lost, regardless of when settle runs.
      return { ...base, status: 'settledLost', result: 'lost' };
    }
    // predict returned null → fall through to active.
  }

  // Zero-risk + open + unscored ⇒ terminal-lost rather than active.
  // Closed/scored branches above already short-circuit zero-risk to
  // `settledLost` via the payout==0 check (or to `void` when the
  // speculation voided — both terminal, label preserved for accuracy).
  // The fall-through here catches the open + secondary-market-transferred
  // case where the position lost its stake before any speculation/contest
  // signal — `fetchCategorizedPositions` (positionFetch.ts:206-225)
  // omits these rows from the REST snapshot for the same reason. Surface
  // as `settledLost` so the SDK reducer transitions a previously-active
  // row to terminal instead of treating it as live own-position exposure.
  if (riskWei6 === 0n) {
    return { ...base, status: 'settledLost', result: 'lost' };
  }

  return { ...base, status: 'active' };
}
