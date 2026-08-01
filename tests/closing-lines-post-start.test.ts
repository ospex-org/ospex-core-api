/**
 * The post-start-poll gate on served closing lines.
 *
 * `confidence='fresh'` applies only an UPPER bound on the writer's poll gap, so
 * a market polled AFTER its own lock still classifies fresh. ospex-benchmark's
 * CLV scorer independently refuses exactly those rows (`close_after_start`), so
 * serving them made this API the more permissive of two CLV surfaces over the
 * same data — 147 rows, 4.05%, on the corpus measured 2026-07-31.
 *
 * These assert the gate at the layer that decides what a consumer receives:
 * `attachClosingLines` against a Supabase double, checking which speculations
 * come back carrying `.closing`.
 *
 * THE DOUBLE HONOURS THE SELECT PROJECTION. PostgREST returns only requested
 * columns, so a fake that returns whole fixture rows would keep passing if
 * `lock_time`/`last_polled_at` were dropped from CLOSING_LINE_COLUMNS — the
 * gate would silently lose its inputs while every assertion stayed green. The
 * projection is replayed here so that removal fails.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { attachClosingLines } from '../src/v1/utils/closingLines.js';
import type { Speculation } from '../src/v1/utils/speculations.js';

const NETWORK = 'polygon';
const LOCK = '2026-07-28T23:10:00+00:00';

interface RawClosingRow {
  jsonodds_id: string;
  market: string;
  line: number | null;
  away_p_novig: number | null;
  home_p_novig: number | null;
  lock_time: string | null;
  last_polled_at: string | null;
  value_captured_at: string | null;
  poll_gap_seconds: number | null;
}

function closingRow(over: Partial<RawClosingRow> = {}): RawClosingRow {
  return {
    jsonodds_id: 'game-1',
    market: 'moneyline',
    line: null,
    away_p_novig: 0.5,
    home_p_novig: 0.5,
    lock_time: LOCK,
    // Default: polled one minute BEFORE lock — an ordinary, servable close.
    last_polled_at: '2026-07-28T23:09:00+00:00',
    value_captured_at: '2026-07-28T23:05:00+00:00',
    // Must agree with lock_time - last_polled_at (60s) or the row is unusable.
    poll_gap_seconds: 60,
    ...over,
  };
}

function spec(over: Partial<Speculation> = {}): Speculation {
  return {
    speculationId: 'spec-1',
    contestId: '1',
    type: 'moneyline',
    lineTicks: null,
    line: null,
    speculationStatus: 0,
    winSide: null,
    ...over,
  } as Speculation;
}

/**
 * Minimal PostgREST double. Records the select string per table and REPLAYS THE
 * PROJECTION, so a column the caller stopped requesting is genuinely absent from
 * the row it receives — the same way the real server behaves.
 */
