import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../db/pool';
import { buildSelectQuery } from '../db/queryBuilder';
import type { SchemaCache } from '../db/schema';
import { DB_SCHEMA, TABLES, TABLE_SLUGS, type TableSlug } from '../tables';

export const NEW_DEALER_COLUMNS = [
  'user_id',
  'user_name',
  'account_id',
  'account_name',
  'is_new_dealer_this_month',
  'ordered_qty_mtd',
  'invoice_qty_mtd',
  'ordered_date',
  'invoice_date',
  'l3m_avg_invoice_qty',
  'invoice_qty_target',
  'taluka',
] as const;

export function tableRoutes(db: Db, schema: SchemaCache): FastifyPluginAsync {
  async function listRows(
    slug: TableSlug,
    query: Record<string, unknown>,
    select?: readonly string[],
  ) {
    const columns = await schema.columnsFor(slug);
    const q = buildSelectQuery(TABLES[slug], columns, query, select);
    const { rows } = await db.query(q.text, q.values);
    const hasMore = rows.length > q.limit;
    const data = hasMore ? rows.slice(0, q.limit) : rows;
    return {
      data,
      pagination: { limit: q.limit, offset: q.offset, count: data.length, hasMore },
    };
  }

  return async (app) => {
    for (const slug of TABLE_SLUGS) {
      const table = TABLES[slug];

      app.get(`/${slug}`, async (req) => listRows(slug, req.query as Record<string, unknown>));

      app.get(`/${slug}/columns`, async () => ({
        table: `${DB_SCHEMA}.${table}`,
        columns: await schema.columnsFor(slug),
      }));
    }

    // Only rows where is_new_dealer_this_month is true, returning NEW_DEALER_COLUMNS. The filter
    // is fixed; every other query parameter (paging, sorting, column filters) works as on
    // /dealer-month-activity.
    app.get('/dealer-month-activity/new-dealers', async (req) =>
      listRows(
        'dealer-month-activity',
        { ...(req.query as Record<string, unknown>), is_new_dealer_this_month: 'true' },
        NEW_DEALER_COLUMNS,
      ),
    );

    app.get('/dealer-month-activity/current-month-invoiced', async (req) => {
  const now = new Date();

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');

  const startOfMonth = `${year}-${month}-01`;

  const nextMonth = new Date(year, now.getMonth() + 1, 1);

  const startOfNextMonth =
    `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;

  return listRows(
    'dealer-month-activity',
    {
      ...(req.query as Record<string, unknown>),
      'invoice_date.gte': startOfMonth,
      'invoice_date.lt': startOfNextMonth,
    },
    NEW_DEALER_COLUMNS,
  );
});

    // Only rows where is_high_potential is true, returning every column. Other query
    // parameters work as on /high-potential-taluka-month.
    app.get('/high-potential-taluka-month/high-potential', async (req) =>
      listRows('high-potential-taluka-month', {
        ...(req.query as Record<string, unknown>),
        is_high_potential: 'true',
      }),
    );
  };
}
