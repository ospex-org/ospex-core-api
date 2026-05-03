/**
 * Handler-level tests — minimal fakes for express's req/res so we can
 * verify malformed-address handling and the response shape end-to-end
 * (status + claim-params) without booting a real HTTP server.
 *
 * The fetchCategorizedPositions helper is mocked so handler logic is
 * the only thing under test.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const fetchMock = vi.hoisted(() => ({
  fetchCategorizedPositions: vi.fn(),
}));
const supabaseMock = vi.hoisted(() => ({ getSupabase: vi.fn() }));
const envMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ network: 'polygon', chainId: 137 })),
}));

vi.mock('../src/v1/utils/positionFetch.js', async () => {
  // Preserve the real type-export `positionTypeIntToString`; just override
  // fetchCategorizedPositions for the handler tests.
  const actual = await vi.importActual<typeof import('../src/v1/utils/positionFetch.js')>(
    '../src/v1/utils/positionFetch.js',
  );
  return {
    ...actual,
    fetchCategorizedPositions: fetchMock.fetchCategorizedPositions,
  };
});
vi.mock('../src/lib/supabase.js', () => supabaseMock);
vi.mock('../src/lib/env.js', () => envMock);

const { getClaimParamsHandler, getPositionStatusHandler } = await import(
  '../src/v1/positions.js'
);

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

function makeReq(address: string): Request {
  return { params: { address } } as unknown as Request;
}

const ADDR = '0xabcdefabcdef0123456789abcdef0123456789ab';

describe('GET /v1/positions/:address/status', () => {
  it('returns 400 with INVALID_PARAM for a malformed address', async () => {
    const res = makeRes();
    await getPositionStatusHandler(makeReq('not-an-address'), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
  });

  it('returns three buckets with summed totals', async () => {
    fetchMock.fetchCategorizedPositions.mockResolvedValueOnce({
      active: [{ positionId: 'a', speculationId: '1' }],
      pendingSettle: [
        {
          positionId: 'p',
          speculationId: '2',
          positionType: 0,
          team: 'A',
          opponent: 'B',
          market: 'moneyline',
          oddsDecimal: 2,
          riskAmountUSDC: 100,
          profitAmountUSDC: 100,
          result: 'won',
          predictedWinSide: 'away',
          estimatedPayoutUSDC: 200,
          estimatedPayoutWei6: '200000000',
        },
      ],
      claimable: [
        {
          positionId: 'c',
          speculationId: '3',
          positionType: 0,
          team: 'A',
          opponent: 'B',
          market: 'moneyline',
          oddsDecimal: 2,
          riskAmountUSDC: 50,
          profitAmountUSDC: 50,
          result: 'won',
          estimatedPayoutUSDC: 100,
          estimatedPayoutWei6: '100000000',
        },
      ],
    });

    const res = makeRes();
    await getPositionStatusHandler(makeReq(ADDR), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      address: ADDR,
      totals: {
        activeCount: 1,
        pendingSettleCount: 1,
        claimableCount: 1,
        estimatedPayoutWei6: '100000000',
        pendingSettlePayoutWei6: '200000000',
      },
    });
  });
});

describe('GET /v1/positions/:address/claim-params', () => {
  it('returns 400 with INVALID_PARAM for a malformed address', async () => {
    const res = makeRes();
    await getClaimParamsHandler(makeReq('0xnope'), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
  });

  it('emits a single-step txParams array for claimable rows', async () => {
    fetchMock.fetchCategorizedPositions.mockResolvedValueOnce({
      active: [],
      pendingSettle: [],
      claimable: [
        {
          positionId: 'pid',
          speculationId: '42',
          positionType: 1,
          team: 'Home',
          opponent: 'Away',
          market: 'spread',
          oddsDecimal: 1.91,
          riskAmountUSDC: 100,
          profitAmountUSDC: 91,
          result: 'won',
          estimatedPayoutUSDC: 191,
          estimatedPayoutWei6: '191000000',
        },
      ],
    });

    const res = makeRes();
    await getClaimParamsHandler(makeReq(ADDR), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { positions: unknown[] };
    expect(body.positions).toHaveLength(1);
    expect(body.positions[0]).toMatchObject({
      positionId: 'pid',
      bucket: 'claimable',
      result: 'won',
      txParams: [
        {
          method: 'claimPosition',
          target: 'PositionModule',
          args: { speculationId: '42', positionType: 1 },
        },
      ],
    });
  });

  it('emits a two-step txParams array (settle then claim) for pendingSettle rows', async () => {
    fetchMock.fetchCategorizedPositions.mockResolvedValueOnce({
      active: [],
      pendingSettle: [
        {
          positionId: 'pid',
          speculationId: '99',
          positionType: 0,
          team: 'A',
          opponent: 'B',
          market: 'moneyline',
          oddsDecimal: 2,
          riskAmountUSDC: 50,
          profitAmountUSDC: 50,
          result: 'won',
          predictedWinSide: 'away',
          estimatedPayoutUSDC: 100,
          estimatedPayoutWei6: '100000000',
        },
      ],
      claimable: [],
    });

    const res = makeRes();
    await getClaimParamsHandler(makeReq(ADDR), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { positions: Array<{ bucket: string; txParams: unknown[] }> };
    expect(body.positions).toHaveLength(1);
    expect(body.positions[0]!.bucket).toBe('pendingSettle');
    expect(body.positions[0]!.txParams).toEqual([
      {
        method: 'settleSpeculation',
        target: 'SpeculationModule',
        args: { speculationId: '99' },
      },
      {
        method: 'claimPosition',
        target: 'PositionModule',
        args: { speculationId: '99', positionType: 0 },
      },
    ]);
  });

  it('lists claimable rows before pendingSettle rows', async () => {
    fetchMock.fetchCategorizedPositions.mockResolvedValueOnce({
      active: [],
      pendingSettle: [
        {
          positionId: 'p',
          speculationId: '2',
          positionType: 0,
          team: 'A',
          opponent: 'B',
          market: 'moneyline',
          oddsDecimal: 2,
          riskAmountUSDC: 1,
          profitAmountUSDC: 1,
          result: 'won',
          predictedWinSide: 'away',
          estimatedPayoutUSDC: 2,
          estimatedPayoutWei6: '2000000',
        },
      ],
      claimable: [
        {
          positionId: 'c',
          speculationId: '1',
          positionType: 0,
          team: 'A',
          opponent: 'B',
          market: 'moneyline',
          oddsDecimal: 2,
          riskAmountUSDC: 1,
          profitAmountUSDC: 1,
          result: 'won',
          estimatedPayoutUSDC: 2,
          estimatedPayoutWei6: '2000000',
        },
      ],
    });

    const res = makeRes();
    await getClaimParamsHandler(makeReq(ADDR), res as unknown as Response);
    const body = res.body as { positions: Array<{ bucket: string }> };
    expect(body.positions.map((p) => p.bucket)).toEqual(['claimable', 'pendingSettle']);
  });
});
