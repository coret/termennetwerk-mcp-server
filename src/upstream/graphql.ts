import { GraphQLClient } from 'graphql-request';
import { print } from 'graphql';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { config } from '../config.js';
import { upstreamLimiter } from './limiter.js';
import {
  SourcesDocument,
  TermsDocument,
  LookupDocument,
  type SourcesQuery,
  type TermsQuery,
  type LookupQuery,
  type QueryMode,
} from '../generated/graphql.js';

export type Lang = 'nl' | 'en' | 'fy';
export type CatalogLang = 'nl' | 'en';

export type SourcesData = NonNullable<SourcesQuery['sources']>;
export type TermsData = NonNullable<TermsQuery['terms']>;
export type LookupData = NonNullable<LookupQuery['lookup']>;

export interface TermsArgs {
  sources: string[];
  query: string;
  languages?: Lang[];
  genres?: string[];
  queryMode?: QueryMode;
  timeoutMs?: number;
}

export interface LookupArgs {
  uris: string[];
  languages?: Lang[];
  timeoutMs?: number;
}

export interface GraphqlClient {
  sources(language: CatalogLang, genres?: string[]): Promise<SourcesData>;
  terms(args: TermsArgs): Promise<{ data: TermsData; errors: string[] }>;
  lookup(args: LookupArgs): Promise<{ data: LookupData; errors: string[] }>;
}

export function createGraphqlClient(
  opts: { fetch?: typeof fetch; endpoint?: string } = {},
): GraphqlClient {
  const client = new GraphQLClient(opts.endpoint ?? `${config.API_BASE}/graphql`, {
    fetch: opts.fetch ?? fetch,
    errorPolicy: 'all',
    headers: { 'User-Agent': config.USER_AGENT },
  });

  async function run<T, V extends Record<string, unknown>>(
    doc: TypedDocumentNode<T, V>,
    variables: V,
    headers: Record<string, string> = {},
  ): Promise<{ data: T | undefined; errors: string[] }> {
    await upstreamLimiter.acquire();
    const res = await client.rawRequest<T, V>(print(doc), variables, headers);
    return { data: res.data, errors: (res.errors ?? []).map((e) => e.message) };
  }

  /** Drops undefined values so optional arguments fall back to upstream defaults. */
  function vars<V extends Record<string, unknown>>(v: V): V {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as V;
  }

  return {
    async sources(language, genres) {
      const { data, errors } = await run(SourcesDocument, vars({ genres }), {
        'Accept-Language': language,
      });
      if (!data?.sources) throw new Error(`Upstream sources query failed: ${errors.join('; ')}`);
      return data.sources;
    },
    async terms(args) {
      // `limit` is deliberately never sent: upstream applies it before ranking.
      const { data, errors } = await run(TermsDocument, vars({ ...args }));
      if (!data?.terms) throw new Error(`Upstream terms query failed: ${errors.join('; ')}`);
      return { data: data.terms, errors };
    },
    async lookup(args) {
      const { data, errors } = await run(LookupDocument, vars({ ...args }));
      if (!data?.lookup) throw new Error(`Upstream lookup query failed: ${errors.join('; ')}`);
      return { data: data.lookup, errors };
    },
  };
}
