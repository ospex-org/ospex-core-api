# Commitment Cancel Flow

There are three ways to cancel an EIP-712 commitment in Ospex. Two are on-chain (authoritative), one is off-chain (signal only). Pick by what you actually need to invalidate and how much you trust the off-chain order book.

## TL;DR

| Method | Where | Effect | When to use |
|---|---|---|---|
| `DELETE /v1/commitments/:hash` | Off-chain, signed | `commitments.status = 'cancelled'` so takers stop seeing it | The default. The commitment hasn't been matched yet and you just want to retract it. |
| `MatchingModule.cancelCommitment(c)` | On-chain | Emits `COMMITMENT_CANCELLED`. Indexer projects to `commitments.status = 'cancelled'`. | The commitment was partially matched, OR you don't trust the off-chain book to honor the DELETE. |
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

Authoritative. The maker (or the contract's allowed canceller) calls `cancelCommitment` with the full `OspexCommitment` struct. The contract:

1. Verifies the commitment hash matches a recorded fill record (if partially filled), or the signature (otherwise).
2. Marks the commitment as cancelled in `s_commitmentState`.
3. Emits `COMMITMENT_CANCELLED` via `OspexCore.emitCoreEvent()`.

The indexer's `handleCommitmentCancelled` (`ospex-indexer/src/handlers/commitments.ts`) projects this to `commitments.status = 'cancelled'`, regardless of off-chain state.

**Use this when:**
- The commitment has been partially matched (`partially_filled`) and you want to prevent further matches.
- You don't trust the relay / off-chain book to honor a DELETE — e.g., you're a taker discovering a stale signed commitment off-chain and you want to ensure no one can fill it.
- You've signed a commitment but never POSTed it to the API; on-chain cancel is the only way to invalidate it (no off-chain row exists to DELETE).

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

All three paths converge on `commitments.status = 'cancelled'` (or `nonce_invalidated = true` for the bulk path). The indexer does not roll back an off-chain DELETE — even if the row was already `cancelled` due to off-chain action, the indexer's own UPDATE on `COMMITMENT_CANCELLED` is a no-op write of the same value, FK-safe and idempotent.

| Sequence | End state |
|---|---|
| DELETE (off-chain) → COMMITMENT_CANCELLED (on-chain) | `cancelled`. Indexer UPDATE is a no-op. |
| COMMITMENT_CANCELLED (on-chain) → DELETE (off-chain) | `cancelled`. Endpoint returns 200 idempotent. |
| DELETE (off-chain) while taker has in-flight `matchCommitment` | If the on-chain match lands first, indexer flips status to `partially_filled` / `filled`. The DELETE then sees that status and returns 409. The CAS guard (`UPDATE ... WHERE status='open'`) prevents accidentally overwriting a matched row. |
| Reorg drops a `COMMITMENT_CANCELLED` event after off-chain DELETE | Off-chain cancel persists. Indexer's recovery pipeline replays from canonical `chain_events`; if the cancel event is no longer in the canonical chain, the indexer doesn't re-cancel — but the off-chain `cancelled` status stays. The off-chain DELETE is non-authoritative *for on-chain settlement*, but it's authoritative *for the order book*. This is the intended divergence. |

## What this endpoint does NOT do

- It does not submit any on-chain transaction. Authoritative cancel is the maker's responsibility.
- It does not refund or release any USDC approval. Approvals to `PositionModule` remain in place; revoke via the standard ERC-20 path if needed.
- It does not invalidate the EIP-712 signature on-chain. A taker reading the signed commitment from another source could still attempt a match; the off-chain DELETE is a coordination signal, not cryptographic invalidation.
- It does not bulk-cancel by speculation. Use `raiseMinNonce`.
