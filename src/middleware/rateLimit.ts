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
