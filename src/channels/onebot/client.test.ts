import { describe, expect, it, vi } from 'vitest';
import { OneBotGateway } from './client.js';
import { logger } from '../../infra/logger.js';
import { loadMessageTestConfig as loadConfig } from '../../test-support/config.js';
import { normalizeOneBotEvent } from './normalize.js';

function createGateway() {
  const config = loadConfig({
    ONEBOT_MODE: 'forward',
    ONEBOT_FORWARD_WS_URL: 'ws://127.0.0.1:3001/onebot/v11/ws',
    ONEBOT_OUTBOUND_MAX_TEXT_LENGTH: '120',
  });

  return new OneBotGateway(config, logger.child({ test: 'onebot-gateway' }));
}

describe('OneBotGateway message segment building', () => {
  it('resolves only an exact unique group nickname and rejects cross-group member rows', async () => {
    const gateway = createGateway();
    const event = normalizeOneBotEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 123, self_id: 999, message: 'hi' })!;
    const rows = [{ group_id: 100, user_id: 456, card: '张三', nickname: '三' }, { group_id: 200, user_id: 789, card: '张三' }];
    const sendAction = vi.fn(async () => ({ retcode: 0, data: rows }));
    (gateway as any).transport = { sendAction };
    await expect(gateway.resolveGroupHistoryTarget(event, { kind: 'name', value: '张三' })).resolves.toBe('456');
    expect(sendAction).toHaveBeenCalledWith('get_group_member_list', { group_id: '100' }, 3000);
    rows.push({ group_id: 100, user_id: 678, card: '张三' });
    await expect(gateway.resolveGroupHistoryTarget(event, { kind: 'name', value: '张三' })).rejects.toThrow('同名');
    await expect(gateway.resolveGroupHistoryTarget(event, { kind: 'name', value: '张' })).rejects.toThrow('完全匹配');
    await expect(gateway.resolveGroupHistoryTarget({ ...event, mode: 'direct' }, { kind: 'id', value: '456' })).rejects.toThrow('当前群');
  });

  it('requests bounded history from the event group without resolving URLs or forwarded messages', async () => {
    const gateway = createGateway();
    const event = normalizeOneBotEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 123, self_id: 999, message: 'hi' })!;
    const sendAction = vi.fn(async () => ({ retcode: 0, data: { messages: [] } }));
    (gateway as any).transport = { sendAction };
    await expect(gateway.getGroupHistoryPage(event, '-123', 50, 2000)).resolves.toEqual([]);
    expect(sendAction).toHaveBeenCalledWith('get_group_msg_history', { group_id: '100', message_seq: '-123', count: 50, reverse_order: true, disable_get_url: true, parse_mult_msg: false }, 2000);
    await expect(gateway.getGroupHistoryPage(event, 'bad', 50, 2000)).rejects.toThrow();
    await expect(gateway.getGroupHistoryPage(event, undefined, 51, 2000)).rejects.toThrow();
    await expect(gateway.getGroupHistoryPage({ ...event, mode: 'direct' }, undefined, 20, 2000)).rejects.toThrow();
    expect(sendAction).toHaveBeenCalledTimes(1);
  });

  it('requires an authoritative same-chat image segment before streaming a referenced image', async () => {
    const config = loadConfig({ ONEBOT_INBOUND_IMAGE_STREAM: 'true' });
    const gateway = new OneBotGateway(config, logger.child({test:'image-scope'}));
    const event = normalizeOneBotEvent({post_type:'message',message_type:'group',group_id:100,user_id:123,self_id:999,message_id:5,message:[{type:'reply',data:{id:'4'}},{type:'text',data:{text:'分析图片'}}]})!;
    let group = 100;let rawTextOnly = false;
    const sendAction = vi.fn(async (_action, params) => ({retcode:0,data:{message_id:params.message_id,message_type:'group',group_id:group,user_id:123,time:1,message:params.message_id==='4'&&!rawTextOnly?[{type:'image',data:{file:'trusted.image'}}]:[{type:'text',data:{text:'[CQ:image,file=trusted.image]'}}]}}));
    const readImageStream = vi.fn(async ()=>'aW1hZ2U=');(gateway as any).transport={sendAction,readImageStream};
    await expect(gateway.resolveInboundImageFile('trusted.image',event)).resolves.toBe('base64://aW1hZ2U=');
    expect(readImageStream).toHaveBeenCalledWith('trusted.image',config.ai.maxInboundImageBytes);
    group=200;readImageStream.mockClear();await expect(gateway.resolveInboundImageFile('trusted.image',event)).rejects.toThrow('不属于');expect(readImageStream).not.toHaveBeenCalled();
    group=100;rawTextOnly=true;await expect(gateway.resolveInboundImageFile('trusted.image',event)).rejects.toThrow('不属于');
    await expect(gateway.resolveInboundImageFile('/private/file.png',event)).rejects.toThrow('标识');
  });
  it('checks queried group/user ids and ignores unverified role values', async () => {
    const gateway = createGateway();
    const sendAction = vi.fn(async () => ({ status: 'ok', retcode: 0, data: { group_id: '100', user_id: '2', role: 'admin' } }));
    (gateway as any).transport = { sendAction };
    await expect(gateway.getGroupMemberRole('100', '2')).resolves.toBe('admin');
    expect(sendAction).toHaveBeenCalledWith('get_group_member_info', { group_id: '100', user_id: '2', no_cache: true });
    await expect(gateway.getGroupMemberRole('100', '3')).rejects.toThrow();
  });
  it('resolves opaque inbound image ids through OneBot get_image', async () => {
    const gateway = createGateway();
    const sendAction = vi.fn(async () => ({
      status: 'ok',
      retcode: 0,
      data: { url: 'https://multimedia.nt.qq.com.cn/image/1' },
    }));
    (gateway as unknown as { transport: { sendAction: typeof sendAction } }).transport = {
      sendAction,
    };

    await expect(gateway.resolveInboundImageFile('{ABC}.image')).resolves.toBe(
      'https://multimedia.nt.qq.com.cn/image/1',
    );
    expect(sendAction).toHaveBeenCalledWith('get_image', { file: '{ABC}.image' });
  });

  it('builds base64 image segments for outbound agent images', () => {
    const gateway = createGateway();
    const segments = (gateway as unknown as {
      buildMessageSegments: (params: {
        text?: string;
        image?: { kind: 'base64' | 'url'; value: string; mimeType?: string };
        replyToId?: string;
      }) => string | Array<Record<string, unknown>>;
    }).buildMessageSegments({
      replyToId: '123',
      image: {
        kind: 'base64',
        value: 'ZmFrZS1wbmc=',
        mimeType: 'image/png',
      },
    });

    expect(segments).toEqual([
      { type: 'reply', data: { id: '123' } },
      { type: 'image', data: { file: 'base64://ZmFrZS1wbmc=' } },
    ]);
  });

  it('returns plain text when only text is present and no reply is needed', () => {
    const gateway = createGateway();
    const message = (gateway as unknown as {
      buildMessageSegments: (params: {
        text?: string;
        image?: { kind: 'base64' | 'url'; value: string; mimeType?: string };
        replyToId?: string;
      }) => string | Array<Record<string, unknown>>;
    }).buildMessageSegments({
      text: '你好',
    });

    expect(message).toBe('你好');
  });

  it('keeps correlation id and purpose on outbound context without affecting segment shape', async () => {
    const gateway = createGateway();
    const calls: Array<{ context: Record<string, unknown>; text: string }> = [];

    const fakeGateway = gateway as unknown as {
      sendConversationMessage: (params: Record<string, unknown>) => Promise<string | undefined>;
    };
    fakeGateway.sendConversationMessage = async (params) => {
      calls.push({
        context: params,
        text: '',
      });
      return '42';
    };

    await gateway.sendText(
      {
        chatType: 'group',
        targetId: '123',
        replyToId: '1',
        correlationId: 'ob11-g-123-1',
        purpose: 'progress',
      },
      '处理中',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.context.chatType).toBe('group');
    expect(calls[0]?.context.targetId).toBe('123');
    expect(calls[0]?.context.replyToId).toBe('1');
  });
});
