import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { loadMessageTestConfig as loadConfig } from '../test-support/config.js';
import { BotApplication } from './app.js';

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'qq-public-group-'));
  const file = path.join(dir, 'rules.json');
  await writeFile(file, JSON.stringify({ groups: { '100': { enabled: true, requireMention: true, allowAllMembers: true, replyLimits: { admin: 5, member: 1 } } } }));
  const config = loadConfig({ ONEBOT_GROUP_CONFIG_FILE: file, ONEBOT_ALLOWED_GROUPS: '100', ONEBOT_ALLOWED_USERS: '1', ONEBOT_OWNER_USERS: '1', ONEBOT_PROGRESS_MODE: 'off' });
  const app = new BotApplication(config, pino({ enabled: false })) as any;
  const sendPrompt = vi.fn<(p: Record<string, unknown>) => Promise<Record<string, unknown>>>(async () => ({ text: 'OK', images: [], sessionId: 'test', stopReason: 'end_turn' }));
  const reset = vi.fn();
  const runtime = { bridge: { sendPrompt }, lastActivityAt: Date.now() };
  app.conversations = { getPersisted: () => undefined, getOrCreate: () => runtime, persistRuntime: vi.fn(), reset };
  const sendText = vi.spyOn(app.gateway, 'sendText').mockResolvedValue(undefined);
  vi.spyOn(app.gateway, 'sendPayload').mockResolvedValue([]);
  const actions = vi.fn(async (_a, p) => ({ status: 'ok', retcode: 0, data: { group_id: p.group_id, user_id: p.user_id, role: p.user_id === '2' ? 'admin' : p.user_id === '3' ? 'owner' : 'member' } }));
  app.gateway.transport = { sendAction: actions };
  let id = 0;
  const message = (user: string, text = '你好', mention = true, group = '100') => ({ post_type: 'message', message_type: 'group', group_id: group, user_id: user, self_id: '999', message_id: String(++id), message: [...(mention ? [{ type: 'at', data: { qq: '999' } }] : []), { type: 'text', data: { text } }] });
  return { app, file, sendPrompt, sendText, actions, reset, message, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('public group policy at the real message entry point', () => {
  it('enforces owner/admin/member quotas before AI, keeping private and other groups closed', async () => {
    const h = await setup();
    try {
      for (let n = 0; n < 7; n++) await h.app.handleIncomingPayload(h.message('1'));
      for (let n = 0; n < 7; n++) await h.app.handleIncomingPayload(h.message('2'));
      for (let n = 0; n < 7; n++) await h.app.handleIncomingPayload(h.message('3'));
      for (let n = 0; n < 3; n++) await h.app.handleIncomingPayload(h.message('4'));
      expect(h.sendPrompt).toHaveBeenCalledTimes(18);
      const calls = h.actions.mock.calls.length;
      await h.app.handleIncomingPayload(h.message('5', '/search hello', false));
      await h.app.handleIncomingPayload(h.message('6', 'hello', true, '200'));
      await h.app.handleIncomingPayload({ post_type: 'message', message_type: 'private', user_id: '4', self_id: '999', message_id: '900', message: 'hello' });
      expect(h.sendPrompt).toHaveBeenCalledTimes(18);
      expect(h.actions).toHaveBeenCalledTimes(calls);
    } finally { await h.cleanup(); }
  });
  it('limits commands as well and keeps shared controls and internal status owner-only', async () => {
    const h = await setup();
    try {
      await h.app.handleIncomingPayload(h.message('2', '/reset'));
      expect(h.reset).not.toHaveBeenCalled();
      expect(h.sendText.mock.calls[0]?.[1]).toContain('主人');
      await h.app.handleIncomingPayload(h.message('4', '/status'));
      const publicStatus = String(h.sendText.mock.calls[1]?.[1]);
      expect(publicStatus).toContain('每60秒 1 次');
      expect(publicStatus).not.toContain('Session');
      await h.app.handleIncomingPayload(h.message('4', '/ping'));
      expect(h.sendText).toHaveBeenCalledTimes(2);
    } finally { await h.cleanup(); }
  });
  it('allows only the self to mark, persist, inspect and clear individual overrides', async () => {
    const h = await setup();
    try {
      await h.app.handleIncomingPayload(h.message('2', '/member 4 unlimited'));
      expect(JSON.parse(await readFile(h.file, 'utf8')).groups['100'].memberRules).toBeUndefined();
      await h.app.handleIncomingPayload(h.message('1', '/member 4 limit 2'));
      await h.app.handleIncomingPayload(h.message('1', '/member 4 label 朋友'));
      const saved = JSON.parse(await readFile(h.file, 'utf8')).groups['100'].memberRules['4'];
      expect(saved.limitPerMinute).toBe(2);
      expect(saved.label).toBe('朋友');
      for (let n = 0; n < 3; n++) await h.app.handleIncomingPayload(h.message('4'));
      expect(h.sendPrompt).toHaveBeenCalledTimes(2);
      await h.app.handleIncomingPayload(h.message('1', '/member 4 clear'));
      expect(JSON.parse(await readFile(h.file, 'utf8')).groups['100'].memberRules['4']).toBeUndefined();
      expect(h.reset).not.toHaveBeenCalled();
    } finally { await h.cleanup(); }
  });
});
