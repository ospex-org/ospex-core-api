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
 * forms are pinned in `mcp-tools.test.ts`, which passes the clock in.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectReached, type CapturedRequest, type FakePostgrest, type FakeReply } from './helpers/fakePostgrest.js';
import {
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
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const fake of fakes.splice(0)) await fake.close();
  vi.doUnmock('../src/lib/env.js');
  vi.doUnmock('../src/lib/logger.js');
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

interface Running {
  url: string;
  fake: FakePostgrest;
  log: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
}

async function run(
  tables: Tables,
  options: { override?: (request: CapturedRequest, index: number) => FakeReply | undefined; config?: Row } = {},
): Promise<Running> {
  const fake = await startBook(tables, options.override);
  fakes.push(fake);
  const config = configFor(fake, options.config);
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), fatal: vi.fn() };

  vi.resetModules();
  vi.doMock('../src/lib/env.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/lib/env.js')>()),
    loadConfig: () => config,
  }));
  vi.doMock('../src/lib/logger.js', () => ({ logger: log, formatError: String }));

  const { buildApp } = await import('../src/app.js');
  const app = buildApp(config as unknown as Parameters<typeof buildApp>[0]);
  const server = createServer(app);
  // The listener and every socket it accepts, or a passing suite hangs at exit.
  server.on('connection', (socket) => socket.unref());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  server.unref();
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, fake, log };
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

  it('reads nothing from the database to connect or to list its tools', async () => {
    const running = await run(liveBook());
    const client = await connect(running);
    await client.listTools();
    await client.listTools();
    expect(running.fake.requests).toHaveLength(0);
  });

  it('answers a tool call that was never preceded by a handshake', async () => {
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
    expect(body.result.serverInfo.name).toBe('ospex');
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
    expect(text).toContain('Exactly 7 is a push.');
    expect(text).toContain('Exact amounts: you pay 1.999935 USDC and win 1.904700 USDC.');
    expect(text).toContain(`Take link: https://ospex.org/take/${hash('a1')}?risk=2`);
    expect(text).toContain('Nothing has been placed.');
    expect(text).toContain(`commitment_hash: ${hash('a1')}`);
    // The quote's signature is what a taker's transaction carries. It is never in the answer.
    expect(text).not.toContain('5a5a5a5a');
    expect(running.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments', 'maker_funding']);
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
    expect(text).toContain('Ospex takes no bets on a game under way.');
    expect(text).toContain('No order was prepared, and nothing was placed.');
    expect(text).not.toContain('Take link');
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
    expect(text).toContain('Status: open: it can be taken.');
    expect(text).toContain(`Fills on this quote by ${TAKER}: 1.`);
    expect(text).toContain(`risked 1.999935 USDC to win 1.9047 at 1.95`);
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
      ['prepare_order', { contest_id: 481, market: 'total', side: 'under', risk_usdc: 2 }, 'contest_id'],
      ['prepare_order', { market: 'total', side: 'under', risk_usdc: 2 }, 'contest_id'],
      ['list_markets', { window_hours: 169 }, 'window_hours'],
      ['list_markets', { window_hours: '48' }, 'window_hours'],
      ['get_order_status', {}, 'commitment_hash'],
    ];
    for (const [name, args, field] of cases) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Input validation error');
      expect(textOf(result)).toContain(field);
    }
    expect(running.fake.requests).toHaveLength(0);
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

  it('serves one tool call from a request and answers the rest of a batch with an error', async () => {
    const running = await run(liveBook());
    const call = (id: number): unknown => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'list_markets', arguments: {} },
    });
    const response = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: JSON_RPC_HEADERS,
      body: JSON.stringify([call(1), call(2), call(3), { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }]),
    });
    expect(response.status).toBe(200);
    const answers = (await response.json()) as Array<{
      id: number;
      result?: { content?: Array<{ text: string }>; tools?: unknown[] };
      error?: { code: number; message: string };
    }>;
    const byId = new Map(answers.map((entry) => [entry.id, entry]));
    expect([...byId.keys()].sort()).toEqual([1, 2, 3, 4]);
    expect(byId.get(1)?.result?.content?.[0]?.text).toContain('contest_id 481');
    for (const id of [2, 3]) {
      expect(byId.get(id)?.result).toBeUndefined();
      expect(byId.get(id)?.error).toEqual({
        code: -32600,
        message: 'One tool call per request. Send this one on its own.',
      });
    }
    // What is not a tool call is served as usual.
    expect(byId.get(4)?.result?.tools).toHaveLength(3);
    // One call's reads, not three.
    expect(running.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
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

// ── the deadline ───────────────────────────────────────────────────────

describe('a tool call that takes too long', () => {
  it('ships a deadline of 20 seconds', async () => {
    vi.resetModules();
    const { TOOL_DEADLINE_MS } = await import('../src/mcp/server.js');
    expect(TOOL_DEADLINE_MS).toBe(20_000);
  });

  it('is answered for at its deadline while the read behind it is still waiting', async () => {
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
    const result = await client.callTool({ name: 'list_markets', arguments: {} });
    const elapsed = Date.now() - startedAt;

    // The read was made, and is still unanswered: the deadline is what spoke.
    expectReached(fake);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Ospex is taking too long to answer. Nothing was placed. Try again in a moment.');
    expect(elapsed).toBeGreaterThanOrEqual(240);
    expect(elapsed).toBeLessThan(3_000);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'list_markets' }),
      'mcp: tool call passed its deadline',
    );
    await server.close();
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

  it('answers a body that is not JSON with a JSON-RPC parse error, not the app\'s 500', async () => {
    const running = await run(liveBook());
    const response = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: JSON_RPC_HEADERS,
      body: '{"jsonrpc": ',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 }, id: null });
    // The app's error handler never saw it.
    expect(running.log.error).not.toHaveBeenCalled();
  });

  it('answers JSON that is not JSON-RPC the same way', async () => {
    const running = await run(liveBook());
    const response = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: JSON_RPC_HEADERS,
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 }, id: null });
  });

  it('refuses a body over one mebibyte with 413, and takes one just under it', async () => {
    const running = await run(liveBook());
    const padded = (bytes: number): string => {
      const frame = rpc('tools/list', { pad: '' });
      return rpc('tools/list', { pad: 'x'.repeat(bytes - Buffer.byteLength(frame)) });
    };
    const over = padded(1024 * 1024 + 1);
    expect(Buffer.byteLength(over)).toBe(1024 * 1024 + 1);
    const refused = await fetch(`${running.url}/mcp`, { method: 'POST', headers: JSON_RPC_HEADERS, body: over });
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 }, id: null });

    const under = padded(1024 * 1024);
    expect(Buffer.byteLength(under)).toBe(1024 * 1024);
    const taken = await fetch(`${running.url}/mcp`, { method: 'POST', headers: JSON_RPC_HEADERS, body: under });
    expect(taken.status).toBe(200);
  });

  it('refuses a POST that does not say it accepts both response forms', async () => {
    const running = await run(liveBook());
    const response = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: rpc('tools/list', {}),
    });
    expect(response.status).toBe(406);
    expect(running.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('Not Acceptable') }),
      'mcp: request refused by the transport',
    );
  });

  it('refuses a batch of more than one hundred messages', async () => {
    const running = await run(liveBook());
    const batch = (count: number): string =>
      JSON.stringify(
        Array.from({ length: count }, (_, index) => ({ jsonrpc: '2.0', id: index + 1, method: 'tools/list', params: {} })),
      );
    const refused = await fetch(`${running.url}/mcp`, { method: 'POST', headers: JSON_RPC_HEADERS, body: batch(101) });
    expect(refused.status).toBe(400);
    const taken = await fetch(`${running.url}/mcp`, { method: 'POST', headers: JSON_RPC_HEADERS, body: batch(100) });
    expect(taken.status).toBe(200);
    expect((await taken.json()) as unknown[]).toHaveLength(100);
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
    // The second request found one fewer left than the first.
    const left = (response: Response): number =>
      Number(/remaining=(\d+)/.exec(response.headers.get('ratelimit') ?? '')?.[1]);
    expect(left(get)).toBe(left(post) - 1);
  });

  it('does not spend the REST read budget, nor REST reads its own', async () => {
    const running = await run(liveBook());
    const left = (response: Response): number =>
      Number(/remaining=(\d+)/.exec(response.headers.get('ratelimit') ?? '')?.[1]);
    const before = left(await fetch(`${running.url}/v1/protocol/info`));
    for (let index = 0; index < 5; index += 1) await fetch(`${running.url}/mcp`);
    const after = left(await fetch(`${running.url}/v1/protocol/info`));
    expect(after).toBe(before - 1);
  });

  it('writes one line for each request, naming the method it carried and nothing it was given', async () => {
    const running = await run(liveBook());
    const response = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: { ...JSON_RPC_HEADERS, 'mcp-protocol-version': '2025-06-18', 'user-agent': 'endpoint-test/1.0' },
      body: rpc('tools/call', {
        name: 'get_order_status',
        arguments: { commitment_hash: hash('a1'), taker_address: TAKER },
      }),
    });
    expect(response.status).toBe(200);
    await response.json();
    await vi.waitFor(() => {
      expect(running.log.info).toHaveBeenCalledWith(expect.anything(), 'mcp: request');
    });
    const line = running.log.info.mock.calls.find((call) => call[1] === 'mcp: request')?.[0] as Record<string, unknown>;
    expect(line).toMatchObject({
      status: 200,
      answered: true,
      methods: ['tools/call'],
      protocol: '2025-06-18',
      agent: 'endpoint-test/1.0',
    });
    expect(typeof line['ms']).toBe('number');
    // Arguments are never logged: not the hash, not the wallet.
    expect(JSON.stringify(running.log.info.mock.calls)).not.toContain(TAKER);
    expect(JSON.stringify(running.log.info.mock.calls)).not.toContain(hash('a1'));
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
});
