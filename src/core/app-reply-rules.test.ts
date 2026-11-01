import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { loadMessageTestConfig as loadConfig } from '../test-support/config.js';
import { DirectApiBridge } from '../agents/direct/bridge.js';
import { BotApplication } from './app.js';

afterEach(() => vi.restoreAllMocks());
it('applies hot-reloaded global rules across group/private and blank/selected styles, using only current text for sources', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'qq-global-rules-')), styles=path.join(dir,'styles'), file=path.join(dir,'rules.json');
  await mkdir(styles); await writeFile(path.join(styles,'default.txt'),''); await writeFile(path.join(styles,'温和.txt'),'SELECTED_STYLE');
  await writeFile(file,JSON.stringify({version:1,sourceLinks:'on_request',instructions:'GLOBAL_SENTINEL'}));
  const c=loadConfig({AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high',DIRECT_API_BASE_URL:'https://example.invalid/v1',QQ_CODEX_API_KEY:'test-only',CONTEXT_BOUNDED:'true',
    SESSION_FILE_PATH:path.join(dir,'sessions.json'),BOT_REPLY_RULES_FILE:file,BOT_REPLY_STYLE_DIR:styles,BOT_REPLY_STYLE_STATE_FILE:path.join(dir,'styles.json'),
    ONEBOT_ALLOWED_USERS:'1',ONEBOT_OWNER_USERS:'1',ONEBOT_ALLOWED_GROUPS:'100',ONEBOT_PROGRESS_MODE:'off',ACP_WEB_SEARCH:'true',DIRECT_API_SEND_HISTORY:'true'});
  c.onebot.groupPolicies['100']={id:'100',allowAllMembers:true,requireMention:true,replyLimits:{admin:5,member:3}};
  const app=new BotApplication(c,pino({enabled:false})) as any;
  const send=vi.spyOn(app.gateway,'sendPayload').mockResolvedValue([]); vi.spyOn(app.gateway,'sendText').mockResolvedValue(undefined);
  const sentText=(index:number)=>(send.mock.calls[index]![1] as {text:string}).text;
  const prompt=vi.spyOn(DirectApiBridge.prototype,'sendPrompt').mockResolvedValue({text:'回答正文。\n\n来源：\nhttps://example.org/source',images:[],sessionId:'direct-stateless',stopReason:'end_turn'});
  let id=0;
  const event=(text:string,group=false)=>({post_type:'message',message_type:group?'group':'private',group_id:group?'100':undefined,user_id:'1',self_id:'999',message_id:String(++id),
    message:[...(group?[{type:'at',data:{qq:'999'}}]:[]),{type:'text',data:{text}}]});
  await app.handleIncomingPayload(event('分析这件事'));
  expect(prompt.mock.calls[0]![0].replyRules).toMatchObject({allowSourceLinks:false,instructions:expect.stringContaining('GLOBAL_SENTINEL')});
  expect(sentText(0)).toBe('回答正文。');
  await app.handleIncomingPayload(event('给来源'));
  expect(sentText(1)).toContain('https://example.org/source');
  await app.handleIncomingPayload(event('/style 温和',true));
  await app.handleIncomingPayload(event('普通聊天',true));
  expect(prompt.mock.calls[2]![0].systemPrompt).toContain('SELECTED_STYLE');
  expect(prompt.mock.calls[2]![0].replyRules?.allowSourceLinks).toBe(false);
  expect(prompt.mock.calls[2]![0].contextLines?.join('\n')).toContain('默认不显示来源链接');
  expect(sentText(2)).toBe('回答正文。');
  await writeFile(file,JSON.stringify({version:1,sourceLinks:'always',instructions:'NEW_GLOBAL'}));
  await app.handleIncomingPayload(event('普通聊天'));
  expect(prompt.mock.calls[3]![0].replyRules?.instructions).toContain('NEW_GLOBAL');
  expect(sentText(3)).toContain('https://example.org/source');
  await writeFile(file,JSON.stringify({version:1,sourceLinks:'on_request'}));
  await app.handleIncomingPayload(event('继续分析，不要附来源'));
  expect(prompt.mock.calls[4]![0].replyRules?.allowSourceLinks).toBe(false);
  expect(sentText(4)).not.toContain('https:');
  await app.handleIncomingPayload(event('/search 今天的天气'));
  expect(prompt.mock.calls[5]![0].replyRules?.allowSourceLinks).toBe(false);
  expect(sentText(5)).not.toContain('https:');
  await app.handleIncomingPayload(event('/search Python 并给来源'));
  expect(prompt.mock.calls[6]![0].replyRules).toMatchObject({allowSourceLinks:true,appendSourceList:true});
  expect(sentText(6)).toContain('https:');
});
