/**
 * The relay's bound on `riskAmount` and `nonce` for a posted quote: 2^53 - 1, the
 * largest safe JavaScript integer. It is relay policy, so what these cases pin
 * is what a maker sees: the status and message for a quote past the bound, and
 * that a quote at the bound gets through validation.
 *
 * Runs the real `eip712Auth('OspexCommitment')` middleware. Validation comes
 * before signature recovery, so a quote inside the bound is proven to have
 * passed it by reaching the signature check and being refused there (401).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const NOW = Date.parse('2026-05-20T16:00:00.000Z');

const envMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    network: 'polygon',
    chainId: 137,
    matchingModuleAddress: '0x3333333333333333333333333333333333333333',
  })),
}));
vi.mock('../src/lib/env.js', () => envMock);

const { eip712Auth } = await import('../src/middleware/eip712Auth.js');

interface FakeRes {
  statusCode?: number;
  body?: unknown;
  status: (code: number) => FakeRes;
  json: (body: unknown) => FakeRes;
}

function post(overrides: Record<string, unknown>): FakeRes {
  const req = {
    body: {
      action: {
        type: 'OspexCommitment',
        maker: '0x1111111111111111111111111111111111111111',
        scorer: '0x2222222222222222222222222222222222222222',
        contestId: '1',
        lineTicks: 0,
        positionType: 0,
        oddsTick: 200,
        riskAmount: '1000000',
        nonce: '1',
        expiry: String(Math.floor(NOW / 1000) + 3600),
        ...overrides,
      },
      signature: `0x${'11'.repeat(65)}`,
    },
  } as unknown as Request;
  const res: FakeRes = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  eip712Auth('OspexCommitment')(req, res as unknown as Response, vi.fn() as unknown as NextFunction);
  return res;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const RISK_MESSAGE = 'riskAmount is too large: a quote may risk at most 9007199254740991 (about 9 billion USDC).';
const NONCE_MESSAGE = 'nonce is too large: the highest nonce accepted is 9007199254740991.';

describe('posted quote: riskAmount and nonce bound', () => {
  it.each([
    ['10^21 as a string', '1000000000000000000000'],
    ['10^21 as a JSON number', 1e21],
    ['the first lot-aligned amount past the bound', '9007199254741000'],
  ])('riskAmount of %s is refused with a 400 and a plain message', (_name, riskAmount) => {
    const res = post({ riskAmount });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: RISK_MESSAGE, code: 'INVALID_PARAM' });
  });

  it.each([
    ['10^21 as a string', '1000000000000000000000'],
    ['10^21 as a JSON number', 1e21],
    ['2^53', '9007199254740992'],
  ])('nonce of %s is refused with a 400 and a plain message', (_name, nonce) => {
    const res = post({ nonce });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: NONCE_MESSAGE, code: 'INVALID_PARAM' });
  });

  it('control: the largest lot-aligned riskAmount and the largest nonce inside the bound pass validation', () => {
    const res = post({ riskAmount: '9007199254740900', nonce: '9007199254740991' });
    // Past validation, refused only because the fixture signature is not real.
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_INVALID' });
  });
});
