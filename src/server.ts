import { createApp } from './app.js';
import { createCache } from './cache.js';
import { config, VERSION } from './config.js';
import { log } from './log.js';
import { createGraphqlClient } from './upstream/graphql.js';
import { createReconcileClient } from './upstream/reconcile.js';

const cache = createCache(config.REDIS_URL, log);
const app = createApp({
  gql: createGraphqlClient(),
  recon: createReconcileClient(),
  cache,
  log,
});

const server = app.listen(config.PORT, '127.0.0.1', () => {
  log.info({ port: config.PORT, version: VERSION, upstream: config.API_BASE }, 'termennetwerk-mcp-server listening');
});
// Reconcile batches can take minutes upstream; do not cut them off at the socket.
server.requestTimeout = 180_000;

const shutdown = () => {
  log.info('shutting down');
  server.close(() => void cache.close().then(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
