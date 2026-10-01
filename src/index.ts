import { existsSync } from 'node:fs';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createPool } from './db/pool';

async function main(): Promise<void> {
  // Local runs: pick up .env however the process was started. Variables already set in the
  // environment win. The image excludes .env (.dockerignore), so Cloud Run is unaffected.
  if (existsSync('.env')) process.loadEnvFile('.env');

  const config = loadConfig();
  const pool = createPool(config);
  const app = buildApp({ config, db: pool });

  pool.on('error', (err) => app.log.error({ err }, 'idle pg client error'));
  app.addHook('onClose', async () => pool.end());

  // Cloud Run sends SIGTERM and allows ~10s before SIGKILL.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      app.close().then(
        () => process.exit(0),
        (err: unknown) => {
          app.log.error({ err }, 'error during shutdown');
          process.exit(1);
        },
      );
    });
  }

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  app.log.info({ env: config.APP_ENV }, 'msme-data-service started');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
