import type { Logger } from 'pino';
import { createClient, type RedisClientType } from 'redis';
import type { PersistedConversationState } from '../types/session.js';
import type { SessionStore } from './session-store.js';

function sessionKey(prefix: string, conversationKey: string): string {
  return `${prefix}:session:${conversationKey}`;
}

function indexKey(prefix: string): string {
  return `${prefix}:sessions`;
}

export class RedisSessionStore implements SessionStore {
  readonly kind = 'redis' as const;
  private client: RedisClientType<any, any, any> | null = null;

  constructor(
    private readonly redisUrl: string,
    private readonly keyPrefix: string,
    private readonly ttlMs: number,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<void> {
    await this.ensureClient();
  }

  async get(conversationKey: string): Promise<PersistedConversationState | undefined> {
    const client = await this.ensureClient();
    const raw = await client.get(sessionKey(this.keyPrefix, conversationKey));
    if (!raw) {
      await client.sRem(indexKey(this.keyPrefix), conversationKey);
      return undefined;
    }

    try {
      return JSON.parse(raw) as PersistedConversationState;
    } catch (error) {
      this.logger.warn(
        {
          conversationKey,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to parse redis session record; deleting corrupt entry',
      );
      await client.del(sessionKey(this.keyPrefix, conversationKey));
      await client.sRem(indexKey(this.keyPrefix), conversationKey);
      return undefined;
    }
  }

  async list(): Promise<PersistedConversationState[]> {
    const client = await this.ensureClient();
    const keys = await client.sMembers(indexKey(this.keyPrefix));
    if (keys.length === 0) {
      return [];
    }

    const records = await Promise.all(keys.map(async (conversationKey) => this.get(conversationKey)));
    return records
      .filter((record): record is PersistedConversationState => Boolean(record))
      .sort((a, b) => a.conversationKey.localeCompare(b.conversationKey));
  }

  async upsert(record: PersistedConversationState): Promise<void> {
    const client = await this.ensureClient();
    const key = sessionKey(this.keyPrefix, record.conversationKey);
    const ttlSeconds = this.ttlSeconds();

    const multi = client.multi();
    multi.set(key, JSON.stringify(record), { EX: ttlSeconds });
    multi.sAdd(indexKey(this.keyPrefix), record.conversationKey);
    await multi.exec();
  }

  async delete(conversationKey: string): Promise<void> {
    const client = await this.ensureClient();
    const multi = client.multi();
    multi.del(sessionKey(this.keyPrefix, conversationKey));
    multi.sRem(indexKey(this.keyPrefix), conversationKey);
    await multi.exec();
  }

  async clearExpired(now: number): Promise<string[]> {
    const client = await this.ensureClient();
    const keys = await client.sMembers(indexKey(this.keyPrefix));
    if (keys.length === 0) {
      return [];
    }

    const removed: string[] = [];
    for (const conversationKey of keys) {
      const key = sessionKey(this.keyPrefix, conversationKey);
      const ttl = await client.ttl(key);
      if (ttl === -2) {
        await client.sRem(indexKey(this.keyPrefix), conversationKey);
        removed.push(conversationKey);
        continue;
      }

      if (ttl <= 0) {
        const record = await this.get(conversationKey);
        if (!record) {
          removed.push(conversationKey);
          continue;
        }
        const lastActivityAt = Date.parse(record.lastActivityAt);
        if (!Number.isFinite(lastActivityAt) || now - lastActivityAt > this.ttlMs) {
          await this.delete(conversationKey);
          removed.push(conversationKey);
        } else {
          await client.expire(key, this.ttlSeconds());
        }
      }
    }

    return removed;
  }

  async close(): Promise<void> {
    if (!this.client) {
      return;
    }
    const current = this.client;
    this.client = null;
    await current.quit();
  }

  private async ensureClient(): Promise<RedisClientType<any, any, any>> {
    if (this.client) {
      return this.client;
    }

    const client = createClient({
      url: this.redisUrl,
      socket: {
        reconnectStrategy: false,
      },
    });

    client.on('error', (error) => {
      this.logger.warn({ error: error.message }, 'redis session store client error');
    });

    await client.connect();
    this.client = client;
    return client;
  }

  private ttlSeconds(): number {
    return Math.max(1, Math.ceil(this.ttlMs / 1000));
  }
}
