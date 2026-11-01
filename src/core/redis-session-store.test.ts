import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedConversationState } from '../types/session.js';
import { logger } from '../infra/logger.js';

const {
  createClientMock,
  getMockState,
  resetMockState,
} = vi.hoisted(() => {
  const state = {
    kv: new Map<string, string>(),
    expiry: new Map<string, number>(),
    sets: new Map<string, Set<string>>(),
  };

  function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  function applyExpiry(): void {
    const now = nowSeconds();
    for (const [key, expiresAt] of [...state.expiry.entries()]) {
      if (expiresAt <= now) {
        state.expiry.delete(key);
        state.kv.delete(key);
      }
    }
  }

  const client = {
    on: vi.fn(),
    connect: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
    get: vi.fn(async (key: string) => {
      applyExpiry();
      return state.kv.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, value: string, options?: { EX?: number }) => {
      state.kv.set(key, value);
      if (options?.EX) {
        state.expiry.set(key, nowSeconds() + options.EX);
      }
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      state.kv.delete(key);
      state.expiry.delete(key);
      return 1;
    }),
    sAdd: vi.fn(async (key: string, member: string) => {
      const set = state.sets.get(key) ?? new Set<string>();
      set.add(member);
      state.sets.set(key, set);
      return 1;
    }),
    sRem: vi.fn(async (key: string, member: string) => {
      state.sets.get(key)?.delete(member);
      return 1;
    }),
    sMembers: vi.fn(async (key: string) => [...(state.sets.get(key) ?? new Set<string>())]),
    ttl: vi.fn(async (key: string) => {
      applyExpiry();
      if (!state.kv.has(key)) {
        return -2;
      }
      const expiresAt = state.expiry.get(key);
      if (!expiresAt) {
        return -1;
      }
      return Math.max(0, expiresAt - nowSeconds());
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      if (!state.kv.has(key)) {
        return 0;
      }
      state.expiry.set(key, nowSeconds() + seconds);
      return 1;
    }),
    multi: vi.fn(() => {
      const operations: Array<() => Promise<unknown>> = [];
      return {
        set(key: string, value: string, options?: { EX?: number }) {
          operations.push(() => client.set(key, value, options));
          return this;
        },
        del(key: string) {
          operations.push(() => client.del(key));
          return this;
        },
        sAdd(key: string, member: string) {
          operations.push(() => client.sAdd(key, member));
          return this;
        },
        sRem(key: string, member: string) {
          operations.push(() => client.sRem(key, member));
          return this;
        },
        async exec() {
          return Promise.all(operations.map((operation) => operation()));
        },
      };
    }),
  };

  return {
    createClientMock: vi.fn(() => client),
    getMockState: () => state,
    resetMockState: () => {
      state.kv.clear();
      state.expiry.clear();
      state.sets.clear();
      vi.clearAllMocks();
    },
  };
});

vi.mock('redis', () => ({
  createClient: createClientMock,
}));

describe('RedisSessionStore', () => {
  beforeEach(() => {
    resetMockState();
  });

  async function createStore() {
    const { RedisSessionStore } = await import('./redis-session-store.js');
    return new RedisSessionStore('redis://127.0.0.1:6379', 'qq-ai-bot-test', 120 * 60 * 1000, logger);
  }

  async function upsertSample(store: { upsert(record: PersistedConversationState): Promise<void> }, key: string) {
    await store.upsert({
      conversationKey: key,
      chatType: 'direct',
      targetId: key,
      remoteSessionId: `remote-${key}`,
      lastActivityAt: new Date().toISOString(),
    });
  }

  it('stores and reloads records via redis primitives', async () => {
    const store = await createStore();
    await store.load();
    await upsertSample(store, 'direct:1');

    await expect(store.get('direct:1')).resolves.toMatchObject({
      remoteSessionId: 'remote-direct:1',
    });

    const listed = await store.list();
    expect(listed.map((item) => item.conversationKey)).toEqual(['direct:1']);
    expect(createClientMock).toHaveBeenCalledTimes(1);
  });

  it('cleans stale index entries when redis data is missing', async () => {
    const store = await createStore();
    await store.load();
    await upsertSample(store, 'direct:1');

    const state = getMockState();
    state.kv.delete('qq-ai-bot-test:session:direct:1');
    state.expiry.delete('qq-ai-bot-test:session:direct:1');

    await expect(store.get('direct:1')).resolves.toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});
