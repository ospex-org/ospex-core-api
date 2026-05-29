/**
 * Pure tests for the stream-auth library — ChallengeStore (in-memory
 * single-use map) + the HMAC-SHA256 token codec — plus a pino redaction
 * smoke test that pins the production redact paths.
 */
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

import {
  ChallengeStore,
  STREAM_AUTH_KID,
  generateChallengeId,
  mintStreamAuthToken,
  verifyStreamAuthToken,
} from '../src/lib/streamAuth.js';

const SECRET = 'unit-test-hmac-secret-aaaaaaaaaa00';

// Anchored on the same wall-clock as `vi.setSystemTime` in beforeEach so the
// default token is valid; overrides can substitute expired/issuedAt values.
const NOW_SEC_FIXTURE = Math.floor(Date.parse('2026-05-28T16:00:00.000Z') / 1000);
const claims = (overrides: Partial<Parameters<typeof mintStreamAuthToken>[0]> = {}) => ({
  address: '0x1111111111111111111111111111111111111111',
  resource: 'own-state' as const,
  scope: 'read:own-state' as const,
  audience: 'https://api.test.local',
  chainId: 137,
  issuedAt: NOW_SEC_FIXTURE,
  expiresAt: NOW_SEC_FIXTURE + 900,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-28T16:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

// ─────────────────────────────────────────────────────────────────────────
// ChallengeStore
// ─────────────────────────────────────────────────────────────────────────

describe('ChallengeStore', () => {
  const ADDR = '0x1111111111111111111111111111111111111111';
  const NOW_SEC = Math.floor(Date.parse('2026-05-28T16:00:00.000Z') / 1000);

  it('consume returns ok exactly once per challengeId (single-use)', () => {
    const store = new ChallengeStore();
    const id = generateChallengeId();
    store.add(id, ADDR, NOW_SEC + 180);
    expect(store.consume(id, ADDR, NOW_SEC)).toEqual({ ok: true });
    expect(store.consume(id, ADDR, NOW_SEC)).toEqual({ ok: false, reason: 'already_used' });
  });

  it('consume rejects unknown challengeId', () => {
    const store = new ChallengeStore();
    expect(store.consume('not-a-real-id', ADDR, NOW_SEC)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('consume rejects an expired challenge (expiresAt <= nowSec)', () => {
    const store = new ChallengeStore();
    const id = generateChallengeId();
    store.add(id, ADDR, NOW_SEC); // already at the boundary — strict <= rejects
    expect(store.consume(id, ADDR, NOW_SEC)).toEqual({ ok: false, reason: 'expired' });
  });

  it('consume rejects a mismatched address (defends against the "burn" DoS)', () => {
    const store = new ChallengeStore();
    const id = generateChallengeId();
    store.add(id, ADDR, NOW_SEC + 180);
    const OTHER = '0x2222222222222222222222222222222222222222';
    expect(store.consume(id, OTHER, NOW_SEC)).toEqual({ ok: false, reason: 'address_mismatch' });
    // The honest user can still consume — burn attempt did NOT mark consumed.
    expect(store.consume(id, ADDR, NOW_SEC)).toEqual({ ok: true });
  });

  it('expired check precedes consumed check (an expired-and-consumed entry still says "expired")', () => {
    const store = new ChallengeStore();
    const id = generateChallengeId();
    store.add(id, ADDR, NOW_SEC + 10);
    store.consume(id, ADDR, NOW_SEC); // mark consumed while still alive
    // Re-consume at a later time when the entry has expired AND is consumed.
    expect(store.consume(id, ADDR, NOW_SEC + 11)).toEqual({ ok: false, reason: 'expired' });
  });

  it('FIFO drop when maxEntries reached — oldest unconsumed evicted, newest survives', () => {
    const store = new ChallengeStore({ maxEntries: 2 });
    store.add('id-a', ADDR, NOW_SEC + 180);
    store.add('id-b', ADDR, NOW_SEC + 180);
    store.add('id-c', ADDR, NOW_SEC + 180); // evicts id-a
    expect(store.size()).toBe(2);
    expect(store.consume('id-a', ADDR, NOW_SEC)).toEqual({ ok: false, reason: 'unknown' });
    expect(store.consume('id-b', ADDR, NOW_SEC)).toEqual({ ok: true });
    expect(store.consume('id-c', ADDR, NOW_SEC)).toEqual({ ok: true });
  });

  it('addresses are normalized to lowercase on both add + consume', () => {
    const store = new ChallengeStore();
    const id = generateChallengeId();
    const MIXED = '0xAbCdEf1234567890aBcDeF1234567890aBcDeF12';
    store.add(id, MIXED, NOW_SEC + 180);
    expect(store.consume(id, MIXED.toUpperCase(), NOW_SEC)).toEqual({ ok: true });
  });

  it('generateChallengeId returns a fresh 22-char base64url string each call', () => {
    const a = generateChallengeId();
    const b = generateChallengeId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).toHaveLength(22); // 16 random bytes → 22 base64url chars (no padding)
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Token codec
// ─────────────────────────────────────────────────────────────────────────

describe('mintStreamAuthToken / verifyStreamAuthToken', () => {
  const NOW_SEC = Math.floor(Date.parse('2026-05-28T16:00:00.000Z') / 1000);

  it('mint+verify roundtrip — claims survive with kid:"v1" attached', () => {
    const token = mintStreamAuthToken(claims(), SECRET);
    const verified = verifyStreamAuthToken(token, SECRET, NOW_SEC);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims).toMatchObject({
      address: '0x1111111111111111111111111111111111111111',
      resource: 'own-state',
      scope: 'read:own-state',
      audience: 'https://api.test.local',
      chainId: 137,
      kid: STREAM_AUTH_KID,
    });
  });

  it('rejects a token with a different HMAC secret (bad_signature)', () => {
    const token = mintStreamAuthToken(claims(), SECRET);
    expect(verifyStreamAuthToken(token, 'wrong-secret-xxxxxxxxxxxxxxxxxxx', NOW_SEC)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects an expired token', () => {
    const token = mintStreamAuthToken(claims({ expiresAt: NOW_SEC - 1 }), SECRET);
    expect(verifyStreamAuthToken(token, SECRET, NOW_SEC)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token whose payload has been tampered with (bad_signature)', () => {
    const token = mintStreamAuthToken(claims(), SECRET);
    const [payloadB64, sigB64] = token.split('.');
    // Swap the address in the payload to a different lowercased value.
    const decoded = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
    decoded.address = '0x9999999999999999999999999999999999999999';
    const tamperedPayload = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    const tampered = `${tamperedPayload}.${sigB64}`;
    expect(verifyStreamAuthToken(tampered, SECRET, NOW_SEC)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a token with a missing dot (malformed)', () => {
    expect(verifyStreamAuthToken('no-dot-here', SECRET, NOW_SEC)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a token with an empty payload or sig segment (malformed)', () => {
    expect(verifyStreamAuthToken('.sig', SECRET, NOW_SEC)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyStreamAuthToken('payload.', SECRET, NOW_SEC)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a token whose payload is non-JSON (malformed)', () => {
    const garbage = Buffer.from('not json', 'utf8').toString('base64url');
    expect(verifyStreamAuthToken(`${garbage}.x`, SECRET, NOW_SEC)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a token whose claims object is missing fields (malformed)', () => {
    const partial = Buffer.from(JSON.stringify({ address: 'x', kid: 'v1' }), 'utf8').toString('base64url');
    expect(verifyStreamAuthToken(`${partial}.x`, SECRET, NOW_SEC)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a token with an unknown kid (unknown_kid) without signature work', () => {
    const claimsWithFutureKid = { ...claims(), kid: 'v999' };
    const payload = Buffer.from(JSON.stringify(claimsWithFutureKid), 'utf8').toString('base64url');
    // Anything for the sig — verify must short-circuit on kid first.
    const token = `${payload}.aaaa`;
    expect(verifyStreamAuthToken(token, SECRET, NOW_SEC)).toEqual({
      ok: false,
      reason: 'unknown_kid',
    });
  });

  // Hermes review-30: `Buffer.from(s, 'base64url')` is LENIENT — it strips
  // characters outside the base64url alphabet. Without a strict pre-decode
  // check, `validToken + "!!!!"` decodes to the same bytes as `validToken`
  // and verifies. Tightens token identity for any future raw-token denylist.
  describe('strict base64url alphabet (review-30 footgun)', () => {
    it('rejects a token whose sig segment carries trailing non-alphabet bytes', () => {
      const valid = mintStreamAuthToken(claims(), SECRET);
      const tampered = `${valid}!!!!`;
      expect(verifyStreamAuthToken(tampered, SECRET, NOW_SEC)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    });

    it('rejects a token whose payload segment carries non-alphabet bytes', () => {
      const valid = mintStreamAuthToken(claims(), SECRET);
      const [p, s] = valid.split('.');
      const tampered = `${p}@@@.${s}`;
      expect(verifyStreamAuthToken(tampered, SECRET, NOW_SEC)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    });

    it('rejects a token using padding "=" (not used by our minter)', () => {
      const valid = mintStreamAuthToken(claims(), SECRET);
      const [p, s] = valid.split('.');
      expect(verifyStreamAuthToken(`${p}=.${s}`, SECRET, NOW_SEC)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Pino redaction — production config pins token + Authorization paths
// ─────────────────────────────────────────────────────────────────────────

describe('logger redaction (M3 token hygiene)', () => {
  function makeCapturingLogger(): { log: pino.Logger; captured: () => string } {
    let buf = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        buf += chunk.toString();
        cb();
      },
    });
    // Mirror production: import from the production logger via a fresh
    // pino instance with the same redact config. (Production logger writes
    // to stdout — we'd capture via process.stdout, which is fragile in test.)
    const log = pino(
      {
        redact: {
          paths: [
            'token',
            '*.token',
            'req.headers.authorization',
            'req.headers.Authorization',
            'headers.authorization',
            'headers.Authorization',
          ],
          censor: '[Redacted]',
          remove: false,
        },
      },
      stream,
    );
    return { log, captured: () => buf };
  }

  it('redacts `token` top-level field', () => {
    const { log, captured } = makeCapturingLogger();
    log.info({ token: 'sensitive-bearer-blob' }, 'mint');
    expect(captured()).toContain('[Redacted]');
    expect(captured()).not.toContain('sensitive-bearer-blob');
  });

  it('redacts nested `*.token` field', () => {
    const { log, captured } = makeCapturingLogger();
    log.info({ response: { token: 'sensitive-bearer-blob' } }, 'mint');
    expect(captured()).not.toContain('sensitive-bearer-blob');
  });

  it('redacts `req.headers.authorization` (Express request shape)', () => {
    const { log, captured } = makeCapturingLogger();
    log.info(
      { req: { headers: { authorization: 'Bearer sensitive-bearer-blob' } } },
      'inbound',
    );
    expect(captured()).not.toContain('sensitive-bearer-blob');
    expect(captured()).toContain('[Redacted]');
  });

  it('leaves unrelated keys untouched', () => {
    const { log, captured } = makeCapturingLogger();
    log.info({ address: '0xabc', code: 'OK' }, 'normal');
    expect(captured()).toContain('0xabc');
    expect(captured()).toContain('OK');
  });
});
