import { describe, expect, it } from 'vitest';
import { classifyOddsUpdate, type CurrentOddsRow } from '../src/lib/oddsClassifier.js';

const T1 = '2026-05-20T12:00:00.000Z';
const T2 = '2026-05-20T12:00:30.000Z';

function row(o: Partial<CurrentOddsRow> = {}): CurrentOddsRow {
  return {
    network: 'polygon',
    jsonodds_id: 'jo-1',
    market: 'moneyline',
    line: null,
    away_odds_american: -110,
    home_odds_american: -110,
    upstream_last_updated: T1,
    poll_captured_at: T1,
    changed_at: T1,
    ...o,
  };
}

describe('classifyOddsUpdate', () => {
  it('treats an INSERT (no old row) as a change', () => {
    expect(classifyOddsUpdate(null, row())).toBe('change');
    expect(classifyOddsUpdate(undefined, row())).toBe('change');
  });

  it('is a change when a tracked price column moves', () => {
    expect(classifyOddsUpdate(row(), row({ away_odds_american: -120 }))).toBe('change');
    expect(classifyOddsUpdate(row(), row({ home_odds_american: 105 }))).toBe('change');
    expect(classifyOddsUpdate(row({ line: -3.5 }), row({ line: -2.5 }))).toBe('change');
  });

  it('is a change when changed_at advances even with identical prices', () => {
    expect(classifyOddsUpdate(row(), row({ changed_at: T2 }))).toBe('change');
  });

  it('is a refresh when only poll/upstream timestamps advance', () => {
    expect(classifyOddsUpdate(row(), row({ poll_captured_at: T2 }))).toBe('refresh');
    expect(classifyOddsUpdate(row(), row({ upstream_last_updated: T2 }))).toBe('refresh');
  });

  it('is none when nothing changed', () => {
    expect(classifyOddsUpdate(row(), row())).toBe('none');
  });

  it('does not throw on a malformed timestamp — it just suppresses that signal', () => {
    // Same prices, garbage timestamps that do not parse → no advance detected.
    const bad = row({ poll_captured_at: 'not-a-date', changed_at: 'nope', upstream_last_updated: 'x' });
    expect(classifyOddsUpdate(bad, { ...bad })).toBe('none');
  });
});
