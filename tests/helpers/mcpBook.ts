/**
 * A small synthetic book for the connector's tests: rows shaped as the database
 * serves them, and a fake PostgREST that answers from them.
 *
 * Every identifier here is made up. The scorer addresses are repeated digits,
 * the hashes are repeated bytes, and the speculation keys were computed once,
 * outside this repo's code, from those made-up inputs — they are literals, so
 * the join under test is checked against a value it did not produce.
 */

import {
  applyFilters,
  applyPage,
  startFakePostgrest,
  type CapturedRequest,
  type FakePostgrest,
  type FakeReply,
} from './fakePostgrest.js';

export const NETWORK = 'polygon';

export const SCORERS = {
  moneyline: '0x1111111111111111111111111111111111111111',
  spread: '0x2222222222222222222222222222222222222222',
  total: '0x3333333333333333333333333333333333333333',
} as const;

/** keccak256(abi.encode(uint256 contestId, address scorer, int32 lineTicks)) for the fixture's lines. */
export const KEYS = {
  'c481-moneyline': '0xeeb245b739e8f43ae6b5300bb19599b072000abb52ca86ac948f32c891c62430',
  'c481-total-70': '0x09da056ea908a649656a37d2c1b2a71bf629855eb8226256fda3b9a3e71dd6f8',
  'c481-total-75': '0xe1b63de02e3fa895b6d870d837f971130d92feebe20c63daa64e603e4668dc03',
  'c481-spread--15': '0x17793222ee94f544801b47be3f74d2893beb54ed7544b385cb595131d2b12e5e',
  'c481-spread-15': '0x177ee04e65a973d8cd8d480ebf9823672d0ff18abbcbf633f0c9fac35d049ee4',
  'c481-total-80': '0x4b3cc31ef99502a41d98cf9f44c958944991726076375a47d1f3ed0b0de50efe',
  'c482-moneyline': '0xee72c216120938970016baca1213b8edfaee68ffa646c53d9a6166048b994924',
  'c482-total-85': '0x22959082f07771ea03546ea705658a8c2f6181ac55383bf2a48d6edb5f740985',
  'c483-moneyline': '0x83d48fa463087de2beae902e7cc753b9ff97ed306542947b148db6c78eaadad8',
} as const;

export const MAKER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const MAKER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const TAKER = '0xcccccccccccccccccccccccccccccccccccccccc';
export const SIGNATURE = `0x${'5a'.repeat(65)}`;

/**
 * The instant the fixture calls "now": Sunday 27 September 2026, 12:00:00 UTC,
 * which is 8:00 am Eastern.
 */
export const NOW_MS = Date.UTC(2026, 8, 27, 12, 0, 0);
/** First pitch: 19:05 UTC the same day, 3:05 pm Eastern. */
export const START = '2026-09-27T19:05:00+00:00';
/** The quotes' expiry: ten minutes before first pitch, 2:55 pm Eastern. */
export const EXPIRY = '2026-09-27T18:55:00+00:00';

export type Row = Record<string, unknown>;

/** A hash made of one repeated byte: `hash('a1')` is `0xa1a1…a1`. */
export function hash(byte: string): string {
  return `0x${byte.repeat(32)}`;
}

export function contestRow(over: Row = {}): Row {
  return {
    network: NETWORK,
    contest_id: 481,
    jsonodds_id: '11111111-2222-3333-4444-555555555555',
    away_team: 'Tampa Bay Rays',
    home_team: 'Philadelphia Phillies',
    sport_slug: 'mlb',
    jsonodds_sport_id: 0,
    start_time: START,
    effective_start_time: START,
    game_match_time: START,
    game_earliest_match_time: START,
    game_rundown_match_time: START,
    game_sportspage_match_time: START,
    contest_status: 'verified',
    ...over,
  };
}

export function speculationRow(over: Row = {}): Row {
  return {
    network: NETWORK,
    speculation_id: 1001,
    contest_id: 481,
    speculation_scorer: SCORERS.total,
    market_type: 'total',
    line_ticks: 70,
    speculation_status: 'open',
    win_side: 'tbd',
    settled_at: null,
    voided: false,
    ...over,
  };
}

