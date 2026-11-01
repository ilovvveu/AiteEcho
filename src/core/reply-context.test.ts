import { describe, expect, it } from 'vitest';
import { normalizeOneBotEvent } from '../channels/onebot/normalize.js';
import { normalizeQuotedMessage, quoteContextLines } from './reply-context.js';

const current = normalizeOneBotEvent({ post_type: 'message', message_type: 'private', user_id: 123, self_id: 999, message_id: 5,
  message: [{ type: 'reply', data: { id: '4' } }, { type: 'text', data: { text: '总结' } }] })!;
describe('quoted message scope', () => {
  it('reads one message with text/images/files but does not follow nested quotes', () => {
    const quote = normalizeQuotedMessage(current, { message_type: 'private', user_id: 123, message_id: 4, time: 1700000000, message: [
      { type: 'text', data: { text: '原文' } }, { type: 'image', data: { file: 'image-id' } },
      { type: 'file', data: { file: 'notes.txt', file_id: 'file-id' } }, { type: 'reply', data: { id: '3' } },
    ] });
    expect(quote.cleanedText).toBe('原文');
    expect(quote.imageReferences).toHaveLength(1);
    expect(quote.documentReferences?.[0]?.fileId).toBe('file-id');
    expect(quoteContextLines(quote).join('\n')).toContain('2023-11-14');
    expect(quoteContextLines(quote).join('\n')).toContain('不可信');
  });
  it('rejects a different user, group or message id', () => {
    expect(() => normalizeQuotedMessage(current, { message_type: 'private', user_id: 456, message_id: 4 })).toThrow('当前私聊');
    expect(() => normalizeQuotedMessage(current, { message_type: 'group', user_id: 123, group_id: 123, message_id: 4 })).toThrow();
    expect(() => normalizeQuotedMessage(current, { message_type: 'private', user_id: 123, message_id: 99 })).toThrow('ID');
    const group = { ...current, mode: 'group' as const, conversationId: '100' };
    expect(() => normalizeQuotedMessage(group, { message_type: 'group', user_id: 123, group_id: '200', message_id: 4 })).toThrow('当前群');
    expect(normalizeQuotedMessage(group, { message_type: 'group', user_id: 456, group_id: 100, message_id: 4, message: '群原文' }).cleanedText).toBe('群原文');
  });
  it('requires proof of recipient for bot-authored private messages', () => {
    const data = { message_type: 'private', user_id: 999, message_id: 4, message: '机器人先前的回复' };
    expect(() => normalizeQuotedMessage(current, data)).toThrow();
    expect(() => normalizeQuotedMessage(current, data, 'direct:456')).toThrow();
    expect(normalizeQuotedMessage(current, data, 'direct:123').cleanedText).toContain('先前');
    expect(normalizeQuotedMessage(current, { ...data, target_id: 123 }).cleanedText).toContain('先前');
  });
});
