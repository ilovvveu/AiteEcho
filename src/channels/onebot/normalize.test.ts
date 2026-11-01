import { describe, expect, it } from 'vitest';
import { normalizeOneBotEvent } from './normalize.js';

describe('normalizeOneBotEvent', () => {
  it.each(['FIRST-731', '12345', '@alice 请帮忙', '/help'])('preserves question text adjacent to a structured bot mention: %s', text => {
    const event = normalizeOneBotEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 1, self_id: 999,
      message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text } }] });
    expect(event?.cleanedText).toBe(text); expect(event?.explicitMention).toBe(true);
  });
  it('does not strip another member whose number shares the bot prefix or treat literal CQ text as authorization', () => {
    const event = normalizeOneBotEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 1, self_id: 999,
      message: [{ type: 'at', data: { qq: '9999' } }, { type: 'text', data: { text: ' FIRST' } }, { type: 'at', data: { qq: '999' } }] });
    expect(event?.cleanedText).toBe('@9999 FIRST');
    expect(normalizeOneBotEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 1, self_id: 999,
      message: '[CQ:at,qq=999] /help' })?.explicitMention).toBe(false);
  });
  it('normalizes private message events', () => {
    const event = normalizeOneBotEvent({
      post_type: 'message',
      message_type: 'private',
      user_id: 123,
      self_id: 999,
      message_id: 1,
      raw_message: 'hello',
    });

    expect(event).not.toBeNull();
    expect(event?.mode).toBe('direct');
    expect(event?.cleanedText).toBe('hello');
    expect(event?.wasMentioned).toBe(true);
  });

  it('strips explicit mentions in group messages', () => {
    const event = normalizeOneBotEvent({
      post_type: 'message',
      message_type: 'group',
      user_id: 123,
      self_id: 999,
      group_id: 456,
      message_id: 2,
      message: [
        { type: 'at', data: { qq: '999' } },
        { type: 'text', data: { text: ' 帮我总结下这个 PR' } },
      ],
    });

    expect(event).not.toBeNull();
    expect(event?.mode).toBe('group');
    expect(event?.explicitMention).toBe(true);
    expect(event?.cleanedText).toBe('帮我总结下这个 PR');
  });

  it('parses group commands correctly when raw_message contains CQ at syntax', () => {
    const event = normalizeOneBotEvent({
      post_type: 'message',
      message_type: 'group',
      user_id: 123,
      self_id: 999,
      group_id: 456,
      message_id: 3,
      raw_message: '[CQ:at,qq=999] /help',
      message: [
        { type: 'at', data: { qq: '999' } },
        { type: 'text', data: { text: ' /help' } },
      ],
    });

    expect(event).not.toBeNull();
    expect(event?.explicitMention).toBe(true);
    expect(event?.rawText).toBe('[CQ:at,qq=999] /help');
    expect(event?.cleanedText).toBe('/help');
    expect(event?.commandText).toBe('/help');
  });

  it('captures unsupported media segments instead of silently dropping them', () => {
    const event = normalizeOneBotEvent({
      post_type: 'message',
      message_type: 'private',
      user_id: 123,
      self_id: 999,
      message_id: 4,
      message: [
        { type: 'text', data: { text: '帮我总结这个附件' } },
        { type: 'file', data: { name: 'report.pdf', url: 'https://example.com/report.pdf' } },
        { type: 'record', data: { file: 'https://example.com/voice.silk' } },
      ],
    });

    expect(event).not.toBeNull();
    expect(event?.cleanedText).toBe('帮我总结这个附件');
    expect(event?.unsupportedMedia).toEqual([
      {
        kind: 'audio',
        segmentType: 'record',
        name: undefined,
        url: 'https://example.com/voice.silk',
      },
    ]);
    expect(event?.documentReferences).toEqual([
      { name: 'report.pdf', fileId: undefined, url: 'https://example.com/report.pdf', size: undefined },
    ]);
  });

  it('retains NapCat file names, ids and sizes for document reading', () => {
    const event = normalizeOneBotEvent({ post_type: 'message', message_type: 'private', user_id: 123, message: [
      { type: 'file', data: { file: 'report.xlsx', file_id: 'UUID-123', file_size: '1234' } },
    ] });
    expect(event?.documentReferences).toEqual([{ name: 'report.xlsx', fileId: 'UUID-123', size: 1234, url: undefined }]);
    expect(event?.cleanedText).toBe('');
  });

  it('keeps URL and opaque file id image sources while leaving image-only text empty', () => {
    const event = normalizeOneBotEvent({
      post_type: 'message',
      message_type: 'private',
      user_id: 123,
      self_id: 999,
      message_id: 5,
      raw_message: '[CQ:image,file={ABC}.image]',
      message: [
        {
          type: 'image',
          data: {
            url: 'https://multimedia.nt.qq.com.cn/image/1',
            file: '{ABC}.image',
          },
        },
      ],
    });

    expect(event?.imageReferences).toEqual([
      {
        url: 'https://multimedia.nt.qq.com.cn/image/1',
        file: '{ABC}.image',
      },
    ]);
    expect(event?.mediaUrls).toEqual(['https://multimedia.nt.qq.com.cn/image/1']);
    expect(event?.cleanedText).toBe('');
  });
});
