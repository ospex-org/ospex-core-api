/**
 * The connector's MCP server: three read-only tools over the public order
 * book.
 *
 * Built fresh for every request. The transport it is connected to is stateless
 * and single-use, and a server can be connected to one transport at a time, so
 * a shared instance would fail the second of two overlapping requests.
 * Building one costs well under a millisecond and reads nothing.
 *
 * ## What the tools answer with
 *
 * One block of text per call, and nothing else. No output schema and no
 * structured content: a client that is given both shows its model one of them,
 * and which one differs between clients. Everything a later call needs is a
 * labelled line in the text.
 *
 * ## What reaches the caller when something breaks
 *
 * A message thrown inside a tool is sent to the caller as written, so nothing
 * is allowed to throw past {@link served}: a failure is logged in full and
 * answered with fixed wording.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { formatError, logger } from '../lib/logger.js';
import type { ToolAnswer, ToolContext } from './context.js';
import { getOrderStatus } from './tools/getOrderStatus.js';
import { DEFAULT_WINDOW_HOURS, MAX_WINDOW_HOURS, listMarkets } from './tools/listMarkets.js';
import { prepareOrder } from './tools/prepareOrder.js';

export const SERVER_NAME = 'ospex';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = [
  'Ospex is a peer-to-peer sports betting protocol on Polygon. These tools read its public order book.',
  'They place nothing, sign nothing and hold no funds. A bet is placed only when a person opens a take link',
  'and confirms the transaction in their own wallet, so a prepared order is not a placed one until',
  'get_order_status lists its fill.',
  'Prices are decimal odds for the person taking the quote. Amounts are USDC.',
].join(' ');

/** Every tool here only reads, reads the same thing twice, and reads Ospex's own records. */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const FAILED = 'Something went wrong on the Ospex side. Nothing was placed. Try again in a moment.';
const TOO_SLOW = 'Ospex is taking too long to answer. Nothing was placed. Try again in a moment.';

/**
 * How long a tool call may take before it is answered for: 20 seconds.
 *
 * Under the 30 seconds after which the platform's router gives up on a request
 * and answers it itself, in a shape no client of this protocol can read. The
 * database client retries a read that fails in transit, waiting 1, 2 and then
 * 4 seconds, so one struggling read is seven seconds and four of them in a row
 * are most of the router's budget.
 *
 * Passing the deadline answers the CALL. It does not cancel the reads behind
 * it, which run on until they finish or fail by themselves.
 */
export const TOOL_DEADLINE_MS = 20_000;

const LATE = Symbol('late');

