/**
 * `/mcp` — the connector endpoint: MCP over Streamable HTTP.
 *
 * No sign-in, no sessions, no stored state. A client POSTs one JSON-RPC message
 * and gets one JSON response back.
 *
 *   POST /mcp                  one JSON-RPC request or notification, as an object
 *   any other method on /mcp   405
 *
 * A path under `/mcp` is not served here. It falls through to the app, which
 * answers it as it answers any path nobody serves.
 *
 * ## Why GET is refused here and not handed to the transport
 *
 * A GET asks for a stream the server could push on. This server has nothing to
 * push, and the transport would open the stream anyway and hold it until the
 * client left. 405 is the answer the protocol gives for "no stream offered
 * here", and clients treat it as one.
 *
 * ## Why this route sits ahead of the app's JSON parser
 *
 * Behind the app's parser a malformed body would be answered by the app's
 * error handler, in the REST error shape with a 500. This route reads the body
 * with a parser of its own and answers for it in the protocol's shape: a
 * JSON-RPC parse error with a 400, a 413 for a body over
 * {@link MCP_MAX_BODY_BYTES}, and a 415 for a body that was compressed.
 *
 * ## Why a compressed body is refused
 *
 * A few bytes can inflate to the whole of the limit, so a parser that inflates
 * does a megabyte of work for a request that cost its sender nothing. No
 * client of this protocol compresses what it sends.
 *
 * ## Why a body over the limit is refused before it has all arrived
 *
 * The parser reads a body to its end before it says the body was too large.
 * A sender that never stops would never be answered. The bytes are counted
 * here as they arrive, and the refusal is sent when the count passes the
 * limit.
 *
 * ## Why this route never answers 401
 *
 * A client that is told 401 starts a sign-in this server cannot complete, and
 * may remember that it was asked to.
 *
 * ## One server and one transport per request
 *
 * The transport refuses a second request, and it does so by answering an empty
 * 500 rather than by throwing, so reuse would fail without a trace.
 *
 * ## One message per request
 *
 * An early version of the protocol let a request carry a batch of messages,
 * and the transport serves up to a hundred of them at once. The rate limit
 * counts requests, so a batch is a hundred messages for the price of one. A
 * batch of a hundred was measured at five to twelve times the cost of a request
 * carrying one message, depending on what it is compared with, and it needs no
 * database read to cost that. Later versions of the protocol have no batches.
 *
 * So a body that is a JSON list is refused, whatever its length, before
 * anything is built to serve it. A list of one is refused too: the protocol
 * answers a list with a list, and this endpoint answers with one object.
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isJsonContentType } from '@modelcontextprotocol/sdk/shared/mediaType.js';
import { isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { formatError, logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import type { ScorerAddresses } from '../lib/speculation.js';
import { mcpRateLimit } from '../middleware/rateLimit.js';
import type { ToolContext } from './context.js';
import { buildMcpServer } from './server.js';

/** The largest request body read: 1 MiB, the limit the rest of the API applies. */
export const MCP_MAX_BODY_BYTES = 1024 * 1024;

export interface McpRouterConfig {
  network: string;
  scorers: ScorerAddresses | undefined;
  takeLinkBaseUrl: string;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  error: { code: number; message: string };
  id: null;
}

function refuse(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null } satisfies JsonRpcError);
}

function methodNotAllowed(_req: Request, res: Response): void {
  res.set('Allow', 'POST');
  refuse(res, 405, -32000, 'Method not allowed. This endpoint takes POST.');
}

/** The first header value, cut to a length safe to log. */
function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? undefined : first.slice(0, 120);
}

interface Described {
  method?: string;
  client?: string;
  asked?: string;
}

/** What one JSON-RPC message says about itself, for the log. Arguments are never read. */
function describeMessage(message: unknown): Described {
  if (typeof message !== 'object' || message === null) return {};
  const record = message as Record<string, unknown>;
  const out: Described = {};
  if (typeof record['method'] === 'string') out.method = record['method'].slice(0, 60);
  const params = record['params'];
  if (out.method === 'initialize' && typeof params === 'object' && params !== null) {
    const init = params as Record<string, unknown>;
    if (typeof init['protocolVersion'] === 'string') out.asked = init['protocolVersion'].slice(0, 20);
    const client = init['clientInfo'];
    if (typeof client === 'object' && client !== null) {
      const name = (client as Record<string, unknown>)['name'];
      if (typeof name === 'string') out.client = name.slice(0, 60);
    }
  }
  return out;
}

/**
 * Any JSON value, not only an object or a list: what is not a JSON-RPC message
 * is for the transport to say, in the words it has for it. Nothing is inflated.
 *
 * Which bodies are read is decided by the transport's own test of the
 * Content-Type, because the parser's own test throws on some malformed headers,
 * which would have answered 500. The two still read the header differently
 * when it is sent more than once: Node keeps the first copy, and the transport
 * tests every copy joined. So a body this parser leaves alone can be one the
 * transport would accept, and the handler below never lets the transport read
 * a body for itself.
 */
const readBody = express.json({
  limit: MCP_MAX_BODY_BYTES,
  strict: false,
  inflate: false,
  type: (req) => isJsonContentType(req.headers['content-type']),
});

function refuseTooLarge(res: Response): void {
  logger.warn({ type: 'entity.too.large' }, 'mcp: request body refused');
  refuse(res, 413, -32000, `Payload Too Large: Request body must not exceed ${String(MCP_MAX_BODY_BYTES)} bytes`);
}

