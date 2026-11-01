import { describe, expect, it } from 'vitest';
import { normalizeOneBotEvent } from '../channels/onebot/normalize.js';
import type { NormalizedOneBotEvent } from '../types/onebot.js';
import { parseHistoryQuery, type HistoryQuery } from './history-query.js';

const NOW = Date.parse('2026-10-22T04:30:00.000Z'); // Beijing 12:30
const DAY = 86_400_000;

function event(text: string, overrides: Partial<NormalizedOneBotEvent> = {}): NormalizedOneBotEvent {
  return {
    id: '100:1', mode: 'group', conversationId: '100', replyTarget: '100',
    senderId: '456', selfId: '999', rawText: text, cleanedText: text, commandText: text,
    mediaUrls: [], unsupportedMedia: [], mentionedUserIds: ['999'], wasMentioned: true,
    explicitMention: true, isSelfMessage: false, raw: {}, ...overrides,
  };
}

function query(text: string, overrides: Partial<NormalizedOneBotEvent> = {}, now = NOW): HistoryQuery {
  const result = parseHistoryQuery(event(text, overrides), { now });
  expect(result.kind, JSON.stringify(result)).toBe('query');
  if (result.kind !== 'query') throw new Error('Expected query');
  return result.query;
}

function expectError(text: string, pattern: RegExp, overrides: Partial<NormalizedOneBotEvent> = {}): void {
  const result = parseHistoryQuery(event(text, overrides), { now: NOW });
  expect(result.kind, JSON.stringify(result)).toBe('error');
  if (result.kind === 'error') expect(result.message).toMatch(pattern);
}

describe('parseHistoryQuery: commands and natural requests', () => {
  it('defaults to 20 messages within the last 7 days and preserves the instruction', () => {
    expect(query('/history 123')).toEqual({
      target: { kind: 'id', value: '123' }, count: 20, sinceMs: NOW - 7 * DAY,
      untilMs: NOW, rangeLabel: '最近7天', task: '/history 123',
    });
  });

  it.each([
    ['/history @123 50', 50, 7 * DAY],
    ['/history 123 24h 分析其态度', 20, DAY],
    ['/history 123 7d', 20, 7 * DAY],
    ['/history 123 最近50条 最近168小时', 50, 7 * DAY],
    ['/history 123 最近五十条 最近七天', 50, 7 * DAY],
    ['/history 123 最近1条 最近1小时', 1, 3_600_000],
  ])('parses command options: %s', (text, count, duration) => {
    const result = query(text);
    expect(result.count).toBe(count);
    expect(result.sinceMs).toBe(NOW - duration);
    expect(result.untilMs).toBe(NOW);
  });

  it('honors a custom command prefix without regex interpretation', () => {
    const result = parseHistoryQuery(event('.*history 123 20'), { now: NOW, commandPrefix: '.*' });
    expect(result.kind).toBe('query');
    expect(parseHistoryQuery(event('/history 123'), { now: NOW, commandPrefix: '!' })).toEqual({ kind: 'none' });
  });

  it.each([
    ['分析 @123 最近20条发言', { kind: 'id', value: '123' }],
    ['总结 QQ号123 今天在本群说了什么', { kind: 'id', value: '123' }],
    ['读取张三的最近内容并分析', { kind: 'name', value: '张三' }],
    ['请帮我总结张三最近7天的20条消息', { kind: 'name', value: '张三' }],
    ['分析我最近的发言', { kind: 'id', value: '456' }],
    ['我最近20条发言，帮我分析', { kind: 'id', value: '456' }],
    ['我最近20条发言，帮我分析一下说话风格', { kind: 'id', value: '456' }],
    ['本人今天在本群说了什么，请总结一下', { kind: 'id', value: '456' }],
    ['读取本群张三的历史消息并分析', { kind: 'name', value: '张三' }],
  ])('extracts an exact target: %s', (text, target) => {
    expect(query(text).target).toEqual(target);
  });

  it('uses a real non-bot mention and deduplicates repeated mentions', () => {
    const result = query('分析 @123 最近20条发言', { mentionedUserIds: ['999', '123', '123'] });
    expect(result.target).toEqual({ kind: 'id', value: '123' });
  });

  it('parses normalized segment mentions rather than raw CQ text or quoted message contents', () => {
    const normalized = normalizeOneBotEvent({
      post_type: 'message', message_type: 'group', group_id: '100', user_id: '456', self_id: '999',
      raw_message: '[CQ:reply,id=77] [CQ:at,qq=999] 分析 [CQ:at,qq=123] 最近20条发言',
      message: [
        { type: 'reply', data: { id: '77' } }, { type: 'at', data: { qq: '999' } },
        { type: 'text', data: { text: ' 分析 ' } }, { type: 'at', data: { qq: '123' } },
        { type: 'text', data: { text: ' 最近20条发言' } },
      ],
    });
    expect(normalized).not.toBeNull();
    const result = parseHistoryQuery(normalized!, { now: NOW });
    expect(result.kind).toBe('query');
    if (result.kind === 'query') expect(result.query.target).toEqual({ kind: 'id', value: '123' });
  });

  it('does not count analysis task numbers as range options', () => {
    expect(query('/history 123 20 请给出3条建议').count).toBe(20);
    expect(query('分析张三最近20条消息，请给出3条建议').count).toBe(20);
  });

  it('preserves up to 500 Unicode characters without splitting a surrogate pair', () => {
    const original = `/history 123 分析${'😀'.repeat(600)}`;
    const task = query(original).task;
    expect(Array.from(task)).toHaveLength(500);
    expect(task.endsWith('😀')).toBe(true);
  });

  it('accepts 1 to 20 digit ids without lossy numeric conversion', () => {
    expect(query('/history 1').target.value).toBe('1');
    expect(query('/history 12345678901234567890').target.value).toBe('12345678901234567890');
    expect(query('/history 000123').target.value).toBe('000123');
  });
});

