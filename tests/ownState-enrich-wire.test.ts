/**
 * What `fetchCommitmentEnrichment` puts on the wire, and what comes back when the
 * SERVER decides the response size (`ospex-core-api#101`).
 *
 * ## Why this file exists next to `ownState-enrich.test.ts`
 *
 * That file drives the same function through a builder mock, which is the right tool
 * for what the enrichment DOES with the rows and is structurally blind to the defect
 * this file is about: a bound nobody in this repo wrote.
 *
 * PostgREST's documented default response maximum is 1,000 rows. A read that crosses
 * it SUCCEEDS with fewer rows — no error, no `error` field, no short-page signal — so
 * a builder mock, which answers whatever the fixture holds regardless of the query,
 * cannot reproduce it at all. `#100` chunked this function's id list at 199 and that
 * bounds the REQUEST: the contests read is one row per `contest_id`, so a 199-id
 * chunk cannot answer with more than 199 rows. The SPECULATIONS read is keyed on the
 * same column and is one-to-MANY — a contest carries a speculation per market and
 * line — so its answer fans out BENEATH a bounded input and can still cross the
 * maximum.
 *
 * So the fake server here applies the filters, applies `order`/`limit`, and THEN
 * truncates at the maximum exactly as the real one does. `cappedResponder` is the
 * whole point of the file: without that last step every case below passes on code
 * that reads 1,001 rows in one request, which no production server would serve.
 *
 * ## Why it matters more than "an optional field goes null"
 *
 * Verified in `ospex-market-maker`, not assumed. `mapOwnerCommitmentToMaker`
 * (src/reducers/owner-mapping.ts:171) THROWS `OwnerMappingError` on a null
 * `speculationId` whenever `marketSelection.seedSpeculations` is false — the config
 * default (src/config/index.ts:319) and the value in the shipped example. That throw
 * latches `ownStateMappingDegraded` (runners/index.ts:3605), which clears
 * `ownStateSession.healthy` (:4255) and raises the §5.1 posting hold (:4369): new
 * quotes stop and `streamHealthCancelSweep` pulls the book while exposure is
 * non-zero. Its self-heal assumes the null is transient indexer lag; a
 * cap-truncated null is deterministic, so the rebaseline reproduces it and the hold
 * does not clear.
 *
 * ## Reachability, stated because the fixtures look alarming and the data is not
 *
 * Measured on production 2026-09-23: polygon holds 992 speculations across 461
 * contests, at most 3 per contest, so the densest possible 199-contest chunk answers
 * 473 rows. Crossing 1,000 in one chunk needs a mean of 5.03 speculations per
 * contest. This is a latent halt one alt-line feature away, not a live one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  applyFilters,
  applyPage,
  expectReached,
  startFakePostgrest,
  type CapturedRequest,
  type FakePostgrest,
  type FakeReply,
} from './helpers/fakePostgrest.js';

const envMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ network: 'polygon', chainId: 137 })),
}));
vi.mock('../src/lib/env.js', () => envMock);
vi.mock('../src/lib/supabase.js', () => ({ getSupabase: vi.fn() }));
const loggerMock = vi.hoisted(() => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  formatError: (e: unknown) => String(e),
}));
vi.mock('../src/lib/logger.js', () => loggerMock);

const { fetchCommitmentEnrichment, toOwnerCommitmentBody } = await import(
  '../src/v1/ownState/enrich.js'
);

const NOW = Date.parse('2026-06-01T16:00:00.000Z');
const ADDRESS = '0x1111111111111111111111111111111111111111';
const CONTEST = 42;
/** PostgREST's documented default response maximum. */
const SERVER_MAX_ROWS = 1000;
/** One more than the maximum: the smallest fixture that can exhibit the defect. */
const TUPLES = SERVER_MAX_ROWS + 1;
/** The drain's own page size — one short of the maximum, deliberately. */
const PAGE = 999;
/** The drain's page budget. */
const MAX_PAGES = 64;

let fake: FakePostgrest;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  vi.useRealTimers();
  await fake?.close();
  vi.clearAllMocks();
});

/** A scorer address that differs per tuple, so every tuple key is distinct. */
const scorerOf = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

/**
 * Exactly the four columns the read selects — no more. A fixture carrying extra
 * columns would let a build that dropped one from its `select` still pass, because
 * the fake answers with whole row objects regardless of the projection. The column
 * list is asserted on the URL instead, which is the only place it is observable.
 */
