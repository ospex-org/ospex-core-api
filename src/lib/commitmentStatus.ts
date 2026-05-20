/**
 * Commitment lifecycle / effective-status derivation.
 *
 * The indexer stores an *event-derived* status (`open` → `partially_filled` →
 * `filled`, plus `cancelled`). It never writes `expired`: expiry is a passive
 * `timestamptz` column with no triggering on-chain event, and `nonce_invalidated`
 * is tracked as a separate boolean rather than a status transition. So a row that
 * is unmatchable *by time* or *by nonce floor* still reads `open` /
 * `partially_filled` in the DB.
 *
 * This helper derives the **effective** status a client should treat as true
 * right now. It mirrors the on-chain temporal guard in
 * `MatchingModule._validateCommitment` (ospex-foundry-matched-pairs), which
 * reverts with `MatchingModule__CommitmentExpired` when
 * `block.timestamp >= commitment.expiry` — i.e. `expiry <= now` is genuinely
 * unmatchable, and `expiry == 0`/absent is *always* unmatchable. Nonce-invalidated
 * commitments revert with `NonceTooLow`; `raiseMinNonce` is the protocol's
 * bulk-cancel lever, so we surface them as effectively `cancelled`.
 *
 * SCOPE: this is the *lifecycle* status (stored status + expiry + nonce
 * invalidation). It is intentionally **not** a complete matchability predicate —
 * a fully-consumed row can still read `partially_filled` with
 * `remainingRiskAmount = 0` (the indexer `risk_amount = 0` edge), which is a
 * separate, separately-tracked accounting concern and is NOT folded in here.
 */

export type EffectiveCommitmentStatus =
  | 'open'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'expired';

/** Stored statuses that are immutable terminal facts — expiry/nonce can't change them. */
const TERMINAL_STORED: ReadonlySet<string> = new Set(['filled', 'cancelled', 'expired']);

/** Stored statuses that are still on the live book and subject to time/nonce death. */
const LIVE_STORED: ReadonlySet<string> = new Set(['open', 'partially_filled']);

export interface EffectiveStatusInput {
  /** Raw `commitments.status` as stored by the indexer / submission relay. */
  storedStatus: string;
  /** Raw `commitments.expiry` (ISO-8601 timestamptz) or null. */
  expiry: string | null;
  /** Raw `commitments.nonce_invalidated`. */
  nonceInvalidated: boolean;
  /** Epoch ms captured ONCE per request (do not call Date.now() per row). */
  nowMs: number;
}

/**
 * Derive effective status. Returns `string` (not the union) on purpose: the DB
 * CHECK constraint bounds `status` to the five known values, but if an unknown
 * value ever appears we pass it through unchanged rather than fabricating /
 * blindly casting a value into the public status field.
 */
export function deriveEffectiveStatus(input: EffectiveStatusInput): string {
  const { storedStatus, expiry, nonceInvalidated, nowMs } = input;

  // Terminal stored states win — including a stored `expired` (the CHECK
  // constraint permits it even though no current writer produces it).
  if (TERMINAL_STORED.has(storedStatus)) return storedStatus;

  if (LIVE_STORED.has(storedStatus)) {
    // Bulk-cancel via raiseMinNonce: reverts on match (NonceTooLow). Effectively cancelled.
    if (nonceInvalidated) return 'cancelled';
    // Temporal guard. Null/invalid expiry behaves as `expiry == 0` on chain → always expired.
    if (expiry === null) return 'expired';
    const expiryMs = Date.parse(expiry);
    if (!Number.isFinite(expiryMs) || expiryMs <= nowMs) return 'expired';
    return storedStatus;
  }

  // Unknown stored status — should be impossible under the DB CHECK. Don't
  // invent a public status; surface the raw value untouched.
  return storedStatus;
}

/**
 * Map a set of requested EFFECTIVE statuses to the set of raw/stored statuses
 * that could derive into any of them. Used by the list endpoint to fetch a
 * sufficient candidate superset before post-filtering on effective status.
 *
 * `cancelled` and `expired` can arise from a stored `open`/`partially_filled`
 * row (via nonce invalidation / time expiry), so wanting either pulls those in.
 */
export function rawStatusCandidates(wanted: ReadonlySet<string>): string[] {
  const raw = new Set<string>();
  if (wanted.has('open')) raw.add('open');
  if (wanted.has('partially_filled')) raw.add('partially_filled');
  if (wanted.has('filled')) raw.add('filled');
  if (wanted.has('cancelled')) {
    raw.add('cancelled');
    raw.add('open');
    raw.add('partially_filled');
  }
  if (wanted.has('expired')) {
    raw.add('expired');
    raw.add('open');
    raw.add('partially_filled');
  }
  return [...raw];
}

/**
 * True when the requested effective-status set can be served by the efficient
 * DB-filter path (no JS post-filtering): every wanted status is a live status,
 * so `status IN (wanted) AND nonce_invalidated = false AND expiry > now` is
 * exactly equivalent to "effective status ∈ wanted". Terminal statuses
 * (filled/cancelled/expired) ignore expiry and need post-filtering instead.
 */
export function isLiveOnlyFilter(wanted: ReadonlySet<string>): boolean {
  if (wanted.size === 0) return false;
  for (const s of wanted) {
    if (!LIVE_STORED.has(s)) return false;
  }
  return true;
}
