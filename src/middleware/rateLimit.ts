import rateLimit from 'express-rate-limit';

/**
 * Rate limiter for `POST /v1/commitments`.
 *
 * Conservative ceiling until we have real traffic. The contract-side
 * cost of accepting a commitment is just a Supabase row write — so the
 * DoS surface is small — but limiting cheap writes still keeps a
 * single bad actor from filling the table.
 */
export const commitmentsRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'Too many commitments from this IP, please slow down.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Rate limiter for read endpoints (`GET /v1/*`).
 *
 * More permissive than the write limiter — read endpoints serve the
 * maker / discovery feed, and a single market-maker process easily
 * issues a few hundred reads per minute as it sweeps the open book.
 * 600/min ≈ 10/sec — generous for a single client, still bounds a
 * runaway scraper.
 */
/**
 * Rate limiter for the three `/v1/benchmark/*` reads.
 *
 * Tighter than the general read budget because these are the only endpoints
 * here that fan out across several relations and then run a projection over
 * every score row in the served window. 120/min is ~40 landing-page loads a
 * minute from one egress host, which is generous for a public page, and it is
 * the second of the two bounds review asked for — the first being the
 * single-flight memo in `v1/benchmark/cache.ts`, which collapses a burst of
 * identical requests to one upstream fan-out.
 *
 * Two bounds rather than one because they fail differently: the memo does
 * nothing against requests that differ in `?date=`, and a limiter does nothing
 * about a hundred simultaneous identical cold requests.
 */
export const benchmarkRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'Too many benchmark requests from this IP, please slow down.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Rate limiter for `/mcp`.
 *
 * Its own counter, so connector traffic and REST reads do not spend one
 * budget. The same size as the read budget, for the same reason: a tool call
 * is a handful of reads.
 *
 * The key is the caller's address, and for a hosted assistant that is the
 * assistant provider's address, not the person's. Everyone using the connector
 * through one provider shares this budget per provider address. There is no
 * sign-in on the endpoint, so there is nothing narrower to key on.
 *
 * What counts against it: every request to the endpoint, including the
 * handshake a client makes before its first tool call and the 405 a probing
 * GET receives. One session of connect, list the tools, call one, measured
 * five requests with the reference client.
 *
 * The body is JSON-RPC, like everything else this endpoint answers.
 */
export const mcpRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Too many requests from this address, please slow down.' },
    id: null,
  },
});

export const readRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'Too many requests from this IP, please slow down.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});
