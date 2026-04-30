# ospex-core-api

Public read API for the Ospex protocol. Reads on-chain state via Supabase (populated by `ospex-indexer`) and exposes it as a versioned REST API at `/v1/*`.

This repo replaces the API surface that used to live inside `ospex-agent-server`. The agent (Michelle/Dan) code has been deprecated; the read endpoints are migrating here so they can evolve independently of any agent code.

## Status

In progress. Working today:

- `/healthz` (liveness), `/readyz` (readiness)
- `POST /v1/commitments` — EIP-712 commitment relay
- `GET /v1/commitments` — list with filters / pagination
- `GET /v1/markets`, `GET /v1/markets/:contestId` — market list / detail
- `GET /v1/protocol/info` — static protocol metadata
- `GET /v1/positions/:address` — wallet position history
- `GET /v1/positions/:address/status` — categorized active / claimable
- `GET /v1/positions/:address/claim-params` — txParams for claim calls
- `GET /v1/positions/by-tx/:txHash` — parse `PositionFilled` from a tx
- `GET /v1/positions/claim-result/:txHash` — parse `PositionClaimed` from a tx
- `GET /v1/leaderboard` — current active leaderboard
- `GET /v1/schedule?sport=` — upcoming games

Not ported (no R4 analog — see "Position helpers" section below): `/withdraw-params`, `/withdraw-result/:txHash`. Not ported in any batch yet (deferred or out of scope): `/v1/analytics/*`, `/v1/current-odds*`.

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
curl http://localhost:3000/readyz    # readiness — 200 only if Supabase is reachable
```

## Health endpoints

- `/healthz` — **liveness**. The process is up and the event loop is responsive. Always returns 200. Heroku/uptime monitors should target this — restarting the dyno doesn't fix a downstream outage, so we don't fail liveness when Supabase is down.
- `/readyz` — **readiness**. The process is up *and* its required dependencies are reachable. Returns 503 if Supabase is unreachable so traffic routers / smoke tests can avoid sending requests that would fail.

## Endpoints

All read endpoints share `readRateLimit` (600 req/min per IP); the write endpoint has its own tighter limit.

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

The default response is **the matchable open book**: still-fillable commitments that a taker could `matchCommitment` against right now. Power users can opt back into invalidated / expired / non-default-status rows via the flags below.

Query params:
| Param | Notes |
|---|---|
| `maker` | optional — filter by maker address |
| `contestId` | optional — filter by contest |
| `scorer` | optional — filter by scorer address |
| `status` | optional, comma-separated. Default `open,partially_filled` (both are still fillable — `partially_filled` rows have `remaining_risk_amount > 0`). Any of `open`, `partially_filled`, `filled`, `cancelled`. |
| `includeInvalidated` | optional bool, default `false`. By default, rows where the maker has raised `s_minNonces[maker][speculationKey]` past this commitment's nonce (`nonce_invalidated = true`) are excluded — the contract would reject `matchCommitment` on them. Set `true` to include. |
| `includeExpired` | optional bool, default `false`. By default, rows whose `expiry` has passed are excluded. Set `true` to include. |
| `limit` | optional, default 100, max 1000 |
| `offset` | optional, default 0 |

Response: `{ commitments: CommitmentBody[], pagination: { limit, offset, total, hasMore } }`. Each `CommitmentBody` has the full canonical shape including `signature`, `speculationKey`, `nonceInvalidated`, `createdAt`, etc.

### `GET /v1/markets`

List upcoming markets within a configurable time window (default 72h, max 168h).

Query params: `sport` (one of `nba`, `nhl`, `ncaab`, `nfl`, `mlb`), `status`, `window` (hours), `limit` (max 200), `offset`.

Response: `{ markets: MarketListItem[], pagination }`. Each market has `contestId`, team names, sport, `matchTime`, status, and a list of speculations. Each speculation has `type` (`moneyline`/`spread`/`total`), `lineTicks` (raw int32, 10x format per the contracts), `line` (`lineTicks / 10`), and for spread also `awayLine` / `homeLine`.

### `GET /v1/markets/:contestId`

Single market detail. Returns the same shape as a list item, plus an `orderbook: []` array on each speculation (currently empty — populating from `commitments` is a future-batch task; until then, callers should query `GET /v1/commitments?contestId=...` for the open book).

### `GET /v1/protocol/info`

Static metadata: name, network, chainId, contract addresses (matchingModule, scorers), supported sports, fees.

### Position helpers

#### `GET /v1/positions/:address`

Paginated position history for a wallet. Returns positions with `riskAmountUSDC`, `profitAmountUSDC`, `claimed`, `positionType` (0|1), and totals (`totalCount`, `totalRiskUSDC`, `totalProfitUSDC`, `activeCount`).

Query params: `limit` (max 200), `offset`.

#### `GET /v1/positions/:address/status`

Returns the wallet's unclaimed positions split into `active` (speculation still open) and `claimable` (speculation closed, position has non-zero expected payout). Each entry has `positionId`, `speculationId`, `positionType`, `team`, `opponent`, `market`, `oddsDecimal`, `riskAmountUSDC`, `profitAmountUSDC`. Claimable entries also have `result` (`won`/`push`/`void`), `estimatedPayoutUSDC` (full precision, no rounding), and `estimatedPayoutWei6` (raw uint256-as-string). Totals at the top level mirror this — `estimatedPayoutUSDC` plus `estimatedPayoutWei6` aggregated in bigint to avoid float-rounding loss across many claimable rows. Capped at 200 unclaimed positions per address (matches agent-server behavior).

Filtering matches the contract exactly: `claimPosition` reverts only when `riskAmount == 0 || payout == 0` (`PositionModule.sol:367-370`). The filter is done in wei6 (bigint), so sub-cent payouts that ARE claimable on-chain still appear in the response. Lost positions are excluded (the contract would revert with `NoPayout`); positions on still-open speculations go in `active`. There is no `withdrawable` bucket — see note below.

This endpoint reads `speculations.market_type` directly (populated by the indexer per migration 027) and does not depend on the `SCORER_*_ADDRESS` env vars — those are only required for `POST /v1/commitments`.

#### `GET /v1/positions/:address/claim-params`

Returns ready-to-sign tx params for every claimable position. R4 `claimPosition` takes `(speculationId, positionType)` — no `oddsPairId` (the R3 field is gone in R4 since positions are uniquely identified by `(speculationId, user, positionType)`).

Same filter / market_type semantics as `/status` above.

Response: `{ address, positions: [{ positionId, speculationId, description, txParams: { method: 'claimPosition', args: { speculationId, positionType } } }, …] }`. The `description` field shows `"<$0.01"` for sub-cent expected payouts so it doesn't misleadingly round to `$0.00`.

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

Out of scope for this batch: best-effort merge with on-chain `contests` (so each game can flag whether it has a contest). Needs the `resolveTeam` alias resolver from agent-server's `db/supabase/queries.ts`. Until then, callers can cross-check by team-name against `GET /v1/markets`.

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

## Deployment

Heroku app: `ospex-core-api`. Production URL: `https://ospex-core-api-195f635df864.herokuapp.com/`.

