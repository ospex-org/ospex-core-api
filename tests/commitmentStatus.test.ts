/**
 * Unit tests for the effective-status derivation. Pure functions — no Supabase,
 * no network, deterministic `nowMs`. This is the regression proof that a
 * time-expired or nonce-invalidated commitment whose stored status is still
 * `open`/`partially_filled` derives to a terminal effective status.
 */
import { describe, expect, it } from 'vitest';
import { deriveEffectiveStatus } from '../src/lib/commitmentStatus.js';

const NOW = Date.parse('2026-05-20T16:00:00.000Z');
const FUTURE = '2026-05-20T17:00:00.000Z';
const PAST = '2026-05-20T15:00:00.000Z';

function eff(
  storedStatus: string,
  expiry: string | null,
  nonceInvalidated = false,
  bookVisible = true,
  nowMs = NOW,
): string {
  return deriveEffectiveStatus({ storedStatus, expiry, nonceInvalidated, bookVisible, nowMs });
}

describe('deriveEffectiveStatus', () => {
  it('open + future expiry → open', () => {
    expect(eff('open', FUTURE)).toBe('open');
  });

  it('open + past expiry → expired', () => {
    expect(eff('open', PAST)).toBe('expired');
  });

  it('open + null expiry → expired (expiry==0 always reverts on-chain)', () => {
    expect(eff('open', null)).toBe('expired');
  });

  it('open + unparseable expiry → expired', () => {
    expect(eff('open', 'not-a-date')).toBe('expired');
  });

  it('partially_filled + future expiry → partially_filled', () => {
    expect(eff('partially_filled', FUTURE)).toBe('partially_filled');
  });

  it('partially_filled + past expiry → expired', () => {
    expect(eff('partially_filled', PAST)).toBe('expired');
  });

  it('expiry exactly == now → expired (>= boundary matches MatchingModule)', () => {
    expect(eff('open', new Date(NOW).toISOString())).toBe('expired');
  });

  it('expiry one ms in the future → open', () => {
    expect(eff('open', new Date(NOW + 1).toISOString())).toBe('open');
  });

  // ── nonce invalidation → cancelled ──────────────────────────────────────
  it('open + nonceInvalidated + future expiry → cancelled', () => {
    expect(eff('open', FUTURE, true)).toBe('cancelled');
  });

  it('partially_filled + nonceInvalidated + future expiry → cancelled', () => {
    expect(eff('partially_filled', FUTURE, true)).toBe('cancelled');
  });

  it('nonceInvalidated takes precedence over expiry (open + past + invalidated → cancelled)', () => {
    expect(eff('open', PAST, true)).toBe('cancelled');
  });

  // ── off-chain hidden (book_visible=false) → cancelled ────────────────────
  it('open + hidden → cancelled (off-chain DELETE hides from book)', () => {
    expect(eff('open', FUTURE, false, false)).toBe('cancelled');
  });

  it('partially_filled + hidden → cancelled', () => {
    expect(eff('partially_filled', FUTURE, false, false)).toBe('cancelled');
  });

  it('hidden + past expiry → cancelled (hidden checked before expiry, matches pre-split DELETE)', () => {
    expect(eff('open', PAST, false, false)).toBe('cancelled');
  });

  it('filled + hidden → filled (terminal wins; book visibility irrelevant)', () => {
    expect(eff('filled', FUTURE, false, false)).toBe('filled');
  });

  it('explicit visible open → open (default-true path sanity)', () => {
    expect(eff('open', FUTURE, false, true)).toBe('open');
  });

  // ── terminal stored states are immutable ─────────────────────────────────
  it('filled + past expiry → filled (terminal)', () => {
    expect(eff('filled', PAST)).toBe('filled');
  });

  it('filled + future expiry → filled', () => {
    expect(eff('filled', FUTURE)).toBe('filled');
  });

  it('filled + nonceInvalidated → filled (terminal wins over nonce)', () => {
    expect(eff('filled', PAST, true)).toBe('filled');
  });

  it('cancelled + future expiry → cancelled (terminal)', () => {
    expect(eff('cancelled', FUTURE)).toBe('cancelled');
  });

  it('cancelled + past expiry → cancelled', () => {
    expect(eff('cancelled', PAST)).toBe('cancelled');
  });

  it('stored expired → expired regardless of a future expiry timestamp', () => {
    expect(eff('expired', FUTURE)).toBe('expired');
  });

  // ── defensive: unknown stored status passes through, never fabricated ─────
  it('unknown stored status → passed through unchanged', () => {
    expect(eff('something_weird', FUTURE)).toBe('something_weird');
  });
});