describe('parseHistoryQuery: ambiguous or unsupported requests', () => {
  it.each([
    '今天聊得很开心', '请分析这句话', '分析今天的股市走势', '张三最近聊天很少',
    '有人说“分析张三最近20条发言”', '“分析张三最近20条发言”',
    '> 分析张三最近20条发言', '/historybook 123', '/search 张三的历史消息',
    '我最近聊天内容都是分析', '今天的内容主要是历史分析',
  ])('does not trigger for ordinary or quoted text: %s', (text) => {
    expect(parseHistoryQuery(event(text), { now: NOW })).toEqual({ kind: 'none' });
  });

  it('does not inspect raw message contents when the current normalized instruction is unrelated', () => {
    expect(parseHistoryQuery(event('谢谢', { rawText: '/history 123 50', replyToId: '77' }), { now: NOW })).toEqual({ kind: 'none' });
  });

  it.each(['/history', '分析最近20条发言', '分析他的最近20条发言'])('requires a concrete target: %s', (text) => {
    expectError(text, /明确指定/);
  });

  it.each([
    ['分析张三 和 李四最近20条发言', /一位/],
    ['/history @123 @456 20', /一位/],
    ['分析123 456最近20条发言', /一位/],
    ['/history 123456789012345678901', /1 至 20/],
    ['分析2026-10-22最近20条发言', /日期/],
    ['/history 最近20条', /日期/],
    ['/history 999', /非机器人/],
  ])('rejects ambiguous or invalid targets: %s', (text, pattern) => expectError(text, pattern));

  it('rejects multiple actual targets, all-member mentions, and conflicting names', () => {
    expectError('分析 @123 @456 最近20条发言', /一位/, { mentionedUserIds: ['999', '123', '456'] });
    expectError('分析 @all 最近20条发言', /全体成员/, { mentionedUserIds: ['999', 'all'] });
    expectError('分析张三最近20条发言', /歧义/, { mentionedUserIds: ['999', '123'] });
  });

  it.each([
    '/history 123 0', '/history 123 51', '/history 123 -1', '/history 123 1.5',
    '/history 123 最近0条', '/history 123 最近51条', '/history 123 最近1.5条',
    '/history 123 最近六十条', '/history 123 最近999999999999999999999999条',
    '分析张三最近0条发言',
  ])('rejects invalid message counts without clamping: %s', (text) => expectError(text, /1 至 50/));

  it.each([
    '/history 123 0d', '/history 123 8d', '/history 123 169h', '/history 123 -1h',
    '/history 123 最近8天', '/history 123 最近0小时', '/history 123 最近1.5天',
    '/history 123 最近1个月', '/history 123 最近1年', '/history 123 最近1周',
    '分析张三最近8天的发言', '读取张三的最近全部内容并分析',
  ])('rejects invalid or unbounded ranges: %s', (text) => expectError(text, /最长 7 天|最多 7 天/));

  it('rejects conflicting ranges and counts', () => {
    expectError('/history 123 今天 昨天', /范围不唯一/);
    expectError('/history 123 今天 24h', /范围不唯一/);
    expectError('/history 123 20 30', /条数不唯一/);
  });

  it('limits recognized queries to the current group but ignores unrelated direct messages', () => {
    expectError('/history 123', /仅支持当前本群/, { mode: 'direct' });
    expectError('分析张三今天的聊天消息', /仅支持当前本群/, { mode: 'direct' });
    expectError('分析张三最近在其他群的聊天消息', /当前本群/);
    expect(parseHistoryQuery(event('hello', { mode: 'direct' }))).toEqual({ kind: 'none' });
  });
});

