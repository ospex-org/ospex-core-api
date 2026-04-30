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
