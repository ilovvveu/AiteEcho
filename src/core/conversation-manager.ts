import type { Logger } from 'pino';
import type { AppConfig } from '../config/index.js';
import { ACPAgentBridge } from '../agents/acp/bridge.js';
import { DirectApiBridge } from '../agents/direct/bridge.js';
import { Diagnostics } from '../infra/diagnostics.js';
import { isTransportErrorText } from './transport-error.js';
import type { PersistedConversationState, RuntimeConversationMeta } from '../types/session.js';
import type { SessionStore } from './session-store.js';
import { contextPrompt, pruneContext } from './bounded-context.js';
import type { ContextSelection } from './context-selection.js';
import type { ContextTurn } from '../types/session.js';
import { removeOwnedSessionFiles } from './context-session-files.js';

interface ConversationRuntime extends RuntimeConversationMeta {
  bridge: Pick<ACPAgentBridge, 'sendPrompt' | 'stop' | 'getSessionId'>;
  lastActivityAt: number;
  busy?: boolean;
}

export class ConversationManager {
  private readonly runtimes = new Map<string, ConversationRuntime>();
  private readonly persistedRecords = new Map<string, PersistedConversationState>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly store: SessionStore,
    private readonly hooks?: {
      onAcpPromptStarted?: () => void;
      onAcpPromptFailed?: () => void;
    },
    private readonly diagnostics = new Diagnostics(),
  ) {}

  async load(): Promise<void> {
    await this.store.load();
    const records = await this.store.list();
    this.persistedRecords.clear();
    for (const record of records) {
      this.persistedRecords.set(record.conversationKey, record);
    }
    if (this.config.context.enabled) await this.cleanupExpired();
  }

  listPersisted(): PersistedConversationState[] {
    return [...this.persistedRecords.values()].sort((a, b) => a.conversationKey.localeCompare(b.conversationKey));
  }

  listActive(): Array<{
    conversationKey: string;
    lastActivityAt: string;
    remoteSessionId?: string;
  }> {
    return [...this.runtimes.values()].map((runtime) => ({
      conversationKey: runtime.conversationKey,
      lastActivityAt: new Date(runtime.lastActivityAt).toISOString(),
      remoteSessionId: runtime.bridge.getSessionId(),
    }));
  }

  getPersisted(conversationKey: string): PersistedConversationState | undefined {
    return this.persistedRecords.get(conversationKey);
  }

  shouldSendHistory(conversationKey: string): boolean {
    if (this.config.ai.backend !== 'direct') return true;
    const override = this.persistedRecords.get(conversationKey)?.sendHistoryOverride;
    return typeof override === 'boolean' ? override : this.config.ai.direct.sendHistory;
  }

  getOrCreate(meta: RuntimeConversationMeta): ConversationRuntime {
    const existing = this.runtimes.get(meta.conversationKey);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }

    const runtime: ConversationRuntime = {
      ...meta,
      bridge: this.config.ai.backend === 'direct' ? new DirectApiBridge(this.config, this.diagnostics, {
        onPromptStarted: () => this.hooks?.onAcpPromptStarted?.(),
        onPromptFailed: () => this.hooks?.onAcpPromptFailed?.(),
      }) : new ACPAgentBridge(
        this.config,
        this.logger.child({ conversationKey: meta.conversationKey }),
        {
          onPromptStarted: () => this.hooks?.onAcpPromptStarted?.(),
          onPromptFailed: () => this.hooks?.onAcpPromptFailed?.(),
        },
      ),
      lastActivityAt: Date.now(),
    };
    this.runtimes.set(meta.conversationKey, runtime);
    return runtime;
  }

  async touch(meta: RuntimeConversationMeta): Promise<void> {
    const runtime = this.getOrCreate(meta);
    runtime.lastActivityAt = Date.now();
    await this.persistRuntime(runtime);
  }

  async persistRuntime(runtime: ConversationRuntime): Promise<void> {
    const current = this.persistedRecords.get(runtime.conversationKey);
    const record: PersistedConversationState = {
      conversationKey: runtime.conversationKey,
      chatType: runtime.chatType,
      targetId: runtime.targetId,
      remoteSessionId: this.config.ai.backend === 'acp' && this.config.ai.reuseSession
        ? (runtime.bridge.getSessionId() ?? current?.remoteSessionId)
        : undefined,
      progressModeOverride: current?.progressModeOverride,
      verboseModeOverride: current?.verboseModeOverride,
      sendHistoryOverride: current?.sendHistoryOverride,
      lastActivityAt: new Date(runtime.lastActivityAt).toISOString(),
      ...(current?.contextTurns ? { contextTurns: current.contextTurns } : {}),
      ...(current?.retiredSessionIds ? { retiredSessionIds: current.retiredSessionIds } : {}),
    };
    await this.store.upsert(record);
    this.persistedRecords.set(record.conversationKey, record);
  }

  async patchPersisted(
    conversationKey: string,
    patch: Partial<PersistedConversationState> & Pick<PersistedConversationState, 'chatType' | 'targetId'>,
  ): Promise<PersistedConversationState> {
    const current = await this.store.get(conversationKey);
    const next: PersistedConversationState = {
      conversationKey,
      chatType: patch.chatType ?? current?.chatType ?? 'direct',
      targetId: patch.targetId ?? current?.targetId ?? '',
      remoteSessionId: patch.remoteSessionId ?? current?.remoteSessionId,
      progressModeOverride: patch.progressModeOverride ?? current?.progressModeOverride,
      verboseModeOverride: patch.verboseModeOverride ?? current?.verboseModeOverride,
      sendHistoryOverride: Object.hasOwn(patch, 'sendHistoryOverride') ? patch.sendHistoryOverride : current?.sendHistoryOverride,
      lastActivityAt: patch.lastActivityAt ?? current?.lastActivityAt ?? new Date().toISOString(),
      ...(current?.contextTurns ? { contextTurns: current.contextTurns } : {}),
      ...(current?.retiredSessionIds ? { retiredSessionIds: current.retiredSessionIds } : {}),
    };
    await this.store.upsert(next);
    this.persistedRecords.set(next.conversationKey, next);
    return next;
  }

  async reset(conversationKey: string): Promise<void> {
    const runtime = this.runtimes.get(conversationKey);
    if (runtime) {
      if (this.config.context.enabled) await this.releaseContext(runtime);
      else await runtime.bridge.stop();
      this.runtimes.delete(conversationKey);
    }
    if (this.config.context.enabled) {
      await this.cleanRetired(conversationKey);
      const pending = this.persistedRecords.get(conversationKey)?.retiredSessionIds;
      if (pending?.length) {
        const current = this.persistedRecords.get(conversationKey)!;
        const next = { ...current, contextTurns: [], remoteSessionId: undefined, progressModeOverride: undefined, verboseModeOverride: undefined, sendHistoryOverride: undefined };
        await this.store.upsert(next); this.persistedRecords.set(conversationKey, next); return;
      }
    }
    await this.store.delete(conversationKey);
    this.persistedRecords.delete(conversationKey);
  }

  async cleanupExpired(): Promise<string[]> {
    if (this.config.context.enabled) return this.cleanupBounded();
    const now = Date.now();
    const expiredKeys = await this.store.clearExpired(now);
    for (const key of expiredKeys) {
      this.persistedRecords.delete(key);
    }

    for (const [key, runtime] of this.runtimes.entries()) {
      if (now - runtime.lastActivityAt <= this.config.storage.sessionTtlMs) {
        continue;
      }
      await runtime.bridge.stop();
      this.runtimes.delete(key);
      if (!expiredKeys.includes(key)) {
        expiredKeys.push(key);
      }
    }

    if (expiredKeys.length > 0) {
      this.logger.info({ expiredKeys }, 'cleaned expired conversations');
    }
    return expiredKeys;
  }

  async prepareContext(runtime: ConversationRuntime, selection?: ContextSelection): Promise<string[]> {
    runtime.busy = true;
    const current = this.persistedRecords.get(runtime.conversationKey);
    const turns = pruneContext(current?.contextTurns, this.config.context);
    if (this.config.ai.backend === 'acp' && (current?.retiredSessionIds?.length ?? 0) >= 100) throw new Error('会话文件清理积压，请联系机器人主人检查本机文件权限');
    if (current) {
      const next = { ...current, remoteSessionId: undefined, contextTurns: turns };
      await this.store.upsert(next);
      this.persistedRecords.set(next.conversationKey, next);
    }
    return this.shouldSendHistory(runtime.conversationKey) ? contextPrompt(turns, this.config.context, Date.now(), selection) : [];
  }

  async registerContextSession(runtime: ConversationRuntime, id: string): Promise<void> {
    const current = this.persistedRecords.get(runtime.conversationKey);
    const next: PersistedConversationState = {
      ...current, conversationKey: runtime.conversationKey, chatType: runtime.chatType, targetId: runtime.targetId,
      lastActivityAt: new Date().toISOString(), remoteSessionId: undefined,
      retiredSessionIds: [...new Set([...(current?.retiredSessionIds ?? []), id])],
    };
    await this.store.upsert(next);
    this.persistedRecords.set(next.conversationKey, next);
  }

  async recordContext(runtime: ConversationRuntime, user: string, assistant: string, metadata: Partial<ContextTurn> = {}): Promise<void> {
    if (isTransportErrorText(assistant)) throw new Error('Transport errors cannot be stored as answers');
    const current = this.persistedRecords.get(runtime.conversationKey);
    const next: PersistedConversationState = {
      ...current, conversationKey: runtime.conversationKey, chatType: runtime.chatType, targetId: runtime.targetId,
      lastActivityAt: new Date().toISOString(), remoteSessionId: undefined,
      contextTurns: pruneContext([...(current?.contextTurns ?? []), { ...metadata, at: Date.now(), user, assistant }], this.config.context),
    };
    await this.store.upsert(next);
    this.persistedRecords.set(next.conversationKey, next);
  }

  async releaseContext(runtime: ConversationRuntime): Promise<void> {
    const id = runtime.bridge.getSessionId();
    let registered = !id;
    try {
      // Register before closing: a crash or failed unlink is retried by the janitor.
      if (id) {
        const current = this.persistedRecords.get(runtime.conversationKey);
        const next: PersistedConversationState = {
          ...current, conversationKey: runtime.conversationKey, chatType: runtime.chatType, targetId: runtime.targetId,
          lastActivityAt: current?.lastActivityAt ?? new Date().toISOString(), remoteSessionId: undefined,
          retiredSessionIds: [...new Set([...(current?.retiredSessionIds ?? []), id])],
        };
        await this.store.upsert(next);
        this.persistedRecords.set(next.conversationKey, next);
        registered = true;
      }
    } finally {
      try {
        await runtime.bridge.stop();
        if (!registered && id) await removeOwnedSessionFiles(this.config.context.codexHome, id);
      } finally { runtime.busy = false; }
    }
    await this.cleanRetired(runtime.conversationKey);
  }

  private async cleanRetired(key: string): Promise<void> {
    if (this.config.ai.backend === 'direct') return; // Never touch or require a Codex installation in direct mode.
    const current = this.persistedRecords.get(key);
    if (!current?.retiredSessionIds?.length) return;
    const pending: string[] = [];
    for (const id of current.retiredSessionIds) {
      if (!await removeOwnedSessionFiles(this.config.context.codexHome, id)) pending.push(id);
    }
    const next = { ...current, retiredSessionIds: pending };
    await this.store.upsert(next);
    this.persistedRecords.set(key, next);
  }

  private async cleanupBounded(): Promise<string[]> {
    const removed: string[] = [];
    const now = Date.now();
    for (const [key, current] of this.persistedRecords) {
      const runtime = this.runtimes.get(key);
      if (runtime?.busy) continue;
      const turns = pruneContext(current.contextTurns, this.config.context, now);
      const removedCount = (current.contextTurns?.length ?? 0) - turns.length;
      if (removedCount) this.diagnostics.record('context_cleanup', 'ok', { count: removedCount });
      const expired = !Number.isFinite(Date.parse(current.lastActivityAt))
        || now - Date.parse(current.lastActivityAt) > this.config.storage.sessionTtlMs;
      if (expired && runtime) { await runtime.bridge.stop(); this.runtimes.delete(key); }
      const next = { ...current, remoteSessionId: undefined, contextTurns: expired ? [] : turns };
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        await this.store.upsert(next); this.persistedRecords.set(key, next); removed.push(key);
      }
      await this.cleanRetired(key);
    }
    return removed;
  }

  async stopAll(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await runtime.bridge.stop();
    }
    this.runtimes.clear();
    await this.store.close?.();
  }
}
