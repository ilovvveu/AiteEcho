import type { NormalizedOneBotEvent } from '../types/onebot.js';

export type HistoryQuery = {
  target: { kind: 'id' | 'name' | 'reply'; value: string };
  count: number;
  sinceMs: number;
  untilMs: number;
  rangeLabel: string;
  task: string;
};

type ParseResult = { kind: 'none' } | { kind: 'error'; message: string } | { kind: 'query'; query: HistoryQuery };
type Target = HistoryQuery['target'];
type Window = Pick<HistoryQuery, 'count' | 'sinceMs' | 'untilMs' | 'rangeLabel'>;

const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const MAX_COUNT = 50;
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万半几]+|NaN|Infinity)';
const ACTION_WORDS = '读取|查看|分析|总结|回顾|看看|看一下|看下|读一下|读下';
const ACTION = new RegExp(`^(?:(?:请|麻烦)(?:你)?(?:帮我)?|帮我|帮忙|能否|能不能|可以)?\\s*(?:${ACTION_WORDS})(?:一下|下)?\\s*`, 'u');
const SCOPE = /今天|昨天|最近|最新|过去|历史|近期|刚刚|刚才|近\s*(?:\d|[一二两三四五六七八九十])/u;
const CONTENT = /发言|聊天|说了|说的|消息|内容/u;
// This is an intent marker only: unlike CONTENT it must not truncate the range spec.
const COUNT_SHORTHAND = new RegExp(`${NUMBER}\\s*(?:条|句)\\s*[。！？!?]?$`, 'iu');

function error(message: string): { kind: 'error'; message: string } {
  return { kind: 'error', message };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function integerOf(text: string): number {
  if (/^\d+$/u.test(text)) return Number(text);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text in digits) return digits[text];
  const tens = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/u.exec(text);
  return tens ? (tens[1] ? digits[tens[1]] : 1) * 10 + (tens[2] ? digits[tens[2]] : 0) : NaN;
}

function targetOf(text: string, senderId: string, natural: boolean): Target | { kind: 'error'; message: string } {
  let value = text.trim();
  // Command arguments are exact names. Only natural-language grammar has particles;
  // never strip message-like nickname suffixes, or a different member could be selected.
  if (natural) value = value.replace(/^(?:本群|群里|群内)(?:的)?\s*/u, '').replace(/的$/u, '').trim();
  value = value.replace(/^@/u, '').trim();
  const qqLabel = /^QQ(?:号)?[：:\s]*(\d+)$/iu.exec(value);
  if (qqLabel) value = qqLabel[1];
  if (natural && /^(?:我|本人)$/u.test(value)) return { kind: 'id', value: senderId };
  if (!value || /^(?:他|她|它|他们|她们|大家|群友|成员|所有人|这个人|那个人|全体成员|all)$/iu.test(value)) {
    return error('请明确指定本群的一位成员：真实 @、QQ 号或完整昵称；也可以说“我最近的发言”。');
  }
  if (/^(?:\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?|\d{4}年|\d+月\d+日)/u.test(value) || SCOPE.test(value) || /^\d+(?:条|天|小时|[hd])$/iu.test(value)) {
    return error('未识别到明确成员；日期、时间范围和消息条数不能作为 QQ 号。');
  }
  if (/[、,，&]|\s+(?:和|与|及|以及|还有)\s+/u.test(value) || /@/u.test(value) || /^\d+\s+\d+$/u.test(value)) {
    return error('一次只能查询一位成员，请只指定一个目标。');
  }
  if (/^\d+$/u.test(value)) {
    return value.length <= 20 ? { kind: 'id', value } : error('QQ 号必须是 1 至 20 位数字。');
  }
  const quoted = /^(?:"([^"]+)"|“([^”]+)”|'([^']+)')$/u.exec(value);
  if (quoted) value = quoted[1] ?? quoted[2] ?? quoted[3];
  if (value.length > 80 || /[\r\n：:;；。!?！？[\]<>]/u.test(value) || /^(?:第|\d+[.+-])/u.test(value)) {
    return error('无法确定唯一成员，请使用真实 @、QQ 号或完整昵称。');
  }
  return { kind: 'name', value };
}

