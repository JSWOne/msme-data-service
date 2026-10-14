import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config';
import type { Db } from './db/pool';
import { SchemaCache } from './db/schema';
import { apiKeyHook } from './plugins/apiKey';
import { registerErrorHandlers } from './plugins/errors';
import { healthRoutes } from './routes/health';
import { tableRoutes } from './routes/tables';

export interface AppDeps {
  config: Pick<Config, 'API_KEYS' | 'LOG_LEVEL' | 'SCHEMA_CACHE_TTL_MS'> &
    Partial<Pick<Config, 'BASE_PATH'>>;
  db: Db;
  logger?: FastifyServerOptions['logger'];
}

/** Pino options that emit Cloud Logging-compatible JSON (severity + message). */
export function cloudLoggingOptions(level: string): FastifyServerOptions['logger'] {
  return {
    level,
    messageKey: 'message',
    formatters: { level: (label: string) => ({ severity: label.toUpperCase() }) },
    redact: ['req.headers["x-api-key"]', 'req.headers.authorization'],
  };
}

export function buildApp({ config, db, logger }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: logger ?? cloudLoggingOptions(config.LOG_LEVEL),
    trustProxy: true, // behind Cloud Run's front end
  });

  registerErrorHandlers(app);

  const schema = new SchemaCache(db, config.SCHEMA_CACHE_TTL_MS);
  void app.register(
    async (base) => {
      await base.register(healthRoutes(db));
      await base.register(
        async (v1) => {
          v1.addHook('onRequest', apiKeyHook(config.API_KEYS));
          await v1.register(tableRoutes(db, schema));
        },
        { prefix: '/v1' },
      );
    },
    { prefix: config.BASE_PATH ?? '' },
  );

  return app;
}
