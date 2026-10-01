import { z } from 'zod';

const configSchema = z
  .object({
    APP_ENV: z.enum(['local', 'qa', 'preprod', 'prod']).default('local'),
    PORT: z.coerce.number().int().positive().default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // Cloud Run: set INSTANCE_CONNECTION_NAME (project:region:instance) and the service
    // connects through the built-in Cloud SQL Auth Proxy unix socket.
    // Local: set DB_HOST (e.g. 127.0.0.1 with cloud-sql-proxy running).
    INSTANCE_CONNECTION_NAME: z.string().min(1).optional(),
    DB_HOST: z.string().min(1).optional(),
    DB_PORT: z.coerce.number().int().positive().default(5432),
    DB_NAME: z.string().min(1),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string().min(1),

    POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
    STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
    SCHEMA_CACHE_TTL_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(10 * 60_000),

    // Comma-separated list so keys can be rotated without downtime.
    API_KEYS: z
      .string()
      .transform((s) =>
        s
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean),
      )
      .pipe(
        z
          .array(z.string().min(16, 'each API key must be at least 16 characters'))
          .min(1, 'at least one API key is required'),
      ),
  })
  .refine((c) => c.INSTANCE_CONNECTION_NAME ?? c.DB_HOST, {
    message: 'Set INSTANCE_CONNECTION_NAME (Cloud Run) or DB_HOST (local)',
    path: ['INSTANCE_CONNECTION_NAME'],
  });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return result.data;
}
