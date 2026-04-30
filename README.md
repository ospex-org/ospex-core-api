# ospex-core-api

Public read API for the Ospex protocol. Reads on-chain state via Supabase (populated by `ospex-indexer`) and exposes it as a versioned REST API at `/v1/*`.

This repo replaces the API surface that used to live inside `ospex-agent-server`. The agent (Michelle/Dan) code has been deprecated; the read endpoints are migrating here so they can evolve independently of any agent code.

## Status

Empty scaffold. Only `/healthz` (liveness) and `/readyz` (readiness) work today. Endpoints are migrating in batches.

## Stack

- Node.js 20+, TypeScript (strict, `exactOptionalPropertyTypes`)
- Express 5
- Supabase (`@supabase/supabase-js`) — the only data layer. **No Firebase.**
- ethers v6 (for EIP-712 verification, added in a later batch)
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
| `ALCHEMY_RPC_URL` | not yet | Reserved; required when on-chain endpoints land |
| `MATCHING_MODULE_ADDRESS` | not yet | Reserved; format-validated when set; required when EIP-712 endpoints land |

## Deployment

Heroku app target: `ospex-core-api`. Procfile uses `web: node dist/server.js`. Build runs via `tsc` on slug compile (Heroku auto-runs `yarn build` for Node apps with a `build` script).

## Project conventions

- **Supabase only** — no Firebase, no Firestore, no `firebase-admin`. The `package.json` has zero firebase deps and any PR adding one should be rejected at review.
- **No data-source smuggling** — handlers and their helpers must read from the same data layer. Don't repeat the `positionFetch.ts` pattern from `ospex-agent-server` where a Supabase-looking handler quietly called a Firestore helper.
- **Network-scoped queries** — every Supabase query that hits a network-partitioned table must filter `eq('network', NETWORK)`. The indexer skill in `.claude/skills/indexer/` has the canonical list.
- **Service-role key bypasses RLS** — the server uses `SUPABASE_SERVICE_ROLE_KEY`, which sees every column on every row. Handlers must explicitly select the public columns they intend to expose (`.select('id, name, ...')` not `.select('*')`) and never echo a row directly to the response. Treat raw row shape as private by default.
- **Strict TypeScript** — `any` is an error, unused vars are errors, console is an error (use the pino `logger`). Run `yarn typecheck` before merging.

## Layout

```
src/
  server.ts          # Express app + boot
  lib/
    env.ts           # boot-time env validation
    supabase.ts      # lazy-init Supabase client
    logger.ts        # pino
  middleware/
    asyncHandler.ts  # ported from agent-server
    errorHandler.ts  # ported from agent-server
  v1/
    router.ts        # versioned router (empty for now)
```
