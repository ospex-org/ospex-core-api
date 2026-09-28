/**
 * `/mcp`, from a client's seat.
 *
 * Every case here starts the REAL app — `buildApp`, with its own middleware in
 * its own order — on a real socket, and talks to it the way a client does: the
 * reference MCP client for the protocol, plain `fetch` for the HTTP around it.
 * The database behind the app is the real database client against a fake
 * PostgREST socket.
 *
 * What that buys over driving the router by hand: the mount itself is under
 * test. A route registered after the app's 404, or behind the app's JSON
 * parser, fails here and would pass anywhere else.
 *
 * The clock is the real one, because the app reads it. So the fixture is built
 * around "now" when a case starts, and assertions about time are about order
 * (starts later, expires sooner), never about a printed hour. The printed
 * forms are pinned in `mcp-list-markets.test.ts`, `mcp-prepare-order.test.ts`
 * and `mcp-order-status.test.ts`, which pass the clock in.
 */
import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect as openSocket, type AddressInfo, type Socket } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectReached, type CapturedRequest, type FakePostgrest, type FakeReply } from './helpers/fakePostgrest.js';
import {
  KEYS,
  MAKER_A,
  NETWORK,
  SCORERS,
  TAKER,
  configFor,
  contestRow,
  fillRow,
  fundingRow,
  hash,
  quoteRow,
  speculationRow,
  startBook,
  tableOf,
  type Row,
  type Tables,
} from './helpers/mcpBook.js';

const fakes: FakePostgrest[] = [];
const servers: Server[] = [];
const clients: Client[] = [];
const sockets: Socket[] = [];

/**
 * The first import of the app is the expensive one: every module behind
 * `buildApp` is transformed before it can run. Whichever case came first used
 * to carry that cost inside its own time limit. Measured in a Linux container
 * on Node 20.19 with the whole suite running beside it, that case took 4.0 to
 * 5.3 seconds against the 5 second default, and timed out in one run of four.
 *
 * So the cost is paid here, once, under a limit of its own. The default limit
 * on every case is left as it is, so that it measures the case.
 */
beforeAll(async () => {
  await import('../src/app.js');
  vi.resetModules();
}, 60_000);

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const fake of fakes.splice(0)) await fake.close();
  vi.doUnmock('../src/lib/env.js');
  vi.doUnmock('../src/lib/logger.js');
  vi.doUnmock('../src/mcp/server.js');
  vi.resetModules();
});

function iso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString().replace('Z', '+00:00');
}

const HOUR = 3_600_000;

/** One game starting in six hours, one line, one quote on each side of it. */
function liveBook(): Tables {
  const start = iso(6 * HOUR);
  return {
    contests_effective: [
      contestRow({
        start_time: start,
        effective_start_time: start,
        game_match_time: start,
        game_earliest_match_time: start,
        game_rundown_match_time: start,
        game_sportspage_match_time: start,
      }),
    ],
    speculations: [speculationRow()],
    commitments: [
      quoteRow({ expiry: iso(5 * HOUR) }),
      quoteRow({
        commitment_hash: hash('a2'),
        position_type: 'lower',
        odds_tick: 191,
        risk_amount: '10000000',
        expiry: iso(5 * HOUR),
      }),
    ],
    maker_funding: [fundingRow({ updated_at: iso(-30_000) })],
    position_fills: [fillRow({ filled_at: iso(-HOUR), row_updated_at: iso(-HOUR) })],
  };
}

type BuildServer = typeof import('../src/mcp/server.js').buildMcpServer;

interface Running {
  url: string;
  fake: FakePostgrest;
  log: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  /** Called once each time the route builds a server to serve a request. */
  built: ReturnType<typeof vi.fn>;
}

async function run(
  tables: Tables,
  options: {
    override?: (request: CapturedRequest, index: number) => FakeReply | undefined;
    config?: Row;
    /** Stands in for the server builder. It is given the real one. */
    buildServer?: (real: BuildServer) => BuildServer;
  } = {},
): Promise<Running> {
  const fake = await startBook(tables, options.override);
  fakes.push(fake);
  const config = configFor(fake, options.config);
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), fatal: vi.fn() };
  const built = vi.fn();

  vi.resetModules();
  vi.doMock('../src/lib/env.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/lib/env.js')>()),
    loadConfig: () => config,
  }));
  vi.doMock('../src/lib/logger.js', () => ({ logger: log, formatError: String }));
  // The real builder, counted. Nothing about the server it returns is changed
  // unless a case asks for that.
  vi.doMock('../src/mcp/server.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../src/mcp/server.js')>();
    const build = options.buildServer?.(original.buildMcpServer) ?? original.buildMcpServer;
    const counted: BuildServer = (...args) => {
      built();
      return build(...args);
    };
    return { ...original, buildMcpServer: counted };
  });

  const { buildApp } = await import('../src/app.js');
  const app = buildApp(config as unknown as Parameters<typeof buildApp>[0]);
  const server = createServer(app);
  // The listener and every socket it accepts, or a passing suite hangs at exit.
  server.on('connection', (socket) => socket.unref());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  server.unref();
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, fake, log, built };
}

interface Answer {
  status: number;
  contentType: string | null;
  /** The body as sent, and parsed when there was one. */
  text: string;
  body: unknown;
  /** What the `mcp: request` line carried for this request. */
  line: Record<string, unknown>;
}

/**
 * POST to `/mcp` and wait for the request's line in the log.
 *
 * The log is cleared first, so everything in it afterwards is this request's.
 * Not for a request that writes no line: a 405 and a 429 do not.
 *
 * A request that is never answered fails here, as a request that was given up
 * on after four seconds, rather than holding the case to its own time limit.
 */
async function post(running: Running, init: { headers?: Record<string, string>; body?: string | Uint8Array }): Promise<Answer> {
  running.log.info.mockClear();
  running.log.warn.mockClear();
  running.log.error.mockClear();
  running.built.mockClear();
  const response = await fetch(`${running.url}/mcp`, {
    method: 'POST',
    headers: init.headers ?? JSON_RPC_HEADERS,
    ...(init.body === undefined ? {} : { body: init.body }),
    signal: AbortSignal.timeout(4_000),
  });
  const text = await response.text();
  await vi.waitFor(() => {
    expect(running.log.info).toHaveBeenCalledWith(expect.anything(), 'mcp: request');
  });
  const lines = running.log.info.mock.calls.filter((call) => call[1] === 'mcp: request');
  expect(lines).toHaveLength(1);
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    text,
    body: text === '' ? undefined : (JSON.parse(text) as unknown),
    line: lines[0]?.[0] as Record<string, unknown>,
  };
}

/**
 * As {@link post}, with the Content-Type sent exactly as given. `fetch` may
 * put a type of its own in place of an empty one; `node:http` sends what it is
 * handed, an empty value included. A list is sent as that many Content-Type
 * headers, in its order.
 */
async function postWithContentType(
  running: Running,
  contentType: string | readonly string[],
  body: string,
): Promise<Answer> {
  running.log.info.mockClear();
  running.log.warn.mockClear();
  running.log.error.mockClear();
  running.built.mockClear();
  const { status, type, text } = await new Promise<{ status: number; type: string | null; text: string }>(
    (resolve, reject) => {
      const request = httpRequest(
        `${running.url}/mcp`,
        {
          method: 'POST',
          headers: {
            'content-type': typeof contentType === 'string' ? contentType : [...contentType],
            accept: 'application/json, text/event-stream',
            'content-length': String(Buffer.byteLength(body)),
          },
          signal: AbortSignal.timeout(4_000),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              type: response.headers['content-type'] ?? null,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      request.end(body);
    },
  );
  await vi.waitFor(() => {
    expect(running.log.info).toHaveBeenCalledWith(expect.anything(), 'mcp: request');
  });
  const lines = running.log.info.mock.calls.filter((call) => call[1] === 'mcp: request');
  expect(lines).toHaveLength(1);
  return {
    status,
    contentType: type,
    text,
    body: text === '' ? undefined : (JSON.parse(text) as unknown),
    line: lines[0]?.[0] as Record<string, unknown>,
  };
}

/** Every argument of every call to the log, at every level, as one lower-case string. */
function everythingLogged(running: Running): string {
  return JSON.stringify([
    running.log.info.mock.calls,
    running.log.warn.mock.calls,
    running.log.error.mock.calls,
  ]).toLowerCase();
}

async function connect(running: Running, path = '/mcp'): Promise<Client> {
  const client = new Client({ name: 'endpoint-test', version: '0.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(running.url + path)) as Transport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((block) => block.text ?? '').join('\n');
}

const JSON_RPC_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

function rpc(method: string, params: unknown, id = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

/** A tools/list request padded to exactly `bytes` bytes. */
function paddedToolsList(bytes: number): string {
  const frame = rpc('tools/list', { pad: '' });
  return rpc('tools/list', { pad: 'x'.repeat(bytes - Buffer.byteLength(frame)) });
}

/** The head of a POST to `/mcp`, with the framing header given and no body. */
function requestHead(framing: string): string {
  return (
    'POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n' +
    `Accept: application/json, text/event-stream\r\n${framing}\r\n\r\n`
  );
}

interface RawAnswer {
  status: number;
  body: unknown;
}

interface RawConnection {
  /** Answers in the order they arrived. Each must state a Content-Length. */
  answers: RawAnswer[];
  /** Resolves once the socket will take more, or once it has closed. */
  write: (data: string) => Promise<void>;
}

/**
 * A connection written to by hand, for a request a client library would not
 * send: a head with no body after it, or a body that does not end.
 */
async function rawConnection(running: Running): Promise<RawConnection> {
  running.log.info.mockClear();
  running.log.warn.mockClear();
  running.log.error.mockClear();
  running.built.mockClear();
  const socket = openSocket(Number(new URL(running.url).port), '127.0.0.1');
  sockets.push(socket);
  // A socket the server has stopped reading may fail a late write. That is
  // not what any case here is about.
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));

  const answers: RawAnswer[] = [];
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buffered.subarray(0, end).toString('latin1');
      const length = Number(/^content-length:\s*(\d+)$/im.exec(head)?.[1]);
      if (!Number.isInteger(length) || buffered.length < end + 4 + length) return;
      answers.push({
        status: Number(head.split(' ')[1]),
        body: JSON.parse(buffered.subarray(end + 4, end + 4 + length).toString('utf8')) as unknown,
      });
      buffered = buffered.subarray(end + 4 + length);
    }
  });
  const write = (data: string): Promise<void> =>
    new Promise<void>((resolve) => {
      if (socket.write(data)) {
        resolve();
        return;
      }
      socket.once('drain', () => resolve());
      socket.once('close', () => resolve());
    });
  return { answers, write };
}

// ── the handshake ──────────────────────────────────────────────────────

