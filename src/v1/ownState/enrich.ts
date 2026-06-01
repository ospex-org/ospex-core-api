/**
 * Owner-state body enrichment — Phase 3 PR0b (§3.1, amendment A6).
 *
 * The owner-auth own-state surface carries a SUPERSET of the public
 * {@link CommitmentBody}: a maker needs the contest context (sport + the
 * ABSOLUTE home/away teams), the canonical `speculationId`, a freshness
 * timestamp, and — the load-bearing piece — the full SIGNED payload so it can
 * authoritatively `cancelOnchainSigned` a row it has taken off the public book
 * (`book_visible=false`) without re-fetching from a public surface that
 * redacts hidden rows. `speculationId` is deliberately ABSENT from the public
 * body (audit deny-list in `commitments.ts`); it is owner-auth-only here.
 *
 * ── Signed-payload reconstruction ───────────────────────────────────────
 *
 * The 9-field EIP-712 `OspexCommitment` struct is rebuilt from the stored
 * columns, plus the hash + signature. bigint struct fields
 * (`contestId`/`riskAmount`/`nonce`/`expiry`) are emitted as decimal STRINGS
 * — JSON has no bigint — and the SDK coerces them back. Reconstruction is
 * lossless: `risk_amount`/`nonce` are `numeric(78,0)` (returned as strings),
 * `contest_id` is `bigint`, and `expiry` was signed as whole unix-seconds so
 * the stored `timestamptz` round-trips exactly. The SDK asserts
 * `hashCommitment(commitment) === commitmentHash` BEFORE it ever signs a
 * cancel, so a drifted or incomplete reconstruction can never cancel the
 * wrong on-chain slot — `null` here (signature absent OR any signed struct
 * field absent) is the fail-closed signal the MM reads as
 * `signedPayloadStatus: 'missing-legacy'`.
 *
 * ── speculationId resolution ────────────────────────────────────────────
 *
 * `speculations` has no `speculation_key` column, but the key is just
 * `keccak(contestId, scorer, lineTicks)` — so the speculation a commitment
 * belongs to is the one whose `(contest_id, speculation_scorer, line_ticks)`
 * matches the commitment's. We batch-fetch speculations for the same
 * `contest_id` set as the contest join and match in-memory. `null` when no
 * speculation exists yet (a still-unmatched commitment) — the field is
 * nullable by contract.
 */

import { getSupabase } from '../../lib/supabase.js';
import {
  rowToBody,
  type CommitmentBody,
  type CommitmentRow,
  type CommitmentRecoveryRow,
} from '../commitments.js';

const POSITION_TYPE_TO_INT: Record<'upper' | 'lower', 0 | 1> = { upper: 0, lower: 1 };

/**
 * Wire shape of the canonical signed commitment payload. Mirrors the SDK's
 * `SignedCommitmentPayload`: the EIP-712 hash, the 9-field struct (bigint
 * fields as decimal strings), and the maker signature. The SDK coerces the
 * string fields back to bigint and asserts the struct hashes to
 * `commitmentHash` before acting on it.
 */
export interface SignedCommitmentWire {
  commitmentHash: string;
  commitment: {
    maker: string;
    contestId: string;
    scorer: string;
    lineTicks: number;
    positionType: 0 | 1;
    oddsTick: number;
    riskAmount: string;
    nonce: string;
    expiry: string;
  };
  signature: string;
}

/**
 * Owner-auth commitment body — the public {@link CommitmentBody} plus the
 * owner-only enrichment fields. `fillability` (a public-only advisory) is
 * never populated on this surface.
 */
export interface OwnerCommitmentBody extends CommitmentBody {
  /** Canonical numeric speculation id, or null when no speculation exists yet. */
  speculationId: string | null;
  /** `contests.sport_slug ?? ''` — matches the rest of the API's sport mapping. */
  sport: string;
  /** Absolute away team (distinct from the maker-relative position side). */
  awayTeam: string;
  /** Absolute home team. */
  homeTeam: string;
  /** `row_updated_at` as whole unix seconds — a freshness signal for the consumer. */
  updatedAtUnixSec: number;
  /** Full signed payload, or null when not reconstructable (fail-closed). */
  signedPayload: SignedCommitmentWire | null;
}

interface ContestContext {
  awayTeam: string;
  homeTeam: string;
  sport: string;
}

export interface CommitmentEnrichment {
  /** `String(contest_id)` → contest context. */
  contestById: Map<string, ContestContext>;
  /** `${contestId}|${scorerLower}|${lineTicks}` → speculationId. */
  speculationIdByTuple: Map<string, string>;
}

type SbClient = ReturnType<typeof getSupabase>;

interface ContestLiteRow {
  contest_id: string | number;
  away_team: string | null;
  home_team: string | null;
  sport_slug: string | null;
}
interface SpeculationTupleRow {
  speculation_id: string | number;
  contest_id: string | number | null;
  speculation_scorer: string | null;
  line_ticks: number | null;
}

