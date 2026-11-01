import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReplyRules, requestsSourceLinks, presentReplySources } from './reply-rules.js';

describe('global reply rules', () => {
  it.each(['给出处', '附上来源链接', '官网在哪', '下载地址呢', '给我 URL', 'show sources', '分析这个链接'])('allows explicit link task: %s', text => {
    expect(requestsSourceLinks(text)).toBe(true);
  });
  it.each(['如何评价这个角色', '搜索今天的天气', '查查最近的更新，不用附来源链接', '不要链接，只给结论', 'no sources', 'without URLs', '不用给网址'])('does not treat search or negative preference as a source request: %s', text => {
    expect(requestsSourceLinks(text)).toBe(false);
  });
  it('hot reloads independently of chat style and retains last valid rules on corrupt, oversized or linked files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qq-reply-rules-')), file = path.join(dir, 'rules.json');
    const rules = new ReplyRules(file);
    expect(rules.resolve('普通聊天').allowSourceLinks).toBe(false);
    expect(rules.resolve('给我来源').allowSourceLinks).toBe(true);
    expect(rules.resolve('给我官网地址')).toMatchObject({allowSourceLinks:true,appendSourceList:false});
    expect(rules.resolve('给我来源')).toMatchObject({allowSourceLinks:true,appendSourceList:true});
    await writeFile(file, JSON.stringify({version:1,sourceLinks:'never',instructions:'GLOBAL_TEXT'}));
    expect(rules.resolve('给我来源')).toMatchObject({allowSourceLinks:false,instructions:expect.stringContaining('GLOBAL_TEXT')});
    await writeFile(file, '{bad'); expect(rules.get().sourceLinks).toBe('never');
    await writeFile(file, JSON.stringify({sourceLinks:'always',instructions:'x'.repeat(20000)}));
    expect(rules.get().sourceLinks).toBe('never');
    await writeFile(file, JSON.stringify({sourceLinks:'always'})); expect(rules.resolve('普通聊天').allowSourceLinks).toBe(true);
    const link = path.join(dir, 'link.json'); await symlink(file, link);
    expect(new ReplyRules(link).get().sourceLinks).toBe('on_request');
    expect(rules.resolve('普通聊天').instructions).toContain('不是文风示范');
  });
  it('removes unsolicited body/markdown/bare URLs, annotation links and empty headings while keeping substantive words', () => {
    const text = '结论是可以。[1]\n参考[官方说明](https://example.org/a)。\n\n来源：\n- https://example.org/b\n2. https://example.org/c\n【1†来源】citeturn0search0';
    const shown = presentReplySources(text, false, '', ['https://example.org/d']);
    expect(shown).toContain('结论是可以'); expect(shown).toContain('官方说明');
    expect(shown).not.toMatch(/https?:|来源：|\[1\]|turn0search/);
    expect(presentReplySources('391',false)).toBe('391');
    expect(presentReplySources('',false)).toBe('');
    expect(presentReplySources('参考 www.example.org',false)).not.toContain('www.example.org');
    expect(presentReplySources('第一段\n\n第二段',false)).toBe('第一段\n\n第二段');
    expect(presentReplySources('来源：\nhttps://example.org',false)).toContain('没有正文');
  });
  it('preserves source metadata on request, code, JSON, and URLs already supplied by the user', () => {
    const code = '```json\n{"url":"https://example.org/api"}\n```\n`https://example.org/code`';
    expect(presentReplySources(code,false)).toBe(code);
    expect(presentReplySources('检查 https://example.org/a',false,'检查 https://example.org/a')).toBe('检查 https://example.org/a');
    const result = presentReplySources('答复',true,'给来源',['https://example.org/a','https://example.org/a']);
    expect(result).toBe('答复\n\n来源：\nhttps://example.org/a');
    expect(presentReplySources(result,true,'给来源',['https://example.org/a'])).toBe(result);
    expect(presentReplySources('https://example.org/official',true,'给官网',['https://example.org/source'],false)).toBe('https://example.org/official');
    expect(presentReplySources('https://example.org/official\n\n来源：\nhttps://example.org/source',true,'给官网',[],false)).toBe('https://example.org/official');
    const sourceInCode='```text\n示例\n来源：https://example.org/api\n```';
    expect(presentReplySources(sourceInCode,true,'给官网',[],false)).toBe(sourceInCode);
  });
});
