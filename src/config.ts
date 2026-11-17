import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const env = process.env;

export const VERSION: string = pkg.version;

export const config = {
  PORT: Number(env['PORT'] ?? 3004),
  REDIS_URL: env['REDIS_URL'] === '' ? null : (env['REDIS_URL'] ?? 'redis://localhost:6379/9'),
  API_BASE: env['TN_API_BASE'] ?? 'https://termennetwerk-api.netwerkdigitaalerfgoed.nl',
  USER_AGENT: `termennetwerk-mcp-server/${VERSION} (+https://github.com/coret/termennetwerk-mcp-server)`,
  PUBLIC_URL: env['PUBLIC_URL'] ?? 'https://mcp-termennetwerk.coret.org/',
  ALLOWED_ORIGINS: (env['ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  RATE_LIMIT_PER_MIN: Number(env['RATE_LIMIT_PER_MIN'] ?? 60),
  UPSTREAM_RPS: Number(env['UPSTREAM_RPS'] ?? 10),
  LIMITS: {
    MAX_SOURCES: 10,
    SEARCH_DEFAULT: 20,
    SEARCH_MAX: 100,
    TIMEOUT_MAX_MS: 60_000,
    LOOKUP_MAX: 200,
    RECONCILE_MAX: 10,
    EXTEND_MAX: 100,
    BYTE_BUDGET: 60_000,
    RECONCILE_HTTP_TIMEOUT_MS: 120_000,
  },
  TTL: {
    sources: 3600,
    search: 3600,
    lookup: 86_400,
    reconcile: 3600,
    extend: 86_400,
  },
} as const;