/** `${contestId}|${scorerLower}|${lineTicks}`, or null when any part is absent. */
function specTupleKey(
  contestId: string,
  scorer: string | null,
  lineTicks: number | null,
): string | null {
  if (contestId === '' || scorer == null || lineTicks == null) return null;
  return `${contestId}|${scorer.toLowerCase()}|${lineTicks}`;
}

/**
 * Batch-fetch the contest context + speculation-id mapping for a set of
 * commitment rows in two queries (contests + speculations, both scoped by the
 * rows' distinct `contest_id`s). The returned maps are consumed by
 * {@link toOwnerCommitmentBody} so per-row mapping does no IO.
 */
export async function fetchCommitmentEnrichment(
  sb: SbClient,
  network: string,
  rows: CommitmentRecoveryRow[],
): Promise<CommitmentEnrichment> {
  const contestById = new Map<string, ContestContext>();
  const speculationIdByTuple = new Map<string, string>();
  if (rows.length === 0) return { contestById, speculationIdByTuple };

  const contestIds = [
    ...new Set(
      rows
        .map((r) => r.contest_id)
        .filter((id): id is string | number => id != null)
        .map(String),
    ),
  ];
  if (contestIds.length === 0) return { contestById, speculationIdByTuple };

  const [contestRes, specRes] = await Promise.all([
    sb
      .from('contests')
      .select('contest_id, away_team, home_team, sport_slug')
      .eq('network', network)
      .in('contest_id', contestIds),
    sb
      .from('speculations')
      .select('speculation_id, contest_id, speculation_scorer, line_ticks')
      .eq('network', network)
      .in('contest_id', contestIds),
  ]);
  if (contestRes.error) {
    throw new Error(`fetchCommitmentEnrichment contests: ${contestRes.error.message}`);
  }
  if (specRes.error) {
    throw new Error(`fetchCommitmentEnrichment speculations: ${specRes.error.message}`);
  }

  for (const c of (contestRes.data ?? []) as unknown as ContestLiteRow[]) {
    contestById.set(String(c.contest_id), {
      awayTeam: c.away_team ?? '',
      homeTeam: c.home_team ?? '',
      sport: c.sport_slug ?? '',
    });
  }
  for (const s of (specRes.data ?? []) as unknown as SpeculationTupleRow[]) {
    const key = specTupleKey(
      s.contest_id != null ? String(s.contest_id) : '',
      s.speculation_scorer,
      s.line_ticks,
    );
    if (key != null) speculationIdByTuple.set(key, String(s.speculation_id));
  }

  return { contestById, speculationIdByTuple };
}

/**
 * Reconstruct the signed payload from a commitment row. Returns null —
 * fail-closed — when the signature is absent (indexer-discovered rows) OR any
 * signed struct field is missing (an incomplete row can't produce a struct
 * that hashes back to `commitmentHash`).
 */
export function buildSignedPayload(row: CommitmentRow): SignedCommitmentWire | null {
  if (!row.signature) return null;
  if (
    row.contest_id == null ||
    row.scorer == null ||
    row.line_ticks == null ||
    row.position_type == null ||
    row.odds_tick == null ||
    row.risk_amount == null ||
    row.nonce == null ||
    row.expiry == null
  ) {
    return null;
  }
  const expiryMs = Date.parse(row.expiry);
  if (!Number.isFinite(expiryMs)) return null;

  return {
    commitmentHash: row.commitment_hash,
    commitment: {
      maker: row.maker,
      contestId: String(row.contest_id),
      scorer: row.scorer,
      lineTicks: row.line_ticks,
      positionType: POSITION_TYPE_TO_INT[row.position_type],
      oddsTick: row.odds_tick,
      riskAmount: String(row.risk_amount),
      nonce: String(row.nonce),
      // Signed as whole unix-seconds; the stored timestamptz round-trips exactly.
      expiry: String(Math.floor(expiryMs / 1000)),
    },
    signature: row.signature,
  };
}

/**
 * Map a commitment recovery row to the enriched owner body, using a
 * pre-fetched {@link CommitmentEnrichment} (no IO). The base public fields
 * come from the shared `rowToBody`; the owner-only fields are layered on.
 */
export function toOwnerCommitmentBody(
  row: CommitmentRecoveryRow,
  nowMs: number,
  enrichment: CommitmentEnrichment,
): OwnerCommitmentBody {
  const base = rowToBody(row as unknown as CommitmentRow, nowMs);
  const contestId = row.contest_id != null ? String(row.contest_id) : '';
  const contest = contestId !== '' ? enrichment.contestById.get(contestId) : undefined;
  const tupleKey = specTupleKey(contestId, row.scorer, row.line_ticks);
  const speculationId =
    tupleKey != null ? (enrichment.speculationIdByTuple.get(tupleKey) ?? null) : null;
  const updatedAtMs = Date.parse(row.row_updated_at);

  return {
    ...base,
    speculationId,
    sport: contest?.sport ?? '',
    awayTeam: contest?.awayTeam ?? '',
    homeTeam: contest?.homeTeam ?? '',
    updatedAtUnixSec: Number.isFinite(updatedAtMs) ? Math.floor(updatedAtMs / 1000) : 0,
    signedPayload: buildSignedPayload(row as unknown as CommitmentRow),
  };
}
