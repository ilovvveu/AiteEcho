import type { Logger } from 'pino';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import type { PersistedConversationState } from '../types/session.js';
import type { SessionStore } from './session-store.js';

export interface PostgresQueryClient {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  end?(): Promise<void>;
}

function assertSafeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error('POSTGRES_TABLE must be a simple SQL identifier');
  }
  return value;
}

function expiresAtFor(record: PersistedConversationState, ttlMs: number): Date {
  const lastActivityAt = Date.parse(record.lastActivityAt);
  const base = Number.isFinite(lastActivityAt) ? lastActivityAt : Date.now();
  return new Date(base + ttlMs);
}

export class PostgresSessionStore implements SessionStore {
  readonly kind = 'postgres' as const;
  private readonly tableName: string;
  private client: PostgresQueryClient | null;
  private ownsClient: boolean;

  constructor(
    private readonly postgresUrl: string,
    tableName: string,
    private readonly ttlMs: number,
    private readonly logger: Logger,
    client?: PostgresQueryClient,
  ) {
    this.tableName = assertSafeIdentifier(tableName);
    this.client = client ?? null;
    this.ownsClient = !client;
  }

  async load(): Promise<void> {
    await this.ensureSchema();
  }

  async get(conversationKey: string): Promise<PersistedConversationState | undefined> {
    await this.ensureSchema();
    const client = await this.ensureClient();
    const result = await client.query<{ payload_json: unknown }>(
      `SELECT payload_json FROM ${this.tableName} WHERE conversation_key = $1 AND expires_at > NOW()`,
      [conversationKey],
    );
    const row = result.rows[0];
    if (!row) {
      await this.delete(conversationKey);
      return undefined;
    }
    try {
      return row.payload_json as PersistedConversationState;
    } catch (error) {
      this.logger.warn(
        {
          conversationKey,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to parse postgres session record; deleting corrupt entry',
      );
      await this.delete(conversationKey);
      return undefined;
    }
  }

  async list(): Promise<PersistedConversationState[]> {
    await this.ensureSchema();
    const client = await this.ensureClient();
    const result = await client.query<{ payload_json: unknown }>(
      `SELECT payload_json FROM ${this.tableName} WHERE expires_at > NOW() ORDER BY conversation_key ASC`,
    );
    return result.rows.map((row) => row.payload_json as PersistedConversationState);
  }

  async upsert(record: PersistedConversationState): Promise<void> {
    await this.ensureSchema();
    const client = await this.ensureClient();
    await client.query(
      `INSERT INTO ${this.tableName} (conversation_key, payload_json, updated_at, expires_at)
       VALUES ($1, $2::jsonb, NOW(), $3)
       ON CONFLICT (conversation_key)
       DO UPDATE SET payload_json = EXCLUDED.payload_json, updated_at = NOW(), expires_at = EXCLUDED.expires_at`,
      [record.conversationKey, JSON.stringify(record), expiresAtFor(record, this.ttlMs)],
    );
  }

  async delete(conversationKey: string): Promise<void> {
    await this.ensureSchema();
    const client = await this.ensureClient();
    await client.query(`DELETE FROM ${this.tableName} WHERE conversation_key = $1`, [conversationKey]);
  }

  async clearExpired(now: number): Promise<string[]> {
    await this.ensureSchema();
    const client = await this.ensureClient();
    const result = await client.query<{ conversation_key: string }>(
      `DELETE FROM ${this.tableName} WHERE expires_at <= $1 RETURNING conversation_key`,
      [new Date(now)],
    );
    return result.rows.map((row) => row.conversation_key);
  }

  async close(): Promise<void> {
    if (!this.client || !this.ownsClient) {
      return;
    }
    const current = this.client;
    this.client = null;
    await current.end?.();
  }

  private async ensureSchema(): Promise<void> {
    const client = await this.ensureClient();
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${this.tableName} (
        conversation_key TEXT PRIMARY KEY,
        payload_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      )`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${this.tableName}_expires_at_idx ON ${this.tableName} (expires_at)`,
    );
  }

  private async ensureClient(): Promise<PostgresQueryClient> {
    if (this.client) {
      return this.client;
    }
    const pool = new Pool({
      connectionString: this.postgresUrl,
      max: 4,
      idleTimeoutMillis: 10_000,
    });
    pool.on('error', (error) => {
      this.logger.warn({ error: error.message }, 'postgres session store client error');
    });
    this.client = pool;
    this.ownsClient = true;
    return pool;
  }
}
