# Commitment Cancel Flow

There are three ways to cancel an EIP-712 commitment in Ospex. Two are on-chain (authoritative), one is off-chain (signal only). Pick by what you actually need to invalidate and how much you trust the off-chain order book.

## TL;DR

| Method | Where | Effect | When to use |
|---|---|---|---|
| `DELETE /v1/commitments/:hash` | Off-chain, signed | Sets `commitments.status = 'cancelled'` so takers stop seeing it on the order book. Does NOT prevent on-chain matching by anyone holding the signature. | The default. The commitment hasn't been matched yet and you just want to retract it from the book. |
| `MatchingModule.cancelCommitment(c)` | On-chain | Sets `s_cancelledCommitments[hash] = true` so any future `matchCommitment` call reverts. Indexer projects `COMMITMENT_CANCELLED` to `commitments.status = 'cancelled'`. | The definitive cancel. Use when the commitment was partially matched, when you don't trust the order book, or when you need to close the divergence window described below. |
| `MatchingModule.raiseMinNonce(contestId, scorer, lineTicks, newMinNonce)` | On-chain | Bumps `s_minNonces[maker][speculationKey]`. Every commitment on that speculation with `nonce < newMinNonce` becomes unmatchable. Indexer mirrors to `maker_nonce_floors` and flips affected rows to `nonce_invalidated = true`. | Bulk cancel — you want to wipe many commitments on the same `(contestId, scorer, lineTicks)` triple in one tx. |

## Off-chain cancel — `DELETE /v1/commitments/:hash`

**Body shape**

```json
{
  "action": {
    "type": "CancelCommitment",
    "commitmentHash": "0x…",
    "expiry": 1730000000
  },
  "signature": "0x…"
}
```

**EIP-712 type**

```
CancelCommitment(bytes32 commitmentHash, uint256 expiry)
```

`expiry` is unix seconds, capped at **1 hour** in the future. The cancel is a one-shot action — a long replay window has no upside.

**Domain** — same as `OspexCommitment`:
- `name`: `"Ospex"`
- `version`: `"1"`
- `chainId`: `137` (Polygon mainnet) or `80002` (Amoy)
- `verifyingContract`: `MatchingModule` address

The signer's identity is recovered from the signature alone — there is no `maker` field in the typed data. The handler authoritatively compares the recovered address to the looked-up commitment's `maker` column.

**Path vs payload guard.** The URL `:hash` and the signed `commitmentHash` must match. A mismatch returns `400 INVALID_PARAM` so a stolen signature can't be redirected to a different hash by editing the URL.

**Status responses**

| HTTP | `code` | When |
|---|---|---|
| `200` | — | Success. Returns the canonical commitment body with `status: "cancelled"`. Same shape as POST/GET. |
| `200` | — | Idempotent — already `cancelled`. Returns the existing row unchanged. |
| `400` | `INVALID_PARAM` | Malformed URL hash, malformed signed action, expired/too-far-out signature, or path-vs-payload hash mismatch. |
| `401` | `AUTH_INVALID` | Signature didn't recover (malformed, wrong domain, wrong chain). |
| `403` | `FORBIDDEN` | Recovered signer doesn't match the commitment's maker. |
| `404` | `NOT_FOUND` | No commitment with that hash on the configured network. |
| `409` | `COMMITMENT_MATCHED` | `status` is `filled` or `partially_filled` — off-chain cancel is not allowed once a match exists. Use the on-chain path. |
| `409` | `INVALID_STATE` | Row is in some other unexpected status. |
| `429` | `RATE_LIMIT_EXCEEDED` | Same 60/min/IP cap as POST. |
| `500` | `INTERNAL_ERROR` | Supabase failure. |

**Authoritative cancel is still on-chain.** This endpoint is the "remove from order book" signal. A taker who runs their own node and sees the on-chain commitment can still try to match it; they'd burn gas calling `MatchingModule.matchCommitment`, but the contract has no record of the off-chain cancel and would accept the match if the signature, nonce floor, and expiry all check out.

