import { describe, expect, it } from 'vitest';
import { planOutboundPayload, splitLongText } from './outbound.js';

describe('planOutboundPayload', () => {
  it('extracts markdown image urls', () => {
    const plan = planOutboundPayload({
      text: '你好\n\n![img](https://example.com/a.png)',
      maxTextLength: 200,
    });

    expect(plan.cleanedText).toBe('你好');
    expect(plan.imageUrls).toEqual(['https://example.com/a.png']);
    expect(plan.actions).toHaveLength(2);
    expect(plan.actions[0]).toEqual({ kind: 'text', text: '你好' });
    expect(plan.actions[1]).toEqual({
      kind: 'image',
      image: { kind: 'url', value: 'https://example.com/a.png' },
    });
  });

  it('extracts local markdown image references', () => {
    const plan = planOutboundPayload({
      text: '图好了：![rank](file:///tmp/qq-ai-bot/rank.png)',
      maxTextLength: 200,
    });

    expect(plan.cleanedText).toBe('图好了：');
    expect(plan.actions).toEqual([
      { kind: 'text', text: '图好了：' },
      {
        kind: 'image',
        image: {
          kind: 'file',
          value: '/tmp/qq-ai-bot/rank.png',
        },
      },
    ]);
  });

  it('keeps agent generated base64 images and deduplicates url images', () => {
    const plan = planOutboundPayload({
      text: '这是结果\n\n![img](https://example.com/a.png)',
      mediaUrls: ['https://example.com/a.png'],
      mediaImages: [
        { kind: 'base64', value: 'ZmFrZS1pbWFnZQ==', mimeType: 'image/png' },
        { kind: 'url', value: 'https://example.com/a.png' },
      ],
      maxTextLength: 200,
    });

    expect(plan.cleanedText).toBe('这是结果');
    expect(plan.imageUrls).toEqual(['https://example.com/a.png']);
    expect(plan.actions).toEqual([
      { kind: 'text', text: '这是结果' },
      {
        kind: 'image',
        image: {
          kind: 'base64',
          value: 'ZmFrZS1pbWFnZQ==',
          mimeType: 'image/png',
        },
      },
      {
        kind: 'image',
        image: { kind: 'url', value: 'https://example.com/a.png' },
      },
    ]);
  });

  it('does not create empty text actions for image-only replies', () => {
    const plan = planOutboundPayload({
      text: '',
      mediaImages: [{ kind: 'base64', value: 'ZmFrZQ==', mimeType: 'image/png' }],
      maxTextLength: 200,
    });

    expect(plan.actions).toEqual([
      {
        kind: 'image',
        image: { kind: 'base64', value: 'ZmFrZQ==', mimeType: 'image/png' },
      },
    ]);
  });

  it('splits long text by boundaries', () => {
    const chunks = splitLongText('a '.repeat(200), 60);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 60)).toBe(true);
  });
});
