/**
 * `/mcp` — the connector endpoint: MCP over Streamable HTTP.
 *
 * No sign-in, no sessions, no stored state. A client POSTs a JSON-RPC message
 * and gets one JSON response back.
 *
 *   POST /mcp     a JSON-RPC request, notification or batch
 *   anything else 405
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
 * The transport reads the body itself. Behind the app's parser a malformed
 * body would be answered by the app's error handler, in the REST error shape
 * with a 500; read here it is a JSON-RPC parse error with a 400, and a body
 * over {@link MCP_MAX_BODY_BYTES} is a 413.
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
 * ## One tool call per request
 *
 * A request may carry a batch of up to a hundred messages, and the transport
 * starts every one of them at once. The rate limit counts requests, so a batch
 * of tool calls would be a hundred calls for the price of one. The first tool
 * call in a request is served and any after it is answered with an error.
 * Later versions of the protocol have no batches at all.
 */

import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { formatError, logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import type { ScorerAddresses } from '../lib/speculation.js';
import { mcpRateLimit } from '../middleware/rateLimit.js';
import type { ToolContext } from './context.js';
import { buildMcpServer } from './server.js';

/** The largest request body read: 1 MiB, the limit the rest of the API applies. */
export const MCP_MAX_BODY_BYTES = 1024 * 1024;
/** Tool calls served from one request. */
export const MCP_MAX_TOOL_CALLS_PER_REQUEST = 1;

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

function methodNotAllowed(_req: Request, res: Response): void {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This endpoint takes POST.' },
      id: null,
    } satisfies JsonRpcError);
}

/** The first header value, cut to a length safe to log. */
function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? undefined : first.slice(0, 120);
}

/** What one JSON-RPC message says about itself, for the log. Arguments are never read. */
function describeMessage(message: unknown): { method?: string; client?: string; asked?: string } {
  if (typeof message !== 'object' || message === null) return {};
  const record = message as Record<string, unknown>;
  const out: { method?: string; client?: string; asked?: string } = {};
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

  router.post('/', (req: Request, res: Response): void => {
    const startedAt = Date.now();
    const seen: Array<{ method?: string; client?: string; asked?: string }> = [];
    let toolCalls = 0;
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
            toolCalls += 1;
            if (toolCalls > MCP_MAX_TOOL_CALLS_PER_REQUEST) {
              // Answered, not dropped: the response to a batch is not written
              // until every request in it has one.
              transport
                .send({
                  jsonrpc: '2.0',
                  id: message.id,
                  error: { code: -32600, message: 'One tool call per request. Send this one on its own.' },
                })
                .catch((err: unknown) => {
                  logger.warn({ err: formatError(err) }, 'mcp: could not answer a refused tool call');
                });
              return;
            }
            // A call may leave `arguments` out, and the server then validates
            // nothing at all against the tool's schema and refuses it, even
            // when every argument is optional. No arguments is no arguments.
            const params = message.params;
            if (params !== undefined && params['arguments'] === undefined) params['arguments'] = {};
          }
          deliver?.(message, extra);
        };
        return transport.handleRequest(req, res);
      })
      .catch((err: unknown) => {
        logger.error({ err: formatError(err) }, 'mcp: request failed');
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null,
          } satisfies JsonRpcError);
        }
      });
  });

  router.all('/', methodNotAllowed);
  return router;
}
