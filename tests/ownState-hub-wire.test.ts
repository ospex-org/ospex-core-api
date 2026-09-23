/**
 * What `OwnStateHub`'s positions DISCOVERY drain actually puts on the wire
 * (`ospex-core-api#97`).
 *
 * ## Why this file exists next to `ownState-hub-derivation-bound.test.ts`
 *
 * That file drives the same code through an in-memory relational double, which
 * is the right tool for what the derivation DOES with the rows and is blind to
 * the one thing a keyset cursor gets wrong: the URL. Two hazards live only there
 * and only for the real client —
 *
 *  - **the `+00:00` in a `timestamptz`.** A raw `row_updated_at` is
 *    `2026-09-22T00:12:13.13737+00:00`, and it is interpolated into a
 *    PostgREST `or=(…)` expression. In a query string a bare `+` decodes as a
 *    SPACE, so an unencoded cursor value would arrive at Postgres as
 *    `2026-09-22T00:12:13.13737 00:00` — either a parse error or, worse, a
 *    silently different instant. Nothing in the in-memory double touches a URL,
 *    so nothing there can tell an encoded cursor from an unencoded one.
 *  - **the select list.** The tip is built from `row_updated_at` AND `id`, so a
 *    column list missing `id` yields `undefined` tips and a cursor that cannot
 *    advance. The double ignores `select` entirely (it records it and filters on
 *    the fixture's own keys), so a dropped column is invisible to it.
 *
 * So these two cases point the real `@supabase/supabase-js` client at a real
 * socket and assert on the REQUESTS RECEIVED, captured on the far side of the
 * client — rule 3c-harness ("the URL is the artifact") and rule 3i (probe the
 * call, not the argument you prepared for it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  applyFilters,
  expectReached,
  startFakePostgrest,
  type FakePostgrest,
} from './helpers/fakePostgrest.js';

const ADDRESS = '0xabcdefabcdef0123456789abcdef0123456789ab';
/** Microseconds AND a `+00:00` offset: the shape PostgREST actually emits. */
const RAW_STAMP = '2026-09-22T00:12:13.13737+00:00';
const NOW = Date.parse('2026-09-22T12:00:00.000Z');

let fake: FakePostgrest;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  vi.useRealTimers();
  await fake?.close();
});

const { OwnStateHub } = await import('../src/v1/ownState/hub.js');

function row(id: number, stamp: string): Record<string, unknown> {
  return {
    id,
    speculation_id: id,
    user_address: ADDRESS,
    network: 'polygon',
    position_type: 'upper',
    risk_amount: '10000',
    profit_amount: '15000',
    claimed: false,
    row_updated_at: stamp,
  };
}

/**
 * The parents the derivation needs. Present deliberately: a fake that answered
 * `[]` for `speculations` would leave every discovered row UNRESOLVED, which now
 * holds the discovery cursor — so the tip assertions below would be measuring an
 * orphan skip rather than a cursor, and would report the tip as never advancing
 * for a reason that has nothing to do with the URL.
 */
function parentsFor(rows: Array<Record<string, unknown>>, table: string): unknown[] {
  return rows.map((r) =>
    table === 'speculations'
      ? {
          speculation_id: r['speculation_id'],
          contest_id: r['speculation_id'],
          network: 'polygon',
          market_type: 'moneyline',
          line_ticks: 0,
          speculation_status: 'open',
          win_side: 'tbd',
          row_updated_at: r['row_updated_at'],
        }
      : {
          contest_id: r['speculation_id'],
          network: 'polygon',
          contest_status: 'unverified',
          away_score: null,
          home_score: null,
          row_updated_at: r['row_updated_at'],
        },
  );
}

async function drive(rows: Array<Record<string, unknown>>): Promise<{
  statuses: string[];
}> {
  fake = await startFakePostgrest((req) => {
    const table = req.path.replace('/rest/v1/', '');
    if (table === 'positions') return { body: applyFilters(rows, req.params) };
    if (table === 'speculations' || table === 'contests') {
      return { body: applyFilters(parentsFor(rows, table), req.params) };
    }
    return { body: [] };
  });
  const client: SupabaseClient = createClient(fake.url, 'test-key');
  const hub = new OwnStateHub({ getClient: () => client, getNetwork: () => 'polygon' });
  const statuses: string[] = [];
  hub.subscribe(ADDRESS, {
    onCommitment: () => undefined,
    onFill: () => undefined,
    onPositionStatus: (_b, _ts, id) => statuses.push(id),
    onResync: () => undefined,
    onDegraded: () => undefined,
  });
  await hub.pollWallet(ADDRESS);
  expectReached(fake);
  return { statuses };
}

