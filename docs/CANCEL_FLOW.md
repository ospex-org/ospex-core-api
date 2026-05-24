# Commitment Cancel Flow

There are three ways to cancel an EIP-712 commitment in Ospex. Two are on-chain (authoritative), one is off-chain (signal only). Pick by what you actually need to invalidate and how much you trust the off-chain order book.

## TL;DR

| Method | Where | Effect | When to use |
|---|---|---|---|
| `DELETE /v1/commitments/:hash` | Off-chain, signed | Sets `commitments.book_visible = false` so takers stop seeing it on the order book; leaves `status` (canonical on-chain lifecycle) untouched. Does NOT prevent on-chain matching by anyone holding the signature. | The default. The commitment hasn't been matched yet and you just want to retract it from the book. |
| `MatchingModule.cancelCommitment(c)` | On-chain | Sets `s_cancelledCommitments[hash] = true` so any future `matchCommitment` call reverts. Indexer projects `COMMITMENT_CANCELLED` to `commitments.status = 'cancelled'`. | The definitive cancel. Use when the commitment was partially matched, when you don't trust the order book, or when you need a cancel that makes the commitment unmatchable on-chain (not just hidden from the book). |
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
| `200` | — | Success. Sets `book_visible=false`; returns the canonical commitment body — effective `status: "cancelled"`, `storedStatus: "open"`, `bookVisible: false`. Same shape as POST/GET. |
| `200` | — | Idempotent — already hidden (`book_visible=false`) or already on-chain `cancelled`, **even if the row has since matched on-chain** (the body's `storedStatus` / `bookVisible` / fill fields carry the real state). Returns the existing row unchanged. |
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
- You want a definitive cancel that makes the commitment unmatchable on-chain — an off-chain DELETE only hides it from the book.

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

The on-chain cancel path writes `commitments.status = 'cancelled'` (authoritative). The off-chain DELETE writes `book_visible = false` and leaves `status` untouched. They are now **different columns**, which removes the `filled_risk_amount` divergence that used to occur when an off-chain cancel raced an on-chain match (see *Known limitations*). Only `s_cancelledCommitments[hash] = true` (set by `MatchingModule.cancelCommitment`) prevents a taker from matching on-chain; an off-chain DELETE leaves the on-chain commitment matchable.

| Sequence | `status` | `book_visible` | On-chain matchable? | Notes |
|---|---|---|---|---|
| DELETE (off-chain) only | `open` | `false` | **Yes** | Signature still valid; `s_cancelledCommitments[hash]` false. Hidden from the book, matchable by anyone holding the signature. Effective API `status` = `cancelled`. |
| `cancelCommitment` (on-chain) only | `cancelled` | `false` | No | `s_cancelledCommitments[hash] = true` reverts `matchCommitment`. Indexer sets both `status='cancelled'` and `book_visible=false`. |
| DELETE then `cancelCommitment` | `cancelled` | `false` | No | DELETE hides; the on-chain cancel then flips `status` to `cancelled`. |
| `cancelCommitment` then DELETE | `cancelled` | `false` | No | Endpoint returns 200 idempotent (already `cancelled`). |
| **DELETE then taker calls `matchCommitment`** | `partially_filled`/`filled` | `false` | n/a — matched | **No divergence.** The row is still `open` when the match lands, so `fill_commitment` applies it and advances `filled_risk_amount` normally; `book_visible` stays `false`, so the hidden remainder is correctly off the public book. A retry DELETE on this hidden row returns `200` idempotent (already hidden). |
| Taker calls `matchCommitment` then DELETE | `partially_filled`/`filled` | unchanged | n/a | If the indexer projected the match first, DELETE returns 409. If the indexer lags (row still `open`), DELETE sets `book_visible=false`; the later match still applies because `status` was `open`. Either way `filled_risk_amount` is correct. |
| Reorg drops a `COMMITMENT_CANCELLED` after on-chain cancel | depends on reorg | per rebuild | depends | The recovery pipeline replays from canonical `chain_events`. `book_visible` is off-chain and not chain-derived, so a rebuild can't reconstruct it — rebuilt / chain-derived rows default `book_visible=false` (fail closed). See *Known limitations*. |

## Known limitations

**The off-chain-cancel-then-match divergence is fixed.** Before the book-visibility split (indexer migration `049`), off-chain DELETE and on-chain `COMMITMENT_CANCELLED` both wrote `status='cancelled'`. An off-chain DELETE that beat the indexer made `fill_commitment` (gated `WHERE status IN ('open','partially_filled')`) skip the later match, so `filled_risk_amount` went stale while the taker's `position_fills` row was still written. Now the off-chain DELETE only sets `book_visible=false`; the canonical `status` stays `open`, so `fill_commitment` applies the match normally and the commitment row and `position_fills` agree.

**Off-chain book visibility does not survive a chain rebuild.** `book_visible` is off-chain state with no `chain_events` record, so a recovery/reorg rebuild (which reconstructs rows from chain truth) cannot restore a prior off-chain hide. Chain-derived (never-POSTed) and rebuilt rows default `book_visible=false` — fail closed, since such a row is an accounting/projection row that should not be published to the book. A maker whose hidden quote is un-hidden by a rebuild re-hides it on its next reconcile.

**Authoritative cancel is still on-chain.** An off-chain DELETE is a book-visibility signal only. To make a commitment genuinely unmatchable, call `MatchingModule.cancelCommitment(c)` — it sets `s_cancelledCommitments[hash] = true`, reverting any future `matchCommitment` at `MatchingModule.sol:490`.

## What this endpoint does NOT do

- It does not submit any on-chain transaction. Authoritative cancel is the maker's responsibility.
- It does not refund or release any USDC approval. Approvals to `PositionModule` remain in place; revoke via the standard ERC-20 path if needed.
- It does not invalidate the EIP-712 signature on-chain. A taker reading the signed commitment from another source could still attempt a match; the off-chain DELETE is a coordination signal, not cryptographic invalidation.
- It does not bulk-cancel by speculation. Use `raiseMinNonce`.
