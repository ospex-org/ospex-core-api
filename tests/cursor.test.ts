import { describe, expect, it } from 'vitest';
import {
  CursorError,
  cursorFromRow,
  decodeCursor,
  encodeCursor,
  keysetOrExpr,
  type StreamCursor,
} from '../src/lib/cursor.js';

describe('cursor codec', () => {
  it('round-trips t/s/i', () => {
    const c: StreamCursor = { t: 'commitments', s: '2026-05-20T12:00:00.123456+00:00', i: '42' };
    const decoded = decodeCursor(encodeCursor(c), 'commitments');
    expect(decoded).toEqual(c);
  });

  it('round-trips a Z-suffixed timestamp', () => {
    const c: StreamCursor = { t: 'fills', s: '2026-05-20T12:00:00.000Z', i: '1' };
    expect(decodeCursor(encodeCursor(c), 'fills')).toEqual(c);
  });

  it('mints a decodable cursor from a row with a numeric id', () => {
    const raw = cursorFromRow('positions', { row_updated_at: '2026-05-20T00:00:00Z', id: 7 });
    const decoded = decodeCursor(raw, 'positions');
    expect(decoded.i).toBe('7');
    expect(decoded.s).toBe('2026-05-20T00:00:00Z');
    expect(decoded.t).toBe('positions');
  });

  it('rejects a cursor minted for a different resource', () => {
    const raw = encodeCursor({ t: 'commitments', s: '2026-05-20T00:00:00Z', i: '1' });
    expect(() => decodeCursor(raw, 'positions')).toThrow(CursorError);
  });

  it('rejects non-base64url / non-JSON input', () => {
    expect(() => decodeCursor('!!!not base64!!!', 'fills')).toThrow(CursorError);
    expect(() => decodeCursor(Buffer.from('not json', 'utf8').toString('base64url'), 'fills')).toThrow(
      CursorError,
    );
  });

  it('rejects missing or non-string fields', () => {
    const missingI = Buffer.from(JSON.stringify({ t: 'fills', s: '2026-05-20T00:00:00Z' }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeCursor(missingI, 'fills')).toThrow(CursorError);

    const numericI = Buffer.from(
      JSON.stringify({ t: 'fills', s: '2026-05-20T00:00:00Z', i: 5 }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(numericI, 'fills')).toThrow(CursorError);
  });

  it('rejects a non-integer id', () => {
    const raw = encodeCursor({ t: 'fills', s: '2026-05-20T00:00:00Z', i: '12.5' } as StreamCursor);
    expect(() => decodeCursor(raw, 'fills')).toThrow(CursorError);
  });

  it('rejects an unparseable timestamp', () => {
    const raw = encodeCursor({ t: 'fills', s: 'not-a-date', i: '1' });
    expect(() => decodeCursor(raw, 'fills')).toThrow(CursorError);
  });

  it('surfaces a ready-to-send ApiError on the thrown CursorError', () => {
    try {
      decodeCursor('@@@', 'fills');
      expect.unreachable('decodeCursor should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CursorError);
      expect((err as CursorError).apiError.code).toBe('INVALID_CURSOR');
      expect((err as CursorError).apiError.error).toMatch(/cursor/i);
    }
  });
});

describe('keysetOrExpr', () => {
  it('builds a strict (row_updated_at, id) > (s, i) keyset OR expression', () => {
    const expr = keysetOrExpr({ t: 'commitments', s: '2026-05-20T12:00:00+00:00', i: '99' });
    expect(expr).toBe(
      'row_updated_at.gt.2026-05-20T12:00:00+00:00,and(row_updated_at.eq.2026-05-20T12:00:00+00:00,id.gt.99)',
    );
  });
});
