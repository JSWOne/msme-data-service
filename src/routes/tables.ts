import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../db/pool';
import { buildSelectQuery } from '../db/queryBuilder';
import type { SchemaCache } from '../db/schema';
import { DB_SCHEMA, TABLES, TABLE_SLUGS } from '../tables';

export function tableRoutes(db: Db, schema: SchemaCache): FastifyPluginAsync {
  return async (app) => {
    for (const slug of TABLE_SLUGS) {
      const table = TABLES[slug];

      app.get(`/${slug}`, async (req) => {
        const columns = await schema.columnsFor(slug);
        const q = buildSelectQuery(table, columns, req.query as Record<string, unknown>);
        const { rows } = await db.query(q.text, q.values);
        const hasMore = rows.length > q.limit;
        const data = hasMore ? rows.slice(0, q.limit) : rows;
        return {
          data,
          pagination: { limit: q.limit, offset: q.offset, count: data.length, hasMore },
        };
      });

      app.get(`/${slug}/columns`, async () => ({
        table: `${DB_SCHEMA}.${table}`,
        columns: await schema.columnsFor(slug),
      }));
    }
  };
}
