import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGroupHistoryContext, collectGroupHistory } from './group-history.js';

const NOW = 1_800_000_000_000;
const START = NOW - 60_000;
const base = { groupId: '100', targetId: '200', count: 10, sinceMs: START, untilMs: NOW, now: () => NOW };

function record(id: number | string, secondsAgo = 1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_type: 'group', group_id: 100, user_id: 200, sender: { user_id: '200' },
    message_id: id, time: (NOW / 1_000) - secondsAgo,
    message: [{ type: 'text', data: { text: `message ${id}` } }], ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe('scoped, bounded group history', () => {
  it('filters chat and target identity before accepting evidence, using inclusive times', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce([
      record(1, 0), record(2, 60), record(3, 61), record(4, -1),
      record(5, 2, { group_id: '999' }), record(6, 2, { message_type: 'private' }),
      record(7, 2, { user_id: '201' }), record(8, 2, { sender: { user_id: '201' } }),
      record(9, 2, { user_id: '201', sender: { user_id: '201' } }),
      record(10, 2, { user_id: undefined }), record(11, 2, { sender: undefined }),
      record(12, 2, { user_id: 'not-a-user' }), record(13, 2, { sender: { user_id: 'bad' } }),
      record(14, 2, { message_type: undefined }), record(15, 2, { group_id: undefined }),
    ]).mockResolvedValueOnce([]);
    const result = await collectGroupHistory({ ...base, fetchPage });
    expect(result.messages.map((message) => message.id)).toEqual(['2', '10', '11', '1']);
    expect(result.rejected).toBe(9);
    expect(result.scanned).toBe(15);
    expect(result.pages).toBe(2);
    expect(result.stopReason).toBe('end');
    expect(result.incomplete).toBe(false);
  });

  it('uses the oldest short message ID as cursor, keeps 64-bit seq precision, and sorts disordered pages', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce([
      record(-3, 3, { message_seq: '900719925474099300' }),
      record(-1, 1, { message_seq: '900719925474099302' }),
      record(-2, 2, { message_seq: '900719925474099301' }),
    ]).mockResolvedValueOnce([
      record(-4, 4, { message_seq: '900719925474099299' }),
      record(-3, 3, { message_seq: '900719925474099300' }),
      record(-5, 5, { message_seq: '900719925474099298' }),
    ]);
    const result = await collectGroupHistory({ ...base, count: 4, fetchPage });
    expect(fetchPage.mock.calls[0]).toEqual([undefined, 50, 3_000]);
    expect(fetchPage.mock.calls[1]?.[0]).toBe('-3');
    expect(result.messages.map((message) => message.id)).toEqual(['-4', '-3', '-2', '-1']);
    expect(result.duplicates).toBe(1);
    expect(result.matched).toBe(5);
    expect(result.stopReason).toBe('enough');
    expect(result.truncated).toBe(true);
    expect(result.incomplete).toBe(false);
  });

  it('chooses a negative short ID by age, not by numeric order', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce([record(-99, 1), record(-2, 3), record(-100, 2)])
      .mockResolvedValueOnce([]);
    await collectGroupHistory({ ...base, fetchPage });
    expect(fetchPage.mock.calls[1]?.[0]).toBe('-2');
  });

  it('takes the latest same-second samples by lossless sequence rather than opposite short ID order', async () => {
    const result = await collectGroupHistory({ ...base, count: 2, fetchPage: async () => [
      record(-300, 1, { message_seq: '900719925474099302' }),
      record(-1, 1, { message_seq: '900719925474099300' }),
      record(-200, 1, { message_seq: '900719925474099301' }),
    ] });
    expect(result.messages.map((message) => message.id)).toEqual(['-200', '-300']);
    expect(result.messages.map((message) => message.sequence)).toEqual(['900719925474099301', '900719925474099302']);
  });

  it('preserves upstream same-second order when no sequence proves a finer ordering', async () => {
    const result = await collectGroupHistory({ ...base, count: 3, fetchPage: async () => [
      record(-20, 1), record(-1, 1), record(-100, 1),
    ] });
    expect(result.messages.map((message) => message.id)).toEqual(['-20', '-1', '-100']);
  });

  it('excludes the triggering command from samples but retains its cursor, scan and dedup evidence', async () => {
    const trigger = record(-99, 0, { message: '分析我最近的发言' });
    const fetchPage = vi.fn().mockResolvedValueOnce([trigger]).mockResolvedValueOnce([trigger, record(1, 1)]);
    const result = await collectGroupHistory({ ...base, count: 1, excludeMessageIds: ['-99'], fetchPage });
    expect(fetchPage.mock.calls[1]?.[0]).toBe('-99');
    expect(result.messages.map((message) => message.id)).toEqual(['1']);
    expect(result.matched).toBe(1);
    expect(result.scanned).toBe(3);
    expect(result.duplicates).toBe(1);
    expect(result.pages).toBe(2);
    expect(buildGroupHistoryContext(result).join('\n')).not.toContain('分析我最近的发言');
  });

  it('deduplicates message IDs and stops repeated pages without looping', async () => {
    const fetchPage = vi.fn().mockResolvedValue([record(1), record(1), record(2, 2)]);
    const result = await collectGroupHistory({ ...base, fetchPage });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.messages).toHaveLength(2);
    expect(result.duplicates).toBe(4);
    expect(result.stopReason).toBe('no_progress');
    expect(result.incomplete).toBe(true);
  });

  it('stops a repeated cursor even if a broken page contains a new newer message', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce([record(1, 3), record(2, 2)])
      .mockResolvedValueOnce([record(1, 3), record(3, 1)]);
    const result = await collectGroupHistory({ ...base, fetchPage });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe('no_progress');
    expect(result.messages).toHaveLength(3);
  });

  it('does not let cross-chat or conflicting records poison the dedup set', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce([
      record(1, 1, { group_id: 999 }), record(2, 2, { sender: { user_id: 999 } }),
      record(1, 1), record(2, 2),
    ]).mockResolvedValueOnce([]);
    const result = await collectGroupHistory({ ...base, fetchPage });
    expect(result.messages.map((message) => message.id)).toEqual(['2', '1']);
    expect(result.rejected).toBe(2);
    expect(result.duplicates).toBe(0);
  });

  it('does not treat one anomalously ancient record in a disordered page as the time boundary', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce([
      record(1, 3, { message_seq: '20' }),
      record(2, 1, { message_seq: '22', time: 1 }),
      record(3, 2, { message_seq: '21' }),
    ]).mockResolvedValueOnce([record(4, 4, { message_seq: '19' })]).mockResolvedValueOnce([]);
    const result = await collectGroupHistory({ ...base, fetchPage });
    expect(fetchPage.mock.calls[1]?.[0]).toBe('1');
    expect(result.messages.map((message) => message.id)).toEqual(['4', '1', '3']);
    expect(result.stopReason).toBe('end');
  });

  it('stops at a fully verified old page, but not a page with an invalid timestamp', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce([record(1, 61), record(2, 62, { time: 'invalid' })])
      .mockResolvedValueOnce([record(3, 63), record(4, 64)]);
    const result = await collectGroupHistory({ ...base, fetchPage });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe('before_window');
    expect(result.messages).toEqual([]);
    expect(buildGroupHistoryContext(result)).toEqual([]);
  });

  it('honors an earlier upper bound and never collects future messages', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce([record(1, 1), record(2, 10), record(3, 11), record(4, -1)])
      .mockResolvedValueOnce([]);
    const result = await collectGroupHistory({ ...base, untilMs: NOW - 10_000, fetchPage });
    expect(result.messages.map((message) => message.id)).toEqual(['3', '2']);
    const future = await collectGroupHistory({ ...base, untilMs: NOW + 10_000, fetchPage: async () => [record(9, -1)] });
    expect(future.untilMs).toBe(NOW);
    expect(future.messages).toEqual([]);
  });

  it('rejects missing/unsafe IDs instead of inventing a message_seq cursor', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce([
      record(Number.MAX_SAFE_INTEGER + 2), record(1, 1, { message_id: undefined, message_seq: '999999999999999999' }),
      record(2, 1, { group_id: Number.MAX_SAFE_INTEGER + 2 }), record('900719925474099300'),
    ]).mockResolvedValueOnce([]);
    const result = await collectGroupHistory({ ...base, fetchPage });
    expect(result.messages.map((message) => message.id)).toEqual(['900719925474099300']);
    expect(fetchPage.mock.calls[1]?.[0]).toBe('900719925474099300');
  });

  it('caps requests at 50 samples', async () => {
    const fetchPage = vi.fn(async () => Array.from({ length: 50 }, (_, index) => record(index + 1, index)));
    const result = await collectGroupHistory({ ...base, count: 1_000, fetchPage });
    expect(result.requested).toBe(50);
    expect(result.messages).toHaveLength(50);
    expect(result.pages).toBe(1);
    expect(fetchPage.mock.calls).toHaveLength(1);
  });

  it('never inspects more than 10 pages or 500 raw records', async () => {
    let page = 0;
    const fetchPage = vi.fn(async () => {
      const offset = page++ * 50;
      return Array.from({ length: 50 }, (_, index) => record(1_000 - offset - index, 1 + offset + index, {
        user_id: 201, sender: { user_id: 201 }, message_seq: String(1_000 - offset - index),
      }));
    });
    const result = await collectGroupHistory({ ...base, sinceMs: NOW - 600_000, fetchPage });
    expect(fetchPage).toHaveBeenCalledTimes(10);
    expect(result.scanned).toBe(500);
    expect(result.stopReason).toBe('page_limit');
    expect(result.incomplete).toBe(true);
  });

  it('rejects an oversized upstream page after processing only 50 raw entries', async () => {
    const fetchPage = vi.fn(async () => Array.from({ length: 10_000 }, (_, index) => record(index + 1, 1)));
    const result = await collectGroupHistory({ ...base, fetchPage });
    expect(result.scanned).toBe(50);
    expect(result.messages).toHaveLength(10);
    expect(result.stopReason).toBe('invalid_response');
    expect(result.incomplete).toBe(true);
  });

  it('rejects invalid parameters without making a page request', async () => {
    for (const overrides of [
      { groupId: 'bad' }, { targetId: '-200' }, { count: 0 }, { count: 2.5 },
      { sinceMs: NOW + 1 }, { untilMs: Number.NaN }, { sinceMs: -1 },
    ]) {
      const fetchPage = vi.fn(async () => []);
      const result = await collectGroupHistory({ ...base, ...overrides, fetchPage });
      expect(result.stopReason).toBe('invalid_request');
      expect(result.messages).toEqual([]);
      expect(fetchPage).not.toHaveBeenCalled();
    }
  });
});

