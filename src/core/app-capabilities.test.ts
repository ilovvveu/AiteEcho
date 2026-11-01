import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotApplication } from './app.js';
import { loadMessageTestConfig as loadConfig } from '../test-support/config.js';
import { documentTestPython as python, textPythonAvailable } from '../test-support/python.js';

vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '8.8.8.8', family: 4 }] }));

function harness() {
  const config = loadConfig({
    ONEBOT_ALLOWED_USERS: '123', ONEBOT_ALLOWED_GROUPS: '100', ONEBOT_REQUIRE_MENTION_IN_GROUP: 'true',
    ONEBOT_RESOLVE_REPLIES: 'true', ONEBOT_PROGRESS_MODE: 'off', ACP_WEB_SEARCH: 'true',
    ACP_READ_DOCUMENTS: 'true', ACP_DOCUMENT_PYTHON_COMMAND: python,
  });
  const app = new BotApplication(config, pino({ enabled: false })) as any;
  const sendPrompt = vi.fn<(params: Record<string, unknown>) => Promise<Record<string, unknown>>>(async () => ({ text: 'ANSWER_OK', images: [], sessionId: 'fake-session', stopReason: 'end_turn' }));
  const runtime = { bridge: { sendPrompt }, lastActivityAt: Date.now() };
  app.conversations = { getPersisted: () => undefined, getOrCreate: () => runtime, persistRuntime: vi.fn() };
  const sendPayload = vi.spyOn(app.gateway, 'sendPayload').mockResolvedValue([]);
  const sendText = vi.spyOn(app.gateway, 'sendText').mockResolvedValue(undefined);
  const sendAction = vi.fn();
  app.gateway.transport = { sendAction };
  return { app, sendPrompt, sendPayload, sendText, sendAction };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('QQ capabilities through the application route (no real QQ transport)', () => {
  it.each(['private', 'group'])('keeps the %s help menu free of donation commands and links', async (mode) => {
    const h = harness();
    await h.app.handleIncomingPayload({
      post_type: 'message', message_type: mode, user_id: 123, self_id: 999, group_id: 100, message_id: 10,
      message: [...(mode === 'group' ? [{ type: 'at', data: { qq: '999' } }] : []), { type: 'text', data: { text: '/help' } }],
    });
    expect(h.sendText).toHaveBeenCalledTimes(1);
    const menu = String(h.sendText.mock.calls[0]![1]);
    for (const command of ['help', 'status', 'search', 'style', '语音', 'ping']) expect(menu).toContain(`/${command}`);
    expect(menu).not.toMatch(/donat|支持作者|捐赠|打赏|咖啡|https?:\/\//iu);
    expect(h.sendPrompt).not.toHaveBeenCalled();
    expect(h.sendPayload).not.toHaveBeenCalled();
    expect(h.sendAction).not.toHaveBeenCalled();
  });
  it.each(['private', 'group'])('treats the retired %s donation command as unknown without calling the model', async (mode) => {
    const h = harness();
    await h.app.handleIncomingPayload({
      post_type: 'message', message_type: mode, user_id: 123, self_id: 999, group_id: 100, message_id: 11,
      message: [...(mode === 'group' ? [{ type: 'at', data: { qq: '999' } }] : []), { type: 'text', data: { text: '/donate' } }],
    });
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.sendText.mock.calls[0]![1]).toBe('未知命令：/donate。发送 /help 查看帮助。');
    expect(h.sendText.mock.calls[0]![1]).not.toMatch(/支持作者|感谢支持|捐赠|打赏|咖啡|https?:\/\//iu);
    expect(h.sendPrompt).not.toHaveBeenCalled();
    expect(h.sendPayload).not.toHaveBeenCalled();
    expect(h.sendAction).not.toHaveBeenCalled();
  });
  it.runIf(textPythonAvailable)('expands a quoted text/image/document and feeds real parsed text to the agent', async () => {
    const h = harness();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    h.sendAction.mockImplementation(async (action: string) => action === 'get_private_file_url'
      ? { status: 'ok', data: { url: 'https://gchat.qpic.cn/doc.txt' } }
      : { status: 'ok', retcode: 0, data: { message_id: 4, message_type: 'private', user_id: 123, message: [
        { type: 'text', data: { text: '引用正文 QUOTE-731' } },
        { type: 'file', data: { file: 'notes.txt', file_id: 'file-id', file_size: 30 } },
        { type: 'image', data: { file: `base64://${png}` } },
      ] } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('附件内容 DOC-731')));
    await h.app.handleIncomingPayload({ post_type: 'message', message_type: 'private', user_id: 123, self_id: 999, message_id: 5, message: [
      { type: 'reply', data: { id: '4' } }, { type: 'text', data: { text: '分析引用的附件' } },
    ] });
    expect(h.sendPrompt).toHaveBeenCalledTimes(1);
    const prompt = h.sendPrompt.mock.calls[0]![0] as any;
    expect(prompt.text).toBe('分析引用的附件');
    expect(prompt.contextLines.join('\n')).toContain('QUOTE-731');
    expect(prompt.contextLines.join('\n')).toContain('DOC-731');
    expect(prompt.images).toHaveLength(1);
    expect(prompt.unsupportedMedia).toEqual([]);
    expect(h.sendPayload).toHaveBeenCalledTimes(1);
    expect(h.sendText).not.toHaveBeenCalled();
  });
  it('rejects disallowed senders and groups without @ before any get_msg/file/network action', async () => {
    const h = harness();
    await h.app.handleIncomingPayload({ post_type: 'message', message_type: 'private', user_id: 456, self_id: 999, message_id: 5, message: [{ type: 'reply', data: { id: '4' } }] });
    await h.app.handleIncomingPayload({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 123, self_id: 999, message_id: 6, message: [{ type: 'reply', data: { id: '4' } }, { type: 'text', data: { text: '/search Python' } }] });
    expect(h.sendAction).not.toHaveBeenCalled();
    expect(h.sendPrompt).not.toHaveBeenCalled();
  });
  it('routes /search to an actual agent prompt with source and privacy instructions', async () => {
    const h = harness();
    await h.app.handleIncomingPayload({ post_type: 'message', message_type: 'private', user_id: 123, self_id: 999, message_id: 8, message: '/search Python 官方文档' });
    const prompt = h.sendPrompt.mock.calls[0]![0] as any;
    expect(prompt.text).toContain('实际调用联网搜索');
    expect(prompt.contextLines.join('\n')).toContain('默认不显示来源链接');
    expect(prompt.replyRules.allowSourceLinks).toBe(false);
    expect(prompt.text).not.toContain('附真实来源');
    expect(h.sendPayload).toHaveBeenCalledTimes(1);
  });
});
