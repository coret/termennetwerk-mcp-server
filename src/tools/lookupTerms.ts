import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { flattenLookup, hasErrors, type LookupItem } from '../flatten.js';
import { cacheKey, withCache } from '../cache.js';
import { config } from '../config.js';
import { READ_ONLY, languagesSchema, looseOutput, ok, run, timeoutSchema, type Deps } from './common.js';

export function register(server: McpServer, deps: Deps): void {
  server.registerTool(
    'lookup_terms',
    {
      title: 'Look up term URIs',
      description: `Resolve known term URIs (from any Network of Terms source, e.g. AAT, CHT, RKD, GTAA, Wikidata) to their labels, definitions, hierarchy (broader/narrower/related), exactMatch links and place/person/organization details. Up to ${config.LIMITS.LOOKUP_MAX} URIs per call. URIs that belong to no known source or no longer exist come back with ok=false and an error. Use search_terms to find URIs from text.`,
      inputSchema: {
        uris: z
          .array(z.string().url())
          .min(1)
          .max(config.LIMITS.LOOKUP_MAX)
          .describe('Term URIs to resolve.'),
        languages: languagesSchema,
        timeoutMs: timeoutSchema,
      },
      outputSchema: { results: z.array(z.any()), ...looseOutput },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(deps, 'lookup_terms', args.uris.length, async () => {
        const uris = [...new Set(args.uris)];
        const key = cacheKey('lookup_terms', { ...args, uris });
        const { value, hit } = await withCache(deps.cache, key, config.TTL.lookup, async () => {
          const { data, errors } = await deps.gql.lookup({
            uris,
            languages: args.languages,
            timeoutMs: args.timeoutMs,
          });
          const results = flattenLookup(data);
          const payload: { results: LookupItem[]; errors?: string[] } = { results };
          if (errors.length) payload.errors = errors;
          return { value: payload, cacheable: !hasErrors(results) && errors.length === 0 };
        });
        return { result: ok(value, (p) => [p.results]), hit };
      }),
  );
}