Procfile: `web: node dist/server.js`. Heroku auto-runs `yarn build` (`tsc` → `dist/`) on slug compile.

### Required Heroku config vars

Set via `heroku config:set <var>=<value> --app ospex-core-api`. Mirrors `.env.example`:

- `NETWORK` — `polygon` for production, `amoy` for testnet
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `ALCHEMY_RPC_URL` — Polygon mainnet RPC (PAYG-tier — required by `/v1/positions/by-tx` and `/v1/positions/claim-result`)
- `MATCHING_MODULE_ADDRESS` — R4 matching module (required by `POST /v1/commitments`)
- `SCORER_MONEYLINE_ADDRESS`, `SCORER_SPREAD_ADDRESS`, `SCORER_TOTAL_ADDRESS` — required by `POST /v1/commitments` (all-or-nothing; partial config is rejected at boot)
- `POSITION_MODULE_ADDRESS` — optional defensive log-source filter for tx parsers

`NODE_ENV=production` and `LOG_LEVEL=info` are recommended. **Do not set `PORT`** — Heroku injects it; setting it as a config var creates a binding mismatch.

### Post-deploy smoke test

```bash
URL=https://ospex-core-api-195f635df864.herokuapp.com
curl -s "$URL/healthz"            # 200 + service / network / chainId
curl -s "$URL/readyz"              # 200 only when supabase.connected and commitments.configured
curl -s "$URL/v1/protocol/info"    # mainnet contract addresses
curl -s "$URL/v1/markets"          # paginated list (empty until indexer ingests data)
```

`/readyz` is the canonical "everything wired" check — both Supabase reachability and EIP-712 relay env config are surfaced in the JSON.

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
  middleware/
    asyncHandler.ts    # error-forwarding wrapper
    errorHandler.ts    # final 500 handler, ApiError shape
    eip712Auth.ts      # per-action signature verifier
    rateLimit.ts       # express-rate-limit instances
  v1/
    router.ts          # versioned router
    commitments.ts     # POST + GET /v1/commitments
    markets.ts         # GET /v1/markets, GET /v1/markets/:contestId
    protocol.ts        # GET /v1/protocol/info
    positions.ts       # GET /v1/positions/:address + /status, /claim-params,
                       #   /by-tx/:txHash, /claim-result/:txHash
    leaderboard.ts     # GET /v1/leaderboard
    schedule.ts        # GET /v1/schedule
    utils/
      positionFetch.ts # categorize active/claimable (Supabase-only)
```
