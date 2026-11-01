import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { loadMessageTestConfig as loadConfig } from '../test-support/config.js';
import { BotApplication } from './app.js';

function setup(enabled = true) {
  const config = loadConfig({ ONEBOT_ALLOWED_GROUPS: '100', ONEBOT_ALLOWED_USERS: '1', ONEBOT_OWNER_USERS: '1', ONEBOT_PROGRESS_MODE: 'off', ONEBOT_READ_GROUP_HISTORY: String(enabled) });
  config.onebot.groupPolicies['100'] = { id: '100', requireMention: true, allowAllMembers: true, replyLimits: { admin: 5, member: 2 } };
  const app = new BotApplication(config, pino({ enabled: false })) as any;
  const sendPrompt = vi.fn(async () => ({ text: '样本分析完成', images: [], sessionId: 'test-history', stopReason: 'end_turn' }));
  const getOrCreate = vi.fn(() => ({ bridge: { sendPrompt }, lastActivityAt: Date.now() }));
  app.conversations = { getPersisted: () => undefined, getOrCreate, persistRuntime: vi.fn() };
  const sendPayload = vi.spyOn(app.gateway, 'sendPayload').mockResolvedValue([]);
  const sendText = vi.spyOn(app.gateway, 'sendText').mockResolvedValue(undefined);
  let rows: unknown[] = [
    { message_id: '90', message_seq: '90', message_type: 'group', group_id: 100, user_id: 456, time: Math.floor(Date.now() / 1000) - 60, message: [{ type: 'text', data: { text: 'TARGET_FACT_90' } }] },
    { message_id: '91', message_seq: '91', message_type: 'group', group_id: 100, user_id: 789, time: Math.floor(Date.now() / 1000) - 30, message: [{ type: 'text', data: { text: 'UNRELATED_PERSON' } }] },
  ];
  const sendAction = vi.fn(async (action: string, params: Record<string, unknown>) => {
    if (action === 'get_group_member_info') return { retcode: 0, data: { group_id: params.group_id, user_id: params.user_id, role: 'member' } };
    if (action === 'get_group_msg_history') return { retcode: 0, data: { messages: rows } };
    if (action === 'get_group_member_list') return { retcode: 0, data: [
      { group_id: 100, user_id: 456, card: '张三' }, { group_id: 100, user_id: 789, card: '张三' },
    ] };
    if (action === 'get_msg') return { retcode: 0, data: { message_id: params.message_id, message_type: 'group', group_id: 100, user_id: 456, message: [{ type: 'text', data: { text: 'QUOTED_TEXT_IS_NOT_THE_HISTORY_SAMPLE' } }] } };
    throw new Error('unexpected action');
  });
  app.gateway.transport = { sendAction };
  let id = 0;
  const event = (text = '分析 456 最近20条发言', user = '1', mention = true, group = '100') => ({
    post_type: 'message', message_type: 'group', group_id: group, user_id: user, self_id: '999', message_id: String(++id), time: Math.floor(Date.now() / 1000),
    message: [...(mention ? [{ type: 'at', data: { qq: '999' } }] : []), { type: 'text', data: { text } }],
  });
  return { app, event, sendPrompt, getOrCreate, sendPayload, sendText, sendAction, setRows: (next: unknown[]) => { rows = next; } };
}

