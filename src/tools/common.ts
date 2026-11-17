import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GraphqlClient } from '../upstream/graphql.js';
import type { ReconcileClient } from '../upstream/reconcile.js';
import type { Cache } from '../cache.js';
import type { Logger } from '../log.js';
import { UnknownSourceError } from '../sources.js';
import { fitBudget } from '../flatten.js';
import { config } from '../config.js';

export interface Deps {
  gql: GraphqlClient;
  recon: ReconcileClient;
  cache: Cache;
  log: Logger;
}

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export const languagesSchema = z
  .array(z.enum(['nl', 'en', 'fy']))
  .min(1)
  .optional()
  .describe(
    'Preferred label languages in order, e.g. ["nl","en"]. When set, labels are returned as a language map ({"nl":[...],"en":[...]}). Frisian (fy) is sparse: most sources return empty labels for fy only.',
  );

export const catalogLanguageSchema = z
  .enum(['nl', 'en'])
  .default('nl')
  .describe('Language for source names, descriptions and reconciliation labels.');

export const timeoutSchema = z
  .number()
  .int()
  .min(1000)
  .max(config.LIMITS.TIMEOUT_MAX_MS)
  .optional()
  .describe('Per-source timeout in ms (default 10000, max 60000). Slow sources such as AAT may need 30000 or more.');

/** Generic loose output schema: results are documented in the tool description. */
export const looseOutput = { truncated: z.boolean().optional(), note: z.string().optional() };

export class ToolError extends Error {}

export function ok(payload: object, lists: (p: any) => unknown[][]): CallToolResult {
  const fitted = fitBudget(payload, lists, config.LIMITS.BYTE_BUDGET);
  return {
    content: [{ type: 'text', text: JSON.stringify(fitted) }],
    structuredContent: fitted as Record<string, unknown>,
  };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Runs a tool body with uniform logging (no query text, URIs or IPs) and error mapping. */
export async function run(
  deps: Deps,
  tool: string,
  count: number,
  body: () => Promise<{ result: CallToolResult; hit: boolean }>,
): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const { result, hit } = await body();
    deps.log.info({ tool, count, ms: Date.now() - started, hit }, 'tool call');
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    deps.log.warn({ tool, count, ms: Date.now() - started, error: error.name }, 'tool call failed');
    if (err instanceof UnknownSourceError || err instanceof ToolError) return fail(error.message);
    return fail(`Upstream Network of Terms request failed: ${error.message}. Try again later or with fewer items.`);
  }
}
