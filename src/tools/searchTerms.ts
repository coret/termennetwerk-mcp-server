import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveSources } from '../sources.js';
import { flattenTermsResults, hasErrors, type SourceResult } from '../flatten.js';
import { cacheKey, withCache } from '../cache.js';
import { config } from '../config.js';
import { getCatalog } from './listSources.js';
import { READ_ONLY, languagesSchema, looseOutput, ok, run, timeoutSchema, type Deps } from './common.js';

const L = config.LIMITS;

export function register(server: McpServer, deps: Deps): void {
  server.registerTool(
    'search_terms',
    {
      title: 'Search terms',
      description: `Search one or more Network of Terms sources for terms matching a literal text query (e.g. a subject, material, person or place name). Returns per source: ok/error, total matches and the best terms (exact label matches first) with uri, prefLabel, altLabel, definition, scopeNote, broader/narrower/related/exactMatch, and place/person/organization details when the source has them. Pick at most ${L.MAX_SOURCES} sources via list_sources (URI or exact name). A source can fail (e.g. timeout) while others succeed; retry that one with a higher timeoutMs. To get details for URIs you already have, use lookup_terms instead.`,
      inputSchema: {
        sources: z
          .array(z.string().min(1))
          .min(1)
          .max(L.MAX_SOURCES)
          .describe(`Source URIs or exact source names (max ${L.MAX_SOURCES}).`),
        query: z.string().min(1).max(500).describe('Literal search text, e.g. "fiets" or "Rembrandt".'),
        languages: languagesSchema,
        genres: z
          .array(z.string())
          .optional()
          .describe('Genre URIs to filter on, only for sources that support genre filtering.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(L.SEARCH_MAX)
          .default(L.SEARCH_DEFAULT)
          .describe(`Maximum terms per source (default ${L.SEARCH_DEFAULT}, max ${L.SEARCH_MAX}).`),
        timeoutMs: timeoutSchema,
        queryMode: z
          .enum(['OPTIMIZED', 'RAW'])
          .optional()
          .describe('OPTIMIZED (default) normalises the query; RAW sends it unchanged (source-specific syntax).'),
      },
      outputSchema: { query: z.string(), results: z.array(z.any()), ...looseOutput },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(deps, 'search_terms', args.sources.length, async () => {
        const catalog = await getCatalog(deps);
        const uris = resolveSources(args.sources, catalog).map((s) => s.uri);
        const key = cacheKey('search_terms', { ...args, sources: uris });
        const { value, hit } = await withCache(deps.cache, key, config.TTL.search, async () => {
          const { data, errors } = await deps.gql.terms({
            sources: uris,
            query: args.query,
            languages: args.languages,
            genres: args.genres,
            queryMode: args.queryMode,
            timeoutMs: args.timeoutMs,
          });
          const results = flattenTermsResults(data, args.query, args.limit);
          const payload: { query: string; results: SourceResult[]; errors?: string[] } = {
            query: args.query,
            results,
          };
          if (errors.length) payload.errors = errors;
          return { value: payload, cacheable: !hasErrors(results) && errors.length === 0 };
        });
        return { result: ok(value, (p) => p.results.map((r: SourceResult) => r.terms)), hit };
      }),
  );
}
