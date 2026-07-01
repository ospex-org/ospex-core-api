/**
 * Unit tests for the speculation wire-shape settlement projection
 * (`winSide` / `settledAt` / `voided`), shared by both row converters.
 *
 * Guards the core invariant: on the public speculation surface
 * `speculationStatus === 1` ⟺ `winSide !== null`. Both fields are projected
 * from the SAME Supabase row, and the indexer writes `speculation_status`,
 * `win_side`, and `settled_at` in one atomic UPDATE — so a closed speculation
 * always carries its winner (the "closed with no winner" state the agent-facing
 * read once exposed is not representable here).
 */
import { describe, expect, it } from 'vitest';
import {
  specRowToSpeculation,
  specRowToSpeculationViaScorer,
  type SpeculationRow,
} from '../src/v1/utils/speculations.js';

const SCORERS = {
  moneyline: '0x1111111111111111111111111111111111111111',
  spread: '0x2222222222222222222222222222222222222222',
  total: '0x3333333333333333333333333333333333333333',
};

function row(overrides: Partial<SpeculationRow> = {}): SpeculationRow {
  return {
    speculation_id: 100,
    contest_id: 42,
    speculation_scorer: SCORERS.moneyline,
    market_type: 'moneyline',
    line_ticks: 0,
    speculation_status: 'open',
    win_side: 'tbd',
    settled_at: null,
    voided: false,
    ...overrides,
  };
}

describe('specRowToSpeculation — settlement projection', () => {
  it('open speculation → status 0, winSide null, settledAt null, voided false', () => {
    expect(specRowToSpeculation(row())).toMatchObject({
      speculationStatus: 0,
      winSide: null,
      settledAt: null,
      voided: false,
    });
  });

  it('settled (away wins) → status 1, winSide "away", settledAt passthrough', () => {
    const s = specRowToSpeculation(
      row({ speculation_status: 'closed', win_side: 'away', settled_at: '2026-07-01T04:00:14+00:00' }),
    );
    expect(s).toMatchObject({
      speculationStatus: 1,
      winSide: 'away',
      settledAt: '2026-07-01T04:00:14+00:00',
      voided: false,
    });
  });

  it('push → status 1, winSide "push" (a settled, non-null outcome)', () => {
    expect(
      specRowToSpeculation(
        row({ speculation_status: 'closed', win_side: 'push', settled_at: '2026-07-01T04:00:14+00:00' }),
      ),
    ).toMatchObject({ speculationStatus: 1, winSide: 'push', voided: false });
  });

  it('void → status 1, winSide "void", voided true', () => {
    expect(
      specRowToSpeculation(
        row({
          speculation_status: 'closed',
          win_side: 'void',
          settled_at: '2026-07-01T04:00:14+00:00',
          voided: true,
        }),
      ),
    ).toMatchObject({ speculationStatus: 1, winSide: 'void', voided: true });
  });

  it('preserves the settledAt string verbatim (no Date round-trip / µs truncation)', () => {
    const micro = '2026-07-01T04:00:14.123456+00:00';
    const s = specRowToSpeculation(row({ speculation_status: 'closed', win_side: 'home', settled_at: micro }));
    expect(s?.settledAt).toBe(micro);
  });

  it('INVARIANT: speculationStatus === 1 ⟺ winSide !== null, across every win_side value', () => {
    const sides = ['tbd', 'away', 'home', 'over', 'under', 'push', 'void'] as const;
    for (const ws of sides) {
      const s = specRowToSpeculation(
        row({
          speculation_status: ws === 'tbd' ? 'open' : 'closed',
          win_side: ws,
          voided: ws === 'void',
        }),
      );
      expect(s).not.toBeNull();
      expect(s!.speculationStatus === 1).toBe(s!.winSide !== null);
    }
  });
});

describe('specRowToSpeculationViaScorer — settlement projection', () => {
  it('projects winSide/settledAt/voided identically to the market_type path', () => {
    expect(
      specRowToSpeculationViaScorer(
        row({ speculation_status: 'closed', win_side: 'home', settled_at: '2026-07-01T04:00:14+00:00' }),
        SCORERS,
      ),
    ).toMatchObject({
      speculationStatus: 1,
      winSide: 'home',
      settledAt: '2026-07-01T04:00:14+00:00',
      voided: false,
    });
  });
});
