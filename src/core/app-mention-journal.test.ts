import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { loadMessageTestConfig as loadConfig } from '../test-support/config.js';
import { DirectApiBridge, DirectApiError } from '../agents/direct/bridge.js';
import { BotApplication } from './app.js';
afterEach(() => vi.restoreAllMocks());
it('journals actual gateway text/command/error replies for every real group mention, including limits, but not unrelated chats; reset retains archive', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qq-app-journal-')); const file = path.join(dir, 'journal', 'events.jsonl');
  const c = loadConfig({ AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high', DIRECT_API_BASE_URL: 'https://example.invalid/v1', QQ_CODEX_API_KEY: 'test-only', CONTEXT_BOUNDED: 'true',
    SESSION_FILE_PATH: path.join(dir, 'sessions.json'), ONEBOT_ALLOWED_USERS: '1', ONEBOT_OWNER_USERS: '1', ONEBOT_ALLOWED_GROUPS: '100',
    ONEBOT_PROGRESS_MODE: 'off', BOT_MENTION_JOURNAL_FILE: file });
  c.onebot.groupPolicies['100'] = { id: '100', allowAllMembers: true, replyLimits: { admin: 5, member: 1 } };
  const app = new BotApplication(c, pino({ enabled: false })) as any;
  let sent = 100;
  app.gateway.transport = { sendAction: vi.fn(async (action: string) => action === 'get_group_member_info'
    ? { retcode: 0, data: { group_id: '100', user_id: '2', role: 'member' } }
    : { status: 'ok', retcode: 0, data: { message_id: ++sent } }) };
  const prompt = vi.spyOn(DirectApiBridge.prototype, 'sendPrompt').mockResolvedValueOnce({ text: 'ANSWER_ONE', images: [], sessionId: 'direct-stateless', stopReason: 'end_turn' })
    .mockRejectedValueOnce(new DirectApiError('first_byte', 'FIRST_BYTE_TIMEOUT'));
  const event = (id: number, user: number, text: string, mention = true, group = true) => ({ post_type: 'message', message_type: group ? 'group' : 'private', group_id: 100,
    self_id: 999, user_id: user, message_id: id, time: 1793174700, sender: { nickname: '昵称', card: '群名片' },
    message: [...(mention && group ? [{ type: 'at', data: { qq: '999' } }] : []), { type: 'text', data: { text: ' ' + text } }] });
  await app.handleIncomingPayload(event(1, 2, 'FIRST'));
  await app.handleIncomingPayload(event(1, 2, 'FIRST')); // Duplicate is not an additional question.
  await app.handleIncomingPayload(event(2, 2, 'RATE_LIMITED'));
  await app.handleIncomingPayload(event(3, 1, 'API_FAILURE'));
  await app.handleIncomingPayload(event(4, 1, '/reset'));
  await app.handleIncomingPayload(event(5, 2, 'ORDINARY_NOT_MENTIONED', false));
  const saved = await readFile(file, 'utf8');
  await app.handleIncomingPayload(event(6, 1, '/help', true, false));
  expect(await readFile(file, 'utf8')).toBe(saved);
  const rows = saved.trim().split('\n').map(line => JSON.parse(line));
  expect(rows.filter(row => row.kind === 'question').map(row => row.text)).toEqual(['FIRST', 'RATE_LIMITED', 'API_FAILURE', '/reset']);
  expect(rows.filter(row => row.kind === 'processing_result').map(row => row.result)).toEqual(['finished', 'rate_limited', 'failed', 'finished']);
  expect(rows.filter(row => row.kind === 'reply').every(row => row.delivery === 'acknowledged')).toBe(true);
  expect(saved).toContain('ANSWER_ONE'); expect(saved).toContain('FIRST_BYTE_TIMEOUT'); expect(saved).not.toContain('ORDINARY_NOT_MENTIONED');
  expect(prompt).toHaveBeenCalledTimes(2); expect(app.getStatus().mentionJournal).toMatchObject({ enabled: true, healthy: true, activeRequests: 0, feedsModelContext: false });
  expect(JSON.stringify(app.getStatus())).not.toContain('ANSWER_ONE');
});
