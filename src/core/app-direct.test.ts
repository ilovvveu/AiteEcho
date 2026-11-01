import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMessageTestConfig as loadConfig } from '../test-support/config.js';
import { BotApplication } from './app.js';
import { ACPAgentBridge } from '../agents/acp/bridge.js';
import { DirectApiBridge, DirectApiError } from '../agents/direct/bridge.js';
import { OneBotActionError } from '../channels/onebot/errors.js';

afterEach(() => vi.restoreAllMocks());
describe('direct backend application integration', () => {
  it.each(['ONEBOT_ACTION_TIMEOUT', 'ONEBOT_CONNECTION_CLOSED', 'ONEBOT_SEND_UNCONFIRMED'] as const)(
    'does not replay, send a contradictory notice, or store successful context after uncertain QQ delivery: %s', async code => {
      const dir = await mkdtemp(path.join(tmpdir(), 'qq-send-uncertain-'));
      const c = loadConfig({ AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high', DIRECT_API_BASE_URL: 'https://example.invalid/v1', QQ_CODEX_API_KEY: 'test-only',
        CONTEXT_BOUNDED: 'true', SESSION_FILE_PATH: path.join(dir, 'sessions.json'), ONEBOT_ALLOWED_USERS: '1', ONEBOT_PROGRESS_MODE: 'off' });
      const app = new BotApplication(c, pino({ enabled: false })) as any;
      const direct = vi.spyOn(DirectApiBridge.prototype, 'sendPrompt').mockResolvedValue({ text: 'GOOD', images: [], sessionId: 'direct-stateless', stopReason: 'end_turn' });
      const send = vi.spyOn(app.gateway, 'sendPayload').mockRejectedValue(new OneBotActionError(code, true));
      const errorReply = vi.spyOn(app.gateway, 'sendText');
      await app.handleIncomingPayload({ post_type: 'message', message_type: 'private', user_id: 1, self_id: 999, message_id: 1, message: 'Q' });
      expect(direct).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1); expect(errorReply).not.toHaveBeenCalled();
      expect(app.conversations.getPersisted('direct:1')?.contextTurns ?? []).toHaveLength(0);
      expect(app.getStatus().ai.recent).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 'qq_send', outcome: 'error', code }),
        expect.objectContaining({ stage: 'qq_notice', code: 'DELIVERY_UNCERTAIN_NO_RESEND' }),
        expect.objectContaining({ stage: 'turn_complete', outcome: 'error' }),
      ]));
      expect(app.pendingAcceptedMessages).toBe(0);
    });
  it('never starts ACP, keeps successful context, and never caches error replies', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qq-direct-app-'));
    const c = loadConfig({ AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high', DIRECT_API_BASE_URL: 'https://example.invalid/v1', QQ_CODEX_API_KEY: 'test-only', CONTEXT_BOUNDED: 'true',
      SESSION_FILE_PATH: path.join(dir, 'sessions.json'), ONEBOT_ALLOWED_USERS: '1', ONEBOT_PROGRESS_MODE: 'off', ACP_AGENT_COMMAND: '/nonexistent/codex', DIRECT_API_SEND_HISTORY: 'true' });
    const app = new BotApplication(c, pino({ enabled: false })) as any;
    const acp = vi.spyOn(ACPAgentBridge.prototype, 'sendPrompt');
    const direct = vi.spyOn(DirectApiBridge.prototype, 'sendPrompt').mockResolvedValueOnce({ text: 'GOOD', images: [], sessionId: 'direct-stateless', stopReason: 'end_turn' })
      .mockRejectedValueOnce(new DirectApiError('dns', 'ENOTFOUND'));
    const send = vi.spyOn(app.gateway, 'sendPayload').mockResolvedValue([]);
    const errorReply = vi.spyOn(app.gateway, 'sendText').mockResolvedValue(undefined);
    const event = (i: number) => ({ post_type: 'message', message_type: 'private', user_id: 1, self_id: 999, message_id: i, message: i === 1 ? 'Q1' : '继续解释Q1' });
    await app.handleIncomingPayload(event(1)); await app.handleIncomingPayload(event(2));
    expect(direct).toHaveBeenCalledTimes(2); expect(acp).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledTimes(1);
    expect(errorReply.mock.calls[0]![1]).toContain('诊断编号');
    const state = app.conversations.getPersisted('direct:1'); expect(state.contextTurns).toHaveLength(1); expect(state.contextTurns[0].assistant).toBe('GOOD');
    expect(state.remoteSessionId).toBeUndefined(); expect(state.retiredSessionIds ?? []).toHaveLength(0);
    expect(direct.mock.calls[1]![0].historyContextLines?.join('\n')).toContain('GOOD');
    expect(app.getStatus().config.directApi).toMatchObject({ stream: false, model: 'synthetic-test-model', reasoning: 'high' });
    expect(JSON.stringify(app.getStatus())).not.toContain('test-only'); expect(app.pendingAcceptedMessages).toBe(0);
  });
});
