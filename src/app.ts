import { readFileSync } from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, type Deps } from './mcp.js';
import { config, VERSION } from './config.js';

const ROOT = new URL('../', import.meta.url);
const readText = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');

// Claude origins are always allowed; ALLOWED_ORIGINS adds more. Requests without an
// Origin header (native MCP clients, curl, server-to-server) are allowed too.
const ORIGINS = ['https://claude.ai', 'https://claude.com'];
const ORIGIN_SUFFIXES = ['.claude.ai', '.claude.com'];

export function isOriginAllowed(origin: string | undefined, extra: readonly string[] = []): boolean {
  if (!origin) return true;
  if (ORIGINS.includes(origin) || extra.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return ORIGIN_SUFFIXES.some((s) => host.endsWith(s));
  } catch {
    return false;
  }
}

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: '2.0',
  error: { code, message },
  id: null,
});

export function createApp(deps: Deps, opts: { rateLimitPerMin?: number } = {}): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  // Body parse errors: answer in JSON-RPC and never log the body (it can hold query text).
  app.use((err: { type?: string; status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    deps.log.warn({ error: err.type ?? 'body-error' }, 'rejected request body');
    if (err.type === 'entity.too.large') {
      res.status(413).json(jsonRpcError(-32600, 'Request body too large'));
      return;
    }
    res.status(400).json(jsonRpcError(-32700, 'Parse error: invalid JSON'));
  });

  const perMin = opts.rateLimitPerMin ?? config.RATE_LIMIT_PER_MIN;
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: perMin,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => (req.body as { method?: string } | undefined)?.method !== 'tools/call',
    handler: (_req, res) => {
      res
        .status(429)
        .json(jsonRpcError(-32000, `Rate limit exceeded: max ${perMin} tool calls per minute. Wait a minute and retry.`));
    },
  });

  // JSON-RPC batches were removed from MCP in protocol 2025-06-18; rejecting them also
  // keeps every tools/call visible to the rate limiter.
  const rejectBatch = (req: Request, res: Response, next: NextFunction) => {
    if (Array.isArray(req.body)) {
      res.status(400).json(jsonRpcError(-32600, 'Batch requests are not supported: send one JSON-RPC message per request.'));
      return;
    }
    next();
  };

  const validateOrigin = (req: Request, res: Response, next: NextFunction) => {
    if (!isOriginAllowed(req.headers.origin, config.ALLOWED_ORIGINS)) {
      res.status(403).json(jsonRpcError(-32000, 'Origin not allowed'));
      return;
    }
    next();
  };

  // Stateless: a fresh server and transport per request.
  const handleMcp = async (req: Request, res: Response) => {
    const server = createMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      deps.log.error({ error: err instanceof Error ? err.name : 'unknown' }, 'MCP request failed');
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
    }
  };

  for (const path of ['/', '/mcp']) {
    app.post(path, validateOrigin, rejectBatch, limiter, handleMcp);
    app.get(path, (req, res) => {
      if ((req.headers.accept ?? '').includes('text/event-stream')) {
        res.status(405).set('Allow', 'POST').json(jsonRpcError(-32000, 'Method not allowed: this server is stateless, use POST.'));
        return;
      }
      res.type('html').send(readText('public/index.html'));
    });
    app.delete(path, (_req, res) => {
      res.status(405).set('Allow', 'POST').end();
    });
  }

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: VERSION, redis: deps.cache.available });
  });

  const card = (_req: Request, res: Response) => {
    res.type('application/json').send(readText('well-known/mcp-server-card.json'));
  };
  app.get('/.well-known/mcp/server-card.json', card);
  app.get('/.well-known/mcp.json', card);

  return app;
}
