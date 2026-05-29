/**
 * Microsecond-precision timestamp helpers.
 *
 * The own-state cursor wire contract intentionally preserves Postgres
 * `timestamptz` precision verbatim. `Date.parse` truncates to ms — these
 * tests pin the boundaries where ms-truncation would silently collapse
 * same-ms parent transitions and cause the `sourceUpdatedAt = max(...)`
 * derivation to mis-sort, mis-filter, or pick the wrong source row.
 */
import { describe, expect, it } from 'vitest';
import {
  compareIsoTimestamptz,
  maxIsoTimestamptz,
  parseIsoTimestamptzKey,
} from '../src/v1/ownState/timestamps.js';

describe('parseIsoTimestamptzKey', () => {
  it('parses a Z-form ms timestamp', () => {
    const k = parseIsoTimestamptzKey('2026-05-29T15:00:00.123Z');
    expect(k).not.toBeNull();
    expect(k!.epochSec).toBe(BigInt(Math.trunc(Date.parse('2026-05-29T15:00:00Z') / 1000)));
    expect(k!.micros).toBe(123000);
  });

  it('parses a `+00:00` microsecond timestamp', () => {
    const k = parseIsoTimestamptzKey('2026-05-29T15:00:00.123456+00:00');
    expect(k).not.toBeNull();
    expect(k!.micros).toBe(123456);
  });

  it('parses with no fractional seconds', () => {
    const k = parseIsoTimestamptzKey('2026-05-29T15:00:00Z');
    expect(k).not.toBeNull();
    expect(k!.micros).toBe(0);
  });

  it('truncates >6-digit fractional to microseconds (not nanoseconds)', () => {
    const k = parseIsoTimestamptzKey('2026-05-29T15:00:00.123456789Z');
    expect(k).not.toBeNull();
    expect(k!.micros).toBe(123456);
  });

  it('returns null for non-UTC offsets (server contract rejects them)', () => {
    expect(parseIsoTimestamptzKey('2026-05-29T15:00:00.000+07:00')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseIsoTimestamptzKey('not a timestamp')).toBeNull();
    expect(parseIsoTimestamptzKey('2026-05-29T15:00:00.000')).toBeNull(); // no zone
  });
});

describe('compareIsoTimestamptz', () => {
  it('orders same-ms microsecond-different timestamps correctly', () => {
    // `.000200` > `.000100` even though both round to `.000` ms.
    expect(compareIsoTimestamptz('2026-05-29T15:00:00.000200Z', '2026-05-29T15:00:00.000100Z'))
      .toBeGreaterThan(0);
    expect(compareIsoTimestamptz('2026-05-29T15:00:00.000100Z', '2026-05-29T15:00:00.000200Z'))
      .toBeLessThan(0);
  });

  it('treats equal microsecond values as equal', () => {
    expect(compareIsoTimestamptz('2026-05-29T15:00:00.123456Z', '2026-05-29T15:00:00.123456Z'))
      .toBe(0);
  });

  it('orders across the Z vs +00:00 wire forms by true time', () => {
    // Same epoch, different shape — equal.
    expect(compareIsoTimestamptz('2026-05-29T15:00:00.123456Z', '2026-05-29T15:00:00.123456+00:00'))
      .toBe(0);
    // Different micros, mixed shapes.
    expect(compareIsoTimestamptz('2026-05-29T15:00:00.123456+00:00', '2026-05-29T15:00:00.123455Z'))
      .toBeGreaterThan(0);
  });

  it('orders different seconds correctly even with no fractional', () => {
    expect(compareIsoTimestamptz('2026-05-29T15:00:01Z', '2026-05-29T15:00:00Z'))
      .toBeGreaterThan(0);
  });
});

describe('maxIsoTimestamptz', () => {
  it('picks .000200 over .000100 (same-ms tie-breaking by microseconds)', () => {
    expect(maxIsoTimestamptz('2026-05-29T15:00:00.000100Z', '2026-05-29T15:00:00.000200Z'))
      .toBe('2026-05-29T15:00:00.000200Z');
  });

  it('picks the later micro across mixed wire forms', () => {
    expect(
      maxIsoTimestamptz(
        '2026-05-29T15:00:00.123455Z',
        '2026-05-29T15:00:00.123456+00:00',
      ),
    ).toBe('2026-05-29T15:00:00.123456+00:00');
  });

  it('preserves the verbatim wire string of the winner', () => {
    // Postgres-style `+00:00` shape preserved (not rewritten to Z).
    expect(
      maxIsoTimestamptz('2026-05-29T15:00:00.000100Z', '2026-05-29T15:00:00.123456+00:00'),
    ).toBe('2026-05-29T15:00:00.123456+00:00');
  });

  it('skips null / undefined / unparseable inputs', () => {
    expect(maxIsoTimestamptz(null, undefined, '2026-05-29T15:00:00.000Z'))
      .toBe('2026-05-29T15:00:00.000Z');
    expect(maxIsoTimestamptz('garbage', '2026-05-29T15:00:00.000Z'))
      .toBe('2026-05-29T15:00:00.000Z');
  });

  it('returns epoch when all inputs are skip-worthy', () => {
    expect(maxIsoTimestamptz(null, undefined, 'garbage')).toBe('1970-01-01T00:00:00.000Z');
    expect(maxIsoTimestamptz()).toBe('1970-01-01T00:00:00.000Z');
  });
});
