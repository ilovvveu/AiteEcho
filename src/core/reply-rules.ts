import { lstatSync, readFileSync } from 'node:fs';
import type { Logger } from 'pino';
import { z } from 'zod';
import { contentVersion } from './reply-profile.js';

const rulesSchema = z.object({
  version: z.literal(1).default(1),
  sourceLinks: z.enum(['on_request', 'always', 'never']).default('on_request'),
  instructions: z.string().trim().max(1000).default(''),
}).strict();
export type ReplyRulesSettings = z.infer<typeof rulesSchema>;
export interface ResolvedReplyRules { instructions: string; allowSourceLinks: boolean; appendSourceList?: boolean; version?: string }
const DEFAULTS = rulesSchema.parse({});

/** Decide from the current question only, never from quoted material or old turns. */
export function requestsSourceLinks(text: string): boolean {
  const target = '(?:来源|出处|参考(?:资料|文献|链接)|链接|网址|地址|原文|官网|官方网站|sources?|citations?|references?|\\bURLs?\\b)';
  if (new RegExp(`(?:不要|不用|不必|无需|别|不想要|不需要|不附|不带).{0,14}${target}`, 'iu').test(text)
    || /\b(?:no|without|omit|exclude|don['’]t\s+(?:include|add|show))\s+(?:any\s+)?(?:source\s+)?(?:links?|URLs?|citations?|references?|sources?)\b/iu.test(text)) return false;
  return new RegExp(`${target}|下载(?:入口|页面|地址)|仓库(?:地址|在哪)|项目地址`, 'iu').test(text);
}

function resolve(settings: ReplyRulesSettings, question: string): ResolvedReplyRules {
  const allowSourceLinks = settings.sourceLinks === 'always'
    || (settings.sourceLinks === 'on_request' && requestsSourceLinks(question));
  const appendSourceList = allowSourceLinks && (settings.sourceLinks === 'always'
    || /来源|出处|参考(?:资料|文献|链接)|\b(?:sources?|citations?|references?)\b/iu.test(question));
  return {
    allowSourceLinks, appendSourceList, version: contentVersion(`full-scene-v3:${JSON.stringify(settings)}`),
    instructions: [
      '历史仅用于事实、人物与话题衔接。旧助手回复的口气、说教方式和引用格式不是文风示范；本轮选择的风格优先，不照抄旧答复。',
      allowSourceLinks
        ? `本轮允许提供${appendSourceList ? '来源或任务所需链接' : '任务所需链接，不额外追加来源列表'}；仅使用真实取得的HTTP(S)网址，不编造。`
        : '本轮默认不显示来源链接、网址、引用编号或文末来源列表；可实际联网核实并说明日期、不确定性，但不要主动附链接。代码和用户原已提供的网址不属于新增来源。',
      settings.instructions,
    ].filter(Boolean).join('\n'),
  };
}

/** Trusted local, hot-reloaded settings shared by all chat styles. */
export class ReplyRules {
  private last = DEFAULTS;
  private signature?: string;
  constructor(private readonly file?: string, private readonly logger?: Logger) {}

  get(): ReplyRulesSettings {
    if (!this.file) return { ...this.last };
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.size > 16384) throw new Error('invalid rules file');
      const signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      if (signature !== this.signature) {
        this.last = rulesSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
        this.signature = signature;
      }
    } catch { this.logger?.warn('global reply rules unavailable; retaining last valid settings'); }
    return { ...this.last };
  }

  resolve(question: string): ResolvedReplyRules { return resolve(this.get(), question); }
}

/** No unsolicited web links outside code; preserve labels, facts and URLs supplied by the user. */
export function presentReplySources(text: string, allowLinks: boolean, question = '', sources: string[] = [], appendSources = allowLinks): string {
  if (!text.trim()) return text;
  if (allowLinks) {
    if (!appendSources) {
      // Functional URL requests are not requests for an additional bibliography.
      const parts = text.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/gu);
      return parts.map((part, i) => i % 2 ? part : part.replace(/\n+(?:#{1,6}\s*)?(?:\*\*)?(?:来源|参考资料|参考文献|参考链接|Sources?|References?|Citations?)(?:\*\*)?[：:][\s\S]*$/iu, '')).join('').trim() || text;
    }
    const missing = [...new Set(sources)].filter(url => !text.includes(url)).slice(0, 5);
    return missing.length ? `${text}\n\n来源：\n${missing.join('\n')}` : text;
  }
  const supplied = new Set(question.match(/(?:https?:\/\/|www\.)[^\s<>"'`，。；！？）)\]}]+/gu) ?? []);
  const protectedParts: string[] = [];
  let body = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`/gu, part => {
    protectedParts.push(part); return `\uE100${protectedParts.length - 1}\uE101`;
  });
  body = body.replace(/\[([^\]\n]*)\]\(<?(https?:\/\/[^\s<>]+?)>?(?:\s+["'][^\n]*?["'])?\)/gu,
    (whole, label: string, url: string) => supplied.has(url) ? whole : /^\d+$/u.test(label) ? '' : label);
  body = body.replace(/(?:https?:\/\/|www\.)[^\s<>"'`，。；！？）)\]}]+/gu, url => supplied.has(url) ? url : '');
  body = body.replace(/cite[^]*|【\d+(?:†[^】]*)?】/gu, '');
  body = body.replace(/\[(\d+)\](?=[\s，。；！？,.!?;:]|$)/gu, '');
  body = body.split('\n').filter(line => {
    const plain = line.replace(/[*#>\s]/gu, '').replace(/^[-+\d.)、]+/u, '');
    return !/^(?:来源|参考资料|参考文献|参考链接|Sources?|References?|Citations?)[：:]?$/iu.test(plain)
      && !/^\s*(?:[-*+]\s*|\[?\d+\]?[：:.、]\s*)$/u.test(line);
  }).join('\n').replace(/[ \t]+([，。；！？])/gu, '$1').replace(/\n{3,}/gu, '\n\n').trim();
  body = body.replace(/\uE100(\d+)\uE101/gu, (_, index: string) => protectedParts[Number(index)] ?? '');
  return body || '这次返回只有来源链接，没有正文内容，请重新提问。';
}
