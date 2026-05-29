/**
 * Stream-auth core (M3) — the challenge / token primitives behind
 * `/v1/auth/stream-{challenge,token}` + the `verifyStreamToken` middleware.
 *
 * Two halves:
 *   - ChallengeStore: in-memory, single-use, TTL-evicting map keyed by
 *     server-generated `challengeId`. Multi-DYNO LIMITATION: a challenge
 *     minted on dyno A cannot be consumed on dyno B. For the current
 *     single-dyno production deployment this is acceptable; scale-out
 *     requires a shared store (Postgres or Redis) — flagged in §M3 of the
 *     migration plan.
 *   - Token codec: compact HMAC-SHA256 `payload.sig` format (essentially a
 *     headerless JWT). `kid: 'v1'` is hardcoded; rotation is a follow-up that
 *     adds a second secret + dual-acceptance, structure already supports it.
 *
 * The EIP-712 typed-data schema lives in `eip712.ts` (`STREAM_AUTH_TYPES` +
 * `buildStreamAuthDomain`). The verifier here only handles the bearer token;
 * the challenge signature is verified at handler-time via `verifyTypedData`.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ────────────────────────────────────────────────────────────────────
// Types — challenge typed-data + token claims
// ────────────────────────────────────────────────────────────────────

/**
 * The EIP-712 typed-data the SDK signs (spec §3.2). Nested `network` struct
 * leaves room for future network metadata without a schema break. `address`
 * is stored / compared lowercased server-side; clients may send checksummed
 * but the resulting typed-data hash must use a consistent casing.
 */
export interface StreamChallenge {
  address: string;
  resource: 'own-state';
  scope: 'read:own-state';
  network: { chainId: number };
  audience: string;
  challengeId: string;
  issuedAt: number;     // unix seconds
  expiresAt: number;    // unix seconds
}

/**
 * Bearer token claims (decoded payload half). The verifier never trusts
 * these until the HMAC check passes; the type is what callers receive on
 * success.
 */
export interface StreamAuthClaims {
  address: string;
  resource: 'own-state';
  scope: 'read:own-state';
  audience: string;
  chainId: number;
  issuedAt: number;
  expiresAt: number;
  kid: string;
}

/** Current key id. Rotation = add `v2` + accept both during transition. */
export const STREAM_AUTH_KID = 'v1';

// ────────────────────────────────────────────────────────────────────
// Challenge id — 16 bytes of CSPRNG entropy as base64url
// ────────────────────────────────────────────────────────────────────

export function generateChallengeId(): string {
  return randomBytes(16).toString('base64url');
}

// ────────────────────────────────────────────────────────────────────
// Challenge store — in-memory, single-use, TTL-evicting
// ────────────────────────────────────────────────────────────────────

interface ChallengeRecord {
  address: string;     // lowercase
  issuedAt: number;    // unix seconds — exactly as minted
  expiresAt: number;   // unix seconds — exactly as minted
  consumed: boolean;
}

export type ConsumeResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'unknown'
        | 'expired'
        | 'already_used'
        | 'address_mismatch'
        | 'tampered';
    };

export class ChallengeStore {
  private readonly store = new Map<string, ChallengeRecord>();
  private lastCleanupMs = 0;
  /**
   * Hard cap so an adversarial mint rate can't pin memory. 50k entries at
   * ~100 bytes each = ~5 MB. Eviction is FIFO (Map preserves insertion
   * order); under pressure the oldest unconsumed entry gets dropped.
   */
  private readonly maxEntries: number;

