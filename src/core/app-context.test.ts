import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMessageTestConfig as loadConfig } from '../test-support/config.js';
import { ACPAgentBridge } from '../agents/acp/bridge.js';
import { BotApplication } from './app.js';

afterEach(() => vi.restoreAllMocks());
describe('bounded context through the real application lifecycle', () => {
  it('keeps the newest 100 replies locally, caps each prompt, reloads style, and clears on reset', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qq-app-context-'));
    const style = path.join(dir, 'style.txt'); await writeFile(style, '轻松自然');
    const config = loadConfig({ CONTEXT_BOUNDED: 'true', CODEX_HOME: dir, SESSION_FILE_PATH: path.join(dir, 'sessions.json'),
      BOT_REPLY_STYLE_FILE: style, ONEBOT_ALLOWED_USERS: '1', ONEBOT_OWNER_USERS: '1', ONEBOT_PROGRESS_MODE: 'off' });
    const app = new BotApplication(config, pino({ enabled: false })) as any;
    const prompts: any[] = [];
    vi.spyOn(ACPAgentBridge.prototype, 'sendPrompt').mockImplementation(async params => {
      prompts.push(params); await params.onSessionReady?.('11111111-2222-3333-4444-555555555555');
      return { text: `ANSWER_${params.text}`, images: [], sessionId: 'fresh', stopReason: 'end_turn' };
    });
    vi.spyOn(ACPAgentBridge.prototype, 'getSessionId').mockReturnValue('11111111-2222-3333-4444-555555555555');
    vi.spyOn(ACPAgentBridge.prototype, 'stop').mockResolvedValue();
    vi.spyOn(app.gateway, 'sendPayload').mockResolvedValue([]);
    const sendText = vi.spyOn(app.gateway, 'sendText').mockResolvedValue(undefined);
    const event = (i: number, message = `USER_${i}`) => ({ post_type: 'message', message_type: 'private', user_id: 1, self_id: 999, message_id: i + 1, message });
    for (let i = 0; i < 105; i++) await app.handleIncomingPayload(event(i));
    const state = app.conversations.getPersisted('direct:1');
    expect(state.contextTurns).toHaveLength(100);
    expect(state.contextTurns[0].user).toContain('USER_5');
    const last = prompts.at(-1);
    expect(last.freshSession).toBe(true); expect(last.sessionIdHint).toBeUndefined();
    const json = last.contextLines.find((line: string) => line.startsWith('[{"at":'));
    expect(JSON.parse(json)).toHaveLength(12); expect(json.length).toBeLessThan(8000);
    expect(json).not.toContain('USER_1"');
    expect(last.systemPrompt).toContain('轻松自然');
    await writeFile(style, '详细认真一点'); await app.handleIncomingPayload(event(106));
    expect(prompts.at(-1).systemPrompt).toContain('详细认真一点');
    await app.handleIncomingPayload(event(107, '/reset'));
    expect(app.conversations.getPersisted('direct:1')).toBeUndefined();
    expect(sendText).toHaveBeenCalled();
  });
  it('serializes same-chat turns so the next request sees the completed answer', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qq-app-serial-'));
    const config = loadConfig({ CONTEXT_BOUNDED: 'true', CODEX_HOME: dir, SESSION_FILE_PATH: path.join(dir, 'sessions.json'), ONEBOT_ALLOWED_USERS: '1', ONEBOT_PROGRESS_MODE: 'off' });
    const app = new BotApplication(config, pino({ enabled: false })) as any;
    const prompts: any[] = [];
    vi.spyOn(ACPAgentBridge.prototype, 'sendPrompt').mockImplementation(async p => {
      prompts.push(p); await new Promise(resolve => setTimeout(resolve, 5));
      return { text: `DONE_${p.text}`, images: [], sessionId: 'fresh', stopReason: 'end_turn' };
    });
    vi.spyOn(ACPAgentBridge.prototype, 'stop').mockResolvedValue();
    vi.spyOn(app.gateway, 'sendPayload').mockResolvedValue([]);
    await Promise.all([1, 2].map(i => app.handleIncomingPayload({ post_type: 'message', message_type: 'private', user_id: 1, self_id: 999, message_id: i, message: `Q${i}` })));
    expect(prompts[1].contextLines.join('\n')).toContain('DONE_Q1');
    expect(app.pendingAcceptedMessages).toBe(0);
  });
});
