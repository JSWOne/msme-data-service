import { z } from 'zod';
import { BadRequestError } from '../errors';
import { DB_SCHEMA } from '../tables';
import type { ColumnInfo } from './schema';

export const MAX_LIMIT = 1000;
export const DEFAULT_LIMIT = 100;
export const MAX_OFFSET = 100_000;
export const MAX_IN_VALUES = 100;

const RESERVED_PARAMS = new Set(['limit', 'offset', 'sort', 'order']);

const OPERATORS = ['eq', 'gte', 'lte', 'lt', 'in'] as const;
type Operator = (typeof OPERATORS)[number];

// Types Postgres cannot ORDER BY; excluded from sorting and tie-breaking.
const NON_ORDERABLE_TYPES = new Set([
  'json',
  'xml',
  'point',
  'line',
  'lseg',
  'box',
  'path',
  'polygon',
  'circle',
]);

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).default(0),
  sort: z.string().min(1).optional(),
  order: z.preprocess(
    (v) => (typeof v === 'string' ? v.toLowerCase() : v),
    z.enum(['asc', 'desc']).default('asc'),
  ),
});

export interface SelectQuery {
  text: string;
  values: unknown[];
  limit: number;
  offset: number;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function parseFilterKey(key: string, columnNames: Set<string>): { column: string; op: Operator } {
  if (columnNames.has(key)) return { column: key, op: 'eq' };
  const dot = key.lastIndexOf('.');
  if (dot > 0) {
    const column = key.slice(0, dot);
    const op = key.slice(dot + 1) as Operator;
    if (columnNames.has(column) && OPERATORS.includes(op)) return { column, op };
  }
  throw new BadRequestError(
    `Unknown query parameter '${key}'. Use <column>, <column>.gte, <column>.lte or <column>.in`,
  );
}

function buildProjection(
  table: string,
  columnNames: Set<string>,
  select: readonly string[] | undefined,
): string {
  if (!select?.length) return '*';
  // A missing column is a server-side misconfiguration, not a bad request, so it surfaces as 500.
  const missing = select.filter((c) => !columnNames.has(c));
  if (missing.length) throw new Error(`Columns not found in ${table}: ${missing.join(', ')}`);
  return select.map(quoteIdent).join(', ');
}

/**
 * Builds a parameterised SELECT. Identifiers come only from the information_schema
 * whitelist (and are quoted); every user-supplied value is a bind parameter.
 * Fetches limit+1 rows so the caller can compute hasMore without a COUNT(*).
 * `select` limits the returned columns (default: all); filtering and sorting still see every column.
 */
export function buildSelectQuery(
  table: string,
  columns: readonly ColumnInfo[],
  query: Record<string, unknown>,
  select?: readonly string[],
): SelectQuery {
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== 'string') {
      throw new BadRequestError(`Query parameter '${key}' must be given exactly once`);
    }
  }
  const params = query as Record<string, string>;

  const parsed = paginationSchema.safeParse(params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BadRequestError(`Invalid '${issue?.path.join('.')}': ${issue?.message}`);
  }
  const { limit, offset, sort, order } = parsed.data;

  const columnNames = new Set(columns.map((c) => c.name));
  const projection = buildProjection(table, columnNames, select);

  const values: unknown[] = [];
  const bind = (v: unknown): string => {
    values.push(v);
    return `$${values.length}`;
  };

  const where: string[] = [];
  for (const [key, raw] of Object.entries(params)) {
    if (RESERVED_PARAMS.has(key)) continue;
    const { column, op } = parseFilterKey(key, columnNames);
    const col = quoteIdent(column);
    switch (op) {
      case 'eq':
        where.push(`${col} = ${bind(raw)}`);
        break;
      case 'gte':
        where.push(`${col} >= ${bind(raw)}`);
        break;
      case 'lte':
        where.push(`${col} <= ${bind(raw)}`);
        break;
      case 'lt':
        where.push(`${col} < ${bind(raw)}`);
        break;
      case 'in': {
        const list = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (list.length === 0) throw new BadRequestError(`'${key}' needs at least one value`);
        if (list.length > MAX_IN_VALUES) {
          throw new BadRequestError(`'${key}' accepts at most ${MAX_IN_VALUES} values`);
        }
        where.push(`${col} = ANY(${bind(list)})`);
        break;
      }
    }
  }

  const orderable = columns.filter((c) => !NON_ORDERABLE_TYPES.has(c.dataType));
  if (sort !== undefined && !orderable.some((c) => c.name === sort)) {
    throw new BadRequestError(`Cannot sort by '${sort}'`);
  }
  const primary = sort ?? orderable[0]?.name;
  // Tie-break on every other orderable column so LIMIT/OFFSET paging is deterministic
  // even though these tables have no declared unique key.
  const orderBy = orderable.map(
    (c) => `${quoteIdent(c.name)} ${c.name === primary ? order.toUpperCase() : 'ASC'}`,
  );
  const primaryIdx = orderable.findIndex((c) => c.name === primary);
  if (primaryIdx > 0) orderBy.unshift(...orderBy.splice(primaryIdx, 1));

  const text = [
    `SELECT ${projection} FROM ${quoteIdent(DB_SCHEMA)}.${quoteIdent(table)}`,
    where.length ? `WHERE ${where.join(' AND ')}` : '',
    orderBy.length ? `ORDER BY ${orderBy.join(', ')}` : '',
    `LIMIT ${bind(limit + 1)} OFFSET ${bind(offset)}`,
  ]
    .filter(Boolean)
    .join(' ');

  return { text, values, limit, offset };
}
