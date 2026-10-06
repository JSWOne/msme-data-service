import { describe, expect, it } from 'vitest';
import { buildSelectQuery, quoteIdent } from '../src/db/queryBuilder';
import { BadRequestError } from '../src/errors';

const columns = [
  { name: 'month', dataType: 'date' },
  { name: 'dealer_id', dataType: 'text' },
  { name: 'meta', dataType: 'json' },
];
const T = 'fct_dealer_month_activity_table';

describe('buildSelectQuery', () => {
  it('defaults to limit 100 / offset 0 and fetches one extra row', () => {
    const q = buildSelectQuery(T, columns, {});
    expect(q.text).toBe(
      'SELECT * FROM "public"."fct_dealer_month_activity_table" ORDER BY "month" ASC, "dealer_id" ASC LIMIT $1 OFFSET $2',
    );
    expect(q.values).toEqual([101, 0]);
    expect(q).toMatchObject({ limit: 100, offset: 0 });
  });

  it('selects only the requested columns', () => {
    const q = buildSelectQuery(T, columns, { meta: 'x' }, ['dealer_id', 'month']);
    expect(q.text).toMatch(
      /^SELECT "dealer_id", "month" FROM "public"\."fct_dealer_month_activity_table" WHERE "meta" = \$1 /,
    );
  });

  it('throws a server error when a selected column is missing', () => {
    expect(() => buildSelectQuery(T, columns, {}, ['dealer_id', 'nope'])).toThrow(
      'Columns not found in fct_dealer_month_activity_table: nope',
    );
    expect(() => buildSelectQuery(T, columns, {}, ['nope'])).not.toThrow(BadRequestError);
  });

  it('builds parameterised filters for every operator', () => {
    const q = buildSelectQuery(T, columns, {
      dealer_id: 'D1',
      'month.gte': '2024-01-01',
      'month.lte': '2024-06-01',
      'dealer_id.in': 'D1, D2,,D3',
    });
    expect(q.text).toContain(
      'WHERE "dealer_id" = $1 AND "month" >= $2 AND "month" <= $3 AND "dealer_id" = ANY($4)',
    );
    expect(q.values).toEqual(['D1', '2024-01-01', '2024-06-01', ['D1', 'D2', 'D3'], 101, 0]);
  });

  it('applies sort/order with the sort column first and tie-breakers after', () => {
    const q = buildSelectQuery(T, columns, {
      sort: 'dealer_id',
      order: 'DESC',
      limit: '10',
      offset: '20',
    });
    expect(q.text).toContain('ORDER BY "dealer_id" DESC, "month" ASC LIMIT $1 OFFSET $2');
    expect(q.values).toEqual([11, 20]);
  });

  it.each([
    [{ unknown_col: 'x' }, /Unknown query parameter/],
    [{ 'month.like': 'x' }, /Unknown query parameter/],
    [{ 'month; DROP TABLE x': '1' }, /Unknown query parameter/],
    [{ limit: '1001' }, /Invalid 'limit'/],
    [{ limit: 'abc' }, /Invalid 'limit'/],
    [{ offset: '-1' }, /Invalid 'offset'/],
    [{ order: 'sideways' }, /Invalid 'order'/],
    [{ sort: 'nope' }, /Cannot sort by 'nope'/],
    [{ sort: 'meta' }, /Cannot sort by 'meta'/],
    [{ dealer_id: ['a', 'b'] }, /exactly once/],
    [{ 'dealer_id.in': ' , ' }, /at least one value/],
    [{ 'dealer_id.in': Array.from({ length: 101 }, (_, i) => i).join(',') }, /at most 100/],
  ])('rejects %j', (query, message) => {
    expect(() => buildSelectQuery(T, columns, query)).toThrow(BadRequestError);
    expect(() => buildSelectQuery(T, columns, query)).toThrow(message);
  });
});

describe('quoteIdent', () => {
  it('escapes embedded double quotes', () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});