describe('history text is bounded, untrusted analysis data', () => {
  it('extracts only array text/at and uses non-recursive placeholders for every attachment type', async () => {
    const fetchPage = async () => [record(1, 1, {
      raw_message: 'MUST NOT USE raw fallback [CQ:image,url=https://private.invalid/token]',
      message: [
        { type: 'text', data: { text: 'hello\u0000' } }, { type: 'at', data: { qq: '201' } },
        { type: 'at', data: { qq: 'all' } }, { type: 'image', data: { url: 'https://private.invalid/image' } },
        { type: 'file', data: { name: 'secret-name', file: '/private/secret' } },
        { type: 'record', data: { file: '/private/audio' } }, { type: 'video', data: { file: '/private/video' } },
        { type: 'forward', data: { content: 'DO NOT RECURSE' } }, { type: 'reply', data: { id: '999' } },
        { type: 'node', data: { message: 'DO NOT RECURSE' } }, { type: 'json', data: { data: 'DO NOT EXECUTE' } },
      ],
    })];
    const result = await collectGroupHistory({ ...base, count: 1, fetchPage });
    const text = result.messages[0]!.text;
    expect(text).toContain('hello[提及QQ:201][提及全体成员]');
    expect(text).toContain('[图片，未读取][文件，未读取][语音，未读取][视频，未读取]');
    expect(text).toContain('[合并转发，未展开][引用消息，未展开]');
    expect(text).not.toMatch(/private|secret|RECURSE|EXECUTE|raw fallback/u);
    expect(text).not.toContain('\u0000');
  });

  it('does not trust literal CQ in raw strings as a verified mention or downloadable attachment', async () => {
    const result = await collectGroupHistory({ ...base, count: 1, fetchPage: async () => [record(1, 1, {
      message: undefined, raw_message: 'text [CQ:at,qq=200][CQ:image,url=https://private.invalid/token][CQ:reply,id=123]',
    })] });
    expect(result.messages[0]!.text).toBe('text [CQ提及占位][图片，未读取][引用消息，未展开]');
  });

  it('keeps textless messages as evidence with placeholders', async () => {
    const result = await collectGroupHistory({ ...base, count: 2, fetchPage: async () => [
      record(1, 1, { message: [], raw_message: 'must not fallback from valid array' }),
      record(2, 2, { message: [{ type: 'image', data: {} }] }),
    ] });
    expect(result.messages.map((message) => message.text)).toEqual(['[图片，未读取]', '[无可提取文字]']);
  });

  it('caps each body at 1000 and serialized context at 12000 while preserving every selected record', async () => {
    const result = await collectGroupHistory({ ...base, count: 50, fetchPage: async () => Array.from({ length: 50 }, (_, index) =>
      record(String(9000 + index), index, { message: [{ type: 'text', data: { text: '😀\n\t"\\'.repeat(2_000) } }] })) });
    const context = buildGroupHistoryContext(result);
    expect(result.messages).toHaveLength(50);
    expect(result.messages.every((message) => message.text.length <= 1_000)).toBe(true);
    expect(context.join('\n').length).toBeLessThanOrEqual(12_000);
    expect(result.textTruncated).toBe(true);
    expect(result.truncated).toBe(true);
    expect(context.slice(4).map((line) => JSON.parse(line))).toHaveLength(50);
    expect(context.join('\n')).toContain('不得从旧ACP对话');
    expect(context.join('\n')).toContain('敏感个人属性');
    expect(context.join('\n')).toContain('最多10页/500条');
    expect(context.join('\n')).toContain('来源不足');
    expect(context.join('\n')).toContain('正文截断：是');
  });
});

