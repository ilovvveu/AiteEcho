import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config/index.js';
import { logger } from '../infra/logger.js';
import type { PersistedConversationState } from '../types/session.js';
import type { SessionStore } from './session-store.js';
import { ConversationManager } from './conversation-manager.js';

class MemorySessionStore implements SessionStore {
  readonly kind = 'file' as const;
  private readonly records = new Map<string, PersistedConversationState>();

  async load(): Promise<void> {}

  async get(conversationKey: string): Promise<PersistedConversationState | undefined> {
    return this.records.get(conversationKey);
  }

  async list(): Promise<PersistedConversationState[]> {
    return [...this.records.values()];
  }

  async upsert(record: PersistedConversationState): Promise<void> {
    this.records.set(record.conversationKey, record);
  }

  async delete(conversationKey: string): Promise<void> {
    this.records.delete(conversationKey);
  }

  async clearExpired(): Promise<string[]> {
    return [];
  }
}

describe('ConversationManager', () => {
  it('still closes the agent if session-file registration cannot be persisted', async () => {
    const config = loadConfig({ CONTEXT_BOUNDED: 'true' }); const store = new MemorySessionStore();
    const manager = new ConversationManager(config, logger, store); await manager.load();
    const runtime = manager.getOrCreate({ conversationKey: 'direct:1', chatType: 'direct', targetId: '1' });
    await manager.prepareContext(runtime);
    vi.spyOn(runtime.bridge, 'getSessionId').mockReturnValue('11111111-2222-3333-4444-555555555555');
    const stop = vi.spyOn(runtime.bridge, 'stop').mockResolvedValue();
    vi.spyOn(store, 'upsert').mockRejectedValue(new Error('disk unavailable'));
    await expect(manager.releaseContext(runtime)).rejects.toThrow('disk unavailable');
    expect(stop).toHaveBeenCalledOnce(); expect(runtime.busy).toBe(false);
  });
  it('retains bounded text across restart without resuming old remote context or clearing quiet overrides', async () => {
    const config = loadConfig({ CONTEXT_BOUNDED: 'true' });
    const store = new MemorySessionStore();
    await store.upsert({ conversationKey: 'group:100', chatType: 'group', targetId: '100', remoteSessionId: 'legacy', progressModeOverride: 'off', verboseModeOverride: 'normal', lastActivityAt: new Date().toISOString(), contextTurns: [{ at: Date.now(), user: 'LAST_USER', assistant: 'LAST_ANSWER' }] });
    const manager = new ConversationManager(config, logger, store); await manager.load();
    const runtime = manager.getOrCreate({ conversationKey: 'group:100', chatType: 'group', targetId: '100' });
    expect((await manager.prepareContext(runtime)).join('\n')).toContain('LAST_ANSWER');
    expect(manager.getPersisted('group:100')?.remoteSessionId).toBeUndefined();
    await manager.recordContext(runtime, 'NEW_USER', 'NEW_ANSWER');
    vi.spyOn(runtime.bridge, 'stop').mockResolvedValue();
    await manager.releaseContext(runtime);
    const reloaded = new ConversationManager(config, logger, store); await reloaded.load();
    expect(reloaded.getPersisted('group:100')).toMatchObject({ progressModeOverride: 'off', verboseModeOverride: 'normal', contextTurns: [{ user: 'LAST_USER' }, { user: 'NEW_USER' }] });
    await reloaded.reset('group:100'); expect(reloaded.getPersisted('group:100')).toBeUndefined();
  });
  it('prunes age limits before prompts and periodic cleanup skips an active turn', async () => {
    const config = loadConfig({ CONTEXT_BOUNDED: 'true' }); const store = new MemorySessionStore();
    const manager = new ConversationManager(config, logger, store); await manager.load();
    const runtime = manager.getOrCreate({ conversationKey: 'direct:1', chatType: 'direct', targetId: '1' });
    await manager.prepareContext(runtime); await manager.recordContext(runtime, 'KEEP', 'ANSWER');
    const record = manager.getPersisted('direct:1')!;
    record.lastActivityAt = new Date(0).toISOString();
    await manager.cleanupExpired(); expect(manager.getPersisted('direct:1')?.contextTurns).toHaveLength(1);
    await manager.releaseContext(runtime); await manager.cleanupExpired();
    expect(manager.getPersisted('direct:1')?.contextTurns).toEqual([]);
  });
  it('preserves quiet-mode overrides when runtime state is persisted', async () => {
    const store = new MemorySessionStore();
    const manager = new ConversationManager(loadConfig({}), logger, store);
    await manager.load();

    await manager.patchPersisted('group:100', {
      chatType: 'group',
      targetId: '100',
      progressModeOverride: 'off',
      verboseModeOverride: 'normal',
    });

    const runtime = manager.getOrCreate({
      conversationKey: 'group:100',
      chatType: 'group',
      targetId: '100',
    });
    await manager.persistRuntime(runtime);

    expect(await store.get('group:100')).toMatchObject({
      progressModeOverride: 'off',
      verboseModeOverride: 'normal',
    });
  });
});
