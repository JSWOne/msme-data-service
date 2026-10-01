import { DB_SCHEMA, TABLES, TABLE_SLUGS, type TableSlug } from '../tables';
import type { Db } from './pool';

export interface ColumnInfo {
  name: string;
  dataType: string;
}

type ColumnsBySlug = Map<TableSlug, ColumnInfo[]>;

export async function loadTableColumns(db: Db): Promise<ColumnsBySlug> {
  const tableNames = TABLE_SLUGS.map((slug) => TABLES[slug]);
  const { rows } = await db.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = ANY($2)
      ORDER BY table_name, ordinal_position`,
    [DB_SCHEMA, tableNames],
  );

  const result: ColumnsBySlug = new Map();
  for (const slug of TABLE_SLUGS) {
    const columns = rows
      .filter((r) => r.table_name === TABLES[slug])
      .map((r) => ({ name: r.column_name, dataType: r.data_type }));
    if (columns.length === 0) {
      throw new Error(`Table ${DB_SCHEMA}.${TABLES[slug]} not found or not readable by DB user`);
    }
    result.set(slug, columns);
  }
  return result;
}

/**
 * Column whitelist, loaded lazily from information_schema so a cold start does not fail
 * when the DB is briefly unreachable, and refreshed after ttlMs to pick up new columns.
 */
export class SchemaCache {
  private pending?: Promise<ColumnsBySlug>;
  private loadedAt = 0;

  constructor(
    private readonly db: Db,
    private readonly ttlMs: number,
  ) {}

  async columnsFor(slug: TableSlug): Promise<ColumnInfo[]> {
    const columns = (await this.load()).get(slug);
    if (!columns) throw new Error(`No columns cached for ${slug}`);
    return columns;
  }

  private load(): Promise<ColumnsBySlug> {
    const expired = this.ttlMs > 0 && Date.now() - this.loadedAt > this.ttlMs;
    if (!this.pending || (expired && this.loadedAt > 0)) {
      this.loadedAt = 0;
      this.pending = loadTableColumns(this.db).then(
        (columns) => {
          this.loadedAt = Date.now();
          return columns;
        },
        (err: unknown) => {
          this.pending = undefined;
          throw err;
        },
      );
    }
    return this.pending;
  }
}
