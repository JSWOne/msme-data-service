import type { FastifyError, FastifyInstance } from 'fastify';
import { BadRequestError } from '../errors';

// Postgres errors caused by bad filter values rather than server faults.
// https://www.postgresql.org/docs/current/errcodes-appendix.html
const PG_CLIENT_ERRORS: Record<string, string> = {
  '22P02': 'Invalid value for column type',
  '22007': 'Invalid date/time format',
  '22008': 'Date/time value out of range',
  '22003': 'Numeric value out of range',
  '22001': 'Value too long for column type',
  '42883': 'Filter not supported for this column type',
};
const PG_QUERY_CANCELED = '57014'; // statement_timeout
// DB unreachable / not accepting connections → 503 so callers know to retry.
const DB_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ENOENT',
  '57P03',
  '53300',
]);

function isDbUnavailable(err: { code?: string; message?: string }): boolean {
  return (
    (err.code !== undefined && DB_UNAVAILABLE_CODES.has(err.code)) ||
    /timeout exceeded when trying to connect/i.test(err.message ?? '')
  );
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((req, reply) => {
    void reply
      .code(404)
      .send({ error: 'Not Found', message: `Route ${req.method} ${req.url} not found` });
  });

  app.setErrorHandler((err: FastifyError & { code?: string }, req, reply) => {
    if (err instanceof BadRequestError) {
      return reply.code(400).send({ error: 'Bad Request', message: err.message });
    }
    if (err.code && PG_CLIENT_ERRORS[err.code]) {
      return reply.code(400).send({ error: 'Bad Request', message: PG_CLIENT_ERRORS[err.code] });
    }
    if (err.code === PG_QUERY_CANCELED) {
      req.log.warn({ err }, 'query timed out');
      return reply
        .code(504)
        .send({ error: 'Gateway Timeout', message: 'Query timed out; narrow your filters' });
    }
    if (isDbUnavailable(err)) {
      req.log.error({ err }, 'database unavailable');
      return reply
        .code(503)
        .send({ error: 'Service Unavailable', message: 'Database temporarily unavailable' });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: 'Bad Request', message: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'Internal Server Error', message: 'Unexpected error' });
  });
}