describe('group history at the real application entry point', () => {
  it('fetches only the current group, sends one bounded target sample and reports actual coverage', async () => {
    const h = setup();
    await h.app.handleIncomingPayload(h.event());
    expect(h.sendPrompt).toHaveBeenCalledTimes(1);
    const prompt = (h.sendPrompt.mock.calls as unknown[][])[0]![0] as { contextLines: string[]; images: unknown[] };
    const context = prompt.contextLines.join('\n');
    expect(context).toContain('TARGET_FACT_90');
    expect(context).not.toContain('UNRELATED_PERSON');
    expect(prompt.images).toEqual([]);
    expect(h.sendPayload).toHaveBeenCalledTimes(1);
    expect((h.sendPayload.mock.calls[0]![1] as { text: string }).text).toContain('1/20');
    expect(h.sendText).not.toHaveBeenCalled();
    expect(h.sendAction.mock.calls.filter(([action]) => action === 'get_group_msg_history').every(([, params]) => params.group_id === '100')).toBe(true);
  });

  it('handles slash commands and actual target mentions without unknown-command replies', async () => {
    const h = setup();
    const event = h.event();
    event.message = [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: '/history ' } }, { type: 'at', data: { qq: '456' } }, { type: 'text', data: { text: ' 20 总结观点' } }];
    await h.app.handleIncomingPayload(event);
    expect(h.sendPrompt).toHaveBeenCalledTimes(1);
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('enforces group, mention and member quotas before reading history', async () => {
    const h = setup();
    await h.app.handleIncomingPayload(h.event(undefined, '4', false));
    await h.app.handleIncomingPayload(h.event(undefined, '4', true, '200'));
    expect(h.sendAction).not.toHaveBeenCalled();
    for (let n = 0; n < 3; n++) await h.app.handleIncomingPayload(h.event(undefined, '4'));
    expect(h.sendPrompt).toHaveBeenCalledTimes(2);
  });

  it('resolves a vague quoted request to its proven group sender and reports the interpreted range', async () => {
    const h = setup();
    const event = h.event('分析刚刚发言的内容');
    event.message.unshift({ type: 'reply', data: { id: '80' } } as any);
    await h.app.handleIncomingPayload(event);
    expect(h.sendPrompt).toHaveBeenCalledTimes(1);
    const context = ((h.sendPrompt.mock.calls as unknown[][])[0]![0] as { contextLines: string[] }).contextLines.join('\n');
    expect(context).toContain('TARGET_FACT_90');
    expect(context).not.toContain('QUOTED_TEXT_IS_NOT_THE_HISTORY_SAMPLE');
    const reply = (h.sendPayload.mock.calls[0]![1] as { text: string }).text;
    expect(reply).toContain('10分钟');
    expect(reply).toContain('QQ 456');
    expect(reply).toContain('1/10');
  });

  it('keeps a history analysis to one result even if ordinary progress messages are enabled', async () => {
    const h = setup();
    h.app.config.onebot.progressMode = 'message';
    await h.app.handleIncomingPayload(h.event('分析 456 最近几条消息'));
    expect(h.sendPrompt).toHaveBeenCalledTimes(1);
    expect(h.sendText).not.toHaveBeenCalled();
    expect(h.sendPayload).toHaveBeenCalledTimes(1);
    expect((h.sendPayload.mock.calls[0]![1] as { text: string }).text).toContain('1/5');
  });

  it('does not invoke the model for zero samples, disabled feature, invalid scope or ambiguous names', async () => {
    const empty = setup(); empty.setRows([]);
    await empty.app.handleIncomingPayload(empty.event());
    expect(empty.sendPrompt).not.toHaveBeenCalled();
    expect(empty.sendText.mock.calls[0]![1]).toContain('0/20');
    const disabled = setup(false);
    await disabled.app.handleIncomingPayload(disabled.event());
    expect(disabled.sendAction).not.toHaveBeenCalled();
    expect(disabled.sendPrompt).not.toHaveBeenCalled();
    const names = setup();
    await names.app.handleIncomingPayload(names.event('读取张三的最近内容并分析'));
    expect(names.sendText.mock.calls[0]![1]).toContain('同名');
    expect(names.sendPrompt).not.toHaveBeenCalled();
    expect(names.sendAction.mock.calls.some(([action]) => action === 'get_group_msg_history')).toBe(false);
    const direct = setup();
    await direct.app.handleIncomingPayload({ ...direct.event('/history 456 20'), message_type: 'private' });
    expect(direct.sendAction).not.toHaveBeenCalled();
    expect(direct.sendPrompt).not.toHaveBeenCalled();
  });
});