describe('/mcp: connecting', () => {
  it('answers the handshake as Ospex, with no session and no sign-in', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    expect(client.getServerVersion()).toMatchObject({ name: 'ospex', title: 'Ospex', version: '0.1.0' });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
    expect(client.getInstructions()).toContain('They place nothing, sign nothing and hold no funds.');
    expect((client.transport as StreamableHTTPClientTransport).sessionId).toBeUndefined();
  });

  it('tells a model that a prepared order is not a placed one, and what would show that it was placed', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    expect(client.getInstructions()).toBe(
      'Ospex is a peer-to-peer sports betting protocol on Polygon. These tools read its public order book. ' +
        'They place nothing, sign nothing and hold no funds. ' +
        'A bet is placed only when a person opens a take link and confirms the transaction in their own wallet, ' +
        "so a prepared order is not a placed one until get_order_status, called with that person's wallet address, " +
        'lists a fill by that address made after the order was prepared. ' +
        'A fill by any other address is somebody else taking the same quote, ' +
        'and a fill from before the order was prepared is an earlier order. ' +
        'Prices are decimal odds for the person taking the quote. Amounts are USDC.',
    );
  });

  it('describes each tool with the sentences a model needs to not overstate what happened', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    const { tools } = await client.listTools();
    const described = (name: string): string => tools.find((tool) => tool.name === name)?.description ?? '';

    // Listing is not placing, and what is listed is what prepare_order would take.
    expect(described('list_markets')).toContain(
      'Only verified games more than two minutes from their start are listed, and only lines that already exist ' +
        'on-chain. Reading the list places nothing.',
    );
    // A preview is a reading at one moment, not a promise.
    expect(described('prepare_order')).toBe(
      'Prepares an order to take a posted quote at its posted price, and returns a preview and a take link. ' +
        'It chooses the best-priced quote on the side named that can fill the amount, works out exactly what ' +
        'is paid and what is won, and checks that the game is verified and is not about to start and that the ' +
        'quote is open. If no single quote can fill the amount, the order is prepared for the most one can, ' +
        'and the preview says so. ' +
        'Nothing is placed and nothing is stored: the order is placed only when a person opens the link and ' +
        'confirms in their own wallet. The preview is as of the moment it is made: the quote can be taken by ' +
        'someone else, cancelled on-chain or expire before the link is used, and the transaction then fails ' +
        'and costs only gas.',
    );
    // A filled quote was filled by somebody. Not necessarily by the person
    // asking, and not necessarily by this order of theirs.
    expect(described('get_order_status')).toBe(
      'Reports where a posted quote stands (open, partially filled, filled, cancelled, expired or withdrawn) ' +
        'and lists the fills on it: who took it, how much they risked and stand to win, when, and in which ' +
        "transaction. Without a wallet address the fills are every taker's, so a filled quote is not proof " +
        "that one person's order went through. With a wallet address it lists only that wallet's fills, " +
        'and a take went through if one of them was made after its order was prepared. ' +
        'A fill is listed once its block is final, usually within about 15 seconds of the transaction ' +
        'confirming, so a take that has only just confirmed may not be listed yet.',
    );
  });

  it('lists exactly three tools, each read-only, each with a title, none with an output schema', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(['get_order_status', 'list_markets', 'prepare_order']);
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.title]))).toEqual({
      list_markets: 'List Ospex markets',
      prepare_order: 'Prepare an Ospex order',
      get_order_status: 'Get Ospex order status',
    });
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.outputSchema).toBeUndefined();
      expect(tool.inputSchema.type).toBe('object');
      expect((tool.description ?? '').length).toBeGreaterThan(200);
      // A name a model API will accept: letters, digits, underscore, hyphen.
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it('declares the arguments each tool takes, and which are required', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    const { tools } = await client.listTools();
    const schema = (name: string): { properties: Record<string, unknown>; required?: string[] } =>
      tools.find((tool) => tool.name === name)!.inputSchema as {
        properties: Record<string, unknown>;
        required?: string[];
      };

    expect(Object.keys(schema('list_markets').properties).sort()).toEqual(['sport', 'window_hours']);
    expect(schema('list_markets').required ?? []).toEqual([]);
    expect(Object.keys(schema('prepare_order').properties).sort()).toEqual([
      'contest_id',
      'line',
      'market',
      'risk_usdc',
      'side',
    ]);
    expect([...(schema('prepare_order').required ?? [])].sort()).toEqual(['contest_id', 'market', 'risk_usdc', 'side']);
    expect(Object.keys(schema('get_order_status').properties).sort()).toEqual(['commitment_hash', 'taker_address']);
    expect(schema('get_order_status').required).toEqual(['commitment_hash']);
  });

  it('advertises that no tool takes an argument it does not list, and that contest_id is a string', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    const { tools } = await client.listTools();
    expect(
      Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema['additionalProperties']])),
    ).toEqual({ list_markets: false, prepare_order: false, get_order_status: false });

    // A number is read too, but what is advertised is the form the listing's
    // own identifier block prints and the form a caller is asked for.
    const prepare = tools.find((tool) => tool.name === 'prepare_order');
    expect((prepare?.inputSchema.properties as Record<string, unknown>)['contest_id']).toEqual({
      type: 'string',
      maxLength: 24,
      description: 'The contest_id list_markets shows for the game, such as "481".',
    });
  });

  it('describes list_markets and every argument in the words a model reads, and names the website', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    expect(client.getServerVersion()).toEqual({
      name: 'ospex',
      title: 'Ospex',
      version: '0.1.0',
      websiteUrl: 'https://ospex.org',
    });
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === 'list_markets')?.description).toBe(
      'Lists the games starting soon on Ospex, with the lines that exist on-chain for each and the prices ' +
        'posted on both sides of every line. Prices are shown from the side of the person taking the quote, ' +
        'as decimal odds rounded to two places, with the most one order can risk at each price. Only verified ' +
        'games more than two minutes from their start are listed, and only lines that already exist ' +
        'on-chain. Reading the list places nothing. Each game carries the contest_id that prepare_order takes.',
    );
    const argumentWords = (name: string): Record<string, unknown> => {
      const properties = tools.find((tool) => tool.name === name)?.inputSchema.properties ?? {};
      return Object.fromEntries(
        Object.entries(properties as Record<string, { description?: string }>).map(([key, value]) => [
          key,
          value.description,
        ]),
      );
    };
    expect(argumentWords('list_markets')).toEqual({
      window_hours: 'How far ahead to look, in hours, from 1 to 168. Defaults to 48.',
      sport: 'One sport to list: mlb, nba, ncaab, ncaaf, nfl or nhl. Leave out for all of them.',
    });
    expect(argumentWords('prepare_order')).toEqual({
      contest_id: 'The contest_id list_markets shows for the game, such as "481".',
      market: 'The market: moneyline, spread or total.',
      side:
        'The side to back, by itself. For a total: over or under. For a moneyline or spread: a team name ' +
        'such as "Phillies", or away or home. The line goes in line, not here.',
      risk_usdc: 'How much USDC to risk, such as 10 or 2.5. At most six decimal places.',
      line:
        'The line, when a game has more than one in the market. A total as the number of points (7.5). ' +
        'A spread as the handicap of the side being backed (-1.5).',
    });
    expect(argumentWords('get_order_status')).toEqual({
      commitment_hash: 'The commitment_hash prepare_order returned: 0x followed by 64 hex characters.',
      taker_address: 'A wallet address, to list only the fills that wallet made.',
    });
  });

  it('reads nothing from the database to connect or to list its tools', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    await client.listTools();
    await client.listTools();
    expect(running.fake.requests).toHaveLength(0);
  });

  it('answers a request that was never preceded by a handshake', async () => {
    const running = await run(liveBook());
    const response = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: JSON_RPC_HEADERS,
      body: rpc('tools/list', {}),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = (await response.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools).toHaveLength(3);
  });

  it('answers a client asking for a protocol version it does not have with one it does', async () => {
    const running = await run(liveBook());
    const response = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: JSON_RPC_HEADERS,
      body: rpc('initialize', {
        protocolVersion: '2099-01-01',
        capabilities: {},
        clientInfo: { name: 'from-the-future', version: '1.0.0' },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(body.result.protocolVersion).toMatch(/^20\d\d-\d\d-\d\d$/);
    expect(body.result.protocolVersion).not.toBe('2099-01-01');
    // The newest one the installed SDK implements, which is what the README promises.
    expect(body.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(body.result.serverInfo.name).toBe('ospex');
  });

  it('answers a notification sent by itself with 202 and no body', async () => {
    const running = await run(liveBook());
    const answer = await post(running, {
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(answer.status).toBe(202);
    expect(answer.text).toBe('');
    expect(answer.line).toMatchObject({ status: 202, answered: true, methods: ['notifications/initialized'] });
    expect(running.fake.requests).toHaveLength(0);

    // Beside it: the same message with an id is a request, and is answered.
    const asked = await post(running, { body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) });
    expect(asked.status).toBe(200);
    expect(asked.body).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });

  // A client built for a newer protocol may try a method this server has never
  // heard of before it falls back to the handshake. Whatever it sends, it has
  // to get an answer it can read as "not here", and never a sign-in or a crash.
  it('answers a method it does not know as unknown, and stays up', async () => {
    const running = await run(liveBook());
    const unknown = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: JSON_RPC_HEADERS,
      body: rpc('server/discover', {}),
    });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32601 } });

    const stated = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: { ...JSON_RPC_HEADERS, 'mcp-protocol-version': '2099-01-01' },
      body: rpc('server/discover', {}),
    });
    expect(stated.status).toBe(400);
    expect(await stated.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32000 } });
    expect(stated.headers.get('www-authenticate')).toBeNull();

    // And the handshake that follows works.
    const client = await connect(running);
    expect((await client.listTools()).tools).toHaveLength(3);
  });

  it('answers at the path with a trailing slash too, without redirecting', async () => {
    const running = await run(liveBook());
    const response = await fetch(`${running.url}/mcp/`, {
      method: 'POST',
      headers: JSON_RPC_HEADERS,
      body: rpc('tools/list', {}),
      redirect: 'manual',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });
});

// ── the tools, through the wire ────────────────────────────────────────