If you're worried about a determined taker filling a commitment after you've signaled cancel off-chain, escalate to the on-chain path.

## On-chain cancel — `MatchingModule.cancelCommitment(c)`

Authoritative. Only the maker can call this — `msg.sender == commitment.maker` is the sole access check. The function takes the full `OspexCommitment` struct, hashes it (`_hashCommitment`), and:

1. Sets `s_cancelledCommitments[commitmentHash] = true` in module storage.
2. Emits `CommitmentCancelled` (local) and `COMMITMENT_CANCELLED` via `OspexCore.emitCoreEvent()`.

There is no signature verification, no fill-record check, and no "allowed canceller" role — `cancelCommitment` reverts with `MatchingModule__NotCommitmentMaker` if anyone other than the maker calls it. Implementation: `MatchingModule.sol:335-369`.

Once `s_cancelledCommitments[hash] = true`, `MatchingModule.matchCommitment` reverts at `MatchingModule.sol:490` if a taker tries to match the cancelled hash. The indexer's `handleCommitmentCancelled` (`ospex-indexer/src/handlers/commitments.ts`) projects the `COMMITMENT_CANCELLED` event to `commitments.status = 'cancelled'`.

**Use this when:**
- The commitment has been partially matched (`partially_filled`) and you want to prevent further matches.
- You don't trust the relay / off-chain book to honor a DELETE — e.g., you're a taker discovering a stale signed commitment off-chain and you want to ensure no one can fill it.
- You've signed a commitment but never POSTed it to the API; on-chain cancel is the only way to invalidate it (no off-chain row exists to DELETE).
- You want a definitive cancel that closes the divergence window described below.

## Bulk cancel — `MatchingModule.raiseMinNonce(...)`

Cheapest way to wipe many commitments on the same speculation. The maker calls:

```solidity
raiseMinNonce(uint256 contestId, address scorer, int32 lineTicks, uint256 newMinNonce)
```

The contract computes `speculationKey = keccak256(abi.encode(contestId, scorer, lineTicks))` and bumps `s_minNonces[msg.sender][speculationKey]` to `newMinNonce`. Every signed commitment by that maker on that speculation with `nonce < newMinNonce` becomes unmatchable — the contract rejects them with `NonceTooLow`.

The indexer:
1. Upserts `maker_nonce_floors` (`network`, `maker`, `speculation_key`, `min_nonce`, `source_block`).
2. Best-effort flips affected `commitments` rows to `nonce_invalidated = true` (`UPDATE ... WHERE status IN ('open','partially_filled') AND nonce < newMinNonce`).

`POST /v1/commitments` reads `maker_nonce_floors` and rejects any incoming commitment with `nonce < min_nonce` (HTTP 400, `code: NONCE_TOO_LOW`). `GET /v1/commitments` defaults to excluding `nonce_invalidated` rows from the open book unless `?includeInvalidated=true` is passed.

**Use this when:**
- You want to retract every quote you've made on a specific contest/scorer/line in one transaction.
- You're a market maker rotating quotes and want a clean slate per speculation.

`raiseMinNonce` is monotonic — the new value must strictly exceed the old. There is no `lowerMinNonce` (intentionally — it would re-enable previously-cancelled commitments, which is a footgun).

## Indexer convergence and races

The on-chain cancel path and the off-chain cancel path both write `commitments.status = 'cancelled'`. They're idempotent — the indexer's `handleCommitmentCancelled` UPDATEs to the same terminal value the API just wrote, and vice versa. But they are NOT equivalent: only `s_cancelledCommitments[hash] = true` (set by `MatchingModule.cancelCommitment`) prevents a taker from matching on-chain. An off-chain DELETE leaves the on-chain commitment matchable.