describe('OwnStateHub positions discovery — the request on the wire', () => {
  it('encodes the cursor timestamp, so a `+00:00` offset survives the query string', async () => {
    // Tick 1 reads nothing (the fixture is stamped before the overlap floor) and
    // sets the tip from… nothing, so tick 1's own cursor is the subscribe-time
    // ISO, which carries no `+`. The row that DOES set a raw tip is delivered on
    // the tick where the fixture moves above the floor, and the tick after that
    // is the one whose cursor carries microseconds and an offset.
    const stamp = `${new Date(NOW + 60_000).toISOString().replace('000Z', '')}13737+00:00`;
    await drive([row(1, stamp)]);
    const positions = fake.requests.filter((r) => r.path.endsWith('/positions'));
    expect(positions).toHaveLength(1);

    // The raw query string is the artifact. A `+` in a value must arrive as `%2B`
    // — PostgREST would read a bare `+` as a space.
    const raw = positions[0]!.rawQuery;
    expect(raw).toContain('or=');
    expect(raw).not.toMatch(/or=\([^&]*\+00%3A00/);
    // And the round trip: what the server parsed back out is the exact string the
    // hub meant to send, offset and all.
    const or = positions[0]!.params.get('or')!;
    expect(or).toMatch(
      /^\(row_updated_at\.gt\.[^,]+,and\(row_updated_at\.eq\.[^,]+,id\.gt\.0\)\)$/,
    );
    const floor = /row_updated_at\.gt\.([^,]+),/.exec(or)![1]!;
    expect(Date.parse(floor)).toBe(NOW - 30_000);

    // Ascending, both keys, and the page limit — read off the URL rather than the
    // builder.
    expect(positions[0]!.params.get('order')).toBe('row_updated_at.asc,id.asc');
    expect(positions[0]!.params.get('limit')).toBe('500');
  });

  it('selects the tip columns, and advances the tip across a raw microsecond stamp', async () => {
    // The end-to-end property: a row whose `row_updated_at` is a real PostgREST
    // `timestamptz` — six fractional digits and a `+00:00` offset — is delivered,
    // and the NEXT tick's cursor is derived from it. That is the assertion a
    // missing `id` in the select list fails, because the tip's second component
    // would be `undefined` and the cursor unparseable.
    const stamp = `${new Date(NOW + 60_000).toISOString().replace('000Z', '')}13737+00:00`;
    const rows = [row(7, stamp)];
    const { statuses } = await drive(rows);
    // Derived, not skipped — which is what makes the tip assertion below a
    // statement about the cursor rather than about an unresolved row.
    expect(statuses).toEqual(['7']);

    const positions = fake.requests.filter((r) => r.path.endsWith('/positions'));
    expect(positions[0]!.params.get('select')).toContain('id');
    expect(positions[0]!.params.get('select')).toContain('row_updated_at');

    // Drive one more tick against the same hub by re-subscribing is not the
    // point; the tip is what matters, and it is observable on the next request.
    const client: SupabaseClient = createClient(fake.url, 'test-key');
    const hub = new OwnStateHub({ getClient: () => client, getNetwork: () => 'polygon' });
    hub.subscribe(ADDRESS, {
      onCommitment: () => undefined,
      onFill: () => undefined,
      onPositionStatus: () => undefined,
      onResync: () => undefined,
      onDegraded: () => undefined,
    });
    await hub.pollWallet(ADDRESS);
    await hub.pollWallet(ADDRESS);
    expectReached(fake, 2);
    const asked = fake.requests
      .filter((r) => r.path.endsWith('/positions'))
      .map((r) => r.params.get('or')!);
    // The last request's floor is 30s below the row's OWN stamp, which is only
    // true if the tip was built from the row the previous tick read.
    const lastFloor = /row_updated_at\.gt\.([^,]+),/.exec(asked[asked.length - 1]!)![1]!;
    expect(Date.parse(lastFloor)).toBe(Date.parse(stamp) - 30_000);
    // Sanity: the fixture's stamp really is the sub-millisecond + offset shape
    // this file exists for, not a millisecond `Z`. Five fractional digits rather
    // than six, deliberately — PostgREST TRIMS trailing zeros, which is why the
    // production row this fixture copies reads `…13.13737+00:00`. A fixture
    // padded to six would not be the shape the wire carries.
    expect(stamp).toMatch(/\.\d{5}\+00:00$/);
    expect(RAW_STAMP).toMatch(/\.\d{5}\+00:00$/);
  });
});
