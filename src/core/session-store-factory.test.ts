import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import { createSessionStore } from './session-store-factory.js';

describe('createSessionStore', () => {
  it('creates a postgres session store from config', () => {
    const config = loadConfig({
      SESSION_STORE: 'postgres',
      POSTGRES_URL: 'postgres://user:pass@127.0.0.1:5432/qq_ai_bot',
      POSTGRES_TABLE: 'custom_sessions',
    });

    const store = createSessionStore(config, pino({ enabled: false }));

    expect(store.kind).toBe('postgres');
  });
});
