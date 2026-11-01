import { describe, expect, it, vi } from 'vitest';
import { PostgresSessionStore, type PostgresQueryClient } from './postgres-session-store.js';
import type { QueryResultRow } from 'pg';
import type { PersistedConversationState } from '../types/session.js';

function queryResult<T>(rows: T[]) {
  return {
    rows,
    rowCount: rows.length,
    command: '',
    oid: 0,
    fields: [],
  };
}

class FakePostgresClient implements PostgresQueryClient {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];
  readonly records = new Map<string, { payload: PersistedConversationState; expiresAt: Date }>();
  closed = false;

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
    this.queries.push({ text, values });

    if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX')) {
      return queryResult<T>([]);
    }

    if (text.startsWith('INSERT INTO')) {
      const [conversationKey, payload, expiresAt] = values as [string, string, Date];
      this.records.set(conversationKey, {
        payload: JSON.parse(payload) as PersistedConversationState,
        expiresAt,
      });
      return queryResult<T>([]);
    }

    if (text.startsWith('SELECT payload_json') && text.includes('conversation_key = $1')) {
      const [conversationKey] = values as [string];
      const record = this.records.get(conversationKey);
      if (!record || record.expiresAt.getTime() <= Date.now()) {
        return queryResult<T>([]);
      }
      return queryResult([{ payload_json: record.payload }] as unknown as T[]);
    }

    if (text.startsWith('SELECT payload_json')) {
      const rows = [...this.records.entries()]
        .filter(([, record]) => record.expiresAt.getTime() > Date.now())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, record]) => ({ payload_json: record.payload }));
      return queryResult(rows as unknown as T[]);
    }

    if (text.startsWith('DELETE FROM') && text.includes('RETURNING conversation_key')) {
      const [now] = values as [Date];
      const removed: Array<{ conversation_key: string }> = [];
      for (const [conversationKey, record] of this.records.entries()) {
        if (record.expiresAt.getTime() <= now.getTime()) {
          this.records.delete(conversationKey);
          removed.push({ conversation_key: conversationKey });
        }
      }
      return queryResult(removed as unknown as T[]);
    }

    if (text.startsWith('DELETE FROM')) {
      const [conversationKey] = values as [string];
      this.records.delete(conversationKey);
      return queryResult<T>([]);
    }

    throw new Error(`unexpected query: ${text}`);
  }

  async end() {
    this.closed = true;
  }
}

function record(conversationKey: string, lastActivityAt = '2026-07-08T00:00:00.000Z'): PersistedConversationState {
  return {
    conversationKey,
    chatType: 'direct',
    targetId: `target-${conversationKey}`,
    remoteSessionId: `session-${conversationKey}`,
    lastActivityAt,
  };
}

describe('PostgresSessionStore', () => {
  it('upserts, reads, lists, deletes, and clears expired records', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T00:00:00.000Z'));

    const client = new FakePostgresClient();
    const store = new PostgresSessionStore('postgres://example', 'qq_ai_bot_sessions', 60_000, console as any, client);

    try {
      await store.load();
      await store.upsert(record('b'));
      await store.upsert(record('a'));

      await expect(store.get('a')).resolves.toMatchObject({ conversationKey: 'a' });
      await expect(store.list()).resolves.toMatchObject([
        { conversationKey: 'a' },
        { conversationKey: 'b' },
      ]);

      await store.delete('a');
      await expect(store.get('a')).resolves.toBeUndefined();

      vi.setSystemTime(new Date('2026-07-08T00:02:00.000Z'));
      await expect(store.clearExpired(Date.now())).resolves.toEqual(['b']);
      await expect(store.list()).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects unsafe table names', () => {
    expect(() => new PostgresSessionStore('postgres://example', 'sessions;drop table users', 60_000, console as any)).toThrow(
      /POSTGRES_TABLE/,
    );
  });
});