describe('/mcp: calling tools', () => {
  it('list_markets answers one block of text, from rows the database served', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    const result = await client.callTool({ name: 'list_markets', arguments: {} });
    expectReached(running.fake, 3);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const text = textOf(result);
    expect(text).toContain('Ospex: 1 game in the next 48 hours');
    expect(text).toContain('Tampa Bay Rays @ Philadelphia Phillies — MLB — ');
    expect(text).toContain('contest_id 481');
    expect(text).toContain('     Over 7.0: 2.10 (up to 9.10 USDC)');
    expect(text).toContain('     Under 7.0: 1.95 (up to 5.25 USDC)');
    expect(running.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
  });

  it('list_markets uses 48 hours when no window is given, and the window it is given', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    await client.callTool({ name: 'list_markets', arguments: {} });
    await client.callTool({ name: 'list_markets', arguments: { window_hours: 12, sport: 'mlb' } });

    const [first, second] = running.fake.requests.filter((request) => tableOf(request) === 'contests_effective');
    const span = (request: CapturedRequest | undefined): number => {
      const bounds = request?.params.getAll('effective_start_time') ?? [];
      return Date.parse(String(bounds[1]).slice(4)) - Date.parse(String(bounds[0]).slice(4));
    };
    expect(span(first)).toBe(48 * HOUR);
    expect(span(second)).toBe(12 * HOUR);
    expect(second?.params.get('sport_slug')).toBe('eq.mlb');
  });

  it('prepare_order answers a preview, a link, and the identifiers the next call takes', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    const result = await client.callTool({
      name: 'prepare_order',
      arguments: { contest_id: '481', market: 'total', side: 'under', risk_usdc: 2 },
    });
    expectReached(running.fake, 4);

    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain('Under 7.0 — Tampa Bay Rays @ Philadelphia Phillies, ');
    expect(text).toContain('Risk 2.00 USDC to win 1.90 at 1.95.');
    expect(text).toContain('A combined score of exactly 7 is a push: the stake is returned.');
    expect(text).toContain('Exact amounts: you pay 1.999935 USDC and win 1.904700 USDC.');
    expect(text).toContain(`Take link: https://ospex.org/take/${hash('a1')}?risk=2`);
    expect(text).toContain('Nothing has been placed.');
    expect(text).toContain(`commitment_hash: ${hash('a1')}`);
    // The quote's signature is what a taker's transaction carries. It is never in the answer.
    expect(text).not.toContain('5a5a5a5a');
    expect(running.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments', 'maker_funding']);

    // The moment the order was prepared, to the second, on the line after the
    // nothing-placed line and before the blank line that opens the identifier
    // block. A fill in the same second as the preparing is not counted as this
    // order. The clock is the real one, so the hour is not pinned here, only
    // the form.
    const lines = text.split('\n');
    const placed = lines.indexOf(
      'Nothing has been placed. The order is placed only when you open the link and confirm in your wallet.',
    );
    expect(placed).toBeGreaterThan(0);
    const prepared = lines[placed + 1] ?? '';
    expect(prepared.startsWith('Prepared ')).toBe(true);
    expect(prepared.endsWith('. A fill made at or before then is not this order.')).toBe(true);
    expect(prepared).toMatch(
      /^Prepared (Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}:\d{2} (am|pm) ET\. A fill made at or before then is not this order\.$/,
    );
    expect(text).not.toContain('A fill made before then');
    expect(lines[placed + 2]).toBe('');
    expect(lines[placed + 3]).toBe('contest_id: 481');
    expect(lines.filter((line) => line.startsWith('Prepared '))).toHaveLength(1);
  });

  it('prepare_order puts the configured origin in the link', async () => {
    const running = await run(liveBook(), { config: { mcpTakeLinkBaseUrl: 'https://take.example' } });
    const client = await connect(running);
    const result = await client.callTool({
      name: 'prepare_order',
      arguments: { contest_id: '481', market: 'total', side: 'under', risk_usdc: 2 },
    });
    expect(textOf(result)).toContain(`Take link: https://take.example/take/${hash('a1')}?risk=2`);
  });

  it('prepare_order refuses a game that started, reading the clock the app reads', async () => {
    const book = liveBook();
    book.contests_effective = [contestRow({ start_time: iso(-HOUR), effective_start_time: iso(-HOUR) })];
    const running = await run(book);
    const client = await connect(running);
    const result = await client.callTool({
      name: 'prepare_order',
      arguments: { contest_id: '481', market: 'total', side: 'under', risk_usdc: 2 },
    });
    const text = textOf(result);
    // The contract still fills a take after the start, so the refusal is this
    // tool's and is worded as one. The start is printed to the minute.
    expect(text.split('\n')).toEqual([
      expect.stringMatching(
        /^Tampa Bay Rays @ Philadelphia Phillies started (Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (am|pm) ET\. No order is prepared on a game under way\.$/,
      ),
      'No order was prepared, and nothing was placed.',
    ]);
    expect(text).not.toContain('takes no bets');
    expect(text).not.toContain('Take link');
    // Nothing was prepared, so no moment of preparing is named.
    expect(text).not.toContain('Prepared ');
    expect(text).not.toContain('A fill made');
  });

  it('get_order_status answers the status and the fills', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    const result = await client.callTool({
      name: 'get_order_status',
      arguments: { commitment_hash: hash('a1'), taker_address: TAKER },
    });
    expectReached(running.fake, 3);
    const text = textOf(result);
    expect(result.isError).toBeUndefined();
    expect(text).toContain(`Quote ${hash('a1')}`);
    expect(text).toContain('\nQuote status: open.\n');
    expect(text).toContain(
      '\nLeft to take: up to 5.25 USDC of taker risk. ' +
        'prepare_order chooses the quote for an order itself, and may choose another one or none.\n',
    );
    expect(text).toContain('\nSide for the taker: Under 7.0.\n');
    expect(text).not.toContain('Taking it backs');
    expect(text).toContain(`Fills on this quote by ${TAKER}: 1.`);
    // The fill's time is printed to the second, so that it can be set against
    // the second an order was prepared in.
    const fill = text.split('\n').find((line) => line.startsWith(`1. ${TAKER} `));
    expect(fill).toMatch(
      new RegExp(
        `^1\\. ${TAKER} risked 1\\.999935 USDC to win 1\\.9047 USDC at 1\\.95, ` +
          '(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \\d{1,2}, \\d{1,2}:\\d{2}:\\d{2} (am|pm) ET\\. ' +
          `Transaction ${hash('f1')}`,
      ),
    );
    expect(text).toContain(`Transaction ${hash('f1')}`);
    expect(text).toContain('A fill is listed once its block is final');
  });

  it('refuses arguments of the wrong kind before the tool runs, and reads nothing', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['prepare_order', { contest_id: '481', market: 'parlay', side: 'under', risk_usdc: 2 }, 'market'],
      ['prepare_order', { contest_id: '481', market: 'total', side: 'under', risk_usdc: '2' }, 'risk_usdc'],
      ['prepare_order', { contest_id: '481', market: 'total', side: 'under', risk_usdc: -2 }, 'risk_usdc'],
      ['prepare_order', { contest_id: null, market: 'total', side: 'under', risk_usdc: 2 }, 'contest_id'],
      ['prepare_order', { contest_id: true, market: 'total', side: 'under', risk_usdc: 2 }, 'contest_id'],
      ['prepare_order', { market: 'total', side: 'under', risk_usdc: 2 }, 'contest_id'],
      ['prepare_order', { contest_id: '481', market: 'total', side: 'under', risk_usdc: 2, line: '7' }, 'line'],
      ['list_markets', { window_hours: 169 }, 'window_hours'],
      ['list_markets', { window_hours: '48' }, 'window_hours'],
      ['get_order_status', {}, 'commitment_hash'],
    ];
    for (const [name, args, field] of cases) {
      const result = await client.callTool({ name, arguments: args });
      expect([name, args, result.isError]).toEqual([name, args, true]);
      // One problem, reported as "<what is wrong> at <field>".
      expect(textOf(result)).toMatch(
        new RegExp(`^MCP error -32602: Input validation error: Invalid arguments for tool ${name}: [^\\n]+ at ${field}$`),
      );
    }
    expect(running.fake.requests).toHaveLength(0);
  });

  it('takes contest_id as a number and answers as it does for the string', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    const order = { market: 'total', side: 'under', risk_usdc: 2 };

    const asString = await client.callTool({ name: 'prepare_order', arguments: { ...order, contest_id: '481' } });
    const asked = running.fake.requests.length;
    expect(asked).toBe(4);
    const asNumber = await client.callTool({ name: 'prepare_order', arguments: { ...order, contest_id: 481 } });

    expect(asNumber.isError).toBeUndefined();
    expect(textOf(asNumber)).toContain('Under 7.0 — Tampa Bay Rays @ Philadelphia Phillies, ');
    expect(textOf(asNumber)).toContain(`Take link: https://ospex.org/take/${hash('a1')}?risk=2`);
    expect(textOf(asNumber)).toContain('\ncontest_id: 481\n');
    // The same answer, apart from the moment each was prepared: two calls can
    // fall either side of a minute.
    const untimed = (text: string): string[] => text.split('\n').filter((line) => !line.startsWith('Prepared '));
    expect(textOf(asString).split('\n').filter((line) => line.startsWith('Prepared '))).toHaveLength(1);
    expect(textOf(asNumber).split('\n').filter((line) => line.startsWith('Prepared '))).toHaveLength(1);
    expect(untimed(textOf(asNumber))).toEqual(untimed(textOf(asString)));

    // The database was asked for the same contest, in the same four reads.
    expect(running.fake.tables().slice(asked)).toEqual([
      'contests_effective',
      'speculations',
      'commitments',
      'maker_funding',
    ]);
    const contestReads = running.fake.requests.filter((request) => tableOf(request) === 'contests_effective');
    expect(contestReads.map((request) => request.params.get('contest_id'))).toEqual(['eq.481', 'eq.481']);
  });

  it('refuses a contest_id number that is not a contest number, in the tool\'s own words and before any read', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    // Numbers the parser read as sent, which the tool then turns away: a
    // fraction, including one on the fixture's own contest, and a negative.
    for (const contestId of [4.5, 481.5, -1]) {
      const result = await client.callTool({
        name: 'prepare_order',
        arguments: { contest_id: contestId, market: 'total', side: 'under', risk_usdc: 2 },
      });
      expect([contestId, result.isError]).toEqual([contestId, true]);
      expect(textOf(result)).toBe(
        'contest_id must be the number list_markets shows for the game.\n' +
          'No order was prepared, and nothing was placed.',
      );
    }
    expect(running.fake.requests).toHaveLength(0);

    // Beside them, the nearest numbers that are taken: a whole one, read as its digits.
    const none = await client.callTool({
      name: 'prepare_order',
      arguments: { contest_id: 5, market: 'total', side: 'under', risk_usdc: 2 },
    });
    expect(textOf(none)).toBe('There is no contest 5 on Ospex.\nNo order was prepared, and nothing was placed.');
    expect(running.fake.requests.map((request) => request.params.get('contest_id'))).toEqual(['eq.5']);
  });

  // Each body is written out as text, so the digits sent are the digits in the
  // source and not the ones a number in this file would become. From 2^53 a
  // whole number loses its last digits as it is parsed: 12345678901234567
  // reads as 12345678901234568, a different contest. The schema refuses it
  // rather than look up the one it became.
  const bigContest = (digits: string): string =>
    '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"prepare_order","arguments":' +
    `{"contest_id":${digits},"market":"total","side":"under","risk_usdc":2}}}`;

  it('refuses contest_id sent as a whole number past 2^53 in the schema\'s words, and reads nothing', async () => {
    const running = await run(liveBook());
    // 2^53 itself is the first whole number that is not safe; 1e21 is past it too.
    for (const digits of ['12345678901234567', '9007199254740992', '1e21']) {
      const answer = await post(running, { body: bigContest(digits) });
      expect([digits, answer.status]).toEqual([digits, 200]);
      const result = (answer.body as { id: number; result: { isError?: boolean; content: Array<{ text: string }> } })
        .result;
      expect([digits, result.isError]).toEqual([digits, true]);
      expect([digits, result.content[0]?.text]).toEqual([
        digits,
        'MCP error -32602: Input validation error: Invalid arguments for tool prepare_order: ' +
          'Expected string, received number at contest_id',
      ]);
      expect([digits, running.fake.requests.length]).toEqual([digits, 0]);
    }

    // Beside them: the largest safe whole number is read as its digits and looked up.
    const safe = await post(running, { body: bigContest('9007199254740991') });
    const result = (safe.body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    expect(result.content[0]?.text).toBe(
      'There is no contest 9007199254740991 on Ospex.\nNo order was prepared, and nothing was placed.',
    );
    expect(running.fake.requests.map((request) => request.params.get('contest_id'))).toEqual([
      'eq.9007199254740991',
    ]);

    // And the fixture's own contest, sent as a bare number, is served.
    const own = await post(running, { body: bigContest('481') });
    const served = (own.body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    expect(served.isError).toBeUndefined();
    expect(served.content[0]?.text).toContain('\ncontest_id: 481\n');
  });

  it('refuses an argument the tool does not have, names it, and reads nothing', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    const order = { contest_id: '481', market: 'total', side: 'under', risk_usdc: 2 };
    const cases: Array<[string, Record<string, unknown>, string]> = [
      // A caller echoing a preview's identifier block back, believing the hash pins the quote.
      ['prepare_order', { ...order, commitment_hash: hash('a2') }, 'commitment_hash'],
      ['list_markets', { contest_id: '481' }, 'contest_id'],
      ['get_order_status', { commitment_hash: hash('a1'), risk_usdc: 2 }, 'risk_usdc'],
    ];
    for (const [name, args, key] of cases) {
      const result = await client.callTool({ name, arguments: args });
      expect([name, result.isError]).toEqual([name, true]);
      expect(textOf(result)).toBe(
        `MCP error -32602: Input validation error: Invalid arguments for tool ${name}: ` +
          `Unrecognized key(s) in object: '${key}'`,
      );
    }
    expect(running.fake.requests).toHaveLength(0);

    // Beside them: each call with the extra argument taken out is served.
    const served: Array<[string, Record<string, unknown>, number]> = [
      ['prepare_order', order, 4],
      ['list_markets', {}, 3],
      ['get_order_status', { commitment_hash: hash('a1') }, 3],
    ];
    for (const [name, args, reads] of served) {
      const before = running.fake.requests.length;
      const result = await client.callTool({ name, arguments: args });
      expect([name, result.isError]).toEqual([name, undefined]);
      expect([name, running.fake.requests.length - before]).toEqual([name, reads]);
    }
  });

  it('refuses a value just past each bound of the advertised arguments, and takes the value at the bound', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    const order = { contest_id: '481', market: 'total', side: 'under', risk_usdc: 2 };
    const status = { commitment_hash: hash('a1') };
    // The argument refused, the field its refusal names, and the nearest argument the schema takes.
    const bounds: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
      ['list_markets', { window_hours: 0 }, 'window_hours', { window_hours: 1 }],
      ['list_markets', { window_hours: 169 }, 'window_hours', { window_hours: 168 }],
      ['list_markets', { window_hours: 1.5 }, 'window_hours', { window_hours: 2 }],
      ['list_markets', { sport: 'm'.repeat(17) }, 'sport', { sport: 'm'.repeat(16) }],
      ['prepare_order', { ...order, contest_id: '4'.repeat(25) }, 'contest_id', { ...order, contest_id: '4'.repeat(24) }],
      ['prepare_order', { ...order, side: '' }, 'side', { ...order, side: 'u' }],
      ['prepare_order', { ...order, side: 'u'.repeat(81) }, 'side', { ...order, side: 'u'.repeat(80) }],
      ['prepare_order', { ...order, risk_usdc: 0 }, 'risk_usdc', { ...order, risk_usdc: 0.000001 }],
      // Past the schema's cap the tool would refuse too, in its own words. Only
      // the schema answers "Input validation error".
      ['prepare_order', { ...order, risk_usdc: 1_000_000.5 }, 'risk_usdc', { ...order, risk_usdc: 1_000_000 }],
      ['prepare_order', { ...order, line: 100_000.5 }, 'line', { ...order, line: 100_000 }],
      ['prepare_order', { ...order, line: -100_000.5 }, 'line', { ...order, line: -100_000 }],
      ['get_order_status', { commitment_hash: 'f'.repeat(81) }, 'commitment_hash', { commitment_hash: 'f'.repeat(80) }],
      ['get_order_status', { ...status, taker_address: 'c'.repeat(61) }, 'taker_address', { ...status, taker_address: 'c'.repeat(60) }],
    ];
    expect(bounds).toHaveLength(13);
    for (const [name, refusedArgs, field, takenArgs] of bounds) {
      const before = running.fake.requests.length;
      const refused = await client.callTool({ name, arguments: refusedArgs });
      expect([name, field, refused.isError]).toEqual([name, field, true]);
      // One problem, reported as "<what is wrong> at <field>", so the field
      // named is the one refused and not a word elsewhere in the message.
      expect(textOf(refused)).toMatch(
        new RegExp(`^MCP error -32602: Input validation error: Invalid arguments for tool ${name}: [^\\n]+ at ${field}$`),
      );
      expect([name, field, running.fake.requests.length]).toEqual([name, field, before]);

      const taken = await client.callTool({ name, arguments: takenArgs });
      expect([name, field, textOf(taken).includes('Input validation error')]).toEqual([name, field, false]);
    }
  }, 15_000);

  it('passes the line it was given to the tool', async () => {
    // Two total lines, each with a quote a taker of the Under can take. Only
    // the line argument can choose between them.
    const book = liveBook();
    book.speculations = [speculationRow(), speculationRow({ speculation_id: 1003, line_ticks: 75 })];
    book.commitments = [
      quoteRow({ expiry: iso(5 * HOUR) }),
      quoteRow({
        commitment_hash: hash('b5'),
        line_ticks: 75,
        odds_tick: 190,
        speculation_key: KEYS['c481-total-75'],
        expiry: iso(5 * HOUR),
      }),
    ];
    const running = await run(book);
    const client = await connect(running);
    const order = { contest_id: '481', market: 'total', side: 'under', risk_usdc: 2 };

    // The fixture is what it says: without a line there are two to choose from.
    const unnamed = await client.callTool({ name: 'prepare_order', arguments: order });
    expect(textOf(unnamed)).toBe(
      'More than one line has a quote: Under 7.0; Under 7.5. Say which with line.\n' +
        'No order was prepared, and nothing was placed.',
    );

    const upper = await client.callTool({ name: 'prepare_order', arguments: { ...order, line: 7.5 } });
    expect(upper.isError).toBeUndefined();
    expect(textOf(upper)).toContain('Under 7.5 — Tampa Bay Rays @ Philadelphia Phillies, ');
    expect(textOf(upper)).toContain(`Take link: https://ospex.org/take/${hash('b5')}?risk=2`);
    expect(textOf(upper)).toContain(`\ncommitment_hash: ${hash('b5')}\n`);
    expect(textOf(upper)).toContain('\nline: 7.5\n');

    const lower = await client.callTool({ name: 'prepare_order', arguments: { ...order, line: 7 } });
    expect(textOf(lower)).toContain(`Take link: https://ospex.org/take/${hash('a1')}?risk=2`);
    expect(textOf(lower)).toContain(`\ncommitment_hash: ${hash('a1')}\n`);
    expect(textOf(lower)).toContain('\nline: 7.0\n');
  });

  it('answers a tools/call that carries no params as an error on that request, not as a failure of the endpoint', async () => {
    const running = await run(liveBook());
    // No `params` at all: there is no call to fill in empty arguments for.
    const answer = await post(running, { body: '{"jsonrpc":"2.0","id":6,"method":"tools/call"}' });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ jsonrpc: '2.0', id: 6, error: { code: expect.any(Number) as number } });
    expect(running.log.error).not.toHaveBeenCalled();
    expect(running.fake.requests).toHaveLength(0);
    expect(answer.line).toMatchObject({ status: 200, answered: true, methods: ['tools/call'] });

    // Beside it: the same call with params and no arguments is served.
    const served = await post(running, { body: rpc('tools/call', { name: 'list_markets' }, 6) });
    expect(served.body).toMatchObject({ jsonrpc: '2.0', id: 6, result: { content: [{ type: 'text' }] } });
    expect((served.body as { result: { isError?: boolean } }).result.isError).toBeUndefined();
  });

  it('answers a tool that does not exist as an error, not as a crash', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    const result = await client.callTool({ name: 'place_order', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('place_order');
    // And the next call still works.
    expect((await client.callTool({ name: 'list_markets', arguments: {} })).isError).toBeUndefined();
  });

  it('takes a call that leaves its arguments out as a call with none', async () => {
    const running = await run(liveBook());
    const response = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: JSON_RPC_HEADERS,
      // No `arguments` key at all. Every argument of list_markets is optional.
      body: rpc('tools/call', { name: 'list_markets' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0]?.text).toContain('Ospex: 1 game in the next 48 hours');
  });

  it('still refuses a call that leaves out arguments its tool requires', async () => {
    const running = await run(liveBook());
    const response = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: JSON_RPC_HEADERS,
      body: rpc('tools/call', { name: 'prepare_order' }),
    });
    const body = (await response.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain('Input validation error');
    expect(running.fake.requests).toHaveLength(0);
  });

  it('serves calls that overlap', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    const calls = Array.from({ length: 12 }, () => client.callTool({ name: 'list_markets', arguments: {} }));
    const results = await Promise.all(calls);
    for (const result of results) {
      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain('contest_id 481');
    }
  });

  it('answers with fixed words when a tool breaks, and keeps the cause out of the answer', async () => {
    const book = liveBook();
    // An amount the tool cannot turn into a number.
    book.position_fills = [fillRow({ taker_risk_amount: 'not-a-number-from-db.internal' })];
    const running = await run(book);
    const client = await connect(running);
    const result = await client.callTool({ name: 'get_order_status', arguments: { commitment_hash: hash('a1') } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Something went wrong on the Ospex side. Nothing was placed. Try again in a moment.');
    expect(running.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'get_order_status', err: expect.stringContaining('not-a-number-from-db.internal') }),
      'mcp: tool call failed',
    );
  });

  it('answers with fixed words when a read fails', async () => {
    const running = await run(liveBook(), {
      override: (request) =>
        tableOf(request) === 'commitments' ? { status: 500, body: { message: 'detail from db.internal' } } : undefined,
    });
    const client = await connect(running);
    const result = await client.callTool({ name: 'list_markets', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'Ospex could not read its order book just now. Nothing was placed. Try again in a moment.',
    );
  });

  it('says it is not configured when the service has no scorer addresses', async () => {
    const running = await run(liveBook(), { config: { scorers: undefined } });
    const client = await connect(running);
    const result = await client.callTool({ name: 'list_markets', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not configured');
    expect(running.fake.requests).toHaveLength(0);
  });
});

// ── one message per request ────────────────────────────────────────────

describe('/mcp: one message per request', () => {
  const ping = (id: number): unknown => ({ jsonrpc: '2.0', id, method: 'ping' });
  const list = (id: number): unknown => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
  const call = (id: number): unknown => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'list_markets', arguments: {} },
  });
  const cancel = (id: number): unknown => ({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: id },
  });

  const REFUSED = {
    jsonrpc: '2.0',
    error: { code: -32600, message: 'One message per request, sent as an object and not as a list.' },
    id: null,
  };

  // Every JSON list, whatever its length and whatever it carries, with the
  // count the warning is expected to state. A list is the only way one request
  // could carry a request together with its own cancellation, or two requests
  // under one id, so refusing the list is what puts both out of reach. A list
  // of one is refused too: the protocol answers a list with a list.
  const lists: Array<[string, unknown[], number]> = [
    ['an empty list', [], 0],
    ['a list of one ping', [ping(1)], 1],
    ['a list of one tool call', [call(7)], 1],
    ['a list of one notification', [{ jsonrpc: '2.0', method: 'notifications/initialized' }], 1],
    ['two pings', [ping(1), ping(2)], 2],
    ['a tool call and a tool listing', [call(1), list(2)], 2],
    ['two tool calls', [call(1), call(2)], 2],
    ['a request and a notification', [ping(1), { jsonrpc: '2.0', method: 'notifications/initialized' }], 2],
    ['three pings', [ping(1), ping(2), ping(3)], 3],
    ['a hundred messages', Array.from({ length: 100 }, (_, index) => list(index + 1)), 100],
    ['a request and its own cancellation', [call(1), cancel(1)], 2],
    ['a cancellation and then the request it cancels', [cancel(1), ping(1)], 2],
    ['two requests sharing one id', [call(1), ping(1)], 2],
    ['two messages that are not JSON-RPC', [{ hello: 'world' }, 7], 2],
  ];

  for (const [name, messages, count] of lists) {
    it(`refuses ${name}, having read nothing and built nothing`, async () => {
      const running = await run(liveBook());
      expect(messages).toHaveLength(count);
      const answer = await post(running, { body: JSON.stringify(messages) });

      expect(answer.status).toBe(400);
      expect(answer.contentType).toContain('application/json');
      expect(answer.body).toEqual(REFUSED);
      expect(running.built).not.toHaveBeenCalled();
      expect(running.fake.requests).toHaveLength(0);
      expect(running.log.warn.mock.calls).toEqual([[{ messages: count }, 'mcp: batch refused']]);
      expect(running.log.error).not.toHaveBeenCalled();
      expect(running.log.info).not.toHaveBeenCalledWith(expect.anything(), 'mcp: tool call');
      // Refused before any message was looked at, so the line names no method.
      expect(answer.line).toMatchObject({ status: 400, answered: true, methods: [] });
    });
  }

  it('covers every length the refusal is claimed for: none, one, two, three and a hundred', () => {
    expect([...new Set(lists.map(([, messages]) => messages.length))].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 100]);
  });

  it('serves each message a refused list of one carried, when it is sent as an object', async () => {
    const running = await run(liveBook());

    const pinged = await post(running, { body: JSON.stringify(ping(1)) });
    expect(pinged.status).toBe(200);
    expect(pinged.body).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(running.built).toHaveBeenCalledTimes(1);
    expect(running.log.warn).not.toHaveBeenCalled();
    expect(pinged.line).toMatchObject({ status: 200, methods: ['ping'] });

    const called = await post(running, { body: JSON.stringify(call(7)) });
    expect(called.status).toBe(200);
    const result = called.body as { id: number; result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(result.id).toBe(7);
    expect(result.result.isError).toBeUndefined();
    expect(result.result.content[0]?.text).toContain('contest_id 481');
    expect(running.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
    expect(called.line).toMatchObject({ status: 200, methods: ['tools/call'] });

    const notified = await post(running, {
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(notified.status).toBe(202);
    expect(notified.text).toBe('');
  });

  it('refuses a list that follows whitespace, as the same list', async () => {
    const running = await run(liveBook());
    const answer = await post(running, { body: `\n  \t${JSON.stringify([ping(1)])}` });
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual(REFUSED);
    expect(running.log.warn.mock.calls).toEqual([[{ messages: 1 }, 'mcp: batch refused']]);
    expect(running.built).not.toHaveBeenCalled();
  });
});

// ── the deadline ───────────────────────────────────────────────────────

describe('a tool call that takes too long', () => {
  it('ships a deadline of 20 seconds', async () => {
    vi.resetModules();
    const { TOOL_DEADLINE_MS } = await import('../src/mcp/server.js');
    expect(TOOL_DEADLINE_MS).toBe(20_000);
  });

  // Arguments that pass every check made before the first read, so that the
  // call is waiting on the database when its deadline comes.
  const stalled: Array<[string, Record<string, unknown>]> = [
    ['list_markets', {}],
    ['prepare_order', { contest_id: '481', market: 'moneyline', side: 'home', risk_usdc: 10 }],
    ['get_order_status', { commitment_hash: hash('ab'), taker_address: TAKER }],
  ];

  for (const [tool, args] of stalled) {
    it(`${tool} is answered for at its deadline while the read behind it is still waiting`, async () => {
      // A database that takes the request and never answers it.
      const fake = await startBook({}, () => ({ hang: true }));
      fakes.push(fake);
      const config = configFor(fake);
      const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
      vi.resetModules();
      vi.doMock('../src/lib/env.js', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../src/lib/env.js')>()),
        loadConfig: () => config,
      }));
      vi.doMock('../src/lib/logger.js', () => ({ logger: log, formatError: String }));
      const { getSupabase } = await import('../src/lib/supabase.js');
      const { buildMcpServer } = await import('../src/mcp/server.js');

      const server = buildMcpServer(
        () => ({
          sb: getSupabase(),
          network: NETWORK,
          scorers: { ...SCORERS },
          takeLinkBaseUrl: 'https://ospex.org',
          nowMs: Date.now(),
        }),
        250,
      );
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'deadline-test', version: '0.0.0' });
      clients.push(client);
      await server.connect(serverSide);
      await client.connect(clientSide);

      const startedAt = Date.now();
      const result = await client.callTool({ name: tool, arguments: args });
      const elapsed = Date.now() - startedAt;

      // The read was made, and is still unanswered: the deadline is what spoke.
      expectReached(fake);
      expect(fake.requests).toHaveLength(1);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('Ospex is taking too long to answer. Nothing was placed. Try again in a moment.');
      // The deadline given is 250 ms. The floor allows for a timer that fires a
      // little early. The ceiling is under 2,500 ms, so a tool that was handed
      // ten times its deadline is seen.
      expect(elapsed).toBeGreaterThanOrEqual(240);
      expect(elapsed).toBeLessThan(2_000);
      expect(log.error.mock.calls).toEqual([
        [{ tool, ms: expect.any(Number) as number }, 'mcp: tool call passed its deadline'],
      ]);
      await server.close();
    });
  }

  it('gives each tool call served through the app the shipped deadline, and a tool listing none', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      await client.listTools();
      expect(timers.mock.calls.filter(([, ms]) => ms === 20_000)).toHaveLength(0);
      const result = await client.callTool({ name: 'list_markets', arguments: {} });
      expect(result.isError).toBeUndefined();
      // One timer of twenty seconds for the one call: the deadline the app
      // builds its servers with, and not only the number the module exports.
      expect(timers.mock.calls.filter(([, ms]) => ms === 20_000)).toHaveLength(1);
    } finally {
      timers.mockRestore();
    }
  });

  it('does not hold a fast call to its deadline', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    const startedAt = Date.now();
    const result = await client.callTool({ name: 'list_markets', arguments: {} });
    expect(result.isError).toBeUndefined();
    // Twenty seconds is the deadline. A call that waited for it would be seen here.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

// ── the HTTP around it ─────────────────────────────────────────────────

describe('/mcp: everything that is not a JSON-RPC POST', () => {
  for (const method of ['GET', 'DELETE', 'PUT', 'PATCH']) {
    it(`answers ${method} with 405 and says POST is what it takes`, async () => {
      const running = await run(liveBook());
      const response = await fetch(`${running.url}/mcp`, {
        method,
        headers: { accept: 'application/json, text/event-stream' },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed. This endpoint takes POST.' },
        id: null,
      });
    });
  }

  it('does not open a stream for a GET that asks for one', async () => {
    const running = await run(liveBook());
    const response = await fetch(`${running.url}/mcp`, { headers: { accept: 'text/event-stream' } });
    expect(response.status).toBe(405);
    expect(response.headers.get('content-type')).not.toContain('text/event-stream');
  });

  // What the app's own error handler answers with. A body this route refuses
  // is never answered in this shape.
  const REST_ERROR = { error: 'Internal server error', code: 'INTERNAL_ERROR' };

  it('answers a body that is not JSON with a JSON-RPC parse error, not the app\'s 500', async () => {
    const running = await run(liveBook());
    const answer = await post(running, { body: '{"jsonrpc": ' });
    expect(answer.status).toBe(400);
    expect(answer.contentType).toContain('application/json');
    expect(answer.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error: Invalid JSON' },
      id: null,
    });
    expect(answer.body).not.toEqual(REST_ERROR);
    // The app's error handler never saw it.
    expect(running.log.error).not.toHaveBeenCalled();
    expect(running.log.warn.mock.calls).toEqual([[{ type: 'entity.parse.failed' }, 'mcp: request body refused']]);
    expect(running.built).not.toHaveBeenCalled();
    expect(answer.line).toMatchObject({ status: 400, answered: true, methods: [] });
  });

  // Each of these is JSON, so the route reads it, and none is a message, so
  // the transport refuses it in its own words. An empty body is read as an
  // empty object.
  const notMessages: Array<[string, string]> = [
    ['an object', '{"hello":"world"}'],
    ['a bare string', '"hello"'],
    ['a bare number', '7'],
    ['null', 'null'],
    ['true', 'true'],
    ['an empty body', ''],
  ];
  for (const [name, body] of notMessages) {
    it(`answers ${name}, which is not JSON-RPC, with a JSON-RPC error from the transport`, async () => {
      const running = await run(liveBook());
      const answer = await post(running, { body });
      expect(answer.status).toBe(400);
      expect(answer.contentType).toContain('application/json');
      expect(answer.body).toEqual({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error: Invalid JSON-RPC message' },
        id: null,
      });
      expect(running.log.error).not.toHaveBeenCalled();
      expect(running.log.warn.mock.calls).toEqual([
        [{ err: 'Parse error: Invalid JSON-RPC message' }, 'mcp: request refused by the transport'],
      ]);
      expect(running.fake.requests).toHaveLength(0);
      expect(answer.line).toMatchObject({ status: 400, answered: true, methods: [] });
    });
  }

  it('refuses a body over one mebibyte with 413, and takes one of exactly one mebibyte', async () => {
    const running = await run(liveBook());
    const padded = paddedToolsList;
    const over = padded(1_048_577);
    expect(Buffer.byteLength(over)).toBe(1_048_577);
    const refused = await post(running, { body: over });
    expect(refused.status).toBe(413);
    expect(refused.contentType).toContain('application/json');
    expect(refused.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Payload Too Large: Request body must not exceed 1048576 bytes' },
      id: null,
    });
    expect(running.log.error).not.toHaveBeenCalled();
    expect(running.log.warn.mock.calls).toEqual([[{ type: 'entity.too.large' }, 'mcp: request body refused']]);
    expect(running.built).not.toHaveBeenCalled();
    expect(refused.line).toMatchObject({ status: 413, answered: true, methods: [] });

    const exact = padded(1_048_576);
    expect(Buffer.byteLength(exact)).toBe(1_048_576);
    const taken = await post(running, { body: exact });
    expect(taken.status).toBe(200);
    expect((taken.body as { result: { tools: unknown[] } }).result.tools).toHaveLength(3);
    expect(running.log.warn).not.toHaveBeenCalled();
    expect(taken.line).toMatchObject({ status: 200, methods: ['tools/list'] });
  });

  const TOO_LARGE = {
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Payload Too Large: Request body must not exceed 1048576 bytes' },
    id: null,
  };

  it(
    'answers 413 to a Content-Length over the limit before any of the body is sent',
    async () => {
      const running = await run(liveBook());
      const raw = await rawConnection(running);
      // The head alone. The body it announces is never sent, so an answer can
      // only come from the length the head states.
      await raw.write(requestHead('Content-Length: 1048577'));
      await vi.waitFor(() => expect(raw.answers).toHaveLength(1), { timeout: 5_000 });
      expect(raw.answers[0]).toEqual({ status: 413, body: TOO_LARGE });

      expect(running.log.warn.mock.calls).toEqual([[{ type: 'entity.too.large' }, 'mcp: request body refused']]);
      expect(running.log.error).not.toHaveBeenCalled();
      expect(running.built).not.toHaveBeenCalled();
      expect(running.fake.requests).toHaveLength(0);
      await vi.waitFor(() => {
        expect(running.log.info).toHaveBeenCalledWith(expect.anything(), 'mcp: request');
      });
      const lines = running.log.info.mock.calls.filter((call) => call[1] === 'mcp: request');
      expect(lines).toHaveLength(1);
      expect(lines[0]?.[0]).toMatchObject({ status: 413, answered: true, methods: [] });
      // The nearest length that is taken, one of exactly one mebibyte sent
      // whole, is served in the case above.
    },
    // The whole case, starting the app included, took 218 to 258 ms on a
    // Windows laptop with Node 22, alone and with the rest of the suite beside
    // it. The limit leaves room for a machine many times slower.
    15_000,
  );

  it(
    'answers 413 to a chunked body that keeps coming, while it is still being sent, and warns once',
    async () => {
      const running = await run(liveBook());
      const raw = await rawConnection(running);
      await raw.write(requestHead('Transfer-Encoding: chunked'));

      // The opening of a message whose padding never ends: no chunk of length
      // zero is sent until the answer is in.
      const opening = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"';
      await raw.write(`${opening.length.toString(16)}\r\n${opening}\r\n`);
      const piece = 'x'.repeat(65_536);
      const chunk = `${piece.length.toString(16)}\r\n${piece}\r\n`;
      let sent = opening.length;
      const ceiling = 32 * 1_048_576;
      while (raw.answers.length === 0 && sent < ceiling) {
        await raw.write(chunk);
        sent += piece.length;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      // Answered before the sender gave up: the body was still arriving.
      expect(sent).toBeLessThan(ceiling);
      expect(sent).toBeGreaterThan(1_048_576);
      expect(raw.answers).toEqual([{ status: 413, body: TOO_LARGE }]);
      expect(running.log.warn.mock.calls).toEqual([[{ type: 'entity.too.large' }, 'mcp: request body refused']]);

      // More of the body after the answer, and then its end. The parser learns
      // only now that the body was too large, and says nothing more about it.
      for (let index = 0; index < 4; index += 1) await raw.write(chunk);
      await raw.write('0\r\n\r\n');
      // A later request on a connection of its own, to wait on: once its line
      // is in the log, the end of the body above has been handled.
      const later = await fetch(`${running.url}/mcp`, {
        method: 'POST',
        headers: JSON_RPC_HEADERS,
        body: rpc('ping', {}),
      });
      expect(later.status).toBe(200);
      await vi.waitFor(() => {
        expect(running.log.info.mock.calls.filter((call) => call[1] === 'mcp: request')).toHaveLength(2);
      });
      const lines = running.log.info.mock.calls.filter((call) => call[1] === 'mcp: request');
      expect(lines.map((call) => (call[0] as { status: number }).status)).toEqual([413, 200]);
      expect(lines[0]?.[0]).toMatchObject({ status: 413, answered: true, methods: [] });

      expect(running.log.warn.mock.calls).toEqual([[{ type: 'entity.too.large' }, 'mcp: request body refused']]);
      expect(running.log.error).not.toHaveBeenCalled();
      // One server, built for the later request. None for the refused one.
      expect(running.built).toHaveBeenCalledTimes(1);
      expect(running.fake.requests).toHaveLength(0);
    },
    // 179 to 235 ms, measured as the case above. When no answer comes, all
    // 32 MiB are sent before the case gives up: 341 to 384 ms on the same
    // machine.
    15_000,
  );

  it(
    'serves a chunked body of exactly one mebibyte',
    async () => {
      const running = await run(liveBook());
      const whole = Buffer.from(paddedToolsList(1_048_576));
      expect(whole.length).toBe(1_048_576);
      // Sent in pieces with no length stated, so only the count taken as the
      // pieces arrive can refuse it.
      const pieces: Buffer[] = [];
      for (let offset = 0; offset < whole.length; offset += 65_536) pieces.push(whole.subarray(offset, offset + 65_536));
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = pieces.shift();
          if (next === undefined) controller.close();
          else controller.enqueue(new Uint8Array(next));
        },
      });
      const response = await fetch(`${running.url}/mcp`, {
        method: 'POST',
        headers: JSON_RPC_HEADERS,
        body: stream,
        duplex: 'half',
      } as RequestInit);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: { tools: unknown[] } };
      expect(body.result.tools).toHaveLength(3);
      expect(running.log.warn).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(running.log.info).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }), 'mcp: request');
      });
    },
    // 175 to 207 ms, measured as the cases above.
    15_000,
  );

  it('refuses a body that does not say it is JSON with 415', async () => {
    const running = await run(liveBook());
    // A message that is served when it is sent as JSON. Only the content type differs.
    const message = rpc('tools/list', {});
    const answer = await post(running, {
      headers: { ...JSON_RPC_HEADERS, 'content-type': 'text/plain' },
      body: message,
    });
    expect(answer.status).toBe(415);
    expect(answer.contentType).toContain('application/json');
    expect(answer.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unsupported Media Type: Content-Type must be application/json' },
      id: null,
    });
    expect(running.log.error).not.toHaveBeenCalled();
    expect(running.log.warn.mock.calls).toEqual([
      [
        { err: 'Unsupported Media Type: Content-Type must be application/json' },
        'mcp: request refused by the transport',
      ],
    ]);
    expect(answer.line).toMatchObject({ status: 415, answered: true, methods: [] });

    const asJson = await post(running, { body: message });
    expect(asJson.status).toBe(200);
  });

  // What the transport answers for a Content-Type that is not JSON, and the
  // one line it writes about it.
  const NOT_JSON_TYPE = {
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Unsupported Media Type: Content-Type must be application/json' },
    id: null,
  };
  const NOT_JSON_TYPE_WARNED = [
    [{ err: 'Unsupported Media Type: Content-Type must be application/json' }, 'mcp: request refused by the transport'],
  ];
  const PING_ANSWER = { jsonrpc: '2.0', id: 7, result: {} };
  const NOT_JSON = '{"jsonrpc": ';

  it('refuses a Content-Type of ;application/json with 415 in the JSON-RPC shape, as a warning and not an error', async () => {
    const running = await run(liveBook());
    const ping = rpc('ping', {}, 7);
    const answer = await postWithContentType(running, ';application/json', ping);
    expect(answer.status).toBe(415);
    expect(answer.contentType).toContain('application/json');
    expect(answer.body).toEqual(NOT_JSON_TYPE);
    expect(answer.body).not.toEqual(REST_ERROR);
    expect(running.log.error).not.toHaveBeenCalled();
    expect(running.log.warn.mock.calls).toEqual(NOT_JSON_TYPE_WARNED);
    expect(running.fake.requests).toHaveLength(0);
    expect(answer.line).toMatchObject({ status: 415, answered: true, methods: [] });

    // The same message under the type written without the leading semicolon.
    const served = await postWithContentType(running, 'application/json', ping);
    expect(served.status).toBe(200);
    expect(served.body).toEqual(PING_ANSWER);
    expect(running.log.warn).not.toHaveBeenCalled();
  });

  for (const type of ['application/json; charset=utf-8', 'application/json;', 'APPLICATION/JSON']) {
    it(`reads and serves a body declared ${JSON.stringify(type)}, with this route's parser`, async () => {
      const running = await run(liveBook());
      const served = await postWithContentType(running, type, rpc('ping', {}, 7));
      expect([type, served.status]).toEqual([type, 200]);
      expect(served.body).toEqual(PING_ANSWER);
      expect(running.log.warn).not.toHaveBeenCalled();
      expect(running.log.error).not.toHaveBeenCalled();
      expect(served.line).toMatchObject({ status: 200, methods: ['ping'] });

      // A body that is not JSON under the same type is answered by the route's
      // own parser, before any server is built. Had the parser left it alone,
      // the transport would have read it and answered in its own words.
      const broken = await postWithContentType(running, type, NOT_JSON);
      expect([type, broken.status]).toEqual([type, 400]);
      expect(broken.body).toEqual({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error: Invalid JSON' },
        id: null,
      });
      expect(running.log.warn.mock.calls).toEqual([[{ type: 'entity.parse.failed' }, 'mcp: request body refused']]);
      expect(running.log.error).not.toHaveBeenCalled();
      expect(running.built).not.toHaveBeenCalled();
    });
  }

  // Content-Types with no media type in front of their first semicolon, and an
  // empty one. The JSON parser's default test of the type throws on the first
  // kind, which the route would answer with a 500.
  const noMediaType = [
    '',
    ';',
    ';;',
    ';=',
    '; charset=utf-8',
    ';application/json; charset=utf-8',
    ';application/json;',
    ';application/json,application/json',
    ';text/plain',
  ];
  for (const type of noMediaType) {
    it(`refuses a Content-Type of ${JSON.stringify(type)} with 415 and no error line, reading nothing`, async () => {
      const running = await run(liveBook());
      // A call that reads the database when it is served.
      const refused = await postWithContentType(running, type, listCall);
      expect([type, refused.status]).toEqual([type, 415]);
      expect(refused.body).toEqual(NOT_JSON_TYPE);
      expect(running.log.error).not.toHaveBeenCalled();
      expect(running.log.warn.mock.calls).toEqual(NOT_JSON_TYPE_WARNED);
      expect(running.fake.requests).toHaveLength(0);
      expect(refused.line).toMatchObject({ status: 415, answered: true, methods: [] });

      // A body that is not JSON gets the same answer: the route's parser did
      // not read it, or it would have answered 400.
      const unread = await postWithContentType(running, type, NOT_JSON);
      expect([type, unread.status]).toEqual([type, 415]);
      expect(unread.body).toEqual(NOT_JSON_TYPE);
      expect(running.log.error).not.toHaveBeenCalled();
      expect(running.log.warn.mock.calls).toEqual(NOT_JSON_TYPE_WARNED);
    });
  }

  // Two Content-Type headers. Node keeps the first copy, which the route's
  // parser tests, and the transport tests both copies joined by a comma. So
  // the two can disagree about whether the body is JSON. Whichever way they
  // disagree, a list is not served and the database is not read.
  const NOT_A_MESSAGE = {
    jsonrpc: '2.0',
    error: { code: -32700, message: 'Parse error: Invalid JSON-RPC message' },
    id: null,
  };
  const NOT_A_MESSAGE_WARNED = [
    [{ err: 'Parse error: Invalid JSON-RPC message' }, 'mcp: request refused by the transport'],
  ];
  const LIST_REFUSED = {
    jsonrpc: '2.0',
    error: { code: -32600, message: 'One message per request, sent as an object and not as a list.' },
    id: null,
  };
  const fiveCalls = JSON.stringify(
    Array.from({ length: 5 }, (_, index) => ({
      jsonrpc: '2.0',
      id: index + 1,
      method: 'tools/call',
      params: { name: 'list_markets', arguments: {} },
    })),
  );
  type Outcome = [status: number, body: unknown, warned: unknown[]];
  const duplicated: Array<{ types: [string, string]; list: Outcome; one: Outcome }> = [
    // The first copy's quote is not closed, so the parser leaves the body
    // alone. Joined, the quote closes, and the transport takes it for JSON.
    {
      types: ['application/json; a="x,', 'y"'],
      list: [400, NOT_A_MESSAGE, NOT_A_MESSAGE_WARNED],
      one: [400, NOT_A_MESSAGE, NOT_A_MESSAGE_WARNED],
    },
    // The parser reads the body under the first copy. The transport refuses
    // the pair joined.
    {
      types: ['application/json', 'text/plain'],
      list: [400, LIST_REFUSED, [[{ messages: 5 }, 'mcp: batch refused']]],
      one: [415, NOT_JSON_TYPE, NOT_JSON_TYPE_WARNED],
    },
    {
      types: ['text/plain', 'application/json'],
      list: [415, NOT_JSON_TYPE, NOT_JSON_TYPE_WARNED],
      one: [415, NOT_JSON_TYPE, NOT_JSON_TYPE_WARNED],
    },
  ];
  for (const { types, list, one } of duplicated) {
    it(`serves nothing under the two Content-Types ${JSON.stringify(types)}, a list or one call`, async () => {
      const running = await run(liveBook());
      for (const [body, [status, answerBody, warned]] of [
        [fiveCalls, list],
        [listCall, one],
      ] as const) {
        const answer = await postWithContentType(running, types, body);
        expect([types, answer.status]).toEqual([types, status]);
        expect(answer.body).toEqual(answerBody);
        expect(running.log.warn.mock.calls).toEqual(warned);
        expect(running.log.error).not.toHaveBeenCalled();
        expect(running.log.info).not.toHaveBeenCalledWith(expect.anything(), 'mcp: tool call');
        expect(answer.line).toMatchObject({ status, answered: true, methods: [] });
      }
      expect(running.fake.requests).toHaveLength(0);
    });
  }

  it('serves one call under the first pair above sent as one header, and refuses the list under it', async () => {
    const running = await run(liveBook());
    const joined = 'application/json; a="x, y"';
    const served = await postWithContentType(running, joined, listCall);
    expect(served.status).toBe(200);
    expect(textOf((served.body as { result: unknown }).result)).toContain('contest_id 481');
    expect(running.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
    expect(served.line).toMatchObject({ status: 200, methods: ['tools/call'] });

    const refused = await postWithContentType(running, joined, fiveCalls);
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual(LIST_REFUSED);
    expect(running.log.warn.mock.calls).toEqual([[{ messages: 5 }, 'mcp: batch refused']]);
    expect(running.built).not.toHaveBeenCalled();
  });

  it('serves one call under two Content-Types when the first copy and both joined name JSON', async () => {
    const running = await run(liveBook());
    // The first copy's quote is not closed and it holds no comma, so it is
    // read as JSON; joined, the quote closes.
    const types = ['application/json; a="x', 'y"'];
    const served = await postWithContentType(running, types, listCall);
    expect(served.status).toBe(200);
    expect(textOf((served.body as { result: unknown }).result)).toContain('contest_id 481');
    expect(running.log.warn).not.toHaveBeenCalled();

    const refused = await postWithContentType(running, types, fiveCalls);
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual(LIST_REFUSED);
    expect(running.log.warn.mock.calls).toEqual([[{ messages: 5 }, 'mcp: batch refused']]);
    expect(running.built).not.toHaveBeenCalled();
  });

  it('refuses a POST that has no body as carrying no message', async () => {
    const running = await run(liveBook());
    const raw = await rawConnection(running);
    // A head that frames no body: no Content-Length and no Transfer-Encoding.
    await raw.write(requestHead('Connection: keep-alive'));
    await vi.waitFor(() => expect(raw.answers).toHaveLength(1), { timeout: 5_000 });
    expect(raw.answers[0]).toEqual({ status: 400, body: NOT_A_MESSAGE });
    expect(running.log.warn.mock.calls).toEqual(NOT_A_MESSAGE_WARNED);
    expect(running.log.error).not.toHaveBeenCalled();
    expect(running.fake.requests).toHaveLength(0);
  });

  for (const accept of ['application/json', 'text/event-stream']) {
    it(`refuses a POST that accepts only ${accept} with 406`, async () => {
      const running = await run(liveBook());
      const answer = await post(running, {
        headers: { 'content-type': 'application/json', accept },
        body: rpc('tools/list', {}),
      });
      expect(answer.status).toBe(406);
      expect(answer.contentType).toContain('application/json');
      expect(answer.body).toEqual({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Not Acceptable: Client must accept both application/json and text/event-stream',
        },
        id: null,
      });
      expect(running.log.error).not.toHaveBeenCalled();
      expect(running.log.warn.mock.calls).toEqual([
        [
          { err: 'Not Acceptable: Client must accept both application/json and text/event-stream' },
          'mcp: request refused by the transport',
        ],
      ]);
      expect(answer.line).toMatchObject({ status: 406, answered: true, methods: [] });
    });
  }

  // What a body sent with any Content-Encoding is answered with. Nothing is
  // inflated, so whether the bytes would inflate, and to what, changes nothing.
  const NO_ENCODING = {
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Unsupported Media Type: send the body as it is, with no Content-Encoding' },
    id: null,
  };

  // A tool call that reads the database when it is served, so a body that was
  // inflated and read would show up as reads.
  const listCall = rpc('tools/call', { name: 'list_markets', arguments: {} }, 9);

  const encoded: Array<[string, string, () => Uint8Array]> = [
    ['a valid gzip body', 'gzip', () => new Uint8Array(gzipSync(Buffer.from(listCall)))],
    // One repeated character compresses to almost nothing: a few kilobytes
    // that would inflate past the limit.
    ['a gzip body that would inflate past one mebibyte', 'gzip', () => new Uint8Array(gzipSync(Buffer.from(paddedToolsList(1_048_577))))],
    ['a body that says it is gzip and is not', 'gzip', () => new Uint8Array(Buffer.from('this is not gzip'))],
    ['a valid deflate body', 'deflate', () => new Uint8Array(deflateSync(Buffer.from(listCall)))],
    ['a valid brotli body', 'br', () => new Uint8Array(brotliCompressSync(Buffer.from(listCall)))],
    ['a gzip body named in capitals', 'GZIP', () => new Uint8Array(gzipSync(Buffer.from(listCall)))],
    // Not compressed at all, but it says it is, in an encoding nobody reads.
    ['a plain body that names an encoding nobody here reads', 'compress', () => new Uint8Array(Buffer.from(listCall))],
  ];

  for (const [name, encoding, bytes] of encoded) {
    it(`refuses ${name} with 415, having inflated nothing, built nothing and read nothing`, async () => {
      const running = await run(liveBook());
      const body = bytes();
      const answer = await post(running, { headers: { ...JSON_RPC_HEADERS, 'content-encoding': encoding }, body });
      expect(answer.status).toBe(415);
      expect(answer.contentType).toContain('application/json');
      expect(answer.body).toEqual(NO_ENCODING);
      expect(answer.body).not.toEqual(REST_ERROR);
      expect(running.log.error).not.toHaveBeenCalled();
      expect(running.log.warn.mock.calls).toEqual([[{ type: 'encoding.unsupported' }, 'mcp: request body refused']]);
      expect(running.built).not.toHaveBeenCalled();
      expect(running.fake.requests).toHaveLength(0);
      // Refused, and still a request in the log.
      expect(answer.line).toMatchObject({ status: 415, answered: true, methods: [] });
    });
  }

  it('checks that the compressed bodies are compressed, so the refusals are not of plain JSON', () => {
    const [gzipped, oversized, , deflated, brotli] = encoded.map(([, , bytes]) => Buffer.from(bytes()));
    expect(gzipped?.subarray(0, 2).toString('hex')).toBe('1f8b');
    expect(oversized?.subarray(0, 2).toString('hex')).toBe('1f8b');
    expect(oversized?.length).toBeLessThan(4_096);
    // zlib's header for the default level.
    expect(deflated?.subarray(0, 2).toString('hex')).toBe('789c');
    expect(brotli?.toString('utf8')).not.toBe(listCall);
    expect(brotli?.toString('utf8')).not.toContain('list_markets');
  });

  it('reads a body sent with the identity encoding, which is no encoding at all', async () => {
    const running = await run(liveBook());
    const answer = await post(running, {
      headers: { ...JSON_RPC_HEADERS, 'content-encoding': 'identity' },
      body: listCall,
    });
    expect(answer.status).toBe(200);
    const body = answer.body as { id: number; result: { content: Array<{ text: string }> } };
    expect(body.id).toBe(9);
    expect(body.result.content[0]?.text).toContain('contest_id 481');
    expect(running.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
    expect(running.log.warn).not.toHaveBeenCalled();
    expect(answer.line).toMatchObject({ status: 200, methods: ['tools/call'] });
  });

  for (const charset of ['iso-8859-1', 'windows-1252', 'us-ascii']) {
    it(`refuses a body declared ${charset} with 415, and asks for UTF-8`, async () => {
      const running = await run(liveBook());
      // A message that is served as UTF-8. Only the declared charset differs.
      const answer = await post(running, {
        headers: { ...JSON_RPC_HEADERS, 'content-type': `application/json; charset=${charset}` },
        body: listCall,
      });
      expect(answer.status).toBe(415);
      expect(answer.contentType).toContain('application/json');
      expect(answer.body).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unsupported Media Type: send the body in UTF-8' },
        id: null,
      });
      expect(running.log.error).not.toHaveBeenCalled();
      expect(running.log.warn.mock.calls).toEqual([[{ type: 'charset.unsupported' }, 'mcp: request body refused']]);
      expect(running.built).not.toHaveBeenCalled();
      expect(running.fake.requests).toHaveLength(0);
      expect(answer.line).toMatchObject({ status: 415, answered: true, methods: [] });
    });
  }

  // Each body in the encoding its charset names. A route that read the bytes
  // as UTF-8 would find NUL bytes between the characters and no JSON.
  const utf: Array<[string, () => Uint8Array]> = [
    ['utf-8', () => new Uint8Array(Buffer.from(listCall, 'utf8'))],
    ['utf-16', () => new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(listCall, 'utf16le')]))],
    ['utf-16le', () => new Uint8Array(Buffer.from(listCall, 'utf16le'))],
    ['utf-32le', () => new Uint8Array(Buffer.from([...listCall].flatMap((char) => [char.charCodeAt(0), 0, 0, 0])))],
  ];
  for (const [charset, bytes] of utf) {
    it(`reads a body declared ${charset} and sent in it`, async () => {
      const running = await run(liveBook());
      const body = bytes();
      expect([charset, body.includes(0)]).toEqual([charset, charset !== 'utf-8']);
      const answer = await post(running, {
        headers: { ...JSON_RPC_HEADERS, 'content-type': `application/json; charset=${charset}` },
        body,
      });
      expect([charset, answer.status]).toEqual([charset, 200]);
      const result = answer.body as { id: number; result: { content: Array<{ text: string }> } };
      expect(result.id).toBe(9);
      expect(result.result.content[0]?.text).toContain('contest_id 481');
      expect(running.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
      expect(running.log.warn).not.toHaveBeenCalled();
    });
  }

  it('answers 500 in the JSON-RPC shape when the server cannot be connected, and keeps the cause in the log', async () => {
    const running = await run(liveBook(), {
      buildServer: (real) => (...args) => {
        const server = real(...args);
        server.connect = () => Promise.reject(new Error('cause known to db.internal'));
        return server;
      },
    });
    const answer = await post(running, { body: rpc('tools/list', {}) });
    // The fixture did what it is for: a server was built, and it was the one that fails.
    expect(running.built).toHaveBeenCalledTimes(1);
    expect(answer.status).toBe(500);
    expect(answer.contentType).toContain('application/json');
    expect(answer.body).toEqual({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    expect(answer.text).not.toContain('db.internal');
    expect(running.log.error.mock.calls).toEqual([
      [{ err: 'Error: cause known to db.internal' }, 'mcp: request failed'],
    ]);
    expect(answer.line).toMatchObject({ status: 500, answered: true, methods: [] });

    // Beside it: the same request to an app whose server connects is served.
    const healthy = await run(liveBook());
    expect((await post(healthy, { body: rpc('tools/list', {}) })).status).toBe(200);
  });

  // A throw from the builder happens before the route's promise chain exists,
  // so it is the route's own error handler that answers it, and not the app's.
  it('answers 500 in the JSON-RPC shape when building the server throws, and keeps the cause in the log', async () => {
    const running = await run(liveBook(), {
      buildServer: () => () => {
        throw new Error('cause known to db.internal');
      },
    });
    const answer = await post(running, { body: rpc('tools/list', {}) });
    // The fixture did what it is for: the builder was called, and it threw.
    expect(running.built).toHaveBeenCalledTimes(1);
    expect(answer.status).toBe(500);
    expect(answer.contentType).toContain('application/json');
    expect(answer.body).toEqual({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    expect(answer.body).not.toEqual(REST_ERROR);
    expect(answer.text).not.toContain('db.internal');
    expect(answer.text).not.toContain('cause known');
    expect(running.log.error.mock.calls).toEqual([
      [{ err: 'Error: cause known to db.internal' }, 'mcp: request failed'],
    ]);
    expect(running.log.warn).not.toHaveBeenCalled();
    expect(running.fake.requests).toHaveLength(0);
    expect(answer.line).toMatchObject({ status: 500, answered: true, methods: [] });

    // Beside it: the same request to an app whose builder does not throw is served.
    const healthy = await run(liveBook());
    expect((await post(healthy, { body: rpc('tools/list', {}) })).status).toBe(200);
  });

  it('never answers 401, and offers no sign-in to discover', async () => {
    const running = await run(liveBook());
    const probes: Array<[string, string]> = [
      ['GET', '/.well-known/oauth-protected-resource'],
      ['GET', '/.well-known/oauth-protected-resource/mcp'],
      ['GET', '/.well-known/oauth-authorization-server'],
      ['GET', '/.well-known/oauth-authorization-server/mcp'],
      ['GET', '/.well-known/openid-configuration'],
      ['POST', '/register'],
      ['GET', '/authorize'],
      ['POST', '/token'],
    ];
    for (const [method, path] of probes) {
      const response = await fetch(`${running.url}${path}`, {
        method,
        ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
      });
      expect([path, response.status]).toEqual([path, 404]);
      expect(response.headers.get('www-authenticate')).toBeNull();
    }
    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await fetch(`${running.url}/mcp`, {
        method,
        ...(method === 'POST' ? { headers: JSON_RPC_HEADERS, body: rpc('tools/list', {}) } : {}),
      });
      expect(response.status).not.toBe(401);
      expect(response.headers.get('www-authenticate')).toBeNull();
    }
  });

  it('counts every request against its own budget of 600 a minute', async () => {
    const running = await run(liveBook());
    const post = await fetch(`${running.url}/mcp`, { method: 'POST', headers: JSON_RPC_HEADERS, body: rpc('tools/list', {}) });
    expect(post.headers.get('ratelimit-policy')).toBe('600;w=60');
    const get = await fetch(`${running.url}/mcp`);
    expect(get.headers.get('ratelimit-policy')).toBe('600;w=60');
    // A fresh app: the first request leaves 599, the second 598. Written out,
    // because a header that is missing reads as NaN on both sides.
    expect(post.headers.get('ratelimit')).toMatch(/^limit=600, remaining=599, reset=\d+$/);
    expect(get.headers.get('ratelimit')).toMatch(/^limit=600, remaining=598, reset=\d+$/);
  });

  it('counts per caller address, read from the one proxy in front of the app', async () => {
    const running = await run(liveBook());
    const remaining = async (forwardedFor: string): Promise<string | null> =>
      (await fetch(`${running.url}/mcp`, { headers: { 'x-forwarded-for': forwardedFor } })).headers.get('ratelimit');
    // Two addresses from the documentation ranges, each with a budget of its own.
    expect(await remaining('192.0.2.10')).toMatch(/^limit=600, remaining=599, reset=\d+$/);
    expect(await remaining('198.51.100.20')).toMatch(/^limit=600, remaining=599, reset=\d+$/);
    // The same address again spends its own budget.
    expect(await remaining('192.0.2.10')).toMatch(/^limit=600, remaining=598, reset=\d+$/);
  });

  it('does not spend the REST read budget, nor REST reads its own', async () => {
    const running = await run(liveBook());
    const left = (response: Response): number =>
      Number(/remaining=(\d+)/.exec(response.headers.get('ratelimit') ?? '')?.[1]);
    const before = left(await fetch(`${running.url}/v1/protocol/info`));
    expect(before).toBe(599);
    for (let index = 0; index < 5; index += 1) await fetch(`${running.url}/mcp`);
    expect(left(await fetch(`${running.url}/v1/protocol/info`))).toBe(598);

    // And the other way: REST reads leave the /mcp count where it was.
    const mcpBefore = left(await fetch(`${running.url}/mcp`));
    expect(mcpBefore).toBe(594);
    for (let index = 0; index < 5; index += 1) await fetch(`${running.url}/v1/protocol/info`);
    expect(left(await fetch(`${running.url}/mcp`))).toBe(593);
  });

  it(
    'answers request 600 in a minute, refuses request 601 with 429 in the JSON-RPC shape, and leaves REST reads alone',
    async () => {
      const running = await run(liveBook());
      const statuses: number[] = [];
      let last = '';
      let lastType: string | null = null;
      for (let sent = 1; sent <= 601; sent += 1) {
        const response = await fetch(`${running.url}/mcp`, {
          method: 'POST',
          headers: JSON_RPC_HEADERS,
          body: rpc('ping', {}, sent),
        });
        statuses.push(response.status);
        last = await response.text();
        lastType = response.headers.get('content-type');
      }

      expect(statuses.slice(0, 600).filter((status) => status !== 200)).toEqual([]);
      expect(statuses[599]).toBe(200);
      expect(statuses[600]).toBe(429);
      expect(lastType).toContain('application/json');
      expect(JSON.parse(last)).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Too many requests from this address, please slow down.' },
        id: null,
      });

      // The refusal came from the limiter, ahead of the route: it wrote no
      // request line and built no server. The 600 before it each did.
      await vi.waitFor(() => {
        expect(running.log.info.mock.calls.filter((call) => call[1] === 'mcp: request')).toHaveLength(600);
      });
      expect(running.built).toHaveBeenCalledTimes(600);

      // A path under the mount spends the same budget, so it is refused too.
      const under = await fetch(`${running.url}/mcp/anything`);
      expect(under.status).toBe(429);

      // The REST counter is another one. With /mcp spent, a read is still served.
      const read = await fetch(`${running.url}/v1/protocol/info`);
      expect(read.status).toBe(200);
      expect(read.headers.get('ratelimit')).toBe('limit=600, remaining=599, reset=60');
    },
    // 601 requests in turn took 1.6 to 3.2 seconds on a Windows laptop with
    // Node 22, the longer runs with other suites running beside this one. The
    // limit leaves room for a machine many times slower, and is under the
    // minute after which the limiter's window would start again.
    45_000,
  );

  it('writes no request line for a method it refuses with 405', async () => {
    const running = await run(liveBook());
    const refused = await fetch(`${running.url}/mcp`);
    expect(refused.status).toBe(405);
    // A POST sent afterwards closes later than the GET did, so once its line
    // is in the log the GET's would be too, if it wrote one.
    const served = await post(running, { body: rpc('ping', {}) });
    expect(served.status).toBe(200);
    expect(running.log.info.mock.calls.map((call) => call[1] as string)).toEqual(['mcp: request']);
  });

  // Each call is sent with its arguments in a case the tool does not print
  // them in, so a line that carried an argument as given, or as the tool
  // normalised it, is found either way by a comparison that ignores case.
  //
  // contest_id is left out of the search on purpose. The request line and the
  // tool-call line do not carry it, which the exact keys below show, but two
  // warnings in prepare_order do name the contest they are about: one for a
  // contest with no readable start time, one for a book that could not be read
  // whole. The first is pinned in the case after these.
  const UPPER_HASH = `0x${'A1'.repeat(32)}`;
  const UPPER_TAKER = `0x${'C'.repeat(40)}`;
  const logged: Array<{ tool: string; args: Record<string, unknown>; secrets: string[] }> = [
    { tool: 'list_markets', args: { window_hours: 12, sport: 'MLB' }, secrets: ['mlb'] },
    {
      tool: 'prepare_order',
      args: { contest_id: '481', market: 'total', side: 'UNDER', risk_usdc: 3.172649 },
      secrets: ['under', '3.172649', '3172649'],
    },
    {
      tool: 'get_order_status',
      args: { commitment_hash: UPPER_HASH, taker_address: UPPER_TAKER },
      secrets: [hash('a1'), TAKER, 'a1'.repeat(32), 'c'.repeat(40)],
    },
  ];

  for (const { tool, args, secrets } of logged) {
    for (const outcome of ['passing', 'failing'] as const) {
      it(`logs none of the arguments of a ${outcome} ${tool} call, at any level`, async () => {
        const running = await run(
          liveBook(),
          outcome === 'passing'
            ? {}
            : { override: () => ({ status: 500, body: { message: 'detail from db.internal' } }) },
        );
        const answer = await post(running, {
          headers: { ...JSON_RPC_HEADERS, 'mcp-protocol-version': '2025-06-18', 'user-agent': 'endpoint-test/1.0' },
          body: rpc('tools/call', { name: tool, arguments: args }),
        });
        expect(answer.status).toBe(200);
        const result = (answer.body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;

        // The call is what the case says it is, and it reached the tool and a read.
        expect(result.isError).toBe(outcome === 'passing' ? undefined : true);
        expect(result.content[0]?.text).not.toContain('Input validation error');
        expectReached(running.fake);

        // Both lines were written, and each carries these keys and no others.
        const toolLines = running.log.info.mock.calls.filter((call) => call[1] === 'mcp: tool call');
        expect(toolLines).toEqual([
          [{ tool, isError: outcome === 'failing', ms: expect.any(Number) as number }, 'mcp: tool call'],
        ]);
        expect(running.log.info.mock.calls).toHaveLength(2);
        expect(Object.keys(answer.line).sort()).toEqual([
          'agent',
          'answered',
          'asked',
          'client',
          'methods',
          'ms',
          'protocol',
          'status',
        ]);
        expect(answer.line).toMatchObject({
          status: 200,
          answered: true,
          methods: ['tools/call'],
          client: undefined,
          asked: undefined,
          protocol: '2025-06-18',
          agent: 'endpoint-test/1.0',
        });
        expect(typeof answer.line['ms']).toBe('number');

        const everything = everythingLogged(running);
        // The search can find something: the tool's name is in there.
        expect(everything).toContain(tool);
        for (const secret of secrets) {
          expect([secret, everything.includes(secret.toLowerCase())]).toEqual([secret, false]);
        }
      });
    }
  }

  it('names the contest in the warning about a contest whose start cannot be read', async () => {
    const book = liveBook();
    book.contests_effective = [contestRow({ effective_start_time: null })];
    const running = await run(book);
    const answer = await post(running, {
      body: rpc('tools/call', {
        name: 'prepare_order',
        arguments: { contest_id: '481', market: 'total', side: 'under', risk_usdc: 2 },
      }),
    });
    const result = (answer.body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    expect(result.content[0]?.text).toBe(
      'Tampa Bay Rays @ Philadelphia Phillies has no start time Ospex can read, so it cannot be bet on.\n' +
        'No order was prepared, and nothing was placed.',
    );
    expect(running.log.warn.mock.calls).toEqual([
      [{ contestId: '481' }, 'mcp: prepare_order found a contest with no readable start time'],
    ]);
    // The two lines written for every call still do not carry it.
    expect(running.log.info.mock.calls.map((call) => Object.keys(call[0] as object).sort())).toEqual([
      ['isError', 'ms', 'tool'],
      ['agent', 'answered', 'asked', 'client', 'methods', 'ms', 'protocol', 'status'],
    ]);
  });

  it('says when a client left before it was answered, whatever the status reads', async () => {
    // A database that never answers, so the call is still running when the client goes.
    const running = await run(liveBook(), { override: () => ({ hang: true }) });
    const leaving = new AbortController();
    const pending = fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: JSON_RPC_HEADERS,
      body: rpc('tools/call', { name: 'list_markets', arguments: {} }),
      signal: leaving.signal,
    });
    await vi.waitFor(() => expectReached(running.fake));
    leaving.abort();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => {
      expect(running.log.info).toHaveBeenCalledWith(expect.anything(), 'mcp: request');
    });
    const line = running.log.info.mock.calls.find((call) => call[1] === 'mcp: request')?.[0];
    expect(line).toMatchObject({ answered: false, methods: ['tools/call'] });
  });

  it('says how long a request took, from its arrival to its close', async () => {
    // A database that never answers, so the request lasts until the client goes.
    const running = await run(liveBook(), { override: () => ({ hang: true }) });
    const leaving = new AbortController();
    const pending = fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: JSON_RPC_HEADERS,
      body: rpc('tools/call', { name: 'list_markets', arguments: {} }),
      signal: leaving.signal,
    });
    await vi.waitFor(() => expectReached(running.fake));
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    leaving.abort();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => {
      expect(running.log.info).toHaveBeenCalledWith(expect.anything(), 'mcp: request');
    });
    const line = running.log.info.mock.calls.find((call) => call[1] === 'mcp: request')?.[0] as { ms: number };
    // At least the 300 ms the client waited after the read was made.
    expect(line.ms).toBeGreaterThanOrEqual(290);
    expect(line.ms).toBeLessThan(15_000);
  });

  it('names a client only from a handshake, and not from a request that repeats its fields', async () => {
    const running = await run(liveBook());
    const pinged = await post(running, {
      body: rpc('ping', { protocolVersion: '2025-06-18', clientInfo: { name: 'not-a-handshake', version: '1.0.0' } }),
    });
    expect(pinged.body).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(pinged.line).toMatchObject({ methods: ['ping'], client: undefined, asked: undefined });

    // Beside it: the same fields on a handshake are named.
    const introduced = await post(running, {
      body: rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'a-handshake', version: '1.0.0' },
      }),
    });
    expect(introduced.line).toMatchObject({ methods: ['initialize'], client: 'a-handshake', asked: '2025-06-18' });
  });

  it('notes who connected and what protocol they asked for', async () => {
    const running = await run(liveBook());
    await connect(running);
    await vi.waitFor(() => {
      const lines = running.log.info.mock.calls.filter((call) => call[1] === 'mcp: request');
      expect(lines.some((call) => (call[0] as { client?: string }).client === 'endpoint-test')).toBe(true);
    });
    const line = running.log.info.mock.calls.find(
      (call) => call[1] === 'mcp: request' && (call[0] as { client?: string }).client === 'endpoint-test',
    )?.[0] as Record<string, unknown>;
    expect(line['methods']).toEqual(['initialize']);
    expect(typeof line['asked']).toBe('string');
  });

  it('cuts each value the request line repeats from the request to a fixed length', async () => {
    const running = await run(liveBook());
    // Every value longer than its cut, and each a different letter, so a cut
    // taken from the wrong value or at the wrong length is seen.
    const introduced = await post(running, {
      headers: { ...JSON_RPC_HEADERS, 'mcp-protocol-version': 'p'.repeat(200), 'user-agent': 'u'.repeat(200) },
      body: rpc('initialize', {
        protocolVersion: 'v'.repeat(50),
        capabilities: {},
        clientInfo: { name: 'n'.repeat(100), version: '1.0.0' },
      }),
    });
    expect(introduced.line).toMatchObject({
      methods: ['initialize'],
      protocol: 'p'.repeat(120),
      agent: 'u'.repeat(120),
      asked: 'v'.repeat(20),
      client: 'n'.repeat(60),
    });

    const unknown = await post(running, { body: rpc('m'.repeat(100), {}) });
    expect(unknown.body).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32601 } });
    expect(unknown.line).toMatchObject({ methods: ['m'.repeat(60)] });
  });

  it('names a message that carries no method as a response in its line', async () => {
    const running = await run(liveBook());
    // A JSON-RPC response, as a client would send one to a request the server made.
    const answer = await post(running, { body: JSON.stringify({ jsonrpc: '2.0', id: 4, result: {} }) });
    expect(answer.status).toBe(202);
    expect(answer.text).toBe('');
    expect(answer.line).toMatchObject({ status: 202, answered: true, methods: ['response'] });
    expect(running.fake.requests).toHaveLength(0);
  });
});