/** Run a tool and turn whatever happens into a tool result. */
async function served(
  tool: string,
  deadlineMs: number,
  run: () => Promise<ToolAnswer>,
): Promise<CallToolResult> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = run();
    // Work that loses to the deadline is still running. Whatever it fails
    // with afterwards has nobody left to catch it but this.
    work.catch(() => undefined);
    const late = new Promise<typeof LATE>((resolve) => {
      timer = setTimeout(() => resolve(LATE), deadlineMs);
    });
    const result = await Promise.race([work, late]);
    if (result === LATE) {
      logger.error({ tool, ms: Date.now() - startedAt }, 'mcp: tool call passed its deadline');
      return { content: [{ type: 'text', text: TOO_SLOW }], isError: true };
    }
    logger.info({ tool, isError: result.isError, ms: Date.now() - startedAt }, 'mcp: tool call');
    return {
      content: [{ type: 'text', text: result.text }],
      ...(result.isError ? { isError: true } : {}),
    };
  } catch (err) {
    logger.error({ tool, err: formatError(err), ms: Date.now() - startedAt }, 'mcp: tool call failed');
    return { content: [{ type: 'text', text: FAILED }], isError: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `context` is called once per tool call, so each call reads the clock once
 * and every comparison in it agrees with every other.
 */
export function buildMcpServer(
  context: () => ToolContext,
  deadlineMs: number = TOOL_DEADLINE_MS,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: 'Ospex', version: SERVER_VERSION, websiteUrl: 'https://ospex.org' },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'list_markets',
    {
      title: 'List Ospex markets',
      description:
        'Lists the games starting soon on Ospex, with the lines that exist on-chain for each and the prices ' +
        'posted on both sides of every line. Prices are shown from the side of the person taking the quote, ' +
        'as decimal odds, with the most one order can risk at each price. Only verified games that have not ' +
        'started are listed, and only lines that already exist on-chain. Reading the list places nothing. ' +
        'Each game carries the contest_id that prepare_order takes.',
      inputSchema: {
        window_hours: z
          .number()
          .int()
          .min(1)
          .max(MAX_WINDOW_HOURS)
          .default(DEFAULT_WINDOW_HOURS)
          .describe('How far ahead to look, in hours, from 1 to 168. Defaults to 48.'),
        sport: z
          .string()
          .max(16)
          .optional()
          .describe('One sport to list: mlb, nba, ncaab, ncaaf, nfl or nhl. Leave out for all of them.'),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      served('list_markets', deadlineMs, () =>
        listMarkets({ windowHours: args.window_hours, sport: args.sport }, context()),
      ),
  );

  server.registerTool(
    'prepare_order',
    {
      title: 'Prepare an Ospex order',
      description:
        'Prepares an order to take a posted quote at its posted price, and returns a preview and a take link. ' +
        'It chooses the best-priced quote on the side named that can fill the amount, works out exactly what ' +
        'is paid and what is won, and checks that the game is verified and has not started and that the quote ' +
        'is open. If no single quote can fill the amount, the order is prepared for the most one can, and the ' +
        'preview says so. Nothing is placed and nothing is stored: the order is placed only when a person opens ' +
        'the link and confirms in their own wallet.',
      inputSchema: {
        contest_id: z.string().max(24).describe('The contest_id list_markets shows for the game, such as "481".'),
        market: z.enum(['moneyline', 'spread', 'total']).describe('The market: moneyline, spread or total.'),
        side: z
          .string()
          .min(1)
          .max(80)
          .describe(
            'The side to back. For a total: over or under. For a moneyline or spread: a team name such as ' +
              '"Phillies", or away or home.',
          ),
        risk_usdc: z
          .number()
          .positive()
          .max(1_000_000)
          .describe('How much USDC to risk, such as 10 or 2.5. At most six decimal places.'),
        line: z
          .number()
          .min(-100_000)
          .max(100_000)
          .optional()
          .describe(
            'The line, when a game has more than one in the market. A total as the number of points (7.5). ' +
              'A spread as the handicap of the side being backed (-1.5).',
          ),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      served('prepare_order', deadlineMs, () =>
        prepareOrder(
          {
            contestId: args.contest_id,
            market: args.market,
            side: args.side,
            riskUsdc: args.risk_usdc,
            line: args.line,
          },
          context(),
        ),
      ),
  );

  server.registerTool(
    'get_order_status',
    {
      title: 'Get Ospex order status',
      description:
        'Reports where a posted quote stands (open, partially filled, filled, cancelled or expired) and lists ' +
        'the fills on it: who took it, how much they risked and stand to win, when, and in which transaction. ' +
        'With a wallet address it lists only that wallet\'s fills, which is how to see whether a take went ' +
        'through. A fill is listed once its block is final, usually within about 15 seconds of the ' +
        'transaction confirming, so a take that has only just confirmed may not be listed yet.',
      inputSchema: {
        commitment_hash: z
          .string()
          .max(80)
          .describe('The commitment_hash prepare_order returned: 0x followed by 64 hex characters.'),
        taker_address: z
          .string()
          .max(60)
          .optional()
          .describe('A wallet address, to list only the fills that wallet made.'),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      served('get_order_status', deadlineMs, () =>
        getOrderStatus({ commitmentHash: args.commitment_hash, takerAddress: args.taker_address }, context()),
      ),
  );

  return server;
}