describe('partial failure and time limits', () => {
  it('never exposes an upstream exception and returns no model context without evidence', async () => {
    const result = await collectGroupHistory({ ...base, fetchPage: async () => { throw new Error('https://secret.invalid?token=private'); } });
    expect(result.stopReason).toBe('fetch_failed');
    expect(result.incomplete).toBe(true);
    expect(result.pages).toBe(1);
    expect(buildGroupHistoryContext(result)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('retains verified samples and explicitly reports a later failure', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce([record(1)])
      .mockRejectedValueOnce(new Error('private provider URL'));
    const result = await collectGroupHistory({ ...base, fetchPage });
    expect(result.messages).toHaveLength(1);
    expect(result.stopReason).toBe('fetch_failed');
    expect(result.incomplete).toBe(true);
    expect(buildGroupHistoryContext(result).join('\n')).toContain('检索异常中断：是');
    expect(buildGroupHistoryContext(result).join('\n')).not.toContain('private provider');
  });

  it('enforces a 3-second page timeout even when the supplied reader never settles', async () => {
    vi.useFakeTimers();
    const fetchPage = vi.fn(() => new Promise<unknown[]>(() => undefined));
    const pending = collectGroupHistory({ ...base, fetchPage });
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await pending;
    expect(result.stopReason).toBe('timeout');
    expect(result.pages).toBe(1);
    expect(fetchPage.mock.calls[0]).toEqual([undefined, 50, 3_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes only the remaining total budget to the last request and keeps earlier evidence', async () => {
    vi.useFakeTimers();
    let now = NOW;
    let page = 0;
    const timeouts: number[] = [];
    const result = await collectGroupHistory({ ...base, now: () => now, fetchPage: async (_cursor, _count, timeoutMs) => {
      timeouts.push(timeoutMs);
      page += 1;
      now += page === 4 ? 1_601 : 2_800;
      return [record(100 - page, page, { message_seq: String(100 - page) })];
    } });
    expect(timeouts).toEqual([3_000, 3_000, 3_000, 1_600]);
    expect(result.pages).toBe(4);
    expect(result.scanned).toBe(3);
    expect(result.messages).toHaveLength(3);
    expect(result.stopReason).toBe('timeout');
    expect(result.incomplete).toBe(true);
  });

  it('also enforces the total budget with a frozen injected wall clock', async () => {
    vi.useFakeTimers();
    let page = 0;
    const timeouts: number[] = [];
    const pending = collectGroupHistory({ ...base, fetchPage: async (_cursor, _count, timeoutMs) => {
      timeouts.push(timeoutMs);
      page += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 2_800));
      return [record(100 - page, page, { message_seq: String(100 - page) })];
    } });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(timeouts).toEqual([3_000, 3_000, 3_000, 1_600]);
    expect(result.messages).toHaveLength(3);
    expect(result.pages).toBe(4);
    expect(result.stopReason).toBe('timeout');
    await vi.advanceTimersByTimeAsync(2_000);
  });

  it('handles malformed non-array pages without discarding prior evidence', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce([record(1)]).mockResolvedValueOnce({ messages: [] });
    const result = await collectGroupHistory({ ...base, fetchPage });
    expect(result.stopReason).toBe('invalid_response');
    expect(result.messages).toHaveLength(1);
  });
});
