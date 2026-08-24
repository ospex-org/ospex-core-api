/**
 * The executed record — verdicts, payouts and the roll-up.
 *
 * Fixture values are chosen from the production population measured 2026-08-24
 * over the 462 taker positions on the 89 on-chain contests corresponding to
 * benchmark cohort games, because the two facts that decide the arithmetic are
 * both things a tidy fixture would hide:
 *
 *   - 174 of 462 positions are `claimed`, so a derivation that short-circuits
 *     on `claimed` (as `derivePositionStatus` deliberately does) reports 38% of
 *     the record as verdict-less;
 *   - 11 positions pushed while carrying 8.6444 USDC of `profit_amount`
 *     between them, so a push fixture with `profitWei6: 0n` cannot tell a
 *     stake-only payout from a stake-plus-profit one.
 *
 * Every push fixture below therefore carries a non-zero profit, and several
 * carry `claimed: true`.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_EXECUTED,
  deriveExecutedVerdict,
  summarizeExecuted,
  type ExecutedContest,
  type ExecutedFill,
  type ExecutedPosition,
  type ExecutedSpeculation,
} from '../src/v1/benchmark/executed.js';
import { derivePositionStatus } from '../src/v1/ownState/positionStatus.js';
import type { MarketType, WinSide } from '../src/lib/speculation.js';

const RISK = 10_000_000n; // 10 USDC
const PROFIT = 7_860_400n; // the counterparty's stake — non-zero on pushes too

function position(over: Partial<ExecutedPosition> = {}): ExecutedPosition {
  return {
    positionType: 0,
    riskWei6: RISK,
    profitWei6: PROFIT,
    claimed: false,
    claimedAmountWei6: null,
    ...over,
  };
}

function spec(over: Partial<ExecutedSpeculation> = {}): ExecutedSpeculation {
  return {
    speculationStatus: 'closed',
    winSide: 'away',
    marketType: 'moneyline',
    lineTicks: null,
    ...over,
  };
}

const SCORED: ExecutedContest = { contestStatus: 'scored', awayScore: 5, homeScore: 3 };

describe('deriveExecutedVerdict — payouts', () => {
  it('a win pays stake plus the counterparty stake', () => {
    const v = deriveExecutedVerdict(position(), spec({ winSide: 'away' }), null);
    expect(v).toEqual({ result: 'won', source: 'settled', payoutWei6: RISK + PROFIT });
  });

  /**
   * The trap. `profitWei6` is deliberately non-zero: with a zero profit this
   * assertion passes against a stake-plus-profit implementation too, and the
   * production population has 11 such rows carrying 8.6444 USDC between them.
   */
  it('a push returns the STAKE ONLY, even though profit is non-zero', () => {
    const v = deriveExecutedVerdict(position(), spec({ winSide: 'push' }), null);
    expect(v.result).toBe('push');
    expect(v.payoutWei6).toBe(RISK);
    expect(v.payoutWei6).not.toBe(RISK + PROFIT);
  });

  it('a void returns the stake', () => {
    const v = deriveExecutedVerdict(position(), spec({ winSide: 'void' }), null);
    expect(v).toEqual({ result: 'void', source: 'settled', payoutWei6: RISK });
  });

  /** A loss pays zero, which is a VALUE. `null` would mean "not yet known". */
  it('a loss pays zero, not null', () => {
    const v = deriveExecutedVerdict(position(), spec({ winSide: 'home' }), null);
    expect(v).toEqual({ result: 'lost', source: 'settled', payoutWei6: 0n });
  });
});

