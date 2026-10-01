import pg from 'pg';
import type { Config } from '../config';

/** Minimal query surface used by the app; satisfied by pg.Pool and by test fakes. */
export interface Db {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

// Return DATE columns as 'YYYY-MM-DD' strings. The pg default parses them into a JS Date
// at local midnight, which shifts the day when serialised to UTC JSON.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function createPool(config: Config): pg.Pool {
  return new pg.Pool({
    host: config.INSTANCE_CONNECTION_NAME
      ? `/cloudsql/${config.INSTANCE_CONNECTION_NAME}`
      : config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    max: config.POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: config.STATEMENT_TIMEOUT_MS,
    application_name: 'msme-data-service',
    // Defence in depth on top of the read-only DB user.
    options: '-c default_transaction_read_only=on',
  });
}