describe('parseHistoryQuery: Asia/Shanghai calendar boundaries', () => {
  it('uses UTC+8 midnight for today even on a host in another timezone', () => {
    const result = query('/history 123 今天');
    expect(result.sinceMs).toBe(Date.parse('2026-10-21T16:00:00.000Z'));
    expect(result.untilMs).toBe(NOW);
  });

  it('uses an inclusive end just before today for yesterday', () => {
    const result = query('总结123昨天在本群说了什么');
    expect(result.sinceMs).toBe(Date.parse('2026-10-20T16:00:00.000Z'));
    expect(result.untilMs).toBe(Date.parse('2026-10-21T15:59:59.999Z'));
  });

  it('changes the day precisely at Beijing midnight', () => {
    const boundary = Date.parse('2026-10-21T16:00:00.000Z');
    expect(query('/history 123 今天', {}, boundary - 1).sinceMs).toBe(boundary - DAY);
    expect(query('/history 123 今天', {}, boundary).sinceMs).toBe(boundary);
    expect(query('/history 123 昨天', {}, boundary).untilMs).toBe(boundary - 1);
  });

  it('handles month/year boundaries and leap day', () => {
    const newYear = query('/history 123 昨天', {}, Date.parse('2027-01-01T00:00:00Z'));
    expect(newYear.sinceMs).toBe(Date.parse('2026-12-30T16:00:00Z'));
    const leap = query('/history 123 昨天', {}, Date.parse('2024-03-01T00:00:00Z'));
    expect(leap.sinceMs).toBe(Date.parse('2024-02-28T16:00:00Z'));
    expect(leap.untilMs).toBe(Date.parse('2024-02-29T15:59:59.999Z'));
  });

  it('reports an invalid injected clock', () => {
    expect(parseHistoryQuery(event('/history 123'), { now: NaN }).kind).toBe('error');
  });
});

describe('parseHistoryQuery: bounded fuzzy phrases and reply targets', () => {
  it.each([
    ['看看@张三最近几条消息', 5, 7 * DAY, /几条.*5条.*默认7天/u],
    ['看一下@张三最近几句发言', 5, 7 * DAY, /几句.*5条.*默认7天/u],
    ['看下张三最近一些内容', 20, 7 * DAY, /默认7天.*默认20/u],
    ['读一下张三近期聊天内容', 20, 7 * DAY, /近期.*默认7天.*默认20/u],
    ['分析@张三刚刚发言的内容', 10, 10 * 60_000, /刚刚.*10分钟.*默认10/u],
    ['总结张三刚才的消息', 10, 10 * 60_000, /刚才.*10分钟.*默认10/u],
    ['分析张三刚刚最近几条发言', 5, 10 * 60_000, /刚刚.*10分钟.*几条.*5条/u],
    ['看看张三刚才最近3条消息', 3, 10 * 60_000, /最多3条.*刚才/u],
    ['看看张三最近4条刚刚的消息', 4, 10 * 60_000, /最多4条.*刚刚/u],
  ])('gives an explicit bounded interpretation: %s', (text, count, duration, label) => {
    const result = query(text);
    expect(result.target).toEqual({ kind: 'name', value: '张三' });
    expect(result.count).toBe(count);
    expect(result.sinceMs).toBe(NOW - duration);
    expect(result.untilMs).toBe(NOW);
    expect(result.rangeLabel).toMatch(label);
  });

  it.each(['/history', '/history 今天', '/history 最近几条', '分析刚刚发言的内容', '读取最近内容并分析'])('defers an omitted target to a same-group reply lookup: %s', (text) => {
    expect(query(text, { replyToId: 'quoted-77' }).target).toEqual({ kind: 'reply', value: 'quoted-77' });
  });

  it('never falls back to a reply author when a member was explicitly specified', () => {
    expect(query('分析张三刚刚发言的内容', { replyToId: '77' }).target).toEqual({ kind: 'name', value: '张三' });
    expect(query('分析@123刚刚发言的内容', { replyToId: '77', mentionedUserIds: ['999', '123'] }).target).toEqual({ kind: 'id', value: '123' });
    expect(query('分析我最近几条消息', { replyToId: '77' }).target).toEqual({ kind: 'id', value: '456' });
  });

  it('does not guess a recent speaker without a reply or a concrete target', () => {
    expectError('分析刚刚发言的内容', /明确指定/);
    expectError('看看最近几条消息', /明确指定/);
    expectError('看看他近期发言的内容', /明确指定/);
  });

  it.each(['最近几条消息很有意思', '张三刚刚发言的内容很好', '我刚刚的内容都是分析', '刚才聊了什么', '近期很忙'])('does not trigger fuzzy descriptions alone: %s', (text) => {
    expect(parseHistoryQuery(event(text, { replyToId: '77' }), { now: NOW })).toEqual({ kind: 'none' });
  });

  it('keeps all limits and range-ambiguity checks for fuzzy scopes', () => {
    expectError('分析张三刚刚最近51条发言', /1 至 50/);
    expectError('分析张三刚刚今天的发言', /范围不唯一/);
    expectError('分析张三最近几条最近20条消息', /条数不唯一/);
    expectError('分析刚刚发言的内容', /仅支持当前本群/, { mode: 'direct', replyToId: '77' });
  });
});

