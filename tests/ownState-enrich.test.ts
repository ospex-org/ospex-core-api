/**
 * Owner-state enrichment unit tests (Phase 3 PR0b §3.1 / A6).
 *
 * Covers the pure helpers in `enrich.ts`:
 *   - `buildSignedPayload` — struct reconstruction + bigint→string wire shape;
 *     fail-closed (null) on missing signature or any missing struct field;
 *   - `toOwnerCommitmentBody` — base public fields + the owner-only enrichment
 *     (sport / absolute teams / speculationId / updatedAtUnixSec / signedPayload),
 *     with map-miss fallbacks;
 *   - `fetchCommitmentEnrichment` — batch contest + speculation-tuple maps,
 *     and the no-rows / no-contest-ids short-circuits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ network: 'polygon', chainId: 137 })),
}));
vi.mock('../src/lib/env.js', () => envMock);
// getSupabase is only imported by enrich.ts for a type alias; stub it so the
// module loads without a real client.
vi.mock('../src/lib/supabase.js', () => ({ getSupabase: vi.fn() }));

const {
  buildSignedPayload,
  toOwnerCommitmentBody,
  fetchCommitmentEnrichment,
} = await import('../src/v1/ownState/enrich.js');

const NOW = Date.parse('2026-06-01T16:00:00.000Z');
const ADDRESS = '0x1111111111111111111111111111111111111111';
const SCORER = '0x2222222222222222222222222222222222222222';

interface RowOverrides {
  [k: string]: unknown;
}
function commitmentRow(over: RowOverrides = {}): Record<string, unknown> {
  return {
    commitment_hash: `0x${'a'.repeat(64)}`,
    maker: ADDRESS,
    contest_id: 42,
    scorer: SCORER,
    line_ticks: 0,
    position_type: 'upper',
    odds_tick: 200,
    market_type: 'moneyline',
    risk_amount: '10000000',
    filled_risk_amount: '0',
    nonce: '7',
    expiry: '2026-06-01T17:00:00.000Z',
    speculation_key: `0x${'b'.repeat(64)}`,
    signature: `0x${'9'.repeat(130)}`,
    status: 'open',
    source: 'agent',
    network: 'polygon',
    nonce_invalidated: false,
    book_visible: true,
    created_at: '2026-06-01T10:00:00.000Z',
    id: 1,
    row_updated_at: '2026-06-01T15:00:00.000Z',
    ...over,
  };
}

const EMPTY_ENRICHMENT = { contestById: new Map(), speculationIdByTuple: new Map() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('buildSignedPayload', () => {
  it('reconstructs the 9-field struct with bigint fields as decimal strings + expiry in unix seconds', () => {
    const payload = buildSignedPayload(commitmentRow() as never);
    expect(payload).not.toBeNull();
    expect(payload).toEqual({
      commitmentHash: `0x${'a'.repeat(64)}`,
      commitment: {
        maker: ADDRESS,
        contestId: '42',
        scorer: SCORER,
        lineTicks: 0,
        positionType: 0,
        oddsTick: 200,
        riskAmount: '10000000',
        nonce: '7',
        // 2026-06-01T17:00:00Z → unix seconds
        expiry: String(Math.floor(Date.parse('2026-06-01T17:00:00.000Z') / 1000)),
      },
      signature: `0x${'9'.repeat(130)}`,
    });
  });

  it('maps position_type lower → 1', () => {
    const payload = buildSignedPayload(commitmentRow({ position_type: 'lower' }) as never);
    expect(payload?.commitment.positionType).toBe(1);
  });

  it('returns null (fail-closed) when the signature is absent (indexer-discovered row)', () => {
    expect(buildSignedPayload(commitmentRow({ signature: null }) as never)).toBeNull();
  });

  it.each([
    'contest_id',
    'scorer',
    'line_ticks',
    'position_type',
    'odds_tick',
    'risk_amount',
    'nonce',
    'expiry',
  ])('returns null when the signed struct field %s is missing', (field) => {
    expect(buildSignedPayload(commitmentRow({ [field]: null }) as never)).toBeNull();
  });

  it('preserves full uint256 precision for risk/nonce (beyond 2^53) as strings', () => {
    const big = '123456789012345678901234567890';
    const payload = buildSignedPayload(
      commitmentRow({ risk_amount: big, nonce: big }) as never,
    );
    expect(payload?.commitment.riskAmount).toBe(big);
    expect(payload?.commitment.nonce).toBe(big);
  });
});

describe('toOwnerCommitmentBody', () => {
  it('layers the owner enrichment onto the base public body', () => {
    const enrichment = {
      contestById: new Map([['42', { awayTeam: 'Lions', homeTeam: 'Bears', sport: 'americanfootball_nfl' }]]),
      speculationIdByTuple: new Map([[`42|${SCORER.toLowerCase()}|0`, '7']]),
    };
    const body = toOwnerCommitmentBody(commitmentRow() as never, NOW, enrichment);
    // base public field still present
    expect(body.commitmentHash).toBe(`0x${'a'.repeat(64)}`);
    expect(body.bookVisible).toBe(true);
    // enrichment
    expect(body.speculationId).toBe('7');
    expect(body.sport).toBe('americanfootball_nfl');
    expect(body.awayTeam).toBe('Lions');
    expect(body.homeTeam).toBe('Bears');
    expect(body.updatedAtUnixSec).toBe(Math.floor(Date.parse('2026-06-01T15:00:00.000Z') / 1000));
    expect(body.signedPayload?.commitment.contestId).toBe('42');
  });

  it('falls back to empty sport/teams + null speculationId when the maps miss', () => {
    const body = toOwnerCommitmentBody(commitmentRow() as never, NOW, EMPTY_ENRICHMENT);
    expect(body.sport).toBe('');
    expect(body.awayTeam).toBe('');
    expect(body.homeTeam).toBe('');
    expect(body.speculationId).toBeNull();
  });

  it('matches the speculation tuple case-insensitively on scorer', () => {
    const enrichment = {
      contestById: new Map(),
      speculationIdByTuple: new Map([[`42|${SCORER.toLowerCase()}|0`, '99']]),
    };
    // Row carries an upper-cased scorer; the tuple key lowercases both sides.
    const body = toOwnerCommitmentBody(
      commitmentRow({ scorer: SCORER.toUpperCase() }) as never,
      NOW,
      enrichment,
    );
    expect(body.speculationId).toBe('99');
  });
});

describe('fetchCommitmentEnrichment', () => {
  function mockSb(byTable: Record<string, { data: unknown; error: unknown }>): {
    sb: unknown;
    tables: string[];
  } {
    const tables: string[] = [];
    const make = (table: string): unknown => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in']) b[m] = (): unknown => b;
      b['then'] = (resolve: (v: unknown) => void): void =>
        resolve(byTable[table] ?? { data: [], error: null });
      return b;
    };
    return {
      sb: {
        from: (t: string): unknown => {
          tables.push(t);
          return make(t);
        },
      },
      tables,
    };
  }

  it('builds the contest + speculation-tuple maps from the two batch queries', async () => {
    const { sb } = mockSb({
      contests: {
        data: [{ contest_id: 42, away_team: 'Lions', home_team: 'Bears', sport_slug: 'nfl' }],
        error: null,
      },
      speculations: {
        data: [{ speculation_id: 7, contest_id: 42, speculation_scorer: SCORER, line_ticks: 0 }],
        error: null,
      },
    });
    const enrichment = await fetchCommitmentEnrichment(sb as never, 'polygon', [
      commitmentRow() as never,
    ]);
    expect(enrichment.contestById.get('42')).toEqual({
      awayTeam: 'Lions',
      homeTeam: 'Bears',
      sport: 'nfl',
    });
    expect(enrichment.speculationIdByTuple.get(`42|${SCORER.toLowerCase()}|0`)).toBe('7');
  });

  it('short-circuits (no queries) when there are no rows', async () => {
    const { sb, tables } = mockSb({});
    const enrichment = await fetchCommitmentEnrichment(sb as never, 'polygon', []);
    expect(enrichment.contestById.size).toBe(0);
    expect(tables).toHaveLength(0);
  });

  it('short-circuits when no row carries a contest_id', async () => {
    const { sb, tables } = mockSb({});
    const enrichment = await fetchCommitmentEnrichment(sb as never, 'polygon', [
      commitmentRow({ contest_id: null }) as never,
    ]);
    expect(enrichment.contestById.size).toBe(0);
    expect(tables).toHaveLength(0);
  });

  it('throws when the contests query errors', async () => {
    const { sb } = mockSb({
      contests: { data: null, error: { message: 'db down' } },
      speculations: { data: [], error: null },
    });
    await expect(
      fetchCommitmentEnrichment(sb as never, 'polygon', [commitmentRow() as never]),
    ).rejects.toThrow(/contests/);
  });
});
