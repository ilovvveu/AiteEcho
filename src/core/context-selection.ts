import type { ContextTurn } from '../types/session.js';
import { detectReplyScene, isBareWeatherQuestion, type ReplyScene } from './reply-profile.js';

export interface ContextSelection { text: string; senderId: string; styleId: string; styleVersion: string; scene: ReplyScene; hasQuote?: boolean }
function sender(turn: ContextTurn): string | undefined { return turn.senderId ?? /^(?:发言人QQ:|发送者 ID：)(\d+)/u.exec(turn.user)?.[1]; }
function question(turn: ContextTurn): string { return turn.user.replace(/^(?:发言人QQ:|发送者 ID：)\d+\n/u, '').split('[附件/引用文字节选]')[0] ?? ''; }

/** Recognize a short location-shaped reply only while this sender has a recent pending city question. */
export function continuesWeatherClarification(candidates: ContextTurn[], text: string, senderId: string, now = Date.now()): boolean {
  const latest = candidates.filter(turn => sender(turn) === senderId).at(-1);
  if (latest?.scene !== 'weather_clarification' || latest.at > now || now - latest.at > 600000) return false;
  const reply = text.trim();
  if (!/^[\p{L}][\p{L}\p{N}· .-]{1,39}[。!！?？]?$/u.test(reply)) return false;
  if (/不用|不查|不看|不想|算了|谢谢|你好|再见|好的|好吧|哈哈|换个|换话题|笑话|讲个|说个|翻译|分析|总结|解释|是谁|是什么|为什么|怎么|多少|请问|help|thanks|hello|never mind|cancel/iu.test(reply)) return false;
  return true;
}
function words(text: string): Set<string> {
  const clean = text.replace(/(?:发言人QQ:|发送者 ID：)\d+/gu, '').toLowerCase();
  const tokens = clean.match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu) ?? [];
  const stop = /^(?:今天|今日|怎么|如何|什么|这个|那个|可以|一下|觉得|你们|我们|现在|帮我|继续)$/u;
  const out = new Set<string>();
  for (const token of tokens) {
    if (/^[a-z0-9_]+$/u.test(token)) out.add(token);
    else for (let i = 0; i < token.length - 1; i++) { const pair = token.slice(i, i + 2); if (!stop.test(pair)) out.add(pair); }
  }
  return out;
}

/** Filter only the already-bounded latest candidates. Never retrieve older or other-chat data. */
export function selectRelevantContext(candidates: ContextTurn[], query: ContextSelection): ContextTurn[] {
  const wanted = words(query.text);
  const ownTail = new Set(candidates.filter(turn => sender(turn) === query.senderId).slice(-2));
  const selected = candidates.filter(turn => {
    const sameSender = sender(turn) === query.senderId;
    const topic = turn.topic ?? (detectReplyScene(question(turn)) === 'weather' ? 'weather' : 'general');
    if (query.scene === 'weather' || query.scene === 'weather_clarification') return sameSender && topic === 'weather';
    if (query.scene === 'followup' && ownTail.has(turn)) return true;
    const prior = words(`${question(turn)}\n${turn.assistant}`);
    return [...wanted].some(word => prior.has(word));
  });
  return selected.map(turn => {
    const changed = turn.styleVersion !== query.styleVersion || turn.styleId !== query.styleId;
    // Keep relevant reference facts, but limit older/mismatched prose. Full original stays local.
    return changed ? { ...turn, assistant: `[旧风格参考内容，非本轮语气示例]${turn.assistant.slice(0, 600)}${turn.assistant.length > 600 ? '[节选]' : ''}` } : turn;
  });
}

export function needsLocalWeatherClarification(text: string, history: string[], hasQuote: boolean): boolean {
  if (hasQuote || !isBareWeatherQuestion(text)) return false;
  try {
    const turns = JSON.parse(history.find(line => line.startsWith('[{"at":')) ?? '[]') as ContextTurn[];
    return turns.every(turn => isBareWeatherQuestion(question(turn)) || turn.scene === 'weather_clarification');
  } catch { return false; }
}
