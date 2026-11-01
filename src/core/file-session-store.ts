import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { PersistedConversationState } from '../types/session.js';
import type { SessionStore } from './session-store.js';

export class FileSessionStore implements SessionStore {
  readonly kind = 'file' as const;
  private readonly records = new Map<string, PersistedConversationState>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly ttlMs: number,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedConversationState[];
      this.records.clear();
      for (const record of parsed) {
        if (!record || typeof record.conversationKey !== 'string') {
          continue;
        }
        this.records.set(record.conversationKey, record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error), filePath: this.filePath },
        'failed to load file session store',
      );
    }
  }

  async get(conversationKey: string): Promise<PersistedConversationState | undefined> {
    return this.records.get(conversationKey);
  }

  async list(): Promise<PersistedConversationState[]> {
    return [...this.records.values()];
  }

  async upsert(record: PersistedConversationState): Promise<void> {
    this.records.set(record.conversationKey, record);
    await this.flush();
  }

  async delete(conversationKey: string): Promise<void> {
    this.records.delete(conversationKey);
    await this.flush();
  }

  async clearExpired(now: number): Promise<string[]> {
    const removed: string[] = [];
    for (const [key, record] of this.records.entries()) {
      const lastActivityAt = Date.parse(record.lastActivityAt);
      if (!Number.isFinite(lastActivityAt)) {
        this.records.delete(key);
        removed.push(key);
        continue;
      }
      if (now - lastActivityAt > this.ttlMs) {
        this.records.delete(key);
        removed.push(key);
      }
    }
    if (removed.length > 0) {
      await this.flush();
    }
    return removed;
  }

  private async flush(): Promise<void> {
    const raw = `${JSON.stringify([...this.records.values()].sort((a, b) => a.conversationKey.localeCompare(b.conversationKey)), null, 2)}\n`;
    const task = this.writes.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temp = `${this.filePath}.tmp`;
      await writeFile(temp, raw, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, this.filePath);
    });
    this.writes = task;
    await task;
  }
}