/**
 * A posted quote. The default is a maker on the OVER of total 7.0 at 2.05 with
 * 5.000000 USDC of risk, none of it taken — so a reader who takes it is on the
 * Under at 1.95.
 */
export function quoteRow(over: Row = {}): Row {
  return {
    network: NETWORK,
    commitment_hash: hash('a1'),
    maker: MAKER_A,
    contest_id: 481,
    scorer: SCORERS.total,
    line_ticks: 70,
    position_type: 'upper',
    odds_tick: 205,
    market_type: 'total',
    risk_amount: '5000000',
    filled_risk_amount: '0',
    nonce: '1790000000',
    expiry: EXPIRY,
    speculation_key: KEYS['c481-total-70'],
    signature: SIGNATURE,
    status: 'open',
    source: 'agent',
    nonce_invalidated: false,
    book_visible: true,
    created_at: '2026-09-27T02:00:00.123456+00:00',
    ...over,
  };
}

export function fundingRow(over: Row = {}): Row {
  return {
    network: NETWORK,
    maker_address: MAKER_A,
    backing_wei6: '1000000000',
    visible_committed_wei6: '10000000',
    checked_at_block: 80000000,
    // Thirty seconds before the fixture's "now".
    updated_at: '2026-09-27T11:59:30+00:00',
    ...over,
  };
}

export function fillRow(over: Row = {}): Row {
  return {
    network: NETWORK,
    id: 1,
    row_updated_at: '2026-09-27T13:00:05.000001+00:00',
    speculation_id: 1001,
    contest_id: 481,
    commitment_hash: hash('a1'),
    maker_address: MAKER_A,
    taker_address: TAKER,
    maker_position_type: 'upper',
    taker_position_type: 'lower',
    maker_risk_amount: '1904700',
    taker_risk_amount: '1999935',
    odds_tick: 205,
    filled_at: '2026-09-27T13:00:00+00:00',
    contest_started: false,
    tx_hash: hash('f1'),
    log_index: 12,
    ...over,
  };
}

export interface Tables {
  contests_effective?: Row[];
  speculations?: Row[];
  commitments?: Row[];
  maker_funding?: Row[];
  position_fills?: Row[];
}

export function tableOf(request: CapturedRequest): string {
  return /^\/rest\/v1\/([^/?]+)/.exec(request.path)?.[1] ?? '';
}

/**
 * A fake PostgREST over `tables` that applies the top-level filters, the order
 * and the limit of each request, and answers a `count=exact` read with the
 * count of the rows its filters selected.
 *
 * `override` answers a request itself when it returns a reply.
 */
export async function startBook(
  tables: Tables,
  override?: (request: CapturedRequest, index: number) => FakeReply | undefined,
): Promise<FakePostgrest> {
  return startFakePostgrest((request, index) => {
    const forced = override?.(request, index);
    if (forced !== undefined) return forced;
    const rows = (tables as Record<string, Row[] | undefined>)[tableOf(request)] ?? [];
    const filtered = applyFilters(rows, request.params);
    const page = applyPage(filtered, request.params);
    if (String(request.headers['prefer'] ?? '').includes('count=exact')) {
      const last = page.length === 0 ? '*' : `0-${String(page.length - 1)}`;
      return { status: 200, body: page, contentRange: `${last}/${String(filtered.length)}` };
    }
    // `.maybeSingle()` asks for an object, not a list.
    if (String(request.headers['accept'] ?? '').includes('vnd.pgrst.object')) {
      if (page.length === 1) return { body: page[0] };
      return {
        status: 406,
        body: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${String(page.length)} rows`, hint: null },
      };
    }
    return { body: page };
  });
}

/** The config the connector's modules read, pointed at a fake. */
export function configFor(fake: FakePostgrest, over: Row = {}): Row {
  return {
    port: 0,
    nodeEnv: 'test',
    supabaseUrl: fake.url,
    supabaseServiceRoleKey: 'test-key',
    network: NETWORK,
    chainId: 137,
    scorers: { ...SCORERS },
    matchingModuleAddress: '0x4444444444444444444444444444444444444444',
    redactHiddenPublic: true,
    mcpTakeLinkBaseUrl: 'https://ospex.org',
    ...over,
  };
}
