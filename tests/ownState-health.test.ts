/**
 * `ownStateHealthHandler` tests (Phase 3 PR0b, amendment A4).
 *
 * The handler is a PUBLIC indexer-lag probe (`GET /v1/health/own-state`).
 * It reads `indexer_cursor.updated_at` for the configured network and
 * reports `indexerLagSeconds = now - updated_at` (clamped at 0),
 * `lastIndexedAt`, and `lagSource: 'indexer_cursor'`.
 *
 * Covers:
 *   - healthy lag computation + network-scoped query;
 *   - clock-skew clamp (future watermark → 0, never negative);
 *   - missing indexer_cursor row → 503 INDEXER_CURSOR_UNAVAILABLE;
 *   - query error → 500 INTERNAL_ERROR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const NOW = Date.parse('2026-06-01T16:00:00.000Z');

const supabaseMock = vi.hoisted(() => ({ getSupabase: vi.fn() }));
const envMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ network: 'polygon', chainId: 137 })),
}));

vi.mock('../src/lib/supabase.js', () => supabaseMock);
vi.mock('../src/lib/env.js', () => envMock);

const { ownStateHealthHandler } = await import('../src/v1/ownState/health.js');

// ── test doubles ──────────────────────────────────────────────────────────

interface FakeRes {
  statusCode?: number;
  body?: unknown;
  status: (code: number) => FakeRes;
  json: (body: unknown) => FakeRes;
}
function makeRes(): FakeRes {
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
  return res;
}

const req = {} as unknown as Request;

interface MockResponse {
  data: unknown;
  error: unknown;
}
interface RecordedCall {
  table?: string;
  method: string;
  args: unknown[];
}

/** Single-query `.maybeSingle()` supabase double matching the snapshot tests. */
function makeSupabase(response: MockResponse): { client: unknown; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let currentTable: string | undefined;
  const builder: Record<string, unknown> = {};
  const chain =
    (method: string) =>
    (...args: unknown[]): unknown => {
      calls.push({ table: currentTable, method, args });
      return builder;
    };
  for (const m of ['select', 'eq']) builder[m] = chain(m);
  builder['maybeSingle'] = (): Promise<MockResponse> => {
    calls.push({ table: currentTable, method: 'maybeSingle', args: [] });
    return Promise.resolve(response);
  };
  return {
    client: {
      from: (t: string): unknown => {
        currentTable = t;
        return builder;
      },
    },
    calls,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  envMock.loadConfig.mockReturnValue({ network: 'polygon', chainId: 137 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ownStateHealthHandler', () => {
  it('reports lag from indexer_cursor.updated_at, scoped to the configured network', async () => {
    const updatedAt = new Date(NOW - 5_000).toISOString(); // 5s ago
    const { client, calls } = makeSupabase({
      data: { updated_at: updatedAt },
      error: null,
    });
    supabaseMock.getSupabase.mockReturnValue(client);

    const res = makeRes();
    await ownStateHealthHandler(req, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      indexerLagSeconds: 5,
      lastIndexedAt: updatedAt,
      lagSource: 'indexer_cursor',
    });
    // Queried indexer_cursor, scoped to the network from config.
    expect(calls.some((c) => c.table === 'indexer_cursor')).toBe(true);
    expect(
      calls.some((c) => c.method === 'eq' && c.args[0] === 'network' && c.args[1] === 'polygon'),
    ).toBe(true);
  });

  it('clamps a future watermark (clock skew) to 0 rather than reporting negative lag', async () => {
    const future = new Date(NOW + 4_000).toISOString();
    const { client } = makeSupabase({
      data: { updated_at: future },
      error: null,
    });
    supabaseMock.getSupabase.mockReturnValue(client);

    const res = makeRes();
    await ownStateHealthHandler(req, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect((res.body as { indexerLagSeconds: number }).indexerLagSeconds).toBe(0);
  });

  it('returns 503 INDEXER_CURSOR_UNAVAILABLE when no indexer_cursor row exists for the network', async () => {
    const { client } = makeSupabase({ data: null, error: null });
    supabaseMock.getSupabase.mockReturnValue(client);

    const res = makeRes();
    await ownStateHealthHandler(req, res as unknown as Response);

    expect(res.statusCode).toBe(503);
    expect((res.body as { code: string }).code).toBe('INDEXER_CURSOR_UNAVAILABLE');
  });

  it('returns 500 INTERNAL_ERROR when the indexer_cursor query errors', async () => {
    const { client } = makeSupabase({ data: null, error: { message: 'db down' } });
    supabaseMock.getSupabase.mockReturnValue(client);

    const res = makeRes();
    await ownStateHealthHandler(req, res as unknown as Response);

    expect(res.statusCode).toBe(500);
    expect((res.body as { code: string }).code).toBe('INTERNAL_ERROR');
  });
});
