# ospex-core-api

Public read API for the Ospex protocol. Reads on-chain state via Supabase (populated by `ospex-indexer`) and exposes it as a versioned REST API at `/v1/*`.

This repo replaces the API surface that used to live inside `ospex-agent-server`. The agent (Michelle/Dan) code has been deprecated; the read endpoints are migrating here so they can evolve independently of any agent code.

## Status

In progress. Working today:

- `/healthz` (liveness), `/readyz` (readiness)
- `POST /v1/commitments` — EIP-712 commitment relay
- `GET /v1/commitments` — list with filters / pagination
- `GET /v1/contests`, `GET /v1/contests/:contestId` — contest list / detail (renamed from `/v1/markets/*`)
- `GET /v1/speculations`, `GET /v1/speculations/:speculationId` — speculation list (filters: `contestId`, `sport`, `status`) / detail (with orderbook + parent contest context)
- `GET /v1/protocol/info` — static protocol metadata
- `GET /v1/positions/:address` — wallet position history
- `GET /v1/positions/:address/status` — categorized active / pendingSettle / claimable
- `GET /v1/positions/:address/claim-params` — ordered `txParams[]` action plan
  (one `claimPosition` step for settled rows; `settleSpeculation` then `claimPosition` for
  rows whose contest is scored but whose speculation is still open)
- `GET /v1/positions/by-tx/:txHash` — parse `PositionFilled` from a tx
- `GET /v1/positions/claim-result/:txHash` — parse `PositionClaimed` from a tx
- `GET /v1/leaderboard` — current active leaderboard
- `GET /v1/schedule?sport=` — upcoming games
- `GET /v1/teams/aliases?sport=` — flat list of team aliases (full name / nickname / abbrev / city) joined to canonical team metadata. Consumed by `@ospex/sdk`'s resolver layer to map free-form `--side` input ("Lakers", "LAL") to a canonical team id when staking a commitment.
- `GET /v1/contests/:contestId/odds` — current upstream reference odds for the contest's underlying game (moneyline / spread / total snapshot from `current_odds`). Per-market response shapes are explicit (no shared "line + away/home" envelope) so consumers can't misread the semantics — see "Odds snapshot" below for the exact shape.
- `GET /v1/analytics/odds-history/:contestId` — opening + current odds for analytics callers (deprecated SDK-internal use; new code should prefer `/contests/:contestId/odds` for current-state reads).
- **Cursor recovery (Phase 1.5):** `?since=<cursor>` recovery mode on `GET /v1/commitments`, `/v1/speculations`, `/v1/contests`; bare `GET /v1/positions` (recovery) alongside the address-scoped snapshot; `GET /v1/fills` (append-only fill events). See "Cursor recovery reads" below.
- **SSE streams (Phase 1.5):** `GET /v1/stream/{commitments,positions,fills,speculations,contests}` — live deltas + cursor catch-up + resync over Server-Sent Events. See "SSE streams" below.
- **Odds stream (Phase 1.5):** `GET /v1/stream/odds?contestId=&market=` — snapshot then live `change`/`refresh` over Server-Sent Events (latest-state, no cursor). See "Odds stream" below.
- `GET /v1/metrics` — operational stream / odds / own-state / connection counters (process-local). See "Metrics" below.
- **Stream auth (M3):** `POST /v1/auth/stream-challenge` + `POST /v1/auth/stream-token` — EIP-712 challenge/response that mints a ~15 min HMAC bearer token, scoped to `{address, audience, chainId}`. Required for the owner-auth `/v1/own-state/*` surfaces landing in M4; the public/anonymous reads above are unchanged.
- **Own-state snapshot (M4a):** `GET /v1/own-state/snapshot?cursor=<opt>` — owner-auth (`Authorization: Bearer <stream-token>`) paged snapshot of the maker's commitments + positions. Returns `{cursor, commitments[], positions[], truncated, positionsTruncated}` per spec §6.1. The composite cursor is the resume point for `/v1/stream/own-state` (M4b) or — when `truncated: true` (commitments-only) — the continuation key for the next page. `positionsTruncated` is the DEGRADED discriminant, decoupled from `truncated`: when `true`, position visibility is PARTIAL. The stream cold-start emits `event: degraded` before `ready` and consumers (SDK / MM) must quote-hold per spec §2.6 and treat owner-state as partial. There is no paging/convergence mechanism that drains positions beyond the actionable cap; the `/v1/positions/:address` REST endpoint provides full history out-of-band for operator tooling. **Passive expiry** (a commitment whose only terminal transition is `expiry <= now`) is NOT emitted by recovery — the indexer doesn't advance `row_updated_at` for time alone, so such rows fall outside both halves of the recovery response. The SDK reducer is responsible for computing effective status locally (same `deriveEffectiveStatus` pattern used by `/v1/commitments`) and pruning any locally-held active commitment whose stored expiry has lapsed; the active set the snapshot returns is authoritative of currently-matchable rows.

Not ported (no R4 analog — see "Position helpers" section below): `/withdraw-params`, `/withdraw-result/:txHash`. Not ported in any batch yet (deferred or out of scope): everything else under `/v1/analytics/*`, `/v1/current-odds*` (the legacy `/v1/current-odds*` paths from agent-server are superseded by the contest-centric `/v1/contests/:contestId/odds`).

## Stack

- Node.js 20+, TypeScript (strict, `exactOptionalPropertyTypes`)
- Express 5
- Supabase (`@supabase/supabase-js`) — the only data layer. **No Firebase.**
- ethers v6 — EIP-712 typed-data hashing / signature recovery
- pino for logs

## Run locally

```bash
yarn install
cp .env.example .env  # fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
yarn typecheck
yarn dev
```

Then:

```bash
curl http://localhost:3000/healthz   # liveness — always 200 if process is up
curl http://localhost:3000/readyz    # readiness — 200 when always-required deps (Supabase + EIP-712 relay env) are wired
```

## Health endpoints

- `/healthz` — **liveness**. The process is up and the event loop is responsive. Always returns 200. Heroku/uptime monitors should target this — restarting the dyno doesn't fix a downstream outage, so we don't fail liveness when Supabase is down.
- `/readyz` — **readiness**. The process is up *and* its required dependencies are reachable. Returns 503 if Supabase is unreachable so traffic routers / smoke tests can avoid sending requests that would fail.

## Endpoints

Most read endpoints share `readRateLimit` (600 req/min per IP); the write endpoint has its own tighter limit. The SSE stream endpoints (`/v1/stream/*`) are intentionally exempt — a stream is one long-lived request, not a burst — and are bounded by a concurrent-connection cap instead (see "SSE streams").

### `POST /v1/commitments`

Accepts a signed EIP-712 `OspexCommitment` from a maker, persists it to Supabase as `status: 'open'`, and returns the stored row. Idempotent on `commitment_hash`: a duplicate post returns 200 with the existing row instead of 409. If a row exists from the indexer (no signature yet), the API enriches it with the maker's signature, full risk amount, nonce, expiry, and speculation key.

