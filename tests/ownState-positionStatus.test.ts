/**
 * `derivePositionStatus` tests.
 *
 * Pure helper — no mocks. Each test pins a single transition in the enum
 * (active / pendingSettle / claimable / claimed / settledLost / void) and
 * the payload fields (`result`, `claimableAmount`, `sourceUpdatedAt`).
 *
 * The scorer logic mirrors `positionFetch.ts:predictWinSide` — covered
 * elsewhere — so these tests focus on the enum boundaries the own-state stream
 * cares about, not the scorer arithmetic.
 */
import { describe, expect, it } from 'vitest';
import {
  derivePositionStatus,
  isTerminalForever,
  positionStatusRank,
  type ContestInput,
  type PositionInput,
  type PositionStatus,
  type SpeculationInput,
} from '../src/v1/ownState/positionStatus.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const SOURCE_UPDATED_AT = '2026-05-29T15:30:00.000Z';

function position(over: Partial<PositionInput> = {}): PositionInput {
  return {
    speculationId: '101',
    address: ADDRESS,
    positionType: 0,
    riskAmount: '1000000',
    profitAmount: '500000',
    claimed: false,
    ...over,
  };
}
function speculation(over: Partial<SpeculationInput> = {}): SpeculationInput {
  return {
    speculationStatus: 'open',
    winSide: 'tbd',
    marketType: 'moneyline',
    lineTicks: null,
    ...over,
  };
}
function contest(over: Partial<ContestInput> = {}): ContestInput {
  return {
    contestStatus: 'unverified',
    awayScore: null,
    homeScore: null,
    ...over,
  };
}

