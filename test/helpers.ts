import { buildApp } from '../src/app';
import type { Db } from '../src/db/pool';
import { TABLES } from '../src/tables';

export const API_KEY = 'test-key-0123456789abcdef';

export const COLUMNS = [
  { column_name: 'month', data_type: 'date' },
  { column_name: 'dealer_id', data_type: 'text' },
  { column_name: 'order_value', data_type: 'numeric' },
  { column_name: 'meta', data_type: 'json' },
  { column_name: 'is_new_dealer_this_month', data_type: 'boolean' },
  { column_name: 'user_id', data_type: 'text' },
  { column_name: 'user_name', data_type: 'text' },
  { column_name: 'account_id', data_type: 'text' },
  { column_name: 'ordered_qty_mtd', data_type: 'numeric' },
  { column_name: 'ordered_date', data_type: 'date' },
  { column_name: 'invoice_date', data_type: 'date' },
  { column_name: 'is_high_potential', data_type: 'boolean' },
];

export interface FakeDb extends Db {
  calls: { text: string; values?: unknown[] }[];
  rows: Record<string, unknown>[];
  failWith?: Error & { code?: string };
}

export function fakeDb(): FakeDb {
  const db: FakeDb = {
    calls: [],
    rows: [],
    async query(text: string, values?: unknown[]) {
      db.calls.push({ text, values });
      if (text.includes('information_schema.columns')) {
        const rows = Object.values(TABLES).flatMap((table_name) =>
          COLUMNS.map((c) => ({ table_name, ...c })),
        );
        return { rows } as never;
      }
      if (db.failWith) throw db.failWith;
      return { rows: text === 'SELECT 1' ? [{ '?column?': 1 }] : db.rows } as never;
    },
  };
  return db;
}

export function testApp(db: Db = fakeDb(), basePath = '') {
  return buildApp({
    config: {
      API_KEYS: [API_KEY],
      LOG_LEVEL: 'silent' as never,
      SCHEMA_CACHE_TTL_MS: 0,
      BASE_PATH: basePath,
    },
    db,
    logger: false,
  });
}