| Sequence | Off-chain `commitments.status` | On-chain matchable? | Notes |
|---|---|---|---|
| DELETE (off-chain) only | `cancelled` | **Yes** | The signature is still valid; `s_cancelledCommitments[hash]` is still false. A taker who has the signature outside the order book can still call `matchCommitment`. |
| `cancelCommitment` (on-chain) only | `cancelled` (after indexer projection) | No | `s_cancelledCommitments[hash] = true` causes `matchCommitment` to revert. |
| DELETE then `cancelCommitment` | `cancelled` | No | Indexer's UPDATE is a no-op. |
| `cancelCommitment` then DELETE | `cancelled` | No | Endpoint returns 200 idempotent. |
| **DELETE then taker calls `matchCommitment`** | `cancelled` (stale `filled_risk_amount`) | n/a — already matched | **Known divergence.** Contract accepts the match (no on-chain cancel was issued). Indexer projects `COMMITMENT_MATCHED`, calls `fill_commitment`, which selects `WHERE status IN ('open', 'partially_filled')` and silently skips the cancelled row. `filled_risk_amount` does NOT advance. The taker's `position_fills` row IS still written (separate code path), so position tracking is correct — only the commitment row's `filled_risk_amount` is wrong. See *Known limitations* below. |
| Taker calls `matchCommitment` then DELETE | depends on indexer lag | n/a | If the indexer projected the match before the DELETE arrives, `status` is `partially_filled`/`filled` and DELETE returns 409. If the indexer hasn't caught up, the DELETE succeeds (status was `open`); the indexer then hits the same `fill_commitment` skip and `filled_risk_amount` stays stale. Same divergence. |
| Reorg drops a `COMMITMENT_CANCELLED` event after on-chain cancel | `cancelled` (off-chain cache) / not cancelled (chain) | depends on reorg outcome | The indexer's recovery pipeline replays from canonical `chain_events`. If the cancel event is no longer canonical, the indexer doesn't re-set `cancelled` — but if `commitments.status` was already `cancelled` (via earlier projection), it isn't reverted either. The on-chain state is authoritative; the off-chain row may need a corrective UPDATE on a follow-up event. This is a separate concern from the off-chain DELETE divergence. |

## Known limitations / divergence

**`commitments.filled_risk_amount` can be stale on cancelled rows.** If an off-chain DELETE lands before a taker's on-chain `matchCommitment`, the contract accepts the match (it has no record of the off-chain cancel), but the indexer's `fill_commitment` PL/pgSQL function (`ospex-indexer/migrations/027_commitment_upsert_on_match.sql:159-198`) restricts its update to `status IN ('open', 'partially_filled')`. The matched amount is silently dropped from the commitment row.

**What still works:** the taker's `position_fills` row is written by a separate handler (`commitment-matched.ts`) and is unaffected. `/v1/positions/:address` continues to surface the actual on-chain position correctly. The `commitments.filled_risk_amount` stale value only affects readers that consume it directly — primarily `/v1/commitments` queries with `?status=cancelled`. The default open-book filter (`status=['open', 'partially_filled']`) excludes cancelled rows, so the typical reader is unaffected.

**Recommended user workaround:** if you need a *definitive* cancel that closes the divergence window, follow the off-chain DELETE with an on-chain `cancelCommitment` call. The on-chain cancel sets `s_cancelledCommitments[hash] = true`, which causes any future `matchCommitment` to revert at `MatchingModule.sol:490` — eliminating the race window entirely.

**Tracked fix:** the cleanest fix is indexer-side — extend `fill_commitment`'s SELECT to include `'cancelled'` and have the CASE flip status back to `partially_filled`/`filled` when an on-chain match lands on a cancelled row. The chain is truth; the off-chain `cancelled` was wishful thinking. This change lives in `ospex-indexer/migrations/` and is out of scope for this PR.

## What this endpoint does NOT do

- It does not submit any on-chain transaction. Authoritative cancel is the maker's responsibility.
- It does not refund or release any USDC approval. Approvals to `PositionModule` remain in place; revoke via the standard ERC-20 path if needed.
- It does not invalidate the EIP-712 signature on-chain. A taker reading the signed commitment from another source could still attempt a match; the off-chain DELETE is a coordination signal, not cryptographic invalidation.
- It does not bulk-cancel by speculation. Use `raiseMinNonce`.
