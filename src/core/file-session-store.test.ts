import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSessionStore } from './file-session-store.js';
import { logger } from '../infra/logger.js';

describe('FileSessionStore', () => {
  it('persists and reloads sessions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qq-ai-bot-'));
    const filePath = path.join(dir, 'sessions.json');
    const store = new FileSessionStore(filePath, 120 * 60 * 1000, logger);

    await store.upsert({
      conversationKey: 'direct:1',
      chatType: 'direct',
      targetId: '1',
      remoteSessionId: 'remote-1',
      lastActivityAt: new Date().toISOString(),
    });

    const reloaded = new FileSessionStore(filePath, 120 * 60 * 1000, logger);
    await reloaded.load();
    expect(await reloaded.get('direct:1')).toMatchObject({
      remoteSessionId: 'remote-1',
      conversationKey: 'direct:1',
    });

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Array<{ conversationKey: string }>;
    expect(raw[0]?.conversationKey).toBe('direct:1');
  });

  it('drops expired sessions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qq-ai-bot-'));
    const filePath = path.join(dir, 'sessions.json');
    const ttlMs = 30_000;
    const store = new FileSessionStore(filePath, ttlMs, logger);

    await store.upsert({
      conversationKey: 'direct:old',
      chatType: 'direct',
      targetId: 'old',
      remoteSessionId: 'remote-old',
      lastActivityAt: new Date(Date.now() - ttlMs - 5_000).toISOString(),
    });
    await store.upsert({
      conversationKey: 'group:123',
      chatType: 'group',
      targetId: '123',
      progressModeOverride: 'off',
      verboseModeOverride: 'normal',
      lastActivityAt: new Date().toISOString(),
    });

    const removed = await store.clearExpired(Date.now());
    expect(removed).toEqual(['direct:old']);
    expect((await store.list()).map((item) => item.conversationKey)).toEqual(['group:123']);
    expect(await store.get('group:123')).toMatchObject({
      progressModeOverride: 'off',
      verboseModeOverride: 'normal',
    });
  });
});