describe('/mcp: what the router module exports', () => {
  it('exports the body limit and the router, and no count of messages per request', async () => {
    vi.resetModules();
    const router = await import('../src/mcp/router.js');
    expect(Object.keys(router).sort()).toEqual(['MCP_MAX_BODY_BYTES', 'createMcpRouter']);
    expect('MCP_MAX_MESSAGES_PER_REQUEST' in router).toBe(false);
    expect(router.MCP_MAX_BODY_BYTES).toBe(1_048_576);
  });
});

// ── the rest of the app, unchanged ─────────────────────────────────────

describe('the app around /mcp', () => {
  it('still serves its health check and its REST reads', async () => {
    const running = await run(liveBook());
    const health = await fetch(`${running.url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: 'ospex-core-api', network: 'polygon' });

    const contests = await fetch(`${running.url}/v1/contests?window=48`);
    expect(contests.status).toBe(200);
    const body = (await contests.json()) as { contests: Array<{ contestId: string; speculations: unknown[] }> };
    expect(body.contests.map((contest) => contest.contestId)).toEqual(['481']);
    expect(body.contests[0]?.speculations).toHaveLength(1);
  });

  it('serves a quote by hash and its fills over REST, through the functions the tools share', async () => {
    const running = await run(liveBook());
    const quote = await fetch(`${running.url}/v1/commitments/${hash('a1')}`);
    expect(quote.status).toBe(200);
    expect(await quote.json()).toMatchObject({ commitmentHash: hash('a1'), maker: MAKER_A, oddsTick: 205 });

    const missing = await fetch(`${running.url}/v1/commitments/${hash('ee')}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: `Commitment ${hash('ee')} not found.`, code: 'NOT_FOUND' });

    const fills = await fetch(`${running.url}/v1/fills?commitmentHash=${hash('a1')}`);
    expect(fills.status).toBe(200);
    const body = (await fills.json()) as { fills: Array<{ txHash: string }>; hasMore: boolean };
    expect(body.fills.map((fill) => fill.txHash)).toEqual([hash('f1')]);
    expect(body.hasMore).toBe(false);
  });

  it('still parses JSON for the routes behind the parser, and still answers their bad bodies as it did', async () => {
    const running = await run(liveBook());
    const response = await fetch(`${running.url}/v1/commitments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"action": ',
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });

  it('still answers a path nobody serves with its own 404', async () => {
    const running = await run(liveBook());
    for (const path of ['/nope', '/mcp/anything', '/mcpx']) {
      const response = await fetch(`${running.url}${path}`);
      expect([path, response.status]).toEqual([path, 404]);
      expect(await response.json()).toEqual({ error: 'not_found', code: 'NOT_FOUND' });
    }
  });

  it('answers a POST to a path under /mcp as the app answers one to any path nobody serves', async () => {
    const running = await run(liveBook());
    // The app reads a JSON body before it looks for a route, so a body it
    // cannot read is its 500 and a body it can read goes on to its 404. A path
    // under /mcp gets that, and not the answers /mcp itself gives.
    for (const path of ['/mcp/x', '/nope']) {
      running.log.error.mockClear();
      const malformed = await fetch(`${running.url}${path}`, {
        method: 'POST',
        headers: JSON_RPC_HEADERS,
        body: '{"jsonrpc": ',
      });
      expect([path, malformed.status]).toEqual([path, 500]);
      expect(await malformed.json()).toEqual({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
      expect(running.log.error.mock.calls).toEqual([
        [{ err: expect.stringContaining('SyntaxError') as string }, 'unhandled error'],
      ]);

      const readable = await fetch(`${running.url}${path}`, {
        method: 'POST',
        headers: JSON_RPC_HEADERS,
        body: rpc('tools/list', {}),
      });
      expect([path, readable.status]).toEqual([path, 404]);
      expect(await readable.json()).toEqual({ error: 'not_found', code: 'NOT_FOUND' });
    }
    // Nothing the route writes for a request of its own was written for these.
    expect(running.log.warn).not.toHaveBeenCalled();
    expect(running.log.info).not.toHaveBeenCalled();
    expect(running.built).not.toHaveBeenCalled();

    // Beside them: the same malformed body at /mcp itself is a JSON-RPC 400.
    const mount = await post(running, { body: '{"jsonrpc": ' });
    expect(mount.status).toBe(400);
    expect(mount.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error: Invalid JSON' },
      id: null,
    });
  });
});
