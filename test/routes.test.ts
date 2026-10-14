import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { NEW_DEALER_COLUMNS } from '../src/routes/tables';
import { API_KEY, COLUMNS, fakeDb, testApp } from './helpers';

let app: FastifyInstance;
afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
});

const auth = { 'x-api-key': API_KEY };
const NEW_DEALER_SELECT = `SELECT ${NEW_DEALER_COLUMNS.map((c) => `"${c}"`).join(', ')} FROM "public"."fct_dealer_month_activity_table"`;

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
  it.each(['dealer-month-activity', 'user-month-summary'])(
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
    expect(call?.text.startsWith(`${NEW_DEALER_SELECT} WHERE `)).toBe(true);
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

  it('GET /v1/dealer-month-activity/high-potential returns both taluka counts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 11, 15));
    const db = fakeDb();
    db.rows = [{ highPotentialTalukaCount: 42, invoicedTalukaCount: 30 }];
    app = testApp(db);
    const res = await app.inject({
      url: '/v1/dealer-month-activity/high-potential?is_high_potential=false&district=D1',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ highPotentialTalukaCount: 42, invoicedTalukaCount: 30 });

    const dealerCall = db.calls.find((c) => c.text.includes('fct_dealer_month_activity_table'));
    expect(dealerCall?.text).toBe(
      'SELECT COUNT(DISTINCT "taluka") FILTER (WHERE "invoice_date" >= $1 AND "invoice_date" < $2)::int AS "invoicedTalukaCount" ' +
        'FROM "public"."fct_dealer_month_activity_table" WHERE "is_high_potential" = $3 AND "district" = $4',
    );
    // December rolls over into January of the next year.
    expect(dealerCall?.values).toEqual(['2026-12-01', '2027-01-01', 'true', 'D1']);

    // highPotentialTalukaCount comes from the taluka table; is_high_potential is not one of its
    // columns, so only district is forwarded.
    const talukaCall = db.calls.find((c) =>
      c.text.includes('fct_high_potential_taluka_month_table'),
    );
    expect(talukaCall?.text).toBe(
      'SELECT COUNT(DISTINCT "taluka")::int AS "highPotentialTalukaCount" ' +
        'FROM "public"."fct_high_potential_taluka_month_table" ' +
        'WHERE "district" = $1 AND "taluka_potential" = ANY($2)',
    );
    expect(talukaCall?.values).toEqual(['D1', ['High', 'Very High']]);
  });

  it('high-potential limits only invoicedTalukaCount to the current month', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 12));
    const db = fakeDb();
    db.rows = [{ highPotentialTalukaCount: 1, invoicedTalukaCount: 0 }];
    app = testApp(db);
    const res = await app.inject({
      url: '/v1/dealer-month-activity/high-potential',
      headers: auth,
    });
    expect(res.json()).toEqual({ highPotentialTalukaCount: 1, invoicedTalukaCount: 0 });
    const dealerCall = db.calls.find((c) => c.text.includes('fct_dealer_month_activity_table'));
    expect(dealerCall?.values).toEqual(['2026-10-01', '2026-11-01', 'true']);
    const talukaCall = db.calls.find((c) =>
      c.text.includes('fct_high_potential_taluka_month_table'),
    );
    expect(talukaCall?.values).toEqual([['High', 'Very High']]);
  });

  it('high-potential-invoiced was merged into high-potential', async () => {
    app = testApp();
    const res = await app.inject({
      url: '/v1/dealer-month-activity/high-potential-invoiced',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('high-potential requires an API key', async () => {
    app = testApp();
    const res = await app.inject({ url: '/v1/dealer-month-activity/high-potential' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/high-potential-taluka-month returns data with pagination', async () => {
    const db = fakeDb();
    db.rows = [{ taluka: 'A' }, { taluka: 'B' }];
    app = testApp(db);
    const res = await app.inject({
      url: '/v1/high-potential-taluka-month?limit=1&taluka_potential=High',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [{ taluka: 'A' }],
      pagination: { limit: 1, offset: 0, count: 1, hasMore: true },
    });
    const call = db.calls.at(-1);
    expect(call?.text).toMatch(
      /^SELECT \* FROM "public"\."fct_high_potential_taluka_month_table" WHERE "taluka_potential" = \$1/,
    );
    expect(call?.values?.[0]).toBe('High');
  });

  it('lists columns of high-potential-taluka-month', async () => {
    app = testApp();
    const res = await app.inject({
      url: '/v1/high-potential-taluka-month/columns',
      headers: auth,
    });
    expect(res.json()).toMatchObject({ table: 'public.fct_high_potential_taluka_month_table' });
  });

  it('GET /v1/high-potential-taluka-month/high-potential-count counts High and Very High talukas', async () => {
    const db = fakeDb();
    db.rows = [{ highPotentialTalukaCount: 17 }];
    app = testApp(db);
    const res = await app.inject({
      url: '/v1/high-potential-taluka-month/high-potential-count?district=D1',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ highPotentialTalukaCount: 17 });
    const call = db.calls.at(-1);
    expect(call?.text).toBe(
      'SELECT COUNT(DISTINCT "taluka")::int AS "highPotentialTalukaCount" ' +
        'FROM "public"."fct_high_potential_taluka_month_table" ' +
        'WHERE "district" = $1 AND "taluka_potential" = ANY($2)',
    );
    expect(call?.values).toEqual(['D1', ['High', 'Very High']]);
  });

  it('high-potential-count ignores a caller-supplied taluka_potential.in', async () => {
    const db = fakeDb();
    db.rows = [{ highPotentialTalukaCount: 0 }];
    app = testApp(db);
    await app.inject({
      url: '/v1/high-potential-taluka-month/high-potential-count?taluka_potential.in=Low',
      headers: auth,
    });
    expect(db.calls.at(-1)?.values).toEqual([['High', 'Very High']]);
  });

  it('high-potential-count requires an API key', async () => {
    app = testApp();
    const res = await app.inject({ url: '/v1/high-potential-taluka-month/high-potential-count' });
    expect(res.statusCode).toBe(401);
  });

  describe.each([
    ['current-month-invoiced', 'invoice_date'],
    ['current-month-ordered', 'ordered_date'],
  ])('GET /v1/dealer-month-activity/%s', (route, column) => {
    const url = `/v1/dealer-month-activity/${route}`;

    it(`filters ${column} to the current month and returns NEW_DEALER_COLUMNS`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 9, 12, 13, 0));
      const db = fakeDb();
      db.rows = [{ user_id: 'U1' }];
      app = testApp(db);
      const res = await app.inject({ url: `${url}?taluka=T1&limit=10`, headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        data: [{ user_id: 'U1' }],
        pagination: { limit: 10, offset: 0, count: 1, hasMore: false },
      });
      const call = db.calls.at(-1);
      expect(call?.text.startsWith(`${NEW_DEALER_SELECT} WHERE `)).toBe(true);
      expect(call?.text).toContain(`"taluka" = $1 AND "${column}" >= $2 AND "${column}" < $3`);
      expect(call?.values?.slice(0, 3)).toEqual(['T1', '2026-10-01', '2026-11-01']);
    });

    it('rolls December over into January of the next year', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 11, 31, 23, 0));
      const db = fakeDb();
      app = testApp(db);
      await app.inject({ url, headers: auth });
      expect(db.calls.at(-1)?.values?.slice(0, 2)).toEqual(['2026-12-01', '2027-01-01']);
    });

    it(`overrides a caller-supplied ${column} range`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 9, 12));
      const db = fakeDb();
      app = testApp(db);
      await app.inject({ url: `${url}?${column}.gte=2020-01-01`, headers: auth });
      expect(db.calls.at(-1)?.values?.slice(0, 2)).toEqual(['2026-10-01', '2026-11-01']);
    });

    it('requires an API key', async () => {
      app = testApp();
      expect((await app.inject({ url })).statusCode).toBe(401);
    });
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