Body shape:

```json
{
  "action": {
    "type": "OspexCommitment",
    "maker":        "0x…",
    "contestId":    "1234",
    "scorer":       "0x…",
    "lineTicks":    -35,
    "positionType": 0,
    "oddsTick":     220,
    "riskAmount":   "10000000",
    "nonce":        "1730000000",
    "expiry":       "1735000000"
  },
  "signature": "0x…"
}
```

Notes:
- 9 fields, no `contributionAmount` (R3 cruft).
- `verifyingContract` of the EIP-712 domain is the **MatchingModule**, not OspexCore.
- `riskAmount` must be a multiple of 100 (lot-size aligned).
- `oddsTick` ∈ [101, 10100].
- `expiry` is unix seconds; must be in the future and within ~1 year of now (the upper bound prevents JS `Date` overflow on pathological values).
- `positionType`: 0 = upper (away/over), 1 = lower (home/under).
- Rate-limited at 60 requests/minute per IP.
- The API also pre-checks `maker_nonce_floors` and rejects commitments with `nonce < min_nonce` as `400 NONCE_TOO_LOW` so unfillable orders never reach the open feed.

Responses: `201 Created` on new, `200 OK` on duplicate, `400` for validation, `401 AUTH_INVALID` on signature mismatch, `429`, `500`.

### `GET /v1/commitments`

List commitments, sorted by `created_at DESC, commitment_hash ASC` (newest first; tie-break on hash so offset-based pagination is deterministic — note that rows backfilled by indexer migration 039 share a timestamp).

The default response is **the matchable open book**: still-fillable commitments that a taker could `matchCommitment` against right now. Power users can opt back into invalidated / expired / non-default-status rows via the flags below. Off-book (hidden) rows are excluded unconditionally — the legacy `?includeHidden=true` opt-in was removed (M2). Makers retrieve their own hidden rows via the owner-auth own-state surface (M4, landing alongside M2 in the integrated migration cutover).

Every returned commitment carries two status fields: **`status` is the _effective_ lifecycle status** and **`storedStatus`** is the raw on-chain lifecycle value the indexer/relay recorded. Effective status folds in what the contract enforces at match time but the indexer never writes as an event, plus off-chain book visibility: a stored `open`/`partially_filled` row past its `expiry` reports `status: 'expired'`; a nonce-invalidated row, or one the maker hid from the book via an off-chain `DELETE` (`bookVisible: false`), reports `status: 'cancelled'` (the row may still be matchable on-chain — read `storedStatus`/`bookVisible` for chain truth). `filled` and `cancelled` stay terminal. The `status`, `includeExpired`, and `includeInvalidated` query params filter on the **stored** value + the expiry / nonce columns (which keeps pagination and `total` exact); the effective lifecycle is read off the response `status` (notably on get-by-hash and on `include*` results). Off-book (hidden) rows are filtered out of the list unconditionally — there is no longer an `includeHidden` opt-in (see "Hidden-row redaction" below).

Query params:
| Param | Notes |
|---|---|
| `maker` | optional — filter by maker address |
| `contestId` | optional — filter by contest |
| `scorer` | optional — filter by scorer address |
| `status` | optional, comma-separated. Filters the **stored** status column. Default `open,partially_filled` (both still fillable — `partially_filled` rows have `remaining_risk_amount > 0`). Any of `open`, `partially_filled`, `filled`, `cancelled`. `expired` is **not** accepted here — it is never a stored value; surface time-expired rows with `includeExpired=true` and read the effective `status` in the response. |
| `includeInvalidated` | optional bool, default `false`. By default, rows where the maker has raised `s_minNonces[maker][speculationKey]` past this commitment's nonce (`nonce_invalidated = true`) are excluded — the contract would reject `matchCommitment` on them. Set `true` to include; included nonce-invalidated rows report effective `status: 'cancelled'` (raw `storedStatus` unchanged). |
| `includeExpired` | optional bool, default `false`. By default, rows whose `expiry` has passed are excluded. Set `true` to include; included past-expiry rows report effective `status: 'expired'`. |
| `includeFillability` | optional bool, default `false`. When `true`, each returned commitment carries an advisory `fillability` object (Layer-D maker-funding signal — see below). Off by default; the response is byte-identical without it. Costs one extra indexed `maker_funding` query per call when enabled. |
| `limit` | optional, default 100, max 1000 |
| `offset` | optional, default 0 |

Response: `{ commitments: CommitmentBody[], pagination: { limit, offset, total, hasMore } }`. Each `CommitmentBody` has the full canonical shape including `status` (effective lifecycle), `storedStatus` (raw indexed value), `bookVisible` (off-chain book visibility), `signature`, `speculationKey`, `nonceInvalidated`, `createdAt`, etc.

#### Hidden-row redaction across anonymous reads (M2)

Anonymous reads of off-book rows (`book_visible=false`) return an **allow-list projection**, not the full body. The projection is enforced at **runtime**: the allow-list is the single source of truth, the wire type is derived from it, and the body is built by projecting the full body through it — so a field can't leak unless it's on the list, regardless of any upstream change. Hidden bodies expose only lifecycle and identity fields and **omit** `signature`, `nonce`, `oddsTick`, `riskAmount`, `remainingRiskAmount`, `lineTicks`, `scorer`, `speculationKey`, and every EIP-712 typed-data field — enough that no anonymous taker can reconstruct a `matchCommitment` transaction against a soft-cancelled order. The two structural discriminants `redacted: true` and `payloadAvailable: false` let consumers branch on the response shape without probing for missing fields.

