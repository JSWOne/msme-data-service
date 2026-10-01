import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** onRequest hook that requires a valid `x-api-key` header. */
export function apiKeyHook(apiKeys: readonly string[]) {
  // Hashing gives equal-length buffers, so timingSafeEqual never leaks key length.
  const expected = apiKeys.map(digest);

  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers['x-api-key'];
    const provided = typeof header === 'string' ? digest(header) : undefined;
    // Compare against every key (no early exit) so timing doesn't reveal which matched.
    const ok = provided
      ? expected.reduce((match, key) => timingSafeEqual(key, provided) || match, false)
      : false;
    if (!ok) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Missing or invalid API key' });
    }
  };
}
