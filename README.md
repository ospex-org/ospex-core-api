# ospex-core-api

Public read API for the Ospex protocol. Reads on-chain state via Supabase (populated by `ospex-indexer`) and exposes it as a versioned REST API at `/v1/*`.

This repo replaces the API surface that used to live inside `ospex-agent-server`. The agent (Michelle/Dan) code has been deprecated; the read endpoints are migrating here so they can evolve independently of any agent code.

## Status

Empty scaffold. Only `/healthz` works today. Endpoints are migrating in batches.

## Stack

- Node.js 20+, TypeScript (strict, `exactOptionalPropertyTypes`)
- Express 5
- Supabase (`@supabase/supabase-js`) — the only data layer. **No Firebase.**
- ethers v6 (for EIP-712 verification, added in a later batch)
- pino for logs

## Run locally

```bash
yarn install
cp .env.example .env  # fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ALCHEMY_RPC_URL, MATCHING_MODULE_ADDRESS
yarn typecheck
yarn dev
```

Then:

```bash
curl http://localhost:3000/healthz
```

## Scripts

| Script | What it does |
|---|---|
| `yarn dev` | Watch + reload via `tsx`, reads `.env` automatically |
| `yarn build` | `tsc` → `dist/` |
| `yarn start` | `node dist/server.js` (production / Heroku) |
| `yarn typecheck` | `tsc --noEmit` |
| `yarn lint` | ESLint over `src/` |

## Environment

See `.env.example`. All required values are validated at boot — missing vars exit with `code 1` immediately, not on first request.

## Deployment

Heroku app target: `ospex-core-api`. Procfile uses `web: node dist/server.js`. Build runs via `tsc` on slug compile (Heroku auto-runs `yarn build` for Node apps with a `build` script).

## Project conventions

- **Supabase only** — no Firebase, no Firestore, no `firebase-admin`. The `package.json` has zero firebase deps and any PR adding one should be rejected at review.
- **No data-source smuggling** — handlers and their helpers must read from the same data layer. Don't repeat the `positionFetch.ts` pattern from `ospex-agent-server` where a Supabase-looking handler quietly called a Firestore helper.
- **Network-scoped queries** — every Supabase query that hits a network-partitioned table must filter `eq('network', NETWORK)`. The indexer skill in `.claude/skills/indexer/` has the canonical list.
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