function parseWindow(spec: string, now: number, command: boolean): Window | { kind: 'error'; message: string } {
  let count = 20;
  let countSeen = false;
  let timeSeen = false;
  let sinceMs = now - 7 * DAY_MS;
  let untilMs = now;
  let rangeLabel = '最近7天';
  const interpretations: string[] = [];
  const todayStart = Math.floor((now + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
  let remaining = spec.trim();
  const quantity = new RegExp(`^(?:(?:最近|最新|过去|近)\\s*)?(${NUMBER})\\s*(条|句|小时|天|星期|周|个月|月|年|h|d)(?![a-z])`, 'iu');
  const bareCount = new RegExp(`^(${NUMBER})(?=\\s|$)`, 'iu');

  while (remaining) {
    remaining = remaining.replace(/^[\s，,、的]+/u, '');
    if (!remaining) break;
    const immediate = /^(刚刚|刚才)/u.exec(remaining);
    if (immediate) {
      if (timeSeen) return error('时间范围不唯一，请只指定一个时间范围。');
      timeSeen = true;
      sinceMs = now - 10 * 60_000;
      rangeLabel = '最近10分钟';
      if (!countSeen) count = 10;
      interpretations.push(`“${immediate[1]}”按10分钟`);
      remaining = remaining.slice(immediate[0].length);
      continue;
    }
    const fuzzyCount = /^(?:(?:最近|最新|过去|近)\s*)?几\s*(条|句)/u.exec(remaining);
    if (fuzzyCount) {
      if (countSeen) return error('消息条数不唯一，请只指定一个条数。');
      countSeen = true;
      count = 5;
      interpretations.push(`“几${fuzzyCount[1]}”按5条`);
      remaining = remaining.slice(fuzzyCount[0].length);
      continue;
    }
    const fuzzyScope = /^(最近一些|近期)/u.exec(remaining);
    if (fuzzyScope) {
      interpretations.push(`“${fuzzyScope[1]}”使用默认范围`);
      remaining = remaining.slice(fuzzyScope[0].length);
      continue;
    }
    const calendar = /^(今天|昨天)/u.exec(remaining);
    const amount = quantity.exec(remaining);
    const bare = command && !calendar && !amount ? bareCount.exec(remaining) : null;
    if (calendar) {
      if (timeSeen) return error('时间范围不唯一，请只指定今天、昨天或一个最近时间范围。');
      timeSeen = true;
      rangeLabel = `${calendar[1]}（北京时间）`;
      sinceMs = calendar[1] === '今天' ? todayStart : todayStart - DAY_MS;
      untilMs = calendar[1] === '今天' ? now : todayStart - 1;
      remaining = remaining.slice(calendar[0].length);
      continue;
    }
    if (amount || bare) {
      const match = (amount ?? bare)!;
      const value = integerOf(match[1]);
      const unit = amount ? amount[2].toLowerCase() : '条';
      if (unit === '条' || unit === '句') {
        if (!Number.isSafeInteger(value) || value < 1 || value > MAX_COUNT) return error('消息条数必须是 1 至 50 的整数，不会自动截断超限请求。');
        if (countSeen) return error('消息条数不唯一，请只指定一个条数。');
        countSeen = true;
        count = value;
      } else {
        if (!['小时', '天', 'h', 'd'].includes(unit)) return error('仅支持今天、昨天、最近 N 小时或 N 天，最长 7 天。');
        const hours = unit === '小时' || unit === 'h';
        const duration = value * (hours ? 3_600_000 : DAY_MS);
        if (!Number.isSafeInteger(value) || value < 1 || duration > 7 * DAY_MS) return error('时间范围必须是正整数小时或天，最长 7 天（168 小时），不会自动截断。');
        if (timeSeen) return error('时间范围不唯一，请只指定今天、昨天或一个最近时间范围。');
        timeSeen = true;
        sinceMs = now - duration;
        rangeLabel = `最近${value}${hours ? '小时' : '天'}`;
      }
      remaining = remaining.slice(match[0].length);
      continue;
    }
    const generic = /^(?:最近|最新|历史)(?=$|\s|的|在|本群|群内|群里)/u.exec(remaining);
    if (generic) {
      remaining = remaining.slice(generic[0].length);
      continue;
    }
    const filler = /^(?:在本群|在群里|在群内|本群|群里|群内|之内|以内|内)/u.exec(remaining);
    if (filler) {
      remaining = remaining.slice(filler[0].length);
      continue;
    }
    if (/^@/u.test(remaining)) return error('一次只能查询一位成员，请只指定一个目标。');
    if (!command || /^(?:最近|最新|过去|近|全部|所有|无限|\d|[+-]\d|NaN|Infinity)/iu.test(remaining)) {
      return error('无法识别消息条数或时间范围；请使用 1 至 50 条，以及今天、昨天、最近 N 小时或 N 天（最多 7 天）。');
    }
    // In a command, the first non-option starts the free-form analysis task.
    break;
  }
  if (interpretations.length > 0) {
    if (!timeSeen) interpretations.push('时间范围默认7天');
    if (!countSeen) interpretations.push(`条数默认${count}`);
    rangeLabel += `，最多${count}条（${interpretations.join('；')}）`;
  }
  return { count, sinceMs, untilMs, rangeLabel };
}

/** Parse only the current inbound instruction, never quoted messages or retrieved history.
 * Time bounds are inclusive. Calendar days use Asia/Shanghai (UTC+8), independent of host TZ.
 */
export function parseHistoryQuery(
  event: NormalizedOneBotEvent,
  options: { now?: number; commandPrefix?: string } = {},
): ParseResult {
  const original = (event.commandText || event.cleanedText).trim();
  const prefix = options.commandPrefix ?? '/';
  const text = event.selfId
    ? original.replace(new RegExp(`^@${escapeRegExp(event.selfId)}(?=\\s|[，,:：/!]|$)[\\s，,:：]*`, 'u'), '')
    : original;
  const commandMatch = new RegExp(`^${escapeRegExp(prefix)}history(?=\\s|$)\\s*`, 'iu').exec(text);
  const action = ACTION.exec(text);
  const selfRequest = /^(?:我|本人)(?:的)?\s*(?:最近|最新|今天|昨天|历史|近期|刚刚|刚才)/u.test(text)
    && new RegExp(`(?:[,，。;；]\\s*(?:(?:请|麻烦)?帮我|请|麻烦)?\\s*|(?:请|帮我))(?:${ACTION_WORDS})(?:一下|下)?`, 'u').test(text);
  if (!commandMatch && (!(action || selfRequest) || !SCOPE.test(text) || !(CONTENT.test(text) || COUNT_SHORTHAND.test(text)))) return { kind: 'none' };
  if (event.mode !== 'group') return error('历史分析仅支持当前本群，不能读取私聊或其他群的消息。');
  if (/其他群|其它群|别的群|所有群|跨群|私聊/u.test(text)) return error('只能读取当前本群的历史，不能查询私聊或其他群。');
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || !Number.isSafeInteger(now)) return error('当前时间无效，暂时无法确定历史查询范围。');

  const mentions = [...new Set(event.mentionedUserIds.filter((id) => id !== event.selfId))];
  if (mentions.length > 1) return error('一次只能查询一位成员，请只 @ 一位非机器人成员。');
  if (mentions.some((id) => !/^\d{1,20}$/u.test(id))) return error('请 @ 一位具体成员，不能查询 @全体成员；QQ 号须为 1 至 20 位数字。');
  let body = commandMatch ? text.slice(commandMatch[0].length) : action ? text.slice(action[0].length) : text;
  const actualId = mentions[0];
  if (actualId) body = body.replace(new RegExp(`@${escapeRegExp(actualId)}(?!\\d)`, 'gu'), '').trim();
  let target: Target;
  let spec: string;

  if (commandMatch) {
    if (actualId) {
      target = { kind: 'id', value: actualId };
      spec = body;
    } else if (event.replyToId && (!body || SCOPE.exec(body)?.index === 0)) {
      target = { kind: 'reply', value: event.replyToId };
      spec = body;
    } else {
      const token = /^(?:"[^"]+"|“[^”]+”|'[^']+'|\S+)/u.exec(body);
      const parsedTarget = targetOf(token?.[0] ?? '', event.senderId, false);
      if (parsedTarget.kind === 'error') return parsedTarget;
      target = parsedTarget;
      spec = body.slice(token?.[0].length ?? 0).trim();
    }
  } else {
    const scope = SCOPE.exec(body);
    if (!scope) return error('请指定最近、今天、昨天或历史范围。');
    const subject = body.slice(0, scope.index).trim();
    if (actualId) {
      if (subject && subject !== '的') return error('目标存在歧义，请只保留一位成员的 @，不要混用其他姓名或 QQ 号。');
      target = { kind: 'id', value: actualId };
    } else if (!subject && event.replyToId) {
      target = { kind: 'reply', value: event.replyToId };
    } else {
      const parsedTarget = targetOf(subject, event.senderId, true);
      if (parsedTarget.kind === 'error') return parsedTarget;
      target = parsedTarget;
    }
    const rangeAndContent = body.slice(scope.index);
    const content = CONTENT.exec(rangeAndContent);
    spec = content ? rangeAndContent.slice(0, content.index) : rangeAndContent.replace(/[。！!？?]+$/u, '').trim();
  }
  if (target.kind === 'id' && target.value === event.selfId) return error('请指定一位非机器人成员。');
  const window = parseWindow(spec, now, Boolean(commandMatch));
  if ('kind' in window) return window;
  return { kind: 'query', query: { target, ...window, task: Array.from(original).slice(0, 500).join('') } };
}
