import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../db/pool';

export function healthRoutes(db: Db): FastifyPluginAsync {
  return async (app) => {
    app.get('/healthz', async () => ({ status: 'ok' }));

    app.get('/readyz', async (req, reply) => {
      try {
        await db.query('SELECT 1');
        return { status: 'ready' };
      } catch (err) {
        req.log.warn({ err }, 'readiness check failed');
        return reply.code(503).send({ status: 'unavailable' });
      }
    });
  };
}
