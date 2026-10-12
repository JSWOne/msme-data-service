import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const base = {
  DB_NAME: 'bq_to_pg',
  DB_USER: 'reader',
  DB_PASSWORD: 'secret',
  API_KEYS: 'key-aaaaaaaaaaaaaaaa, key-bbbbbbbbbbbbbbbb',
  INSTANCE_CONNECTION_NAME: 'jswone-qa-356112:asia-south1:ccp-qa',
};

describe('loadConfig', () => {
  it('parses a valid Cloud Run env with defaults', () => {
    const c = loadConfig(base);
    expect(c.API_KEYS).toEqual(['key-aaaaaaaaaaaaaaaa', 'key-bbbbbbbbbbbbbbbb']);
    expect(c).toMatchObject({ PORT: 8080, POOL_MAX: 5, STATEMENT_TIMEOUT_MS: 10_000 });
  });

  it('requires INSTANCE_CONNECTION_NAME or DB_HOST', () => {
    const { INSTANCE_CONNECTION_NAME: _, ...env } = base;
    expect(() => loadConfig(env)).toThrow(/INSTANCE_CONNECTION_NAME/);
    expect(loadConfig({ ...env, DB_HOST: '127.0.0.1' }).DB_HOST).toBe('127.0.0.1');
  });

  it('normalises BASE_PATH and rejects malformed values', () => {
    expect(loadConfig(base).BASE_PATH).toBe('');
    expect(loadConfig({ ...base, BASE_PATH: '/msme-data-service/' }).BASE_PATH).toBe(
      '/msme-data-service',
    );
    expect(loadConfig({ ...base, BASE_PATH: '/' }).BASE_PATH).toBe('');
    expect(() => loadConfig({ ...base, BASE_PATH: 'msme-data-service' })).toThrow(/BASE_PATH/);
  });

  it('rejects short API keys and missing secrets', () => {
    expect(() => loadConfig({ ...base, API_KEYS: 'short' })).toThrow(/at least 16/);
    expect(() => loadConfig({ ...base, DB_PASSWORD: '' })).toThrow(/DB_PASSWORD/);
  });
});
