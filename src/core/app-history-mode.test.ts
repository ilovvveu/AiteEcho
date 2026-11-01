import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { loadMessageTestConfig as loadConfig } from '../test-support/config.js';
import { BotApplication } from './app.js';
import { DirectApiBridge } from '../agents/direct/bridge.js';

afterEach(() => vi.restoreAllMocks());
it('defaults to no transmitted history, allows only owner opt-in, persists by chat and restores off on reset', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qq-history-mode-'));
  const c = loadConfig({ AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high', DIRECT_API_BASE_URL: 'https://example.invalid/v1', QQ_CODEX_API_KEY: 'test-only', CONTEXT_BOUNDED: 'true',
    ONEBOT_ALLOWED_USERS: '1', ONEBOT_OWNER_USERS: '1', ONEBOT_ALLOWED_GROUPS: '100', ONEBOT_PROGRESS_MODE: 'off', SESSION_FILE_PATH: path.join(dir, 'sessions.json') });
  c.onebot.groupPolicies['100'] = { id: '100', allowAllMembers: true, requireMention: true, replyLimits: { admin: 5, member: 3 } };
  const app = new BotApplication(c, pino({ enabled: false })) as any;
  const prompt = vi.spyOn(DirectApiBridge.prototype, 'sendPrompt').mockResolvedValue({ text: 'SAVED_ANSWER', images: [], sessionId: 'direct-stateless', stopReason: 'end_turn' });
  vi.spyOn(app.gateway, 'sendPayload').mockResolvedValue([]);
  const text = vi.spyOn(app.gateway, 'sendText').mockResolvedValue(undefined);
  vi.spyOn(app.gateway, 'getGroupMemberRole').mockResolvedValue('admin');
  let id = 0;
  const event = (user: string, value: string, mention = true, group = true) => ({ post_type: 'message', message_type: group ? 'group' : 'private', group_id: group ? '100' : undefined,
    self_id: '999', user_id: user, message_id: String(++id), message: [...(mention && group ? [{ type: 'at', data: { qq: '999' } }] : []), { type: 'text', data: { text: value } }] });
  await app.handleIncomingPayload(event('1', 'FIRST'));
  await app.handleIncomingPayload(event('1', 'SECOND'));
  expect(prompt.mock.calls[1]![0].includeHistory).toBe(false); expect(prompt.mock.calls[1]![0].historyContextLines).toEqual([]);
  expect(app.conversations.getPersisted('group:100').contextTurns).toHaveLength(2);
  await app.handleIncomingPayload(event('2', '/context on'));
  expect(String(text.mock.calls.at(-1)![1])).toContain('主人'); expect(app.conversations.shouldSendHistory('group:100')).toBe(false);
  await app.handleIncomingPayload(event('1', '/context on', false)); expect(app.conversations.shouldSendHistory('group:100')).toBe(false);
  await app.handleIncomingPayload(event('1', '/context on')); expect(prompt).toHaveBeenCalledTimes(2);
  expect(app.conversations.shouldSendHistory('group:100')).toBe(true);
  expect(app.conversations.shouldSendHistory('direct:1')).toBe(false);
  await app.handleIncomingPayload(event('1', '继续刚才的话题'));
  expect(prompt.mock.calls.at(-1)![0].includeHistory).toBe(true); expect(prompt.mock.calls.at(-1)![0].historyContextLines?.join('\n')).toContain('SAVED_ANSWER');
  const reloaded = new BotApplication(c, pino({ enabled: false })) as any; await reloaded.conversations.load();
  expect(reloaded.conversations.shouldSendHistory('group:100')).toBe(true);
  await app.handleIncomingPayload(event('1', '/context off')); expect(app.conversations.shouldSendHistory('group:100')).toBe(false);
  expect(app.conversations.getPersisted('group:100').contextTurns).toHaveLength(3);
  await app.handleIncomingPayload(event('1', '/context on')); await app.handleIncomingPayload(event('1', '/context default'));
  expect(app.conversations.shouldSendHistory('group:100')).toBe(false);
  await app.handleIncomingPayload(event('1', '/context on')); await app.handleIncomingPayload(event('1', '/reset'));
  expect(app.conversations.shouldSendHistory('group:100')).toBe(false);
});