function specRow(n: number): Record<string, unknown> {
  return {
    speculation_id: n,
    contest_id: CONTEST,
    network: 'polygon',
    speculation_scorer: scorerOf(n),
    line_ticks: 0,
  };
}

function commitmentRow(n: number): Record<string, unknown> {
  return {
    commitment_hash: `0x${n.toString(16).padStart(64, '0')}`,
    maker: ADDRESS,
    contest_id: CONTEST,
    scorer: scorerOf(n),
    line_ticks: 0,
    position_type: 'upper',
    odds_tick: 200,
    market_type: 'moneyline',
    risk_amount: '10000000',
    filled_risk_amount: '0',
    nonce: String(n),
    expiry: '2026-06-01T17:00:00.000Z',
    speculation_key: `0x${'b'.repeat(64)}`,
    signature: `0x${'9'.repeat(130)}`,
    status: 'open',
    source: 'agent',
    network: 'polygon',
    nonce_invalidated: false,
    book_visible: true,
    created_at: '2026-06-01T10:00:00.000Z',
    id: n,
    row_updated_at: '2026-06-01T15:00:00.000Z',
  };
}

const CONTEST_ROWS = [
  {
    contest_id: CONTEST,
    network: 'polygon',
    away_team: 'Away',
    home_team: 'Home',
    sport_slug: 'baseball_mlb',
  },
];
const SPEC_ROWS = Array.from({ length: TUPLES }, (_, i) => specRow(i + 1));
const COMMITMENTS = Array.from({ length: TUPLES }, (_, i) => commitmentRow(i + 1));

/**
 * The real server's behaviour, including the part that matters: filters, then
 * `order`/`limit`, then a SILENT truncation at the response maximum.
 *
 * `cap` is a parameter so the same fixture can run with the maximum lifted. That
 * control is not decoration — it is what proves a failing case fails because of the
 * cap rather than because the fixture, the filters or the tuple keying are wrong
 * (rule 3b: choose inputs where the mechanism under test is the only thing that can
 * produce the answer).
 */
function cappedResponder(cap: number, specSource: readonly unknown[] = SPEC_ROWS) {
  return (req: CapturedRequest): FakeReply => {
    const table = req.path.replace('/rest/v1/', '');
    const source = table === 'contests' ? CONTEST_ROWS : table === 'speculations' ? specSource : [];
    return { body: applyPage(applyFilters(source, req.params), req.params).slice(0, cap) };
  };
}

const specRequests = (f: FakePostgrest): CapturedRequest[] =>
  f.requests.filter((r) => r.path.endsWith('/speculations'));