describe('deriveExecutedVerdict — where the verdict comes from', () => {
  /**
   * 153 of 462 production positions take this path: the contest is scored but
   * `settleSpeculation` was never called, so `win_side` is still `tbd`. An
   * implementation reading `win_side` alone reports a third of the record as
   * pending.
   */
  it('replays the scorer when the speculation is open and the contest is scored', () => {
    const v = deriveExecutedVerdict(
      position(),
      spec({ speculationStatus: 'open', winSide: 'tbd' }),
      SCORED,
    );
    expect(v).toEqual({ result: 'won', source: 'predicted', payoutWei6: RISK + PROFIT });
  });

  it('is pending when the contest is not scored', () => {
    const v = deriveExecutedVerdict(
      position(),
      spec({ speculationStatus: 'open', winSide: 'tbd' }),
      { contestStatus: 'verified', awayScore: null, homeScore: null },
    );
    expect(v).toEqual({ result: 'pending', source: 'undecided', payoutWei6: null });
  });

  it('is pending when there is no contest joined at all', () => {
    const v = deriveExecutedVerdict(position(), spec({ speculationStatus: 'open', winSide: 'tbd' }), null);
    expect(v.result).toBe('pending');
  });

  /**
   * A scored contest with a spread speculation and no line has no derivable
   * winner — `predictWinSide` returns null and this must stay pending rather
   * than falling through to a loss.
   */
  it('is pending when the scorer replay cannot decide', () => {
    const v = deriveExecutedVerdict(
      position(),
      spec({ speculationStatus: 'open', winSide: 'tbd', marketType: 'spread', lineTicks: null }),
      SCORED,
    );
    expect(v).toEqual({ result: 'pending', source: 'undecided', payoutWei6: null });
  });

  /**
   * A CLOSED speculation still reading `tbd` is a shouldn't-happen. The
   * own-state derivation calls it a loss defensively, which is right for a
   * lifecycle (nothing is claimable) and wrong for a record — it would publish
   * a loss nobody incurred. Here it is undecided.
   */
  it('does not fabricate a loss from a closed-but-tbd speculation', () => {
    const v = deriveExecutedVerdict(position(), spec({ speculationStatus: 'closed', winSide: 'tbd' }), SCORED);
    expect(v).toEqual({ result: 'pending', source: 'undecided', payoutWei6: null });
  });

  it('prefers the settled win side over the replay when both exist', () => {
    // The contest scores say `away`; the protocol says `home`. The protocol wins.
    const v = deriveExecutedVerdict(position(), spec({ speculationStatus: 'closed', winSide: 'home' }), SCORED);
    expect(v).toEqual({ result: 'lost', source: 'settled', payoutWei6: 0n });
  });
});

describe('deriveExecutedVerdict — a claim must not erase the verdict', () => {
  /**
   * The single most consequential difference from `derivePositionStatus`,
   * measured: 174 of 462 production positions are claimed, and claiming is
   * what a WINNER does. A record that forgets them reports won:0.
   */
  it('returns the same verdict claimed or not', () => {
    for (const winSide of ['away', 'home', 'push', 'void'] as const) {
      const unclaimed = deriveExecutedVerdict(position({ claimed: false }), spec({ winSide }), null);
      const claimed = deriveExecutedVerdict(
        position({ claimed: true, claimedAmountWei6: 1n }),
        spec({ winSide }),
        null,
      );
      expect(claimed).toEqual(unclaimed);
    }
  });
});

describe('summarizeExecuted', () => {
  function fill(over: {
    position?: Partial<ExecutedPosition>;
    speculation?: Partial<ExecutedSpeculation>;
    contest?: ExecutedContest | null;
  }): ExecutedFill {
    return {
      position: position(over.position),
      speculation: spec(over.speculation),
      contest: over.contest === undefined ? null : over.contest,
    };
  }

  it('is empty-shaped with no fills', () => {
    expect(summarizeExecuted([])).toEqual(EMPTY_EXECUTED);
  });

  /**
   * One of each outcome. The expected net is written out term by term as a
   * literal so it cannot move with the implementation:
   *   won  +PROFIT, lost  -RISK, push 0, void 0, pending excluded.
   */
  it('nets a mixed book, with pushes and voids contributing zero', () => {
    const got = summarizeExecuted([
      fill({ speculation: { winSide: 'away' } }), // won  -> +PROFIT
      fill({ speculation: { winSide: 'home' } }), // lost -> -RISK
      fill({ speculation: { winSide: 'push' } }), // push -> 0 (NOT +PROFIT)
      fill({ speculation: { winSide: 'void' } }), // void -> 0
      fill({ speculation: { speculationStatus: 'open', winSide: 'tbd' } }), // pending
    ]);
    expect(got.fills).toBe(5);
    expect(got.record).toEqual({ won: 1, lost: 1, push: 1, void: 1, pending: 1 });
    expect(got.stakedWei6).toBe(RISK * 5n);
    expect(got.netWei6).toBe(PROFIT - RISK);
    expect(got.pendingStakeWei6).toBe(RISK);
    expect(got.verdictSource).toEqual({ settled: 4, predicted: 0, undecided: 1 });
  });

  /**
   * Negative control for the push term above: if pushes were credited with
   * profit the net would be `2n * PROFIT - RISK`. Asserting the wrong value is
   * NOT produced makes the push term load-bearing on its own, independent of
   * the four other terms in the same sum.
   */
  it('does not credit push profit into the net', () => {
    const got = summarizeExecuted([
      fill({ speculation: { winSide: 'away' } }),
      fill({ speculation: { winSide: 'home' } }),
      fill({ speculation: { winSide: 'push' } }),
    ]);
    expect(got.netWei6).toBe(PROFIT - RISK);
    expect(got.netWei6).not.toBe(2n * PROFIT - RISK);
  });

  it('counts a claimed_amount disagreement without correcting the derivation', () => {
    const got = summarizeExecuted([
      // agrees: a win claimed for exactly stake + profit
      fill({ position: { claimed: true, claimedAmountWei6: RISK + PROFIT }, speculation: { winSide: 'away' } }),
      // disagrees: claimed for one unit less than the derivation says
      fill({ position: { claimed: true, claimedAmountWei6: RISK + PROFIT - 1n }, speculation: { winSide: 'away' } }),
    ]);
    expect(got.claimedAmountDisagreements).toBe(1);
    // The net still uses the DERIVED payout for both, not the claimed amount.
    expect(got.netWei6).toBe(2n * PROFIT);
  });

  it('does not count an unclaimed row as a disagreement', () => {
    const got = summarizeExecuted([
      fill({ position: { claimed: false, claimedAmountWei6: null }, speculation: { winSide: 'away' } }),
    ]);
    expect(got.claimedAmountDisagreements).toBe(0);
  });

  it('separates predicted verdicts from settled ones', () => {
    const got = summarizeExecuted([
      fill({ speculation: { winSide: 'away' } }),
      fill({ speculation: { speculationStatus: 'open', winSide: 'tbd' }, contest: SCORED }),
    ]);
    expect(got.verdictSource).toEqual({ settled: 1, predicted: 1, undecided: 0 });
    expect(got.record.won).toBe(2);
  });
});