The projection is the contract for the paths that legitimately surface lifecycle transitions for tracked rows — `GET /v1/commitments/:hash`, `?since=<cursor>` recovery, and the SSE `/v1/stream/commitments` payload. The two **orderbook embeds**, `GET /v1/contests/:contestId` and `GET /v1/speculations/:speculationId`, also route through the same projection as **defense-in-depth** on top of their `book_visible=true` filter: a hidden row that ever slipped past the filter emerges redacted, never as a signed payload. (The contest embed groups commitments by `speculationKey`, which a redacted body lacks, so it **drops** such a row; the speculation embed's flat orderbook **surfaces** it redacted, matching the list/recovery/SSE paths.) The default `GET /v1/commitments` list never serves hidden rows in the first place — the filter excludes them.

With `includeFillability=true`, each `CommitmentBody` also carries a `fillability` object — an **advisory** maker-funding signal derived from the indexer's ~30s `maker_funding` snapshot (the maker's USDC balance + PositionModule allowance vs. their visible committed book risk). It is point-in-time and **never folded into `status`**. Shape: `{ advisory: true, makerFundingStatus: 'fully_backed' | 'overcommitted' | 'unknown' | 'stale', orderIndividuallyBackedNow, makerBookBackedNow, makerBackingWei6, makerVisibleCommittedWei6, makerCoverageRatioBps, checkedAtBlock, stale }`. `makerFundingStatus` is the headline: `unknown` = no snapshot for that maker; `stale` = the snapshot aged past ~120s (the `…BackedNow` booleans are then `null` — a "now" assertion can't be made from old data, though the last-known numbers are still returned). `orderIndividuallyBackedNow` = backing covers THIS order's remaining maker risk; `makerBookBackedNow` = backing covers the maker's WHOLE visible book — a maker can be individually-backed yet overcommitted across their book, which is the "fake liquidity" this surfaces. A `maker_funding` read failure degrades every row to `unknown` rather than failing the list.

### `GET /v1/contests`

List upcoming contests within a configurable time window (default 72h, max 168h).

Query params: `sport` (one of `nba`, `nhl`, `ncaab`, `nfl`, `mlb`), `status`, `window` (hours), `limit` (max 200), `offset`.

Response: `{ contests: ContestListItem[], pagination }`. Each contest has `contestId`, team names, sport, `matchTime`, status, and a list of speculations. Each speculation has `speculationId`, `contestId`, `type` (`moneyline`/`spread`/`total`), `lineTicks` (raw int32, 10x format per the contracts), `line` (`lineTicks / 10`), and for spread also `awayLine` / `homeLine`.

### `GET /v1/contests/:contestId`

Single contest detail. Returns the same shape as a list item, plus an `orderbook` array on each speculation populated with currently fillable commitments. Same default filter as `GET /v1/commitments` (status `open` or `partially_filled`, not invalidated, not expired); each entry has the same wire shape as a commitment from `GET /v1/commitments`. Sorted by `createdAt` ascending; price-aware sorting is a follow-up. The list endpoint `GET /v1/contests` does not populate orderbooks.

Detail-only fields surfaced here (omitted on list rows): `jsonoddsId`, `rundownId`, `sportspageId`, `contestCreator`, `leagueId`, `awayScore`, `homeScore`, `contestCreatedAt`, `verifiedAt`, `scoredAt`, `voidedAt`, plus `awayTeamId` / `homeTeamId` (UUIDs from the `teams` table, resolved via `contests.network + jsonodds_id → games.{home_team_id, away_team_id}`; null when no game linkage exists). The team UUIDs are consumed by `@ospex/sdk`'s resolver layer to scope alias matching to a contest's two teams.

### `GET /v1/contests/:contestId/odds`

Current upstream reference odds for the contest's underlying game. One snapshot read of `current_odds` keyed by the contest's `jsonodds_id`. Distinct from the Realtime subscribe path on the SDK side (`client.odds.subscribe(...)`) — the snapshot is "what are the odds right now?", subscribe is "stream me changes."

**Source labelling**: this is upstream/reference odds (what the broader market is pricing the game at, via `ospex-writer`), NOT Ospex liquidity. Consumers should label it that way to users — the SDK + CLI surfacing this endpoint do.

Response shape:

```jsonc
{
  "contestId": "42",
  "jsonoddsId": "jo-abc-123",  // null when contest has no upstream linkage
  "odds": {
    "moneyline": { "market": "moneyline", "awayOddsAmerican": 145, "homeOddsAmerican": -180,
                   "upstreamLastUpdated": "...", "pollCapturedAt": "...", "changedAt": "..." } | null,
    "spread":    { "market": "spread", "awayLine": 3.5, "homeLine": -3.5,
                   "awayOddsAmerican": -110, "homeOddsAmerican": -110, ...timestamps } | null,
    "total":     { "market": "total", "line": 8.5,
                   "overOddsAmerican": -105, "underOddsAmerican": -115, ...timestamps } | null
  }
}
```

**Per-market shapes are explicit** so callers can't misread the semantics:

- **moneyline** carries `awayOddsAmerican` / `homeOddsAmerican` only. No `line` field — moneyline is line-less.
- **spread** carries both `awayLine` and `homeLine` — they're always negations of each other (`awayLine = -homeLine`). No generic un-labelled `line` field, because the writer's raw `current_odds.line` column stores the *home* team's spread (negative if home favored), and a single un-labelled value would let callers misalign with `/v1/contests/:contestId` (which exposes both `awayLine` and `homeLine` on each speculation row) or `/v1/analytics/odds-history`.
- **total** carries `line` (over/under threshold, perspective-neutral) and `overOddsAmerican` / `underOddsAmerican`. The writer's storage convention (Over → `away_odds_american`, Under → `home_odds_american`) is hidden — consumers don't see away/home naming on total markets.

**Status codes**:

| Status | Condition |
|---|---|
| 200 (full) | Contest exists, has `jsonoddsId`, `current_odds` has all three markets populated |
| 200 (partial) | Some markets `null` because the writer hasn't populated them for this game |
| 200 (all `null`) | Contest exists but has no upstream `jsonoddsId` linkage, OR no `current_odds` rows for this game |
| 404 | Contest does not exist |
| 400 | `contestId` is non-numeric |
| 500 | `contests` or `current_odds` query errored (logged with `contestId` + `jsonoddsId`) |

`network` is implicit (the API is deployment-bound to one network) and is not duplicated on each market entry. `jsonoddsId` is at the top level only — a snapshot is for one game, so per-market repetition would be noise.

### `GET /v1/speculations`

List speculations across one or more contests.

Query params:

| Name | What it does |
|---|---|
| `contestId` | optional. Fast path — single-table query keyed on the indexed `contest_id` column. |
| `sport` | optional, one of `nba`/`nhl`/`ncaab`/`nfl`/`mlb`. Slower path: resolves to a contest_id list via the `contests` table first. |
| `status` | optional, `open` or `closed`. Filters on `speculations.speculation_status`. |
| `limit` | optional, default 100, max 500. |
| `offset` | optional, default 0. |

Response: `{ speculations: Speculation[], pagination }`. Each `Speculation` carries `speculationId`, `contestId`, `type`, `lineTicks`, `line`, `speculationStatus`, the settlement outcome `winSide` / `settledAt` / `voided`, and (for spread) `awayLine`/`homeLine`. List rows do NOT include `orderbook` — fetch the detail endpoint for that.

Settlement fields:

- `speculationStatus` — `0` = open (taking commitments), `1` = closed (settled on-chain via `settleSpeculation`). Maps directly from `speculations.speculation_status`, which flips to `closed` only at settle time — never at contest-score time.
- `winSide` — the settled outcome, or `null` while open. One of `away`/`home` (moneyline, spread), `over`/`under` (total), `push`, or `void`. This is the authoritative on-chain `WinSide`; for spread/total/push/void it cannot be recomputed client-side from scores alone. **Invariant: `speculationStatus === 1` ⟺ `winSide !== null`** — both are projected from the same atomic row (the indexer writes `speculation_status` + `win_side` + `settled_at` in one UPDATE), so a closed speculation always carries its winner.
- `settledAt` — ISO timestamp of the on-chain settlement, or `null` while open.
- `voided` — `true` iff the speculation settled to `void` (equivalently `winSide === 'void'`); surfaced explicitly so consumers needn't special-case the enum value.

(`scoredAt` is a contest-level field — read it from `GET /v1/contests/:contestId` (`scoredAt`), not the speculation.)

Reads `speculations.market_type` directly; does not depend on the `SCORER_*_ADDRESS` env vars.

### `GET /v1/speculations/:speculationId`

Single speculation detail with the orderbook of currently fillable commitments and a small parent-contest context block.

Response: `Speculation` (as above) plus:

- `orderbook: Array<CommitmentBody | CommitmentHiddenBody>` — same default filter as `GET /v1/commitments` (open/partially_filled, not invalidated, not expired), keyed on the speculation's `speculation_key`. In normal operation every entry is a full `CommitmentBody`; the union is defense-in-depth — a hidden row that ever slipped past the `book_visible=true` filter surfaces as a redacted body (`redacted: true`, `payloadAvailable: false`), matching the list/recovery/SSE redaction paths (see "Hidden-row redaction" above).
- `contest: { contestId, awayTeam, homeTeam, awayTeamId, homeTeamId, sport, matchTime, status }` — keeps the response useful without a second fetch. `awayTeamId` / `homeTeamId` are UUIDs from the `teams` table (resolved via the `games` join — null when no game linkage exists). Source hashes / scores / lifecycle timestamps stay on the contest detail endpoint.

### `GET /v1/protocol/info`

Static metadata: name, network, chainId, contract addresses (matchingModule, scorers), supported sports, fees.

### Position helpers

#### `GET /v1/positions/:address`

Paginated position history for a wallet. Returns positions with `riskAmountUSDC`, `profitAmountUSDC`, `claimed`, `positionType` (0|1), and totals (`totalCount`, `totalRiskUSDC`, `totalProfitUSDC`, `activeCount`).

Query params: `limit` (max 200), `offset`.

#### `GET /v1/positions/:address/status`

Returns the wallet's unclaimed positions split into three buckets:

- **`active`** — speculation still open AND parent contest not yet `Scored`. Nothing the user can do yet.
- **`pendingSettle`** — speculation still open but the parent contest's `contest_status = 'scored'` on-chain. Anyone can call `SpeculationModule.settleSpeculation(speculationId)` (permissionless) to finalize, after which the position becomes claimable. Predicted-loser rows are filtered out (settling them would just expose `NoPayout` on the subsequent `claimPosition`).
- **`claimable`** — speculation closed (already settled), position has non-zero expected payout.

Each entry has `positionId`, `speculationId`, `positionType`, `team`, `opponent`, `market`, `oddsDecimal`, `riskAmountUSDC`, `profitAmountUSDC`. **Claimable** entries also have `result` (`won`/`push`/`void`), `estimatedPayoutUSDC` (full precision, no rounding), and `estimatedPayoutWei6` (raw uint256-as-string). **PendingSettle** entries carry the same `result` / `estimatedPayoutUSDC` / `estimatedPayoutWei6` fields plus `predictedWinSide` (`away`/`home`/`over`/`under`/`push`) — derived off-chain by replaying the on-chain scorer logic against `contests.{away_score, home_score}` and `speculations.line_ticks`. Once `settleSpeculation` runs the on-chain `winSide` will match.

Top-level `totals` mirrors all three buckets:

| Field | What it sums |
|---|---|
| `activeCount` | rows in `active` |
| `pendingSettleCount` | rows in `pendingSettle` |
| `claimableCount` | rows in `claimable` |
| `estimatedPayoutUSDC` / `estimatedPayoutWei6` | claimable-only payouts (ready to sweep right now) |
| `pendingSettlePayoutUSDC` / `pendingSettlePayoutWei6` | pendingSettle-only predicted payouts (require an extra `settleSpeculation` call before they materialize) |

Wei6 totals are aggregated in bigint to avoid float-rounding loss across many rows; the USDC float is the bigint sum divided by 1e6. Capped at 200 unclaimed positions per address (matches agent-server behavior).

Filtering matches the contract exactly: `claimPosition` reverts only when `riskAmount == 0 || payout == 0` (`PositionModule.sol:367-370`). The filter is done in wei6 (bigint), so sub-cent payouts that ARE claimable on-chain still appear in the response. Lost positions are excluded (the contract would revert with `NoPayout`); positions on still-open speculations whose parent contest is not yet scored go in `active`. There is no `withdrawable` bucket — see note below.

This endpoint reads `speculations.market_type` and `contests.{contest_status, away_score, home_score}` directly (all populated by the indexer) and does not depend on the `SCORER_*_ADDRESS` env vars — those are only required for `POST /v1/commitments`.

#### `GET /v1/positions/:address/claim-params`

Returns ready-to-sign tx params for every claimable AND pendingSettle position. R4 `claimPosition` takes `(speculationId, positionType)` — no `oddsPairId` (the R3 field is gone in R4 since positions are uniquely identified by `(speculationId, user, positionType)`).

Same filter / market_type / scorer-replay semantics as `/status` above.

Response shape:

```json
{
  "address": "0x…",
  "positions": [
    {
      "positionId":           "42_0x…_0",
      "speculationId":        "42",
      "description":          "Lakers moneyline — Won (≈ $191.00)",
      "bucket":               "claimable",
      "result":               "won",
      "estimatedPayoutUSDC":  191,
      "estimatedPayoutWei6":  "191000000",
      "txParams": [
        { "method": "claimPosition", "target": "PositionModule",
          "args": { "speculationId": "42", "positionType": 0 } }
      ]
    },
    {
      "positionId":           "99_0x…_1",
      "speculationId":        "99",
      "description":          "Celtics moneyline — Won (≈ $50.00, needs settle)",
      "bucket":               "pendingSettle",
      "result":               "won",
      "estimatedPayoutUSDC":  50,
      "estimatedPayoutWei6":  "50000000",
      "txParams": [
        { "method": "settleSpeculation", "target": "SpeculationModule",
          "args": { "speculationId": "99" } },
        { "method": "claimPosition",     "target": "PositionModule",
          "args": { "speculationId": "99", "positionType": 1 } }
      ]
    }
  ]
}
```

`txParams` is **always an array** — `claimable` rows have a single `claimPosition` step; `pendingSettle` rows lead with `settleSpeculation` (permissionless, any EOA) and then `claimPosition`. Consumers MUST execute the steps in array order; later steps depend on earlier ones (a `claimPosition` call would revert with `NotSettled` if the preceding `settleSpeculation` hasn't yet landed). `target` is a stable label the consumer maps to the deployed contract address per chain — the API never returns raw contract addresses here so address rotations don't ripple through every consumer. Claimable rows are listed first (single tx, faster to execute), then pendingSettle rows.

The `description` field shows `"<$0.01"` for sub-cent expected payouts so it doesn't misleadingly round to `$0.00`. PendingSettle descriptions append `, needs settle` so the wording differentiates the two buckets when rendered in a CLI / dashboard.

#### `GET /v1/positions/by-tx/:txHash`

Parses the R4 `PositionFilled(speculationId, maker, taker, makerPositionType, takerPositionType, makerRisk, takerRisk)` event from a tx receipt. Each fill creates **two** position rows (maker + taker) so the response returns both as a single array. If `POSITION_MODULE_ADDRESS` is set, only logs from that contract are decoded; otherwise any log matching the event topic is decoded.

Requires `ALCHEMY_RPC_URL`.

#### `GET /v1/positions/claim-result/:txHash`

Parses `PositionClaimed(speculationId, user, positionType, payout)`. Returns the speculation, user, position type, and payout (both as wei6 string and USDC float).

Requires `ALCHEMY_RPC_URL`.

#### Not ported — `/withdraw-params`, `/withdraw-result/:txHash`

R4 has no `adjustUnmatchedPair` method or `PositionAdjusted` event. The R3 helper let a user pull back an unmatched stake on a position; in R4 positions are always fully matched at fill time and "unmatched" lives on the `commitments` table instead.

The R4 analog of "withdraw your unfilled stake" is "cancel your open commitment" via `MatchingModule.cancelCommitment(commitment)`. Consumers can build that call directly from the existing `GET /v1/commitments?maker=…` response — every commitment row carries the 9 fields needed. So no helper endpoint is required. A future `GET /v1/commitments/cancel-result/:txHash` (parsing `CommitmentCancelled`) could be added if needed.

### `GET /v1/leaderboard`

Current active leaderboard (the soonest-ending one whose start has passed) with paginated, descending-by-bankroll registrations.

Query params: `limit` (max 500), `offset`.

### `GET /v1/schedule?sport=`

Upcoming games within `windowHours` (default 36, max 168). Returns games with team names resolved from the `teams` table.

Out of scope for this batch: best-effort merge with on-chain `contests` (so each game can flag whether it has a contest). Callers can cross-check by team-name against `GET /v1/contests` (or, for free-form input, use `GET /v1/teams/aliases` plus a contest's `awayTeamId` / `homeTeamId`).

### `GET /v1/teams/aliases`

Flat list of every row in the `team_aliases` table joined to canonical team metadata from the `teams` table. Network-agnostic — `team_aliases` and `teams` are sports-reference data shared across networks.

Closes the `resolveTeam` gap historically called out in this file. The legacy resolver lived in deprecated `ospex-agent-server` and never migrated; consumers (notably the SDK's commitment resolver layer) now read aliases from this endpoint instead of re-implementing.

Query params:

| Name | What it does |
|---|---|
| `sport` | optional, one of `mlb`/`nba`/`ncaab`/`ncaaf`/`nfl`/`nhl`. Validated against the shared sport constant (`src/lib/sports.ts`). |
| `limit` | optional, default 1000, max 1000 (matches the underlying PostgREST per-request row cap). |
| `offset` | optional, default 0. |

Response:

```json
{
  "aliases": [
    {
      "teamId": "<uuid>",
      "sport": "nba",
      "sportId": 1,
      "teamName": "Los Angeles Lakers",
      "abbrev": "LAL",
      "alias": "Lakers",
      "aliasType": "nickname",
      "source": "manual"
    }
  ],
  "pagination": { "limit": 1000, "offset": 0, "total": 1846, "hasMore": true }
}
```

`team_aliases` stores `sport_id` (smallint) but not `sport` (text). The handler joins through `teams` so callers don't have to maintain their own sport_id ↔ sport mapping.

Pagination caveat: PostgREST returns at most 1000 rows per request, so `limit` is capped at 1000 — the table is ~1300+ rows, and a larger advertised limit would silently truncate while still echoing the requested limit in `pagination.limit`, causing naive `offset += pagination.limit` clients to skip rows. SDK consumers should paginate until `hasMore: false`.

### Cursor recovery reads (Phase 1.5)

The catch-up side of the push contract. A client streams live deltas (SSE — see "SSE streams") and, after a disconnect, asks for everything after its last cursor. These reads are intentionally distinct from the open-book list/snapshot endpoints above.

- **Ordering** is keyset `(row_updated_at, id)` ascending — not offset. `row_updated_at` is trigger-maintained on every UPDATE, so a stored `open → filled/cancelled`, a `settleSpeculation`, or a `claimPosition` advances it and surfaces here. The `id` tie-breaker means same-millisecond updates are never skipped.
- **Includes terminal rows.** Recovery does NOT apply the open-book `status`/`expiry`/`nonce_invalidated` defaults — a commitment that went `filled`/`cancelled`, or a speculation that `settled`, must surface so a client converges its local state.
- **Filters are identity/scope only** (e.g. `maker`, `contestId`, `scorer`, `speculationId`, `address`), not lifecycle-status.
- **Cursor is opaque.** Treat `nextCursor` as a blob and pass it back as `?since=`; it embeds the resource so a cursor from one stream can't be used on another (400 `INVALID_CURSOR`).
- **Convergence vs events.** For mutable rows (commitments/positions/speculations/contests) this is ordered state-delta *convergence* — a row that changed several times while you were away may surface only at its latest state. `position_fills` is the only append-only, event-like stream (`/v1/fills`), where every row is delivered; dedupe client-side on `(txHash, logIndex)`.
- **Resume vs paging (late-commit safety).** Cursors are kind-tagged. A `live` cursor — minted at the stream tail / snapshot tip — makes recovery re-scan an **overlap window**: it queries from `cursor.ts − overlap` (default 30s) so a row committed late under the `now()`-is-transaction-start schema isn't skipped on reconnect. Every `nextCursor` is a `page` cursor (strict keyset on its own `(row_updated_at, id)`), so paging through a backlog terminates regardless of overlap size. The id tie-breaker means same-millisecond rows are never skipped; the overlap re-scan can re-deliver a row already returned, so apply rows idempotently by natural key (commitment hash, speculation id, etc.).

Common response envelope: `{ <resource>: [...], nextCursor: string | null, hasMore: boolean }`. `hasMore` is true when a full `limit` page came back; an empty page echoes the input cursor so the client holds position. `limit` defaults to 100, max 1000.

| Endpoint | Resource | Filters (all optional) |
|---|---|---|
| `GET /v1/commitments?since=` | commitments | `maker`, `contestId`, `scorer`, `speculationId` |
| `GET /v1/positions?since=` | positions | `address`, `speculationId` |
| `GET /v1/fills` | position_fills (events) | `maker`, `taker`, `speculationId`, `contestId`, `commitmentHash` |
| `GET /v1/speculations?since=` | speculations | `contestId` |
| `GET /v1/contests?since=` | contests | `contestId` |

On the mutable-row endpoints, `?since=` *switches* the endpoint into recovery mode; without it they behave exactly as documented above (open-book list / window). `GET /v1/positions` (bare) and `GET /v1/fills` are recovery-native (cursor optional — absent means "from the beginning", paged).

### SSE streams (Phase 1.5)

`GET /v1/stream/:resource` (`resource` ∈ `commitments | positions | fills | speculations | contests`) opens a [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) stream — the live, push side of the contract. One internal poller per resource fans deltas out to every connected client: many agents subscribe, but each resource is polled once per tick (the N→1 collapse that keeps a busy fleet off the DB).

Connect, e.g. `GET /v1/stream/fills?maker=0x…&cursor=<opaque>`:
- **Filters** (identity/scope, all optional) match the recovery table above — commitments: `maker`/`contestId`/`scorer`; positions: `address`/`speculationId`; fills: `maker`/`taker`/`speculationId`/`contestId`/`commitmentHash`; speculations/contests: `contestId`. (`speculationId` on commitments is recovery-REST-only.) Unknown `:resource` → 404.
- **`cursor`** (optional, opaque): the resume point. With it the server replays missed deltas (catch-up) before going live; without it, snapshot first via the REST endpoints, then stream.

Events:
- `event: delta` — `id:` is the opaque cursor; `data:` is the same body shape as the REST recovery/snapshot for that resource. (On `/v1/stream/commitments`, hidden rows arrive in the redacted allow-list projection — see the "Hidden-row redaction" subsection above; the data shape is allow-list-only for those rows.) The cursor is an **opaque resume token, not a version** — store the last `id` to reconnect, and never decode it. Deltas are **not ordered by cursor** (a row committed late under the `now()`-is-transaction-start watermark can arrive after a newer one), so apply **last-received-wins**: process deltas in the order received and overwrite per natural key. The poller re-reads current DB state every tick, so the most recently received delta for an entity reflects its most recent read — a late update is re-emitted by the overlap re-scan and supersedes the stale one because it arrives later. (`position_fills` is append-only — apply every event; dedupe by `(txHash, logIndex)`.)
- `event: ready` — **catch-up complete and this connection is live.** Emitted exactly once, and only on a clean handoff: catch-up finished AND no live delta or resync raced it. So at `ready` the client's state equals the DB state catch-up observed. A `resync` is never followed by `ready` on the same connection.
- `event: resync` (`data: { reason }`) — **re-snapshot.** Fires when: a reorg/backfill recovery completes upstream (recovery hard-deletes rows, which polling can't observe); the catch-up backlog was too large to replay; or **a live delta/resync raced the cursor catch-up** (`reason: "handoff_raced"`). On a raced handoff the server emits one `resync` and closes the connection — the client should re-snapshot and reconnect. (See "Reconnect".)
- `: hb` comment heartbeats (~20s) keep the connection under the platform idle timeout.

Operational notes:
- **Reconnect** with the last `id` you saw (a live cursor): a native `EventSource` resends it automatically as the `Last-Event-ID` header, or pass it as `?cursor=`. **`Last-Event-ID` takes precedence** over `?cursor=` — on an `EventSource` auto-reconnect the original URL's `?cursor=` is stale, while the header is the true resume point. The server replays missed deltas from there, re-scanning the overlap window so a row committed late under the `now()`-based schema isn't missed, then emits `ready`. **Under concurrent write activity** the cursor handoff conservatively aborts to `resync` rather than risk a stale-at-`ready` merge; on `resync` the client re-snapshots (REST) and reconnects (without a cursor, since the snapshot is current).
- SSE is **exempt from gzip** (compression buffers streams would defeat it) and from the request-rate limiter; a **concurrent-connection cap** (per-IP + total) bounds resource use instead — `429` when full. Of the per-IP budget, `RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER` slots are reserved for the owner-auth own-state stream so anonymous (odds/protocol) saturation from one IP can't 429 a market-maker's safety-critical own-state reconnect. The caps are env-tunable (`MAX_STREAM_CONNECTIONS_TOTAL` / `MAX_STREAM_CONNECTIONS_PER_IP` / `RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER`); the live values show on `GET /v1/metrics`.
- **Graceful shutdown.** On `SIGTERM`/`SIGINT` the server proactively ends open streams — protocol streams get a final `resync` (`reason: "server_shutdown"`) then close — so it drains fast instead of waiting out the shutdown timeout. Reconnect as usual.
- `position_fills` is append-only (every event delivered); the other four are state-delta convergence (latest state per row).
- Backed by the same `(network, row_updated_at, id)` indexes as recovery (indexer migration 048) — apply those before production stream traffic.

### Odds stream (Phase 1.5)

`GET /v1/stream/odds?contestId=<numeric>&market=<moneyline|spread|total>` opens a Server-Sent Events stream of upstream reference odds for a contest's underlying game. Both query params are **required**. This is a separate route from the protocol `/v1/stream/:resource` streams because odds is **latest-state, not a durable log** — there's no cursor, no catch-up replay, and no `Last-Event-ID` resume. The server maintains one internal `current_odds` subscription for the whole process and fans out to every connected client (the N→1 collapse); that internal source stays server-side and the provider game id is **never** on the wire (it's resolved from `contestId` internally).

**Source labelling**: this is upstream/reference odds (what the broader market is pricing the game at, via `ospex-writer`), NOT Ospex liquidity — surface it to users that way.

Events:
- `event: snapshot` — `data: { contestId, market, odds }` where `odds` is the current per-market shape (same shapes as `GET /v1/contests/:contestId/odds` — moneyline / spread / total) or `null` when the writer hasn't populated that market (or the contest has no upstream linkage). It is the baseline you're live from, and is re-sent on recovery. **The server never emits a `change`/`refresh` before a `snapshot`** — if the baseline read fails it retries (staying behind a `degraded`) rather than streaming deltas without a baseline.
- `event: change` — `data: { contestId, market, odds }`. A genuine price move (a tracked column changed, or `changedAt` advanced).
- `event: refresh` — `data: { contestId, market, odds }`. The writer re-polled and saw no price change (liveness). Usually you only care about `change`.
- `event: degraded` — `data: { reason }`. The internal source is behind/unavailable; updates are paused. It can arrive **before** any snapshot (the source was down at connect — you get no baseline until it recovers) or after (the source dropped). The connection stays open; on recovery the server sends a fresh `snapshot` (which fully resyncs, since odds is latest-state) and resumes live.
- `: hb` comment heartbeats (~20s).

Apply semantics:
- **No cursor** — there's no `id:` on these events; don't try to resume with `Last-Event-ID`. On any disconnect, just reconnect; the new connection re-snapshots.
- **Latest-state convergence** — the server only emits a delta whose `pollCapturedAt` is strictly newer than the last one emitted for this stream, so duplicates and out-of-order delivery are already filtered. Treat each `change`/`refresh`/`snapshot` as the current value for `(contestId, market)`.
- Unknown `market` (or non-numeric `contestId`) → `400`; unknown contest → `404`; both *before* the stream opens.
- Same gzip exemption and concurrent-connection cap as the protocol streams (shared budget; `429` when full).
- **Graceful shutdown.** On `SIGTERM`/`SIGINT` the server ends the stream with a final `: server_shutdown` comment (no event — odds is latest-state, so there's no protocol `resync`) then closes. Reconnect re-snapshots as usual.

### `GET /v1/metrics`

Operational counters for the SSE subsystem, surfaced as JSON. Kept separate from `/readyz` so readiness stays a pure up/down dependency check; this is the "how loaded is the stream stack" view. Read-rate-limited like the other `GET /v1/*` endpoints.

```jsonc
{
  "stream": {
    "resources": 0, "subscribers": 0,                  // protocol-stream hub: active pollers + total subscribers
    "resyncBroadcastTotal": 0,                         // cumulative resync broadcasts (overlap-window overflow + recovery)
    "catchupStartedTotal": 0,                          // cumulative SSE handler entries into the catchup phase
    "catchupCompletedTotal": 0,                        // cumulative clean handoffs (`ready` emitted)
    "catchupResyncedTotal": 0                          // cumulative catchup → resync exits (started - completed - resynced ≈ in-flight or disconnected mid-catchup)
  },
  "odds": {
    "subscribers": 0, "channelOpen": false, "subscribed": false, "degraded": false,
    "channelDegradedTotal": 0,                         // cumulative Realtime channel-down events (gated by !degraded; one bump per outage)
    "hardResetTotal": 0                                // cumulative hard-reset backstops fired
  },
  "ownState": {
    "wallets": 0,                                      // own-state hub: active per-wallet pollers
    "subscribers": 0,                                  // total owner-auth own-state subscribers
    "resyncBroadcastTotal": 0                          // cumulative own-state resync broadcasts (overlap-window overflow + recovery)
  },
  "connections": {
    "total": 0, "ips": 0, "maxTotal": 200, "maxPerIp": 10,
    "rejectedTotal": 0,                                // cumulative 429s
    "rejectedByScope": { "ip": 0, "total": 0 },        // 429s split by limiting scope
    "slowClientShedTotal": 0                           // cumulative connections ended for backpressure (outbound buffer > MAX_PENDING_BYTES)
  },
  "uptimeSeconds": 0,
  "timestamp": "..."
}
```

All counters are **process-local and cumulative since process start** (reset on restart) — on a multi-dyno deploy, scrape each dyno rather than going through the load balancer. `connections.maxTotal` / `maxPerIp` echo the active caps (defaults, or the `MAX_STREAM_CONNECTIONS_*` overrides).

## Scripts

| Script | What it does |
|---|---|
| `yarn dev` | Watch + reload via `tsx`, reads `.env` automatically |
| `yarn build` | `tsc` → `dist/` |
| `yarn start` | `node dist/server.js` (production / Heroku) |
| `yarn typecheck` | `tsc --noEmit` |
| `yarn lint` | ESLint over `src/` |

## Environment

See `.env.example`. Required values are validated at boot — missing vars exit with `code 1` immediately, not on first request.

| Var | Required | Notes |
|---|---|---|
| `PORT` | no | Defaults to 3000 |
| `NODE_ENV` | no | Defaults to `development` |
| `LOG_LEVEL` | no | Defaults to `info` (pino levels) |
| `NETWORK` | no | `polygon` or `amoy`, defaults to `polygon` |
| `SUPABASE_URL` | **yes** | |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Bypasses RLS — see conventions |
| `ALCHEMY_RPC_URL` | for `/v1/positions/by-tx/:txHash` and `/v1/positions/claim-result/:txHash` | Polygon RPC endpoint for tx-receipt parsing |
| `MATCHING_MODULE_ADDRESS` | for `POST /v1/commitments` | EIP-712 `verifyingContract`. Format-validated when set. |
| `POSITION_MODULE_ADDRESS` | optional | Defensive log-source filter for tx parsers. When set, by-tx / claim-result only decode logs from this address. Format-validated when set. |
| `SCORER_MONEYLINE_ADDRESS` | for `POST /v1/commitments` | All-or-nothing; partial config rejected at boot |
| `SCORER_SPREAD_ADDRESS` | for `POST /v1/commitments` | |
| `SCORER_TOTAL_ADDRESS` | for `POST /v1/commitments` | |
| `MAX_STREAM_CONNECTIONS_TOTAL` | no | Max concurrent SSE streams process-wide. Positive integer; defaults to 200. Surfaced on `/v1/metrics`. |
| `MAX_STREAM_CONNECTIONS_PER_IP` | no | Max concurrent SSE streams per client IP. Positive integer; defaults to 16. Surfaced on `/v1/metrics`. |
| `RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER` | no | Of the per-IP budget, slots reserved for the owner-auth own-state stream — anonymous streams may use at most `(PER_IP - this)`; own-state may use the full `PER_IP`. **Non-negative integer (`0` is allowed** = no reserve / original single shared pool, anon + own-state share the full `PER_IP`); defaults to 3. Surfaced on `/v1/metrics`. |

## Deployment

Heroku app: `ospex-core-api`. Production URL: `https://ospex-core-api-195f635df864.herokuapp.com/`.

Procfile: `web: node dist/server.js`. Heroku auto-runs `yarn build` (`tsc` → `dist/`) on slug compile.

### Required Heroku config vars

Set via `heroku config:set <var>=<value> --app ospex-core-api`. Mirrors `.env.example`:

- `NETWORK` — `polygon` for production, `amoy` for testnet
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `ALCHEMY_RPC_URL` — Polygon mainnet RPC (PAYG-tier — required by `/v1/positions/by-tx` and `/v1/positions/claim-result`)
- `MATCHING_MODULE_ADDRESS` — R4 matching module; verifying contract for the EIP-712 domain on `POST /v1/commitments` and `DELETE /v1/commitments/:hash`, **and** reused as the verifying contract of the separate `OspexStreamAuth` domain (M3 — see `STREAM_AUTH_*` below). The stream-auth endpoints return `503 NOT_READY` if this is unset
- `SCORER_MONEYLINE_ADDRESS`, `SCORER_SPREAD_ADDRESS`, `SCORER_TOTAL_ADDRESS` — required by `POST /v1/commitments` (all-or-nothing; partial config is rejected at boot)
- `POSITION_MODULE_ADDRESS` — optional defensive log-source filter for tx parsers
- `MAX_STREAM_CONNECTIONS_TOTAL`, `MAX_STREAM_CONNECTIONS_PER_IP`, `RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER` — optional SSE concurrent-connection caps (defaults 200 / 16 / 3); per-IP is per egress host. Co-locating N market makers must satisfy BOTH per-IP constraints: `N·(odds channels + 1) ≤ PER_IP` (overall) **and** `N·(odds channels) ≤ PER_IP − RESERVED` (anonymous odds — usually the binding one, since the reserve shrinks the anon budget below the total cap). E.g. PER_IP=16, reserve=3, N=2, odds=7 passes the overall check (16 ≤ 16) but fails anon (14 > 13), so core-api 429s the 14th odds stream — raise `PER_IP`. The owner-auth reserve keeps anonymous saturation from 429-ing a maker's own-state reconnect (`RESERVED=0` disables it = single shared pool). Set any to tune the stream stack without a code change
- `REDACT_HIDDEN_PUBLIC` — optional bool, **default `true`** (redaction enforced). Short-lived rollout/rollback guard for the M2 hidden-row redaction. Setting `false` reverts every anonymous read path to the legacy "full body for all rows" behavior for a deploy window only; the flag is scheduled for removal post-M7 cutover
- `STREAM_AUTH_HMAC_SECRET` — optional but required by **both** stream-auth POST endpoints AND the `verifyStreamToken` middleware (each returns `503 NOT_READY` if unset). HMAC-SHA256 secret used to sign + verify stream-auth bearer tokens; must be ≥ 32 characters of entropy (boot-time fatal otherwise). Rotation = add a second key and accept both during transition (follow-up; current `kid` is `v1`)
- `STREAM_AUTH_AUDIENCE` — optional but required by both stream-auth POST endpoints (same `503 NOT_READY` rule). The canonical host string bound into both the challenge typed-data and the issued token (e.g. `https://api.ospex.org`); SDK clients derive the same string from their `baseUrl`, so a token minted for one deployment cannot be replayed against another
- `STREAM_CHALLENGE_TTL_SECONDS` — optional, default `180` (3 min). Lifetime of a single-use challenge; **boot-fatal outside [120, 300]** per spec §3.3
- `STREAM_TOKEN_TTL_SECONDS` — optional, default `900` (15 min). Lifetime of an issued bearer token; **boot-fatal outside [60, 1800]**
- `OWN_STATE_SNAPSHOT_MAX_COMMITMENTS` — optional, default `5000` per spec §6.2. Per-page commitments cap for `GET /v1/own-state/snapshot`; **boot-fatal outside [100, 50000]**. SDK pages with `?cursor=` until the response carries `truncated: false`

The stream-auth challenge store is **in-memory, per-process**. A challenge minted on one dyno cannot be consumed on another — fine for the current single-dyno Heroku deployment, but horizontal scale-out requires moving challenges to Redis/Postgres or running with sticky routing first. The endpoint-level `503 NOT_READY` checks are deliberately separate from `/readyz` (next section) — `/readyz` keeps the meaning "the always-required dependencies are reachable", and stream-auth is opt-in at the operator level.

`NODE_ENV=production` and `LOG_LEVEL=info` are recommended. **Do not set `PORT`** — Heroku injects it; setting it as a config var creates a binding mismatch.

### Post-deploy smoke test

```bash
URL=https://ospex-core-api-195f635df864.herokuapp.com
curl -s "$URL/healthz"            # 200 + service / network / chainId
curl -s "$URL/readyz"              # 200 only when supabase.connected and commitments.configured
curl -s "$URL/v1/protocol/info"    # mainnet contract addresses
curl -s "$URL/v1/contests"         # paginated list (empty until indexer ingests data)
```

`/readyz` checks the always-required dependencies: Supabase reachability + EIP-712 relay env config for `POST /v1/commitments`. It does **not** include stream-auth (M3) readiness — those endpoints are opt-in at the operator level and surface their own `503 NOT_READY` per call when `STREAM_AUTH_HMAC_SECRET` / `STREAM_AUTH_AUDIENCE` / `MATCHING_MODULE_ADDRESS` are unset.

## Project conventions

- **Supabase only** — no Firebase, no Firestore, no `firebase-admin`. The `package.json` has zero firebase deps and any PR adding one should be rejected at review.
- **No data-source smuggling** — handlers and their helpers must read from the same data layer. Don't repeat the `positionFetch.ts` pattern from `ospex-agent-server` where a Supabase-looking handler quietly called a Firestore helper.
- **Network-scoped queries** — every Supabase query that hits a network-partitioned table must filter `eq('network', NETWORK)`. The indexer skill in `.claude/skills/indexer/` has the canonical list.
- **Service-role key bypasses RLS** — the server uses `SUPABASE_SERVICE_ROLE_KEY`, which sees every column on every row. Handlers must explicitly select the public columns they intend to expose (`.select('id, name, ...')` not `.select('*')`) and never echo a row directly to the response. Treat raw row shape as private by default.
- **Strict TypeScript** — `any` is an error, unused vars are errors, console is an error (use the pino `logger`). Run `yarn typecheck` before merging.

## Layout

```
src/
  server.ts            # Express app + boot
  lib/
    env.ts             # boot-time env validation, typed Config
    supabase.ts        # lazy-init Supabase client
    logger.ts          # pino
    eip712.ts          # R4 OspexCommitment schema, domain, verify, hash
    rpc.ts             # lazy ethers JsonRpcProvider
    sanitize.ts        # wei6ToUSDC, toISOString
    parseOdds.ts       # American / line parsers
    slugs.ts           # toSlug / fromSlug
    speculation.ts     # scorer ↔ market_type, lineTicksToLine (pure)
    txParams.ts        # numeric primitives for on-chain tx building
    cursor.ts          # opaque (table, row_updated_at, id) recovery cursor codec
    recovery.ts        # ?since= parse + nextCursor helpers for recovery reads
    oddsClassifier.ts  # current_odds change/refresh/none classifier (pure)
  middleware/
    asyncHandler.ts    # error-forwarding wrapper
    errorHandler.ts    # final 500 handler, ApiError shape
    eip712Auth.ts      # per-action signature verifier
    rateLimit.ts       # express-rate-limit instances
  v1/
    router.ts          # versioned router
    commitments.ts     # POST + GET /v1/commitments
    contests.ts        # GET /v1/contests, /:contestId
    speculations.ts    # GET /v1/speculations, /:speculationId
    protocol.ts        # GET /v1/protocol/info
    metrics.ts         # GET /v1/metrics — stream/odds/own-state/connection counters
    positions.ts       # GET /v1/positions (recovery) + /:address + /status,
                       #   /claim-params, /by-tx/:txHash, /claim-result/:txHash
    fills.ts           # GET /v1/fills — append-only fill event recovery
    stream/            # GET /v1/stream/* — SSE
      handler.ts       #   protocol handoff state machine: cap → subscribe → catch-up → (clean? ready : resync)
      hub.ts           #   per-resource poller + fan-out + resync watcher (N→1)
      resources.ts     #   per-resource registry (columns, toBody, filters)
      oddsHandler.ts   #   GET /v1/stream/odds — snapshot + live change/refresh (latest-state)
      oddsHub.ts       #   one current_odds Realtime channel → classify → fan out (N→1)
      sse.ts           #   SSE wire helpers (event/comment frames)
      common.ts        #   shared handler scaffolding (heartbeat/shed consts, 429 acquire)
      connections.ts   #   concurrent-connection caps + graceful-shutdown stream registry
    leaderboard.ts     # GET /v1/leaderboard
    schedule.ts        # GET /v1/schedule
    teams.ts           # GET /v1/teams/aliases
    utils/
      positionFetch.ts # categorize active/pendingSettle/claimable (Supabase-only)
      speculations.ts  # shared Speculation wire shape + row→Speculation converters
      odds.ts          # shared per-market odds shapes + row→shape mapper (REST + stream)
```
