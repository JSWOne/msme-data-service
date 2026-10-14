import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../db/pool';
import { buildDistinctCountsQuery, buildSelectQuery } from '../db/queryBuilder';
import type { SchemaCache } from '../db/schema';
import { DB_SCHEMA, TABLES, TABLE_SLUGS, type TableSlug } from '../tables';

export const NEW_DEALER_COLUMNS = [
  'user_id',
  'user_name',
  'account_id',
  'account_name',
  'account_type',
  'is_new_dealer_this_month',
  'ordered_qty_mtd',
  'invoice_qty_mtd',
  'ordered_date',
  'invoice_date',
  'l3m_avg_invoice_qty',
  'invoice_qty_target',
  'taluka',
  'district',
] as const;

const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** First day of the current month and of the next one, as 'YYYY-MM-DD' in server-local time. */
export function currentMonthRange(now = new Date()) {
  return {
    startOfMonth: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)),
    startOfNextMonth: isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 1)),
  };
}

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

  async function countDistinct<K extends string>(
    slug: TableSlug,
    query: Record<string, unknown>,
    column: string,
    counts: Record<K, Record<string, string>>,
  ): Promise<Record<K, number>> {
    const columns = await schema.columnsFor(slug);
    const q = buildDistinctCountsQuery(TABLES[slug], columns, query, column, counts);
    const { rows } = await db.query<Record<K, number>>(q.text, q.values);
    return rows[0]!;
  }

  /** Distinct talukas whose taluka_potential is 'High' or 'Very High'. */
  async function countHighPotentialTalukas(query: Record<string, unknown>): Promise<number> {
    const { highPotentialTalukaCount } = await countDistinct(
      'high-potential-taluka-month',
      { ...query, 'taluka_potential.in': 'High,Very High' },
      'taluka',
      { highPotentialTalukaCount: {} },
    );
    return highPotentialTalukaCount;
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

    // Returns { highPotentialTalukaCount }: distinct talukas whose taluka_potential is 'High' or
    // 'Very High'. NULL talukas are never counted. Column filters (e.g. state, zone,
    // transaction_date_secondary_sales_stock) work as on /high-potential-taluka-month.
    app.get('/high-potential-taluka-month/high-potential-count', async (req) => ({
      highPotentialTalukaCount: await countHighPotentialTalukas(
        req.query as Record<string, unknown>,
      ),
    }));

    app.get('/dealer-month-activity/current-month-invoiced', async (req) => {
      const { startOfMonth, startOfNextMonth } = currentMonthRange();
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

    app.get('/dealer-month-activity/current-month-ordered', async (req) => {
      const { startOfMonth, startOfNextMonth } = currentMonthRange();
      return listRows(
        'dealer-month-activity',
        {
          ...(req.query as Record<string, unknown>),
          'ordered_date.gte': startOfMonth,
          'ordered_date.lt': startOfNextMonth,
        },
        NEW_DEALER_COLUMNS,
      );
    });

    app.get('/dealer-month-activity/current-month-invoiced-retailers', async (req) => {
      const { startOfMonth, startOfNextMonth } = currentMonthRange();
      return listRows(
        'dealer-month-activity',
        {
          ...(req.query as Record<string, unknown>),
          'invoice_date.gte': startOfMonth,
          'invoice_date.lt': startOfNextMonth,
          'account_type.eq': 'Retailer',
        },
        NEW_DEALER_COLUMNS,
      );
    });

    // Returns two counts of distinct talukas (NULL talukas are never counted):
    //   highPotentialTalukaCount: from /high-potential-taluka-month/high-potential-count, i.e.
    //                             taluka_potential is 'High' or 'Very High'.
    //   invoicedTalukaCount:      from dealer-month-activity, rows where is_high_potential is true
    //                             AND invoice_date falls in the current month.
    // Column filters work as on /dealer-month-activity. For highPotentialTalukaCount only the
    // filters on columns that also exist in high-potential-taluka-month (e.g. district, taluka)
    // are applied; the others are ignored for that count.
    app.get('/dealer-month-activity/high-potential', async (req) => {
      const { startOfMonth, startOfNextMonth } = currentMonthRange();
      const query = req.query as Record<string, unknown>;
      const talukaColumns = new Set(
        (await schema.columnsFor('high-potential-taluka-month')).map((c) => c.name),
      );
      const talukaQuery = Object.fromEntries(
        Object.entries(query).filter(([key]) => talukaColumns.has(key.split('.')[0]!)),
      );
      const [highPotentialTalukaCount, { invoicedTalukaCount }] = await Promise.all([
        countHighPotentialTalukas(talukaQuery),
        countDistinct('dealer-month-activity', { ...query, is_high_potential: 'true' }, 'taluka', {
          invoicedTalukaCount: {
            'invoice_date.gte': startOfMonth,
            'invoice_date.lt': startOfNextMonth,
          },
        }),
      ]);
      return { highPotentialTalukaCount, invoicedTalukaCount };
    });
  };
}