function makeSupabase(closingRows: RawClosingRow[]): {
  sb: SupabaseClient;
  selects: Record<string, string>;
} {
  const selects: Record<string, string> = {};

  function project<T extends object>(rows: T[], select: string): Array<Record<string, unknown>> {
    const cols = select.split(',').map((c) => c.trim());
    return rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const c of cols) {
        if (c in r) out[c] = (r as Record<string, unknown>)[c];
      }
      return out;
    });
  }

  const sb = {
    from(table: string) {
      let select = '';
      const builder: Record<string, unknown> = {
        select(s: string) {
          select = s;
          selects[table] = s;
          return builder;
        },
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        range: (from: number) => {
          if (table === 'contests') {
            return Promise.resolve({
              data: project([{ contest_id: '1', jsonodds_id: 'game-1' }], select),
              error: null,
            });
          }
          // Single page: anything past the first range is empty.
          const data = from === 0 ? project(closingRows, select) : [];
          return Promise.resolve({ data, error: null });
        },
        then(resolve: (v: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({
            data: project([{ contest_id: '1', jsonodds_id: 'game-1' }], select),
            error: null,
          }).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;

  return { sb, selects };
}

async function servedClosing(rows: RawClosingRow[]): Promise<Speculation['closing']> {
  const s = spec();
  const { sb } = makeSupabase(rows);
  await attachClosingLines(sb, NETWORK, [s]);
  return s.closing;
}

describe('attachClosingLines — the post-start-poll gate', () => {
  it('withholds a fresh close whose last poll landed after its own lock', async () => {
    const closing = await servedClosing([
      closingRow({ last_polled_at: '2026-07-28T23:15:00+00:00', poll_gap_seconds: -300 }), // 5 min PAST lock
    ]);
    expect(closing).toBeUndefined();
  });

  it('NEGATIVE CONTROL — a close polled before its lock is still served', async () => {
    const closing = await servedClosing([closingRow()]);
    expect(closing).toBeDefined();
    expect(closing?.awayDecimal).toBe(2);
    expect(closing?.homeDecimal).toBe(2);
  });

  it('withholds a close polled hours past its lock', async () => {
    const closing = await servedClosing([
      closingRow({ last_polled_at: '2026-07-29T02:00:00+00:00', poll_gap_seconds: -10200 }),
    ]);
    expect(closing).toBeUndefined();
  });

  // The boundary is the scorer's: `>=` a 1000ms tolerance, which absorbs
  // sub-second rounding and nothing more. Both sides are asserted so the
  // constant cannot drift in either direction unnoticed.
  it('BOUNDARY — 999ms past lock is within tolerance and still served', async () => {
    const closing = await servedClosing([
      closingRow({ last_polled_at: '2026-07-28T23:10:00.999+00:00', poll_gap_seconds: 0 }),
    ]);
    expect(closing).toBeDefined();
  });

  it('BOUNDARY — exactly 1000ms past lock is withheld', async () => {
    const closing = await servedClosing([
      closingRow({ last_polled_at: '2026-07-28T23:10:01.000+00:00', poll_gap_seconds: -1 }),
    ]);
    expect(closing).toBeUndefined();
  });

  it('a poll exactly AT the lock is served (a zero gap is not "after")', async () => {
    const closing = await servedClosing([closingRow({ last_polled_at: LOCK, poll_gap_seconds: 0 })]);
    expect(closing).toBeDefined();
  });

  // A fresh row is a CLAIM that the capture observed this market at a known
  // instant. Missing any of the three instants makes it evidence of nothing, and
  // the scorer refuses it as `close_timing_unusable`. An earlier revision of
  // this file asserted the OPPOSITE — that a null last_polled_at is served —
  // which is precisely where this surface and the scorer diverged.
  it('a null last_polled_at is WITHHELD (incomplete timing evidence)', async () => {
    const closing = await servedClosing([closingRow({ last_polled_at: null })]);
    expect(closing).toBeUndefined();
  });

  it('a null value_captured_at is withheld', async () => {
    const closing = await servedClosing([closingRow({ value_captured_at: null })]);
    expect(closing).toBeUndefined();
  });

  it('a null poll_gap_seconds is withheld', async () => {
    const closing = await servedClosing([closingRow({ poll_gap_seconds: null })]);
    expect(closing).toBeUndefined();
  });

  it('an unparseable last_polled_at is withheld', async () => {
    const closing = await servedClosing([closingRow({ last_polled_at: 'not-a-date' })]);
    expect(closing).toBeUndefined();
  });

  it('a null lock_time is withheld — there is nothing to judge anything against', async () => {
    const closing = await servedClosing([closingRow({ lock_time: null })]);
    expect(closing).toBeUndefined();
  });

  // The stored gap must corroborate the instants, never override them. A row
  // claiming a 60s gap whose instants say otherwise establishes nothing.
  it('a stored poll_gap_seconds that contradicts the instants is withheld', async () => {
    const closing = await servedClosing([
      closingRow({ last_polled_at: '2026-07-28T23:09:00+00:00', poll_gap_seconds: 99_999 }),
    ]);
    expect(closing).toBeUndefined();
  });

  it('NEGATIVE CONTROL — a gap within the 1000ms coherence tolerance is served', async () => {
    const closing = await servedClosing([
      closingRow({ last_polled_at: '2026-07-28T23:09:00.400+00:00', poll_gap_seconds: 60 }),
    ]);
    expect(closing).toBeDefined();
  });

  // closeValueAfterLock — the scorer's third refusal. STRICTLY after, no
  // tolerance: value_captured_at is a direct timestamp with no quantisation.
  it('a VALUE captured after the lock is withheld, with no tolerance', async () => {
    const closing = await servedClosing([
      closingRow({ value_captured_at: '2026-07-28T23:10:00.001+00:00' }),
    ]);
    expect(closing).toBeUndefined();
  });

  it('NEGATIVE CONTROL — a value captured exactly AT the lock is served', async () => {
    const closing = await servedClosing([closingRow({ value_captured_at: LOCK })]);
    expect(closing).toBeDefined();
  });

  it('one game can have a servable market and a withheld one at the same time', async () => {
    const ml = spec({ speculationId: 's-ml', type: 'moneyline' });
    const total = spec({ speculationId: 's-tot', type: 'total', line: 8.5 });
    const { sb } = makeSupabase([
      closingRow({ market: 'moneyline' }),
      closingRow({
        market: 'total',
        line: 8.5,
        last_polled_at: '2026-07-28T23:30:00+00:00',
        poll_gap_seconds: -1200,
      }),
    ]);
    await attachClosingLines(sb, NETWORK, [ml, total]);
    expect(ml.closing).toBeDefined();
    expect(total.closing).toBeUndefined();
  });
});

describe('attachClosingLines — the gate reads columns it actually requests', () => {
  it('requests lock_time and last_polled_at, without which the gate is blind', async () => {
    const { sb, selects } = makeSupabase([closingRow()]);
    await attachClosingLines(sb, NETWORK, [spec()]);
    // Not a style assertion: the projecting double above returns ONLY selected
    // columns, so dropping either of these makes every row read as unparseable
    // and the gate withholds everything. Naming them here says why.
    expect(selects['closing_lines']).toContain('lock_time');
    expect(selects['closing_lines']).toContain('last_polled_at');
  });

  it('still selects the pricing columns the enrichment needs', async () => {
    const { sb, selects } = makeSupabase([closingRow()]);
    await attachClosingLines(sb, NETWORK, [spec()]);
    for (const col of ['jsonodds_id', 'market', 'line', 'away_p_novig', 'home_p_novig']) {
      expect(selects['closing_lines']).toContain(col);
    }
  });
});

describe('attachClosingLines — the verdict does not depend on the host timezone', () => {
  // The sharpest form of the bug this file exists to prevent. `Date.parse` on an
  // offsetless timestamp reads it in the HOST'S LOCAL ZONE, so the same row
  // resolved to different instants on a UTC dyno and a developer machine — and
  // a reviewer demonstrated the PUBLIC verdict flipping between TZ=UTC and
  // TZ=America/New_York. Requiring an explicit offset removes the question
  // rather than making the two zones happen to agree.
  const ZONES = ['UTC', 'America/New_York', 'Asia/Tokyo'];
  const original = process.env.TZ;

  afterEach(() => {
    process.env.TZ = original;
  });

  it('proves the fixture is genuinely TZ-sensitive under Date.parse', () => {
    // Without this, the assertions below could pass because the input happens to
    // be zone-independent rather than because the parser rejects it.
    process.env.TZ = 'UTC';
    const utc = Date.parse('2026-07-28T23:09:00');
    process.env.TZ = 'America/New_York';
    const ny = Date.parse('2026-07-28T23:09:00');
    expect(utc).not.toBe(ny);
  });

  for (const tz of ZONES) {
    it(`withholds an offsetless last_polled_at under TZ=${tz}`, async () => {
      process.env.TZ = tz;
      const closing = await servedClosing([
        closingRow({ last_polled_at: '2026-07-28T23:09:00' }),
      ]);
      expect(closing).toBeUndefined();
    });

    it(`NEGATIVE CONTROL — an offset-qualified row is served under TZ=${tz}`, async () => {
      process.env.TZ = tz;
      const closing = await servedClosing([closingRow()]);
      expect(closing).toBeDefined();
    });
  }

  it('withholds an out-of-range offset (syntax valid, instant not)', async () => {
    const closing = await servedClosing([
      closingRow({ last_polled_at: '2026-07-28T23:09:00+99:99' }),
    ]);
    expect(closing).toBeUndefined();
  });
});
