import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { API_KEY, COLUMNS, fakeDb, testApp } from './helpers';

let app: FastifyInstance;
afterEach(async () => app?.close());

const auth = { 'x-api-key': API_KEY };

describe('health', () => {
  it('serves /healthz and /readyz without an API key', async () => {
    app = testApp();
    expect((await app.inject('/healthz')).statusCode).toBe(200);
    expect((await app.inject('/readyz')).json()).toEqual({ status: 'ready' });
  });

  it('returns 503 from /readyz when the DB is down', async () => {
    const db = fakeDb();
    db.failWith = new Error('connection refused');
    app = testApp(db);
    expect((await app.inject('/readyz')).statusCode).toBe(503);
  });
});

describe('BASE_PATH', () => {
  it('serves every route under the prefix and nothing at the root', async () => {
    app = testApp(fakeDb(), '/msme-data-service');
    expect((await app.inject('/msme-data-service/healthz')).statusCode).toBe(200);
    expect((await app.inject('/msme-data-service/readyz')).json()).toEqual({ status: 'ready' });
    const data = await app.inject({
      url: '/msme-data-service/v1/dealer-month-activity',
      headers: auth,
    });
    expect(data.statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/msme-data-service/v1/dealer-month-activity' })).statusCode,
    ).toBe(401);
    expect((await app.inject('/healthz')).statusCode).toBe(404);
  });
});

describe('API key', () => {
  it.each([undefined, 'wrong-key-0123456789'])('rejects key %s with 401', async (key) => {
    app = testApp();
    const res = await app.inject({
      url: '/v1/dealer-month-activity',
      headers: key ? { 'x-api-key': key } : {},
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('table routes', () => {
  it.each(['dealer-month-activity', 'high-potential-taluka-month', 'user-month-summary'])(
    'GET /v1/%s returns data with pagination',
    async (slug) => {
      const db = fakeDb();
      db.rows = [{ dealer_id: 'A' }, { dealer_id: 'B' }, { dealer_id: 'C' }];
      app = testApp(db);
      const res = await app.inject({ url: `/v1/${slug}?limit=2`, headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        data: [{ dealer_id: 'A' }, { dealer_id: 'B' }],
        pagination: { limit: 2, offset: 0, count: 2, hasMore: true },
      });
      expect(db.calls.at(-1)?.text).toMatch(/^SELECT \* FROM "public"\."fct_\w+_table"/);
    },
  );

  it('reports hasMore=false on the last page', async () => {
    const db = fakeDb();
    db.rows = [{ dealer_id: 'A' }];
    app = testApp(db);
    const res = await app.inject({ url: '/v1/user-month-summary?limit=5', headers: auth });
    expect(res.json().pagination).toEqual({ limit: 5, offset: 0, count: 1, hasMore: false });
  });

  it('lists columns', async () => {
    app = testApp();
    const res = await app.inject({ url: '/v1/dealer-month-activity/columns', headers: auth });
    expect(res.json()).toMatchObject({
      table: 'public.fct_dealer_month_activity_table',
      columns: COLUMNS.map((c) => ({ name: c.column_name, dataType: c.data_type })),
    });
  });

  it('GET /v1/dealer-month-activity/new-dealers filters to new dealers', async () => {
    const db = fakeDb();
    db.rows = [{ dealer_id: 'A' }];
    app = testApp(db);
    const res = await app.inject({
      url: '/v1/dealer-month-activity/new-dealers?month.gte=2024-01-01&limit=10',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [{ dealer_id: 'A' }],
      pagination: { limit: 10, offset: 0, count: 1, hasMore: false },
    });
    const call = db.calls.at(-1);
    expect(call?.text).toMatch(
      /^SELECT "user_id", "user_name", "account_id", "is_new_dealer_this_month", "ordered_qty_mtd", "ordered_date", "invoice_date" FROM "public"\."fct_dealer_month_activity_table" WHERE /,
    );
    expect(call?.text).toContain('"is_new_dealer_this_month" = $2');
    expect(call?.values?.slice(0, 2)).toEqual(['2024-01-01', 'true']);
  });

  it('new-dealers ignores a caller-supplied is_new_dealer_this_month', async () => {
    const db = fakeDb();
    app = testApp(db);
    await app.inject({
      url: '/v1/dealer-month-activity/new-dealers?is_new_dealer_this_month=false',
      headers: auth,
    });
    expect(db.calls.at(-1)?.values?.[0]).toBe('true');
  });

  it('new-dealers requires an API key', async () => {
    app = testApp();
    const res = await app.inject({ url: '/v1/dealer-month-activity/new-dealers' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/high-potential-taluka-month/high-potential filters to high-potential rows', async () => {
    const db = fakeDb();
    db.rows = [{ taluka: 'T1' }];
    app = testApp(db);
    const res = await app.inject({
      url: '/v1/high-potential-taluka-month/high-potential?is_high_potential=false&limit=5',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [{ taluka: 'T1' }],
      pagination: { limit: 5, offset: 0, count: 1, hasMore: false },
    });
    const call = db.calls.at(-1);
    expect(call?.text).toMatch(
      /^SELECT \* FROM "public"\."fct_high_potential_taluka_month_table" WHERE "is_high_potential" = \$1 /,
    );
    expect(call?.values?.[0]).toBe('true');
  });

  it('high-potential requires an API key', async () => {
    app = testApp();
    const res = await app.inject({ url: '/v1/high-potential-taluka-month/high-potential' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for an unknown filter column', async () => {
    app = testApp();
    const res = await app.inject({ url: '/v1/dealer-month-activity?bogus=1', headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Unknown query parameter 'bogus'/);
  });

  it('maps a Postgres invalid-value error to 400', async () => {
    const db = fakeDb();
    db.failWith = Object.assign(new Error('invalid input syntax for type date'), { code: '22007' });
    app = testApp(db);
    const res = await app.inject({ url: '/v1/dealer-month-activity?month=nope', headers: auth });
    expect(res.statusCode).toBe(400);
  });

  it('maps a statement timeout to 504', async () => {
    const db = fakeDb();
    db.failWith = Object.assign(new Error('canceling statement'), { code: '57014' });
    app = testApp(db);
    const res = await app.inject({ url: '/v1/dealer-month-activity', headers: auth });
    expect(res.statusCode).toBe(504);
  });

  it('maps an unreachable DB to 503', async () => {
    const db = fakeDb();
    db.failWith = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    app = testApp(db);
    const res = await app.inject({ url: '/v1/dealer-month-activity', headers: auth });
    expect(res.statusCode).toBe(503);
  });

  it('hides internal error details', async () => {
    const db = fakeDb();
    db.failWith = new Error('password authentication failed for user x');
    app = testApp(db);
    const res = await app.inject({ url: '/v1/dealer-month-activity', headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('password');
  });

  it('returns 404 for unknown tables', async () => {
    app = testApp();
    const res = await app.inject({ url: '/v1/pg_shadow', headers: auth });
    expect(res.statusCode).toBe(404);
  });
});
