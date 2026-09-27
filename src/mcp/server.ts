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
 * ## What the tools take
 *
 * An argument a tool does not have is refused, not ignored. A caller that
 * passes `commitment_hash` to `prepare_order` believing it pins a quote is
 * told that it does not. `contest_id` is read from a number as well as from a
 * string, because the listing prints it bare and a caller copies what it sees.
 *
 * An optional argument sent as `null` is refused, as the advertised schema says
 * it is not nullable: a caller leaves it out. `risk_usdc` is a number and is
 * not read from a string.
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
  "get_order_status, called with that person's wallet address, lists a fill by that address made after",
  'the order was prepared. A fill by any other address is somebody else taking the same quote, and a',
  'fill from before the order was prepared is an earlier order.',
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
 * it, which run on until they finish or fail by themselves. The race below
 * stays subscribed to that work, so what it fails with afterwards is handled.
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
        'as decimal odds rounded to two places, with the most one order can risk at each price. Only verified ' +
        'games more than two minutes from their start are listed, and only lines that already exist ' +
        'on-chain. Reading the list places nothing. Each game carries the contest_id that prepare_order takes.',
      inputSchema: z
        .object({
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
        })
        .strict(),
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
        'is paid and what is won, and checks that the game is verified and is not about to start and that the ' +
        'quote is open. If no single quote can fill the amount, the order is prepared for the most one can, ' +
        'and the preview says so. Nothing is placed and nothing is stored: the order is placed only when a ' +
        'person opens the link and confirms in their own wallet. The preview is as of the moment it is made: ' +
        'the quote can be taken by someone else, cancelled on-chain or expire before the link is used, and ' +
        'the transaction then fails and costs only gas.',
      inputSchema: z
        .object({
          contest_id: z
            .preprocess(
              // A whole number past 2^53 was rounded when it was parsed, so its
              // digits are not the ones that were sent. It is left a number, for
              // the schema to refuse.
              (value) =>
                typeof value === 'number' && !(Number.isInteger(value) && !Number.isSafeInteger(value))
                  ? String(value)
                  : value,
              z.string().max(24),
            )
            .describe('The contest_id list_markets shows for the game, such as "481".'),
          market: z.enum(['moneyline', 'spread', 'total']).describe('The market: moneyline, spread or total.'),
          side: z
            .string()
            .min(1)
            .max(80)
            .describe(
              'The side to back, by itself. For a total: over or under. For a moneyline or spread: a team name ' +
                'such as "Phillies", or away or home. The line goes in line, not here.',
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
        })
        .strict(),
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
        'Reports where a posted quote stands (open, partially filled, filled, cancelled, expired or withdrawn) ' +
        'and lists the fills on it: who took it, how much they risked and stand to win, when, and in which ' +
        'transaction. Without a wallet address the fills are every taker\'s, so a filled quote is not proof ' +
        'that one person\'s order went through. With a wallet address it lists only that wallet\'s fills, ' +
        'and a take went through if one of them was made after its order was prepared. A fill is listed ' +
        'once its block is final, usually within about 15 seconds of the transaction confirming, so a take ' +
        'that has only just confirmed may not be listed yet.',
      inputSchema: z
        .object({
          commitment_hash: z
            .string()
            .max(80)
            .describe('The commitment_hash prepare_order returned: 0x followed by 64 hex characters.'),
          taker_address: z
            .string()
            .max(60)
            .optional()
            .describe('A wallet address, to list only the fills that wallet made.'),
        })
        .strict(),
      annotations: READ_ONLY,
    },
    (args) =>
      served('get_order_status', deadlineMs, () =>
        getOrderStatus({ commitmentHash: args.commitment_hash, takerAddress: args.taker_address }, context()),
      ),
  );

  return server;
}