describe('fetchCommitmentEnrichment against a server that caps its own responses (#101)', () => {
  it('resolves every tuple when the speculations answer fans out past the server maximum', async () => {
    fake = await startFakePostgrest(cappedResponder(SERVER_MAX_ROWS));
    const client: SupabaseClient = createClient(fake.url, 'test-key');

    const enrichment = await fetchCommitmentEnrichment(
      client as never,
      'polygon',
      COMMITMENTS as never,
    );
    expectReached(fake, 2);

    // SETUP FIRST (rule 3g-silentsetup): the fixture must actually be ONE contest
    // with more speculations than the maximum, or there is nothing for the cap to
    // truncate and a green here means nothing.
    expect(new Set(COMMITMENTS.map((r) => r.contest_id)).size).toBe(1);
    expect(SPEC_ROWS).toHaveLength(SERVER_MAX_ROWS + 1);
    // And the request WAS a single 1-id chunk, so `#100`'s id-list chunking is not
    // what is being exercised here.
    expect(specRequests(fake)[0]?.params.get('contest_id')).toBe(`in.(${String(CONTEST)})`);

    // The behaviour under test: every tuple resolves, including the one the
    // single-request build lost.
    expect(enrichment.speculationIdByTuple.size).toBe(TUPLES);
    const last = toOwnerCommitmentBody(COMMITMENTS[TUPLES - 1] as never, NOW, enrichment);
    expect(last.speculationId).toBe(String(TUPLES));
    // Nothing was truncated, so the flag must say so — the negative half of the
    // budget case below (rule 5). A build that hard-coded `true` passes that case
    // and fails here.
    expect(enrichment.speculationsIncomplete).toBe(false);
    expect(loggerMock.logger.warn).not.toHaveBeenCalled();
    // …and the contest context resolved too, which is the SIBLING read (3d-sibling):
    // a fix that paged speculations and broke contests would pass everything above.
    expect(last.sport).toBe('baseball_mlb');
    expect(last.homeTeam).toBe('Home');
  });

  it('asks for the page size, the ordering and the cursor it needs — on the URL', async () => {
    // rule 3c-harness: the URL is the artifact. None of the projection, the sort
    // direction or the continuation is observable in the rows this fake returns,
    // because it answers with whole row objects regardless of `select`.
    fake = await startFakePostgrest(cappedResponder(SERVER_MAX_ROWS));
    const client: SupabaseClient = createClient(fake.url, 'test-key');
    await fetchCommitmentEnrichment(client as never, 'polygon', COMMITMENTS as never);

    const reqs = specRequests(fake);
    expect(reqs).toHaveLength(2); // 1,001 rows over a 999-row page
    for (const r of reqs) {
      // Every column the tuple map and the cursor need. `speculation_id` is both.
      expect(r.params.get('select')).toBe(
        'speculation_id,contest_id,speculation_scorer,line_ticks',
      );
      // One short of the server maximum ON PURPOSE, so a full page is this code's
      // bound and never the server's — 1,000 would make the two indistinguishable.
      expect(r.params.get('limit')).toBe(String(PAGE));
      expect(Number(r.params.get('limit'))).toBeLessThan(SERVER_MAX_ROWS);
      expect(r.params.get('order')).toBe('speculation_id.asc');
      expect(r.params.get('network')).toBe('eq.polygon');
    }
    // Page 1 carries no cursor; page 2 continues STRICTLY past page 1's last row.
    expect(reqs[0]?.params.get('speculation_id')).toBeNull();
    expect(reqs[1]?.params.get('speculation_id')).toBe(`gt.${String(PAGE)}`);
  });

  it('pays no extra request on a population that fits in one page', async () => {
    // The cost note, asserted rather than claimed. Today's densest possible chunk is
    // 473 rows, so the drain must still be ONE request there — a fix that billed a
    // second round trip per chunk on current data would be a per-connect and
    // per-tick cost regression on the only path that actually runs.
    const small = SPEC_ROWS.slice(0, 473);
    fake = await startFakePostgrest(cappedResponder(SERVER_MAX_ROWS, small));
    const client: SupabaseClient = createClient(fake.url, 'test-key');

    const enrichment = await fetchCommitmentEnrichment(
      client as never,
      'polygon',
      COMMITMENTS.slice(0, 473) as never,
    );
    expect(enrichment.speculationIdByTuple.size).toBe(473);
    expect(specRequests(fake)).toHaveLength(1);
    expect(fake.requests.filter((r) => r.path.endsWith('/contests'))).toHaveLength(1);
  });

  it('CONTROL: the same fixture with the maximum lifted resolves in one request', async () => {
    // The negative control for the first case (rule 5). If this failed, that case
    // would be failing for a reason with nothing to do with the cap — a mis-keyed
    // tuple, a wrong scorer case, a broken fixture.
    fake = await startFakePostgrest(cappedResponder(Number.MAX_SAFE_INTEGER));
    const client: SupabaseClient = createClient(fake.url, 'test-key');

    const enrichment = await fetchCommitmentEnrichment(
      client as never,
      'polygon',
      COMMITMENTS as never,
    );
    expect(enrichment.speculationIdByTuple.size).toBe(TUPLES);
    const last = toOwnerCommitmentBody(COMMITMENTS[TUPLES - 1] as never, NOW, enrichment);
    expect(last.speculationId).toBe(String(TUPLES));
  });

  it('stops at the page budget and DEGRADES — it does not throw and does not hang', async () => {
    // The budget's only reachable side. Two things about the shape of this case:
    //
    // The source is effectively endless (it serves a full page for any cursor below
    // a ceiling well ABOVE the budget) rather than literally endless, so a build
    // with the budget REMOVED terminates and fails the page-count assertion instead
    // of hanging. A hang is unscoreable — `verification-discipline.md`'s
    // "mutate a bound away, not up".
    //
    // And it must not throw: `snapshot.ts` turns a throw from this module into HTTP
    // 500 and `stream.ts` into a `resync` the SDK retries with no backoff, so
    // discarding 63,000 resolved tuples over a handful of missing ones would trade a
    // degraded field for a failed connection.
    const CEILING = (MAX_PAGES + 6) * PAGE;
    fake = await startFakePostgrest((req) => {
      const table = req.path.replace('/rest/v1/', '');
      if (table !== 'speculations') return { body: CONTEST_ROWS };
      const raw = req.params.get('speculation_id');
      const after = raw === null ? 0 : Number(raw.replace('gt.', ''));
      if (after >= CEILING) return { body: [] };
      return { body: Array.from({ length: PAGE }, (_, i) => specRow(after + i + 1)) };
    });
    const client: SupabaseClient = createClient(fake.url, 'test-key');

    const enrichment = await fetchCommitmentEnrichment(
      client as never,
      'polygon',
      COMMITMENTS as never,
    );

    expect(specRequests(fake)).toHaveLength(MAX_PAGES);
    expect(enrichment.speculationsIncomplete).toBe(true);
    // The rows gathered up to the budget are still served — degraded, not discarded.
    expect(enrichment.speculationIdByTuple.size).toBe(MAX_PAGES * PAGE);
    // And the operator is told, because nothing on the wire carries this.
    expect(loggerMock.logger.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.logger.warn.mock.calls[0]?.[1]).toContain('page budget exhausted');
  });

  it('throws on a page that does not advance the keyset', async () => {
    // The one way a keyset drain becomes an infinite loop. This throws rather than
    // degrading on purpose: a repeated or unordered page is a code or server defect,
    // not a data condition, so it should redden a test instead of quietly serving
    // less. Every raw row is checked, not just the page's last.
    const samePage = Array.from({ length: PAGE }, (_, i) => specRow(i + 1));
    fake = await startFakePostgrest((req) => {
      const table = req.path.replace('/rest/v1/', '');
      return { body: table === 'speculations' ? samePage : CONTEST_ROWS };
    });
    const client: SupabaseClient = createClient(fake.url, 'test-key');

    await expect(
      fetchCommitmentEnrichment(client as never, 'polygon', COMMITMENTS as never),
    ).rejects.toThrow(/non-advancing keyset page/);
    // Two reads, not sixty-four: it stops at the first page that repeats.
    expect(specRequests(fake)).toHaveLength(2);
  });

  it('skips a row whose speculation_id is present but not a number', async () => {
    // `rowCursor`'s `/^\d+$/` is NOT redundant with its null check, which is what a
    // surviving mutant showed: every fixture above omits the column entirely, so
    // `raw == null` caught them all and the regex was never load-bearing.
    //
    // The two values here are the ones that discriminate, and they fail differently:
    //   ''     -> `BigInt('')` is 0n, so without the regex the row is KEYED and its
    //             map value is the empty string. The market maker's own
    //             `validateSpeculationId` comment names that exact hazard — a blank id
    //             "would silently collapse distinct speculations into one group".
    //   'abc'  -> `BigInt('abc')` THROWS, and nothing in this module catches it, so it
    //             leaves the enrichment as an unhandled error and `snapshot.ts` turns
    //             that into HTTP 500.
    // Neither is reachable from the live schema (`bigint NOT NULL`, served as a JSON
    // number). Both are reachable from a schema or projection change, which is the same
    // producer the cursor guard exists for. Note a widening to `numeric` would arrive
    // as the STRING "992" and is deliberately still accepted.
    const mixed: Array<Record<string, unknown>> = [
      specRow(1),
      { ...specRow(2), speculation_id: '' },
      { ...specRow(3), speculation_id: 'abc' },
      specRow(4),
    ];
    fake = await startFakePostgrest((req) => {
      const table = req.path.replace('/rest/v1/', '');
      return { body: table === 'speculations' ? mixed : CONTEST_ROWS };
    });
    const client: SupabaseClient = createClient(fake.url, 'test-key');

    const enrichment = await fetchCommitmentEnrichment(
      client as never,
      'polygon',
      COMMITMENTS.slice(0, 4) as never,
    );
    expect(enrichment.speculationIdByTuple.size).toBe(2);
    expect([...enrichment.speculationIdByTuple.values()].sort()).toEqual(['1', '4']);
    // Specifically: no key resolved to an empty string.
    expect([...enrichment.speculationIdByTuple.values()]).not.toContain('');
    expect(enrichment.speculationsIncomplete).toBe(false);
  });

  it('throws when the server returns MORE rows than the page it was asked for', async () => {
    // A server that ignores `limit` breaks the one property the page size exists to
    // give: that a response cannot reach the 1,000-row maximum where truncation
    // becomes silent. The drain would still function — it would just be running
    // unbounded again — so this refuses rather than carrying on.
    const oversized = Array.from({ length: PAGE + 501 }, (_, i) => specRow(i + 1));
    fake = await startFakePostgrest((req) => {
      const table = req.path.replace('/rest/v1/', '');
      return { body: table === 'speculations' ? oversized : CONTEST_ROWS };
    });
    const client: SupabaseClient = createClient(fake.url, 'test-key');

    await expect(
      fetchCommitmentEnrichment(client as never, 'polygon', COMMITMENTS as never),
    ).rejects.toThrow(/oversized page/);
  });

  it('throws when a FULL page carries no usable cursor at all', async () => {
    // Reachable only by a code or schema defect — `speculation_id` is
    // `bigint NOT NULL` — and kept because it is what stops a drain that cannot
    // advance from asking for the same page for ever. The realistic producer is a
    // `select` list that stopped naming the cursor column.
    //
    // The page must be FULL. A SHORT page needs no cursor (there is nothing to
    // continue to), and the case below pins that an unkeyable row on a short page is
    // skipped rather than fatal — refusing there would discard every other tuple the
    // call resolved and answer 500 on the snapshot path.
    const cursorless = Array.from({ length: PAGE }, () => ({
      contest_id: CONTEST,
      speculation_scorer: scorerOf(1),
      line_ticks: 0,
    }));
    fake = await startFakePostgrest((req) => {
      const table = req.path.replace('/rest/v1/', '');
      return { body: table === 'speculations' ? cursorless : CONTEST_ROWS };
    });
    const client: SupabaseClient = createClient(fake.url, 'test-key');

    await expect(
      fetchCommitmentEnrichment(client as never, 'polygon', COMMITMENTS as never),
    ).rejects.toThrow(/no usable cursor/);
    expect(specRequests(fake)).toHaveLength(1);
  });

  it('skips an unkeyable row on a SHORT page and still serves the rest', async () => {
    // The other half of the pair (rule 5), and the reason the guard above is scoped
    // to full pages. One row arrives with no `speculation_id`; the tuple map is built
    // from the rest, nothing throws, and nothing is reported incomplete.
    const mixed: Array<Record<string, unknown>> = [
      specRow(1),
      { contest_id: CONTEST, speculation_scorer: scorerOf(2), line_ticks: 0 },
      specRow(3),
    ];
    fake = await startFakePostgrest((req) => {
      const table = req.path.replace('/rest/v1/', '');
      return { body: table === 'speculations' ? mixed : CONTEST_ROWS };
    });
    const client: SupabaseClient = createClient(fake.url, 'test-key');

    const enrichment = await fetchCommitmentEnrichment(
      client as never,
      'polygon',
      COMMITMENTS.slice(0, 3) as never,
    );
    expect(enrichment.speculationIdByTuple.size).toBe(2);
    expect(enrichment.speculationsIncomplete).toBe(false);
    expect(specRequests(fake)).toHaveLength(1);
  });

  it('reports INCOMPLETE — not complete, not a throw — on a non-array page answer', async () => {
    // The shape of this guard is the point. `(data ?? []).length` on a non-array is 0,
    // which is indistinguishable from a short page, so the tolerant reading ends the
    // drain while claiming completeness — the silent truncation this whole change is
    // about. And a throw is not the answer either, because `snapshot.ts` turns one
    // into HTTP 500.
    fake = await startFakePostgrest((req) => {
      const table = req.path.replace('/rest/v1/', '');
      return table === 'speculations'
        ? { body: { message: 'not an array' } }
        : { body: CONTEST_ROWS };
    });
    const client: SupabaseClient = createClient(fake.url, 'test-key');

    const enrichment = await fetchCommitmentEnrichment(
      client as never,
      'polygon',
      COMMITMENTS as never,
    );
    expect(enrichment.speculationsIncomplete).toBe(true);
    expect(enrichment.speculationIdByTuple.size).toBe(0);
    // The sibling contests read still resolved, so the commitment is served with its
    // teams and a null speculationId rather than dropped.
    expect(enrichment.contestById.size).toBe(1);
    expect(loggerMock.logger.warn).toHaveBeenCalledTimes(1);
    expect(specRequests(fake)).toHaveLength(1);
  });
});