/** Refuse a body over the limit as soon as it is known to be over, not once it has ended. */
function refuseOversize(req: Request, res: Response, next: NextFunction): void {
  if (Number(req.headers['content-length']) > MCP_MAX_BODY_BYTES) {
    refuseTooLarge(res);
    return;
  }
  let read = 0;
  req.on('data', (chunk: Buffer) => {
    read += chunk.length;
    if (read > MCP_MAX_BODY_BYTES && !res.headersSent) refuseTooLarge(res);
  });
  next();
}

/**
 * A body the parser turned away, answered in the protocol's shape. Nothing
 * raised on this route goes on to the app's own error handler, which answers
 * in another shape.
 */
function bodyRefused(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  const record = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
  const type = record['type'];
  if (res.headersSent) {
    // Already answered, by the count above or by the transport.
    if (type !== 'entity.too.large') next(err);
    return;
  }
  if (typeof type !== 'string') {
    logger.error({ err: formatError(err) }, 'mcp: request failed');
    refuse(res, 500, -32603, 'Internal error');
    return;
  }
  if (type === 'entity.too.large') {
    refuseTooLarge(res);
    return;
  }
  logger.warn({ type }, 'mcp: request body refused');
  if (type === 'entity.parse.failed') {
    refuse(res, 400, -32700, 'Parse error: Invalid JSON');
    return;
  }
  if (type === 'encoding.unsupported') {
    refuse(res, 415, -32000, 'Unsupported Media Type: send the body as it is, with no Content-Encoding');
    return;
  }
  if (type === 'charset.unsupported') {
    // The parser takes the UTF encodings JSON allows, and refuses the rest.
    refuse(res, 415, -32000, 'Unsupported Media Type: send the body in UTF-8');
    return;
  }
  const status = record['status'];
  refuse(
    res,
    typeof status === 'number' && status >= 400 && status < 500 ? status : 400,
    -32000,
    'The request body could not be read.',
  );
}

export function createMcpRouter(config: McpRouterConfig): Router {
  const router = Router();
  router.use(mcpRateLimit);

  const context = (): ToolContext => ({
    sb: getSupabase(),
    network: config.network,
    scorers: config.scorers,
    takeLinkBaseUrl: config.takeLinkBaseUrl,
    nowMs: Date.now(),
  });

  /** The messages a request carried, as the handler saw them. Filled in as they are served. */
  const seenBy = new WeakMap<Response, Described[]>();

  // One line for every POST, however it ends. Registered before the body is
  // read, so a body that is refused is a request in the log all the same.
  const noteRequest = (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = Date.now();
    const seen: Described[] = [];
    seenBy.set(res, seen);
    res.on('close', () => {
      logger.info(
        {
          status: res.statusCode,
          // The status reads 200 until something writes another, so a client
          // that left before it was answered needs saying separately.
          answered: res.writableFinished,
          ms: Date.now() - startedAt,
          methods: seen.map((message) => message.method ?? 'response'),
          client: seen.find((message) => message.client !== undefined)?.client,
          asked: seen.find((message) => message.asked !== undefined)?.asked,
          protocol: header(req, 'mcp-protocol-version'),
          agent: header(req, 'user-agent'),
        },
        'mcp: request',
      );
    });
    next();
  };

  const serve = (req: Request, res: Response): void => {
    // `undefined` when the parser left the body alone: for a content type that
    // is not JSON, which the transport answers with 415, and for a request that
    // has no body.
    const body: unknown = req.body;
    if (Array.isArray(body)) {
      logger.warn({ messages: body.length }, 'mcp: batch refused');
      refuse(res, 400, -32600, 'One message per request, sent as an object and not as a list.');
      return;
    }

    const seen = seenBy.get(res) ?? [];
    const server = buildMcpServer(context);
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      maxRequestBodySize: MCP_MAX_BODY_BYTES,
    });

    // A request the transport turns away (a missing Accept header, a body that
    // is not JSON-RPC) is the client's doing. It is worth a line, not an alarm.
    transport.onerror = (error: Error): void => {
      logger.warn({ err: error.message }, 'mcp: request refused by the transport');
    };

    // Registered before the request is handled. In JSON mode the handling does
    // not return until the response is written, so a listener added afterwards
    // would miss the close of a client that left early.
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    server
      .connect(transport as Transport)
      .then(() => {
        // Connecting hands the transport the server's message handler. Wrapping
        // it here is what lets the log say which method a request carried.
        const deliver = transport.onmessage;
        transport.onmessage = (message, extra): void => {
          if (seen.length < 8) seen.push(describeMessage(message));
          if (isJSONRPCRequest(message) && message.method === 'tools/call') {
            // A call may leave `arguments` out, and the server then validates
            // nothing at all against the tool's schema and refuses it, even
            // when every argument is optional. No arguments is no arguments.
            const params = message.params;
            if (params !== undefined && params['arguments'] === undefined) params['arguments'] = {};
          }
          deliver?.(message, extra);
        };
        // Handed no body, the transport reads the request itself, and what it
        // reads has not been through the check for a list above. Handed null,
        // it refuses the request as carrying no message, once the Accept and
        // Content-Type headers have passed its own tests.
        return transport.handleRequest(req, res, body ?? null);
      })
      .catch((err: unknown) => {
        logger.error({ err: formatError(err) }, 'mcp: request failed');
        if (!res.headersSent) refuse(res, 500, -32603, 'Internal error');
      });
  };

  router.post('/', noteRequest, refuseOversize, readBody, serve);
  router.all('/', methodNotAllowed);
  router.use(bodyRefused);
  return router;
}