  constructor(opts: { maxEntries?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? 50_000;
  }

  /**
   * Register a freshly minted challenge. The store records EVERY field the
   * server set at mint time — `address`, `issuedAt`, `expiresAt` — so
   * `consume()` can prove the submitted typed-data is the exact challenge
   * the server minted (and not a client-mutated variant whose signature is
   * still self-consistent). Hermes review-30 round 2 caught this gap: the
   * server-trusts-client expiresAt path let an attacker submit a
   * fresh-but-internally-consistent mutated challenge.
   */
  add(challengeId: string, challenge: StreamChallenge): void {
    this.maybeCleanup();
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(challengeId, {
      address: challenge.address.toLowerCase(),
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      consumed: false,
    });
  }

  /**
   * Single-use consume. Beyond the original single-use + expiry +
   * address-binding checks, this now ALSO requires the submitted challenge's
   * server-minted fields (`issuedAt`, `expiresAt`) to exactly match the
   * stored record. A mismatch returns `tampered` — the audience + chainId
   * are still config-validated at the handler layer (defense-in-depth), so
   * this catches the one remaining attack: a mutated timestamp resigned by
   * the legitimate wallet.
   */
  consume(challengeId: string, submitted: StreamChallenge, nowSec: number): ConsumeResult {
    const entry = this.store.get(challengeId);
    if (!entry) return { ok: false, reason: 'unknown' };
    if (entry.expiresAt <= nowSec) return { ok: false, reason: 'expired' };
    if (entry.address !== submitted.address.toLowerCase()) {
      return { ok: false, reason: 'address_mismatch' };
    }
    if (entry.issuedAt !== submitted.issuedAt || entry.expiresAt !== submitted.expiresAt) {
      return { ok: false, reason: 'tampered' };
    }
    if (entry.consumed) return { ok: false, reason: 'already_used' };
    entry.consumed = true;
    return { ok: true };
  }

  /**
   * Lazy sweep — runs at most once per minute. Keeps entries 60 s past
   * expiry so a barely-late submission gets a clean `expired` verdict
   * rather than `unknown` (a small client-quality signal vs treating
   * everything we lost as anonymous).
   */
  private maybeCleanup(): void {
    const nowMs = Date.now();
    if (nowMs - this.lastCleanupMs < 60_000) return;
    this.lastCleanupMs = nowMs;
    const nowSec = Math.floor(nowMs / 1000);
    for (const [id, e] of this.store) {
      if (e.expiresAt + 60 < nowSec) this.store.delete(id);
    }
  }

  /** Test-only escape hatch — drops all entries and resets the cleanup timer. */
  __reset(): void {
    this.store.clear();
    this.lastCleanupMs = 0;
  }

  size(): number {
    return this.store.size;
  }
}

/**
 * The module-singleton — POST /v1/auth/stream-{challenge,token} share this.
 * Tests reach in via `__reset()` between cases.
 */
export const challengeStore = new ChallengeStore();

// ────────────────────────────────────────────────────────────────────
// Token codec — compact `payload.sig` HMAC-SHA256
// ────────────────────────────────────────────────────────────────────

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function b64urlEncodeString(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function b64urlDecodeToString(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

function hmacSha256(secret: string, msg: string): Buffer {
  return createHmac('sha256', secret).update(msg).digest();
}

/**
 * Mint a bearer token. `kid` is fixed at `'v1'` until rotation lands. The
 * payload is the full claims set base64url-encoded; the signature is HMAC
 * over the payload (not over the claims object directly), so verification
 * doesn't need to re-encode in canonical JSON to recompute the same input.
 */
export function mintStreamAuthToken(
  claims: Omit<StreamAuthClaims, 'kid'>,
  secret: string,
): string {
  const full: StreamAuthClaims = { ...claims, kid: STREAM_AUTH_KID };
  const payload = b64urlEncodeString(JSON.stringify(full));
  const sig = b64urlEncode(hmacSha256(secret, payload));
  return `${payload}.${sig}`;
}

export type VerifyTokenResult =
  | { ok: true; claims: StreamAuthClaims }
  | { ok: false; reason: 'malformed' | 'unknown_kid' | 'bad_signature' | 'expired' };

/**
 * Verify a bearer token. The order — structure → kid → signature → expiry —
 * is deliberate: structure & kid failures are cheap and reveal no secret;
 * the signature comparison is timing-safe; expiry comes last so a valid-sig
 * stale token returns `expired` rather than being misclassified.
 */
/**
 * Canonical base64url round-trip. Subsumes a non-alphabet character check
 * AND closes the equivalent-pad-bit variant Hermes verified in review-30
 * round 2: a 32-byte HMAC encodes to 43 base64url chars with 2 unused bits
 * in the last char, so four distinct chars decode to the same byte sequence.
 * Forcing `Buffer.from(s, 'base64url').toString('base64url') === s` rejects
 * any non-canonical encoding, ensuring 1:1 between bytes and wire token.
 */
function isCanonicalBase64url(s: string): boolean {
  if (s.length === 0) return false;
  // Buffer.from(...'base64url') strips non-alphabet chars AND padding, AND
  // ignores the low bits of an over-long final char; re-encoding gives the
  // canonical form. Any input that differs from its canonical form fails.
  return Buffer.from(s, 'base64url').toString('base64url') === s;
}

export function verifyStreamAuthToken(
  token: string,
  secret: string,
  nowSec: number,
): VerifyTokenResult {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const payloadB64 = parts[0]!;
  const sigB64 = parts[1]!;
  if (!isCanonicalBase64url(payloadB64) || !isCanonicalBase64url(sigB64)) {
    return { ok: false, reason: 'malformed' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecodeToString(payloadB64));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isStreamAuthClaims(parsed)) {
    return { ok: false, reason: 'malformed' };
  }
  if (parsed.kid !== STREAM_AUTH_KID) {
    return { ok: false, reason: 'unknown_kid' };
  }

  // Signature verification — timing-safe, requires equal-length buffers.
  const expected = hmacSha256(secret, payloadB64);
  let presented: Buffer;
  try {
    presented = Buffer.from(sigB64, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (presented.length !== expected.length) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  if (parsed.expiresAt <= nowSec) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, claims: parsed };
}

function isStreamAuthClaims(v: unknown): v is StreamAuthClaims {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['address'] === 'string' &&
    o['resource'] === 'own-state' &&
    o['scope'] === 'read:own-state' &&
    typeof o['audience'] === 'string' &&
    typeof o['chainId'] === 'number' &&
    typeof o['issuedAt'] === 'number' &&
    typeof o['expiresAt'] === 'number' &&
    typeof o['kid'] === 'string'
  );
}
