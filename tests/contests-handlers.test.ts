/**
 * Handler-level tests for the contests endpoints. Mocks loadConfig so we
 * can drive the network selection without a real env.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const envMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ network: 'polygon', chainId: 137 })),
}));

vi.mock('../src/lib/env.js', () => envMock);

const { getApprovedScriptsHandler } = await import('../src/v1/contests.js');

interface FakeRes {
  statusCode?: number;
  body?: unknown;
  status: (code: number) => FakeRes;
  json: (body: unknown) => FakeRes;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

function makeReq(): Request {
  return { params: {}, query: {} } as unknown as Request;
}

describe('GET /v1/contests/scripts/approved', () => {
  it('returns the polygon approvals bundle on a polygon deployment', () => {
    envMock.loadConfig.mockReturnValueOnce({ network: 'polygon', chainId: 137 });
    const res = makeRes();
    getApprovedScriptsHandler(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      network: 'polygon',
      approvedSigner: '0xfd6C7Fc1F182de53AA636584f1c6B80d9D885886',
      verify: {
        scriptHash: '0x01c48e15068b68b7d5986d5013edd83a243ac31a761567e9db0e57b513c26c01',
        purpose: 0,
        leagueId: 0,
        version: 1,
      },
      marketUpdate: {
        purpose: 1,
        validUntil: 0,
      },
      score: {
        purpose: 2,
        validUntil: 0,
      },
    });
  });

  it('exposes the verify approval expiry and a non-empty signature', () => {
    envMock.loadConfig.mockReturnValueOnce({ network: 'polygon', chainId: 137 });
    const res = makeRes();
    getApprovedScriptsHandler(makeReq(), res as unknown as Response);
    const body = res.body as { verify: { validUntil: number; signature: string } };
    expect(body.verify.validUntil).toBeGreaterThan(0);
    expect(body.verify.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(body.verify.signature.length).toBe(2 + 130);
  });

  it('returns 503 SCRIPT_APPROVALS_NOT_CONFIGURED on amoy (no committed approvals)', () => {
    envMock.loadConfig.mockReturnValueOnce({ network: 'amoy', chainId: 80002 });
    const res = makeRes();
    getApprovedScriptsHandler(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ code: 'SCRIPT_APPROVALS_NOT_CONFIGURED' });
  });
});