describe('derivePositionStatus / status enum', () => {
  it('open + contest not scored ⇒ active', () => {
    const body = derivePositionStatus(position(), speculation(), contest(), SOURCE_UPDATED_AT);
    expect(body.status).toBe('active');
    expect(body.result).toBeUndefined();
    expect(body.claimableAmount).toBeUndefined();
    expect(body.sourceUpdatedAt).toBe(SOURCE_UPDATED_AT);
  });

  it('open + null contest ⇒ active', () => {
    const body = derivePositionStatus(position(), speculation(), null, SOURCE_UPDATED_AT);
    expect(body.status).toBe('active');
  });

  it('claimed=true overrides every other state ⇒ claimed', () => {
    const body = derivePositionStatus(
      position({ claimed: true }),
      speculation({ speculationStatus: 'closed', winSide: 'away' }),
      contest({ contestStatus: 'scored', awayScore: 10, homeScore: 5 }),
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('claimed');
    expect(body.result).toBeUndefined();
  });

  it('open + contest scored + position winner ⇒ pendingSettle (won, claimable populated)', () => {
    const body = derivePositionStatus(
      position(), // positionType=0 (away/over)
      speculation({ marketType: 'moneyline' }),
      contest({ contestStatus: 'scored', awayScore: 10, homeScore: 5 }),
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('pendingSettle');
    expect(body.result).toBe('won');
    expect(body.claimableAmount).toBe('1500000'); // 1M risk + 500k profit
  });

  it('open + contest scored + push ⇒ pendingSettle (push, payout = risk)', () => {
    const body = derivePositionStatus(
      position(),
      speculation({ marketType: 'moneyline' }),
      contest({ contestStatus: 'scored', awayScore: 7, homeScore: 7 }),
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('pendingSettle');
    expect(body.result).toBe('push');
    expect(body.claimableAmount).toBe('1000000');
  });

  it('open + contest scored + predicted loser ⇒ settledLost', () => {
    const body = derivePositionStatus(
      position(), // upper / away
      speculation({ marketType: 'moneyline' }),
      contest({ contestStatus: 'scored', awayScore: 3, homeScore: 10 }),
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('settledLost');
    expect(body.result).toBe('lost');
    expect(body.claimableAmount).toBeUndefined();
  });

  it('closed + win_side=away + upper position ⇒ claimable', () => {
    const body = derivePositionStatus(
      position(),
      speculation({ speculationStatus: 'closed', winSide: 'away' }),
      null,
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('claimable');
    expect(body.result).toBe('won');
    expect(body.claimableAmount).toBe('1500000');
  });

  it('closed + win_side=home + upper position ⇒ settledLost', () => {
    const body = derivePositionStatus(
      position(),
      speculation({ speculationStatus: 'closed', winSide: 'home' }),
      null,
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('settledLost');
    expect(body.result).toBe('lost');
  });

  it('closed + win_side=push ⇒ claimable (payout=risk)', () => {
    const body = derivePositionStatus(
      position(),
      speculation({ speculationStatus: 'closed', winSide: 'push' }),
      null,
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('claimable');
    expect(body.result).toBe('push');
    expect(body.claimableAmount).toBe('1000000');
  });

  it('closed + win_side=void ⇒ void (with claimableAmount when risk > 0)', () => {
    const body = derivePositionStatus(
      position(),
      speculation({ speculationStatus: 'closed', winSide: 'void' }),
      null,
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('void');
    expect(body.result).toBe('void');
    expect(body.claimableAmount).toBe('1000000');
  });

  it('closed + win_side=void + zero-risk row ⇒ void without claimableAmount', () => {
    const body = derivePositionStatus(
      position({ riskAmount: '0' }),
      speculation({ speculationStatus: 'closed', winSide: 'void' }),
      null,
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('void');
    expect(body.claimableAmount).toBeUndefined();
  });

  it('closed + win_side=tbd ⇒ settledLost (defensive)', () => {
    const body = derivePositionStatus(
      position(),
      speculation({ speculationStatus: 'closed', winSide: 'tbd' }),
      null,
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('settledLost');
    expect(body.result).toBe('lost');
  });

  it('zero-risk winning position ⇒ settledLost (claimPosition would revert)', () => {
    const body = derivePositionStatus(
      position({ riskAmount: '0', profitAmount: '0' }),
      speculation({ speculationStatus: 'closed', winSide: 'away' }),
      null,
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('settledLost');
  });

  it('lower position + away winner ⇒ settledLost', () => {
    const body = derivePositionStatus(
      position({ positionType: 1 }),
      speculation({ speculationStatus: 'closed', winSide: 'away' }),
      null,
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('settledLost');
  });

  it('spread market — predicted winner with adjusted line', () => {
    // lineTicks = +30 (3 points to away in 10× domain). Away 10, home 12 →
    // adjustedAway 130, scaledHome 120 → away wins on spread.
    const body = derivePositionStatus(
      position(), // upper / away
      speculation({ marketType: 'spread', lineTicks: 30 }),
      contest({ contestStatus: 'scored', awayScore: 10, homeScore: 12 }),
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('pendingSettle');
    expect(body.result).toBe('won');
  });

  it('total market — over winner', () => {
    // lineTicks = 150 (15 total in 10× domain). Sum 10+8 = 18, scaled 180 > 150 → over.
    const body = derivePositionStatus(
      position(), // upper = over
      speculation({ marketType: 'total', lineTicks: 150 }),
      contest({ contestStatus: 'scored', awayScore: 10, homeScore: 8 }),
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('pendingSettle');
    expect(body.result).toBe('won');
  });

  it('spread market with null lineTicks ⇒ falls through to active', () => {
    const body = derivePositionStatus(
      position(),
      speculation({ marketType: 'spread', lineTicks: null }),
      contest({ contestStatus: 'scored', awayScore: 10, homeScore: 5 }),
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('active');
  });

  // ── zero-risk convergence with the snapshot's `fetchCategorizedPositions` ──
  it('open + unscored + zero-risk ⇒ settledLost (transferred-out via secondary market)', () => {
    const body = derivePositionStatus(
      position({ riskAmount: '0', profitAmount: '0' }),
      speculation({ speculationStatus: 'open', winSide: 'tbd' }),
      contest({ contestStatus: 'unverified' }),
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('settledLost');
    expect(body.result).toBe('lost');
    expect(body.claimableAmount).toBeUndefined();
  });

  it('open + unscored + zero-risk + null contest ⇒ settledLost', () => {
    const body = derivePositionStatus(
      position({ riskAmount: '0', profitAmount: '0' }),
      speculation({ speculationStatus: 'open', winSide: 'tbd' }),
      null,
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('settledLost');
  });

  it('open + scored + zero-risk (predicted winner) ⇒ settledLost (payout=0)', () => {
    // The pendingSettle winner branch already catches `riskWei6===0 || payoutWei6===0`
    // and returns settledLost — covered here for completeness alongside the new
    // fall-through case above.
    const body = derivePositionStatus(
      position({ riskAmount: '0', profitAmount: '0' }),
      speculation({ marketType: 'moneyline' }),
      contest({ contestStatus: 'scored', awayScore: 10, homeScore: 5 }),
      SOURCE_UPDATED_AT,
    );
    expect(body.status).toBe('settledLost');
  });
});

describe('positionStatusRank', () => {
  it('active < pendingSettle < claimable < terminals', () => {
    expect(positionStatusRank('active')).toBeLessThan(positionStatusRank('pendingSettle'));
    expect(positionStatusRank('pendingSettle')).toBeLessThan(positionStatusRank('claimable'));
    expect(positionStatusRank('claimable')).toBeLessThan(positionStatusRank('claimed'));
  });
  it('all three terminal kinds share the highest rank', () => {
    expect(positionStatusRank('claimed')).toBe(positionStatusRank('settledLost'));
    expect(positionStatusRank('settledLost')).toBe(positionStatusRank('void'));
  });
});

/**
 * `isTerminalForever` — the predicate that lets the own-state hub retire a key
 * from its per-tick work-list (`#83`).
 *
 * The table is exhaustive over `(status, speculationStatus, winSide)` for every
 * combination the derivation can actually produce, because a false positive here
 * silently stops re-deriving a position that could still pay out. Each row states
 * WHY, so the next reader can check the reasoning rather than the shape.
 */
describe('isTerminalForever', () => {
  const OPEN = { speculationStatus: 'open' as const, winSide: 'tbd' as const };
  const CLOSED_AWAY = { speculationStatus: 'closed' as const, winSide: 'away' as const };
  const CLOSED_TBD = { speculationStatus: 'closed' as const, winSide: 'tbd' as const };

  const table: Array<{
    status: PositionStatus;
    spec: Pick<SpeculationInput, 'speculationStatus' | 'winSide'>;
    frozen: boolean;
    why: string;
  }> = [
    { status: 'claimed', spec: OPEN, frozen: true, why: 'the claim already happened; claimPosition cannot run twice' },
    { status: 'claimed', spec: CLOSED_AWAY, frozen: true, why: 'same, and the speculation state is irrelevant to it' },
    { status: 'settledLost', spec: CLOSED_AWAY, frozen: true, why: 'settleSpeculation closes once; a loser pays zero forever' },
    { status: 'settledLost', spec: OPEN, frozen: false, why: 'a PREDICTION off a scored contest — a score correction flips it' },
    { status: 'settledLost', spec: CLOSED_TBD, frozen: false, why: "closed + tbd is a shouldn't-happen state; a real side arriving later turns it claimable" },
    { status: 'claimable', spec: CLOSED_AWAY, frozen: false, why: 'still owes a `claimed` transition, and it is carrying money' },
    { status: 'void', spec: { speculationStatus: 'closed', winSide: 'void' }, frozen: false, why: 'payout equals the stake and is still unclaimed' },
    { status: 'pendingSettle', spec: OPEN, frozen: false, why: 'settlement has not run; claimable is still ahead of it' },
    { status: 'active', spec: OPEN, frozen: false, why: 'nothing has happened yet' },
  ];

  for (const row of table) {
    it(`${row.frozen ? 'retires' : 'keeps'} ${row.status} / ${row.spec.speculationStatus} / ${row.spec.winSide} — ${row.why}`, () => {
      expect(isTerminalForever(row.status, row.spec)).toBe(row.frozen);
    });
  }

  it('retires nothing that the derivation reports as carrying a claimable amount', () => {
    // A cross-check one level up rather than another spelling of the table: any
    // status the derivation gives a `claimableAmount` to is money the wallet can
    // still collect, so retiring it would drop the `claimed` event. Derived from
    // `derivePositionStatus` itself, not from a hand-listed set, so a new
    // money-bearing status added later lands in this loop automatically.
    const specs: Array<Pick<SpeculationInput, 'speculationStatus' | 'winSide'>> = [
      { speculationStatus: 'closed', winSide: 'away' },
      { speculationStatus: 'closed', winSide: 'void' },
      { speculationStatus: 'closed', winSide: 'push' },
      { speculationStatus: 'open', winSide: 'tbd' },
    ];
    for (const spec of specs) {
      const body = derivePositionStatus(
        {
          speculationId: '1',
          address: '0xabc',
          positionType: 0,
          riskAmount: '1000',
          profitAmount: '500',
          claimed: false,
        },
        { ...spec, marketType: 'moneyline', lineTicks: null },
        { contestStatus: 'scored', awayScore: 9, homeScore: 3 },
        '2026-09-22T00:00:00.000000+00:00',
      );
      if (body.claimableAmount !== undefined) {
        expect(isTerminalForever(body.status, spec)).toBe(false);
      }
    }
  });
});
