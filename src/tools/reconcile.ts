import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveSource } from '../sources.js';
import { flattenReconcile, type ReconcileResult } from '../reconcileFlatten.js';
import { RECONCILE_PIDS } from '../upstream/reconcile.js';
import { cacheKey, withCache } from '../cache.js';
import { config } from '../config.js';
import { getCatalog } from './listSources.js';
import { READ_ONLY, ToolError, catalogLanguageSchema, looseOutput, ok, run, type Deps } from './common.js';

export function register(server: McpServer, deps: Deps): void {
  server.registerTool(
    'reconcile',
    {
      title: 'Reconcile names to terms',
      description: `Match names or labels against one Network of Terms source (W3C Reconciliation API) and get scored candidates (id, name, score 0-100, match, type, description). For people, add properties to improve matching: ${RECONCILE_PIDS.join(', ')} (e.g. {"pid":"birthDates","v":"1606"}). Up to ${config.LIMITS.RECONCILE_MAX} queries per call; queries run one after another upstream, so large batches are slow. match=true marks a confident candidate. Wikidata sources have no reconciliation: use search_terms for them.`,
      inputSchema: {
        source: z.string().min(1).describe('Source URI or exact name (see list_sources).'),
        queries: z
          .array(
            z.object({
              query: z.string().min(1).max(500).describe('Name or label to match.'),
              type: z
                .string()
                .optional()
                .describe('Restrict to a type, e.g. https://schema.org/Person, https://schema.org/Place, https://schema.org/Organization or http://www.w3.org/2004/02/skos/core#Concept.'),
              limit: z.number().int().min(1).max(100).optional().describe('Max candidates for this query.'),
              properties: z
                .array(z.object({ pid: z.enum(RECONCILE_PIDS), v: z.string().min(1) }))
                .optional()
                .describe('Extra matching properties for people.'),
            }),
          )
          .min(1)
          .max(config.LIMITS.RECONCILE_MAX),
        language: catalogLanguageSchema,
      },
      outputSchema: { source: z.any(), results: z.array(z.any()), ...looseOutput },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(deps, 'reconcile', args.queries.length, async () => {
        const catalog = await getCatalog(deps);
        const source = resolveSource(args.source, catalog);
        if (!source.reconciliationUrl) {
          throw new ToolError(
            `"${source.name}" has no reconciliation service (this applies to the Wikidata sources). Use search_terms for this source instead.`,
          );
        }
        const url = source.reconciliationUrl;
        const key = cacheKey('reconcile', { ...args, source: source.uri });
        const { value, hit } = await withCache(deps.cache, key, config.TTL.reconcile, async () => {
          const raw = await deps.recon.reconcile(url, args.queries, args.language);
          const results = flattenReconcile(raw, args.queries);
          return { value: { source: { uri: source.uri, name: source.name }, results }, cacheable: true };
        });
        return {
          result: ok(value, (p) => p.results.map((r: ReconcileResult) => r.candidates)),
          hit,
        };
      }),
  );
}
