/**
 * What the tests of the connector's three tools share: a way to run a tool
 * against a database it can actually reach, and one small book to run it on.
 *
 * {@link harness} stands the REAL `@supabase/supabase-js` client against a fake
 * PostgREST socket and hands back the tool functions with a fixed clock. A case
 * then asserts two things: the text the tool answered with, as a literal, and
 * the requests the database received, as captured on its side of the wire.
 *
 * The second matters as much as the first. The tools' safety rests on filters
 * a chainable stub would happily ignore — `book_visible`, `nonce_invalidated`,
 * `expiry`, `contest_status` — so they are asserted where they arrive.
 *
 * The clock is an argument, not a fake timer: `NOW_MS` is 8:00 am Eastern on
 * Sunday 27 September 2026, and first pitch in the fixture is 3:05 pm.
 */
import { vi } from 'vitest';
import type { CapturedRequest, FakePostgrest, FakeReply } from './fakePostgrest.js';
import {
  KEYS,
  MAKER_B,
  NETWORK,
  NOW_MS,
  SCORERS,
  configFor,
  contestRow,
  fundingRow,
  hash,
  quoteRow,
  speculationRow,
  startBook,
  type Row,
  type Tables,
} from './mcpBook.js';

const open: FakePostgrest[] = [];

/** Close every database a case opened, and forget the modules it loaded. For `afterEach`. */
export async function closeHarnesses(): Promise<void> {
  for (const fake of open.splice(0)) await fake.close();
  vi.doUnmock('../../src/lib/env.js');
  vi.doUnmock('../../src/lib/logger.js');
  vi.resetModules();
}

/**
 * Load the tools once, under a time limit of its own. For `beforeAll`.
 *
 * The first import of the tools is the expensive one: every module behind them
 * is transformed before it can run. Without this the first case of a file
 * carries that cost inside its own limit, and on a busy machine goes over it.
 */
export async function warmTools(): Promise<void> {
  await import('../../src/mcp/tools/listMarkets.js');
  await import('../../src/mcp/tools/prepareOrder.js');
  await import('../../src/mcp/tools/getOrderStatus.js');
  vi.resetModules();
}

export interface Harness {
  fake: FakePostgrest;
  log: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  ctx: import('../../src/mcp/context.js').ToolContext;
  listMarkets: typeof import('../../src/mcp/tools/listMarkets.js').listMarkets;
  prepareOrder: typeof import('../../src/mcp/tools/prepareOrder.js').prepareOrder;
  getOrderStatus: typeof import('../../src/mcp/tools/getOrderStatus.js').getOrderStatus;
}

export async function harness(
  tables: Tables,
  options: {
    override?: (request: CapturedRequest, index: number) => FakeReply | undefined;
    config?: Row;
    context?: Partial<import('../../src/mcp/context.js').ToolContext>;
  } = {},
): Promise<Harness> {
  const fake = await startBook(tables, options.override);
  open.push(fake);
  const config = configFor(fake, options.config);
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

  // A fresh module graph per case: the database client is memoised, and the
  // one from the last case points at a socket that has since closed.
  vi.resetModules();
  vi.doMock('../../src/lib/env.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/lib/env.js')>()),
    loadConfig: () => config,
  }));
  vi.doMock('../../src/lib/logger.js', () => ({ logger: log, formatError: String }));

  const { getSupabase } = await import('../../src/lib/supabase.js');
  const { listMarkets } = await import('../../src/mcp/tools/listMarkets.js');
  const { prepareOrder } = await import('../../src/mcp/tools/prepareOrder.js');
  const { getOrderStatus } = await import('../../src/mcp/tools/getOrderStatus.js');

  return {
    fake,
    log,
    ctx: {
      sb: getSupabase(),
      network: NETWORK,
      scorers: { ...SCORERS },
      takeLinkBaseUrl: 'https://ospex.org',
      nowMs: NOW_MS,
      ...options.context,
    },
    listMarkets,
    prepareOrder,
    getOrderStatus,
  };
}

// ── the fixture ────────────────────────────────────────────────────────
//
// One game, three lines, four quotes. Every quote has its own price and its
// own size, so an answer that read the wrong one shows a wrong number.

export const MONEYLINE = speculationRow({
  speculation_id: 1000,
  speculation_scorer: SCORERS.moneyline,
  market_type: 'moneyline',
  line_ticks: 0,
});
export const TOTAL_7 = speculationRow({ speculation_id: 1001 });
export const SPREAD = speculationRow({
  speculation_id: 1002,
  speculation_scorer: SCORERS.spread,
  market_type: 'spread',
  line_ticks: -15,
});

/** Maker A on the Over at 2.05, 5 USDC: a reader takes the Under at 1.95, up to 5.25. */
export const UNDER_QUOTE = quoteRow();
/** Maker B on the Under at 1.91, 10 USDC: a reader takes the Over at 2.10, up to 9.10. */
export const OVER_QUOTE = quoteRow({
  commitment_hash: hash('a2'),
  maker: MAKER_B,
  position_type: 'lower',
  odds_tick: 191,
  risk_amount: '10000000',
});
/** Maker A on the away team at 2.50, 4 USDC: a reader takes the home team at 1.67, up to 6.00. */
export const HOME_QUOTE = quoteRow({
  commitment_hash: hash('a3'),
  scorer: SCORERS.moneyline,
  market_type: 'moneyline',
  line_ticks: 0,
  position_type: 'upper',
  odds_tick: 250,
  risk_amount: '4000000',
  speculation_key: KEYS['c481-moneyline'],
});
/** Maker A on the home team at 1.60, 3 USDC: a reader takes the away team at 2.67, up to 1.80. */
export const AWAY_QUOTE = quoteRow({
  commitment_hash: hash('a4'),
  scorer: SCORERS.moneyline,
  market_type: 'moneyline',
  line_ticks: 0,
  position_type: 'lower',
  odds_tick: 160,
  risk_amount: '3000000',
  speculation_key: KEYS['c481-moneyline'],
});

export const BOOK: Tables = {
  contests_effective: [contestRow()],
  speculations: [TOTAL_7, MONEYLINE, SPREAD],
  commitments: [UNDER_QUOTE, OVER_QUOTE, HOME_QUOTE, AWAY_QUOTE],
  maker_funding: [fundingRow(), fundingRow({ maker_address: MAKER_B })],
};

export function lines(...text: string[]): string {
  return text.join('\n');
}

export const GAME = 'Tampa Bay Rays @ Philadelphia Phillies';
export const PLACED_NOTHING = 'No order was prepared, and nothing was placed.';
export const READ_FAILED =
  'Ospex could not read its order book just now. Nothing was placed. Try again in a moment.';

/** The order most cases prepare: 2 USDC on the Under. */
export const UNDER_2 = { contestId: '481', market: 'total', side: 'under', riskUsdc: 2, line: undefined } as const;
