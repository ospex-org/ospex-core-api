/**
 * Pure tests for the own-state composite cursor codec (M4a). Roundtrip +
 * exhaustive structural validation. The cursor's invariants gate every
 * own-state owner-auth request, so each rejection branch is pinned.
 */
import { describe, expect, it } from 'vitest';

import {
  OWN_STATE_CURSOR_VERSION,
  OwnStateCursorError,
  SENTINEL_WATERMARK,
  decodeOwnStateCursor,
  encodeOwnStateCursor,
  watermarkKeysetOr,
  type OwnStateCursor,
} from '../src/v1/ownState/cursor.js';

const sample: OwnStateCursor = {
  t: 'own-state',
  v: OWN_STATE_CURSOR_VERSION,
  c: { s: '2026-05-28T16:00:00.000Z', i: '1234' },
  f: { s: '2026-05-28T16:00:00.000Z', i: '7' },
  p: { s: '2026-05-28T16:00:00.000Z', i: '99' },
  k: 'live',
};

describe('encode/decode roundtrip', () => {
  it('roundtrips a well-formed cursor', () => {
    const encoded = encodeOwnStateCursor(sample);
    expect(decodeOwnStateCursor(encoded)).toEqual(sample);
  });

  it('survives the page-active discriminant (cold-start truncation)', () => {
    const paged = { ...sample, k: 'page-active' as const };
    expect(decodeOwnStateCursor(encodeOwnStateCursor(paged))).toEqual(paged);
  });

  it('survives the page-recovery discriminant (recovery-mode continuation)', () => {
    const paged = { ...sample, k: 'page-recovery' as const };
    expect(decodeOwnStateCursor(encodeOwnStateCursor(paged))).toEqual(paged);
  });

  it('encodes to a URL-safe (base64url, no padding) string', () => {
    const encoded = encodeOwnStateCursor(sample);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('decode — structural rejections', () => {
  it('rejects non-base64url garbage', () => {
    expect(() => decodeOwnStateCursor('!!!!')).toThrow(OwnStateCursorError);
  });

  it('rejects base64url that does not decode to JSON', () => {
    const notJson = Buffer.from('not json', 'utf8').toString('base64url');
    expect(() => decodeOwnStateCursor(notJson)).toThrow(OwnStateCursorError);
  });

  it('rejects JSON that is not an object', () => {
    const arr = Buffer.from(JSON.stringify([1, 2, 3]), 'utf8').toString('base64url');
    expect(() => decodeOwnStateCursor(arr)).toThrow(OwnStateCursorError);
  });

  it('rejects a cursor with the wrong `t` (cross-stream reuse)', () => {
    const wrongT = encodeOwnStateCursor({ ...sample, t: 'commitments' as unknown as 'own-state' });
    expect(() => decodeOwnStateCursor(wrongT)).toThrow(OwnStateCursorError);
  });

  it('rejects a cursor with the wrong version (forward-compat block)', () => {
    const wrongV = encodeOwnStateCursor({ ...sample, v: 999 as unknown as 1 });
    expect(() => decodeOwnStateCursor(wrongV)).toThrow(OwnStateCursorError);
  });

  it('rejects a cursor with an invalid k', () => {
    const bad = Buffer.from(JSON.stringify({ ...sample, k: 'nope' }), 'utf8').toString('base64url');
    expect(() => decodeOwnStateCursor(bad)).toThrow(OwnStateCursorError);
  });
});

describe('decode — watermark rejections (each resource slot is validated)', () => {
  it('rejects a non-object watermark', () => {
    const bad = Buffer.from(
      JSON.stringify({ ...sample, c: 'not an object' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeOwnStateCursor(bad)).toThrow(OwnStateCursorError);
  });

  it('rejects a watermark with a non-ISO timestamp', () => {
    const bad = Buffer.from(
      JSON.stringify({ ...sample, c: { s: 'yesterday', i: '0' } }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeOwnStateCursor(bad)).toThrow(OwnStateCursorError);
  });

  it('rejects a watermark with a non-integer id', () => {
    const bad = Buffer.from(
      JSON.stringify({ ...sample, c: { s: sample.c.s, i: 'abc' } }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeOwnStateCursor(bad)).toThrow(OwnStateCursorError);
  });

  it('rejects a watermark with a negative id (the regex requires \\d+)', () => {
    const bad = Buffer.from(
      JSON.stringify({ ...sample, c: { s: sample.c.s, i: '-1' } }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeOwnStateCursor(bad)).toThrow(OwnStateCursorError);
  });

  it('rejects timestamps containing a comma (the PostgREST .or() delimiter)', () => {
    const bad = Buffer.from(
      JSON.stringify({ ...sample, c: { s: '2026,05,28T16:00:00.000Z', i: '0' } }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeOwnStateCursor(bad)).toThrow(OwnStateCursorError);
  });

  // Hermes review-31 round 1 blocker #5: the shape regex alone let
  // `2026-99-99T...` through (passes ISO regex; Date.parse → NaN). The new
  // semantic gate catches these before they reach PostgREST.
  it('rejects a semantically-invalid calendar timestamp (shape-valid but Date.parse=NaN)', () => {
    const bad = Buffer.from(
      JSON.stringify({ ...sample, c: { s: '2026-99-99T99:99:99.000Z', i: '0' } }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeOwnStateCursor(bad)).toThrow(OwnStateCursorError);
  });

  it('rejects an id that overflows Postgres bigint (2^63)', () => {
    const overflowingId = '9223372036854775808'; // 2^63
    const bad = Buffer.from(
      JSON.stringify({ ...sample, c: { s: sample.c.s, i: overflowingId } }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeOwnStateCursor(bad)).toThrow(OwnStateCursorError);
  });

  it('accepts an id exactly at Postgres bigint max (2^63 - 1)', () => {
    const maxId = '9223372036854775807';
    const ok = Buffer.from(
      JSON.stringify({ ...sample, c: { s: sample.c.s, i: maxId } }),
      'utf8',
    ).toString('base64url');
    expect(decodeOwnStateCursor(ok).c.i).toBe(maxId);
  });
});

describe('SENTINEL_WATERMARK', () => {
  it('is a valid watermark that decodes', () => {
    const sentinel = encodeOwnStateCursor({ ...sample, c: SENTINEL_WATERMARK });
    expect(decodeOwnStateCursor(sentinel).c).toEqual(SENTINEL_WATERMARK);
  });
});

describe('watermarkKeysetOr', () => {
  it('emits the strictly-after keyset OR expression', () => {
    expect(watermarkKeysetOr({ s: '2026-05-28T16:00:00.000Z', i: '7' })).toBe(
      'row_updated_at.gt.2026-05-28T16:00:00.000Z,and(row_updated_at.eq.2026-05-28T16:00:00.000Z,id.gt.7)',
    );
  });
});

describe('OwnStateCursorError', () => {
  it('carries a 400-style ApiError with code INVALID_CURSOR', () => {
    try {
      decodeOwnStateCursor('!!!!');
    } catch (err) {
      expect(err).toBeInstanceOf(OwnStateCursorError);
      expect((err as OwnStateCursorError).apiError).toMatchObject({ code: 'INVALID_CURSOR' });
      return;
    }
    expect.fail('expected throw');
  });
});