describe('parseHistoryQuery: concise requests and exact member names', () => {
  it.each(['QQ音乐', '张三消息', '张三的', '本群张三', '群里小王', '聊天内容', '我'])('preserves slash-command nickname tokens exactly: %s', (name) => {
    expect(query(`/history ${name} 20`).target).toEqual({ kind: 'name', value: name });
  });

  it.each(['QQ123', 'QQ号123', 'QQ：123'])('strips QQ labels only when the entire remainder is a numeric id: %s', (name) => {
    expect(query(`/history ${name} 20`).target).toEqual({ kind: 'id', value: '123' });
  });

  it.each(['QQ音乐', '张三消息', '张三聊天', '张三内容'])('preserves message-like suffixes in natural-language names: %s', (name) => {
    expect(query(`读取${name}的最近内容并分析`).target).toEqual({ kind: 'name', value: name });
    expect(query(`分析${name}最近几条`).target).toEqual({ kind: 'name', value: name });
  });

  it('removes only one natural-language particle and retains an explicitly quoted nickname', () => {
    expect(query('读取张三的的最近内容并分析').target).toEqual({ kind: 'name', value: '张三的' });
    expect(query('读取“张三的”的最近内容并分析').target).toEqual({ kind: 'name', value: '张三的' });
    expect(query('/history “张三的” 20').target).toEqual({ kind: 'name', value: '张三的' });
  });

  it.each([
    ['分析 @123 最近几条', '123', 5, 7 * DAY],
    ['分析 @123 最近30条', '123', 30, 7 * DAY],
    ['看看 QQ号123 刚刚说的', '123', 10, 10 * 60_000],
    ['分析张三刚才的发言', '张三', 10, 10 * 60_000],
    ['看看张三最近几句？', '张三', 5, 7 * DAY],
    ['看看张三刚刚最近4条', '张三', 4, 10 * 60_000],
  ])('recognizes concise history requests without losing the quantity: %s', (text, target, count, duration) => {
    const result = query(text);
    expect(result.target.value).toBe(target);
    expect(result.count).toBe(count);
    expect(result.sinceMs).toBe(NOW - duration);
  });

  it('uses an actual mention in a noun-omitting request', () => {
    const result = query('分析 @123 最近几条', { mentionedUserIds: ['999', '123'] });
    expect(result.target).toEqual({ kind: 'id', value: '123' });
    expect(result.count).toBe(5);
  });

  it('does not silently send invalid noun-omitting requests to the general model', () => {
    expectError('分析张三最近51条', /1 至 50/);
    expectError('分析张三最近0条', /1 至 50/);
    expectError('看看最近几条', /明确指定/);
    expectError('分析@123刚才最近51条', /1 至 50/);
  });

  it.each(['和田', '大和', '参与者', '及时雨', '读书与咖啡', '张三和李四'])('preserves a complete name for exact group-member matching: %s', (name) => {
    expect(query(`分析${name}刚才的发言`).target).toEqual({ kind: 'name', value: name });
  });

  it.each(['张三、李四', '张三，李四', '张三 和 李四', '张三 与 李四', '张三 及 李四', '张三 以及 李四'])('still rejects clear multiple-member separators: %s', (name) => {
    expectError(`分析${name}最近几条`, /一位/);
  });

  it.each([
    '张三最近几条很有趣', '最近几条', '请分析最近几条政策', '看看这张图最近几条线的走势',
    '他说“分析张三最近几条”', '“分析张三最近几条”', '张三刚刚说的很好', '看看张三最近几条太逗了',
  ])('does not expand into ordinary descriptions or other counted objects: %s', (text) => {
    expect(parseHistoryQuery(event(text), { now: NOW })).toEqual({ kind: 'none' });
  });
});
