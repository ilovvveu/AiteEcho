import type { PersistedConversationState } from '../types/session.js';

export type SessionStoreKind = 'file' | 'redis' | 'postgres';

export interface SessionStore {
  readonly kind: SessionStoreKind;
  load(): Promise<void>;
  get(conversationKey: string): Promise<PersistedConversationState | undefined>;
  list(): Promise<PersistedConversationState[]>;
  upsert(record: PersistedConversationState): Promise<void>;
  delete(conversationKey: string): Promise<void>;
  clearExpired(now: number): Promise<string[]>;
  close?(): Promise<void>;
}
