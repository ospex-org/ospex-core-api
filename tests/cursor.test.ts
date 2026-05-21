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
  it('round-trips t/s/i/k', () => {
    const c: StreamCursor = { t: 'commitments', s: '2026-05-20T12:00:00.123456+00:00', i: '42', k: 'live' };
    expect(decodeCursor(encodeCursor(c), 'commitments')).toEqual(c);
  });

  it('round-trips a Z-suffixed timestamp and page kind', () => {
    const c: StreamCursor = { t: 'fills', s: '2026-05-20T12:00:00.000Z', i: '1', k: 'page' };
    expect(decodeCursor(encodeCursor(c), 'fills')).toEqual(c);
  });

  it('mints a page cursor from a row with a numeric id', () => {
    const raw = cursorFromRow('positions', { row_updated_at: '2026-05-20T00:00:00Z', id: 7 }, 'page');
    expect(decodeCursor(raw, 'positions')).toEqual({
      t: 'positions',
      s: '2026-05-20T00:00:00Z',
      i: '7',
      k: 'page',
    });
  });

  it('defaults a kind-less cursor to live (conservative — applies the overlap re-scan)', () => {
    const raw = Buffer.from(
      JSON.stringify({ t: 'fills', s: '2026-05-20T00:00:00Z', i: '3' }),
      'utf8',
    ).toString('base64url');
    expect(decodeCursor(raw, 'fills').k).toBe('live');
  });

  it('rejects an unrecognized kind', () => {
    const raw = Buffer.from(
      JSON.stringify({ t: 'fills', s: '2026-05-20T00:00:00Z', i: '3', k: 'weird' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(raw, 'fills')).toThrow(CursorError);
  });

  it('rejects a cursor minted for a different resource', () => {
    const raw = encodeCursor({ t: 'commitments', s: '2026-05-20T00:00:00Z', i: '1', k: 'page' });
    expect(() => decodeCursor(raw, 'positions')).toThrow(CursorError);
  });

  it('rejects non-base64url / non-JSON input', () => {
    expect(() => decodeCursor('!!!not base64!!!', 'fills')).toThrow(CursorError);
    expect(() => decodeCursor(Buffer.from('not json', 'utf8').toString('base64url'), 'fills')).toThrow(
      CursorError,
    );
  });

  it('rejects missing core string fields', () => {
    const missingI = Buffer.from(
      JSON.stringify({ t: 'fills', s: '2026-05-20T00:00:00Z', k: 'page' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(missingI, 'fills')).toThrow(CursorError);
  });

  it('rejects a non-integer id', () => {
    const raw = Buffer.from(
      JSON.stringify({ t: 'fills', s: '2026-05-20T00:00:00Z', i: '12.5', k: 'page' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(raw, 'fills')).toThrow(CursorError);
  });

  it('rejects a non-ISO timestamp', () => {
    const raw = Buffer.from(
      JSON.stringify({ t: 'fills', s: 'not-a-date', i: '1', k: 'page' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(raw, 'fills')).toThrow(CursorError);
  });

  // Hermes hardening: a Date.parse-valid timestamp containing the PostgREST
  // `.or()` delimiter (comma) must be rejected as INVALID_CURSOR, not flow
  // into the filter grammar and 500.
  it('rejects an RFC-style timestamp with a comma', () => {
    const evil = 'Tue, 20 May 2026 12:00:00 GMT';
    expect(Number.isNaN(Date.parse(evil))).toBe(false); // Date.parse would accept it
    const raw = Buffer.from(
      JSON.stringify({ t: 'fills', s: evil, i: '1', k: 'page' }),
      'utf8',
    ).toString('base64url');
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
    expect(keysetOrExpr('2026-05-20T12:00:00+00:00', '99')).toBe(
      'row_updated_at.gt.2026-05-20T12:00:00+00:00,and(row_updated_at.eq.2026-05-20T12:00:00+00:00,id.gt.99)',
    );
  });
});