/**
 * Differential against `derivePositionStatus` — the model this one deliberately
 * does not reuse.
 *
 * On every UNCLAIMED, non-zero-risk case the two must agree on the categorical
 * result, or one of them is wrong about the scorer. Where they diverge by
 * design, the divergence is asserted rather than excluded, so a future change
 * to either has to come here and say so.
 */
describe('differential vs derivePositionStatus', () => {
  const WIN_SIDES: WinSide[] = ['away', 'home', 'over', 'under', 'push', 'void'];
  const MARKETS: MarketType[] = ['moneyline', 'spread', 'total'];

  it('agrees on every unclaimed, funded, settled case', () => {
    let compared = 0;
    for (const winSide of WIN_SIDES) {
      for (const marketType of MARKETS) {
        for (const positionType of [0, 1] as const) {
          const p = position({ positionType, claimed: false });
          const s = spec({ speculationStatus: 'closed', winSide, marketType, lineTicks: 0 });
          const mine = deriveExecutedVerdict(p, s, null);
          const theirs = derivePositionStatus(
            {
              speculationId: '1',
              address: '0xabc',
              positionType,
              riskAmount: p.riskWei6.toString(),
              profitAmount: p.profitWei6.toString(),
              claimed: false,
            },
            { speculationStatus: 'closed', winSide, marketType, lineTicks: 0 },
            null,
            '2026-08-24T00:00:00Z',
          );
          expect(mine.result, `${winSide}/${marketType}/${String(positionType)}`).toBe(theirs.result);
          compared += 1;
        }
      }
    }
    // A differential that compared nothing would pass. 6 win sides x 3 markets
    // x 2 position types.
    expect(compared).toBe(36);
  });

  /**
   * DIVERGENCE, by design and pinned. A zero-risk position (the stake was
   * drained by a secondary-market transfer) that pushes is a PUSH in the
   * record — it happened, it settled, it netted nothing — while the lifecycle
   * derivation calls it `settledLost` because `claimPosition` would revert with
   * NoPayout and the market-maker needs the lifecycle to close. Both are right
   * for their own question.
   */
  it('diverges on a zero-risk push, and that is the intended difference', () => {
    const p = position({ riskWei6: 0n, claimed: false });
    const mine = deriveExecutedVerdict(p, spec({ winSide: 'push' }), null);
    const theirs = derivePositionStatus(
      { speculationId: '1', address: '0xabc', positionType: 0, riskAmount: '0', profitAmount: PROFIT.toString(), claimed: false },
      { speculationStatus: 'closed', winSide: 'push', marketType: 'moneyline', lineTicks: null },
      null,
      '2026-08-24T00:00:00Z',
    );
    expect(mine.result).toBe('push');
    expect(theirs.result).toBe('lost');
  });

  /**
   * DIVERGENCE, by design and pinned — the reason this module exists.
   * `derivePositionStatus` yields no `result` at all once the position is
   * claimed; 174 of 462 production positions are in that state.
   */
  it('diverges on a claimed position, and that is the reason this module exists', () => {
    const p = position({ claimed: true, claimedAmountWei6: RISK + PROFIT });
    const mine = deriveExecutedVerdict(p, spec({ winSide: 'away' }), null);
    const theirs = derivePositionStatus(
      { speculationId: '1', address: '0xabc', positionType: 0, riskAmount: RISK.toString(), profitAmount: PROFIT.toString(), claimed: true },
      { speculationStatus: 'closed', winSide: 'away', marketType: 'moneyline', lineTicks: null },
      null,
      '2026-08-24T00:00:00Z',
    );
    expect(mine.result).toBe('won');
    expect(theirs.status).toBe('claimed');
    expect(theirs.result).toBeUndefined();
  });
});
