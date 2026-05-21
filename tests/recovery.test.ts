/**
 * Unit tests for the recovery overlap logic — the fix for the A1 review
 * blocker (strict keyset could miss a row committed late under the
 * now()-is-transaction-start schema).
 */
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../src/lib/cursor.js';
import { RECOVERY_OVERLAP_MS, nextCursor, recoveryKeysetExpr } from '../src/lib/recovery.js';

describe('recoveryKeysetExpr', () => {
  it('page cursor → strict keyset on its own (s, i)', () => {
    const expr = recoveryKeysetExpr({ t: 'commitments', s: '2026-05-20T12:00:00.000Z', i: '40', k: 'page' });
    expect(expr).toBe(
      'row_updated_at.gt.2026-05-20T12:00:00.000Z,and(row_updated_at.eq.2026-05-20T12:00:00.000Z,id.gt.40)',
    );
  });

  it('live cursor → floored by the overlap window, id 0 (inclusive re-scan)', () => {
    const s = '2026-05-20T12:00:00.000Z';
    const floored = new Date(Date.parse(s) - RECOVERY_OVERLAP_MS).toISOString();
    expect(floored).toBe('2026-05-20T11:59:30.000Z'); // 30s before
    expect(recoveryKeysetExpr({ t: 'commitments', s, i: '40', k: 'live' })).toBe(
      `row_updated_at.gt.${floored},and(row_updated_at.eq.${floored},id.gt.0)`,
    );
  });

  it('the live re-scan reaches strictly before the cursor (closes the reconnect gap)', () => {
    // The blocker: a row committed late with row_updated_at = t0 < cursor t1
    // would be skipped by strict `> t1`. The live floor (t1 - overlap) re-includes it.
    const s = '2026-05-20T12:00:00.000Z';
    const floored = new Date(Date.parse(s) - RECOVERY_OVERLAP_MS).toISOString();
    const expr = recoveryKeysetExpr({ t: 'fills', s, i: '5', k: 'live' });
    expect(expr).toContain(`row_updated_at.gt.${floored}`);
    expect(Date.parse(floored)).toBeLessThan(Date.parse(s));
  });
});

describe('nextCursor', () => {
  it('mints a PAGE cursor from the last row, so paging stays strict and terminates', () => {
    const raw = nextCursor('fills', { row_updated_at: '2026-05-20T12:00:00.000Z', id: 9 }, null);
    expect(raw).not.toBeNull();
    expect(decodeCursor(raw as string, 'fills')).toEqual({
      t: 'fills',
      s: '2026-05-20T12:00:00.000Z',
      i: '9',
      k: 'page',
    });
  });

  it('echoes the input cursor when the page is empty (holds position; keeps re-scanning if live)', () => {
    const since = encodeCursor({ t: 'fills', s: '2026-05-20T12:00:00.000Z', i: '9', k: 'live' });
    expect(nextCursor('fills', undefined, since)).toBe(since);
  });

  it('returns null when empty and the client started fresh', () => {
    expect(nextCursor('fills', undefined, null)).toBeNull();
  });
});
