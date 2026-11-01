import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { loadMessageTestConfig as loadConfig } from '../test-support/config.js';
import { DirectApiBridge, DirectApiError } from '../agents/direct/bridge.js';
import { BotApplication } from './app.js';

afterEach(()=>vi.restoreAllMocks());
async function harness(){
  const dir=await mkdtemp(path.join(tmpdir(),'qq-style-pipeline-')),styles=path.join(dir,'styles'),log=path.join(dir,'trace.jsonl');
  await mkdir(styles);
  for(const [name,text] of [['default',''],['猫娘','猫系轻快口吻，适用追问与事实。'],['机械','低情绪客观表达。'],['萝莉','活泼轻快表达。']])await writeFile(path.join(styles,`${name}.txt`),text!);
  const c=loadConfig({AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high',DIRECT_API_BASE_URL:'https://example.invalid/v1',QQ_CODEX_API_KEY:'test-only',CONTEXT_BOUNDED:'true',CONTEXT_PROMPT_TURNS:'6',CONTEXT_PROMPT_CHARS:'3000',
    DIRECT_API_SEND_HISTORY:'true',BOT_REPLY_STYLE_DIR:styles,BOT_REPLY_STYLE_STATE_FILE:path.join(dir,'style-state.json'),
    SESSION_FILE_PATH:path.join(dir,'sessions.json'),BOT_DIAGNOSTIC_LOG:log,ONEBOT_ALLOWED_USERS:'1',ONEBOT_OWNER_USERS:'1',ONEBOT_ALLOWED_GROUPS:'100',ONEBOT_PROGRESS_MODE:'off'});
  c.onebot.groupPolicies['100']={id:'100',allowAllMembers:true,requireMention:true,replyLimits:{admin:5,member:3}};
  const app=new BotApplication(c,pino({enabled:false})) as any;
  const payload=vi.spyOn(app.gateway,'sendPayload').mockResolvedValue([]),error=vi.spyOn(app.gateway,'sendText').mockResolvedValue(undefined);
  vi.spyOn(app.gateway,'getGroupMemberRole').mockResolvedValue('member');
  const prompt=vi.spyOn(DirectApiBridge.prototype,'sendPrompt').mockResolvedValue({text:'合成天气结果，仅作测试。',images:[],sessionId:'direct-stateless',stopReason:'end_turn'});
  let seq=0;
  const event=(text:string,user='1',group=true)=>({post_type:'message',message_type:group?'group':'private',group_id:group?'100':undefined,user_id:user,self_id:'999',message_id:String(++seq),message:[...(group?[{type:'at',data:{qq:'999'}}]:[]),{type:'text',data:{text}}]});
  return {app,c,dir,log,payload,error,prompt,event};
}
it('clarifies weather locally in the chosen voice, avoids other members locations, and preserves local history with trace metadata',async()=>{
  const h=await harness();await h.app.replyStyle.select('group:100','猫娘');
  await h.app.handleIncomingPayload(h.event('今天天气怎么样'));
  expect(h.prompt).not.toHaveBeenCalled();expect((h.payload.mock.calls[0]![1] as any).text).toContain('喵');
  await h.app.handleIncomingPayload(h.event('上海天气怎么样'));
  expect(h.prompt).toHaveBeenCalledOnce();expect(h.prompt.mock.calls[0]![0].replyProfile).toMatchObject({styleId:'猫娘',scene:'weather'});
  await h.app.handleIncomingPayload(h.event('今天天气怎么样','2'));
  expect(h.prompt).toHaveBeenCalledOnce();expect((h.payload.mock.calls[2]![1] as any).text).toContain('哪个城市');
  const state=h.app.conversations.getPersisted('group:100');expect(state.contextTurns).toHaveLength(3);
  expect(state.contextTurns[0]).toMatchObject({senderId:'1',styleId:'猫娘',scene:'weather_clarification',topic:'weather'});
  expect(state.contextTurns[1].assistant).toBe('合成天气结果，仅作测试。');
  await h.app.diagnostics.flush();
  const log=await readFile(h.log,'utf8');expect(log).toContain('reply_profile');expect(log).toContain('styleVersion');expect(log).toContain('rulesVersion');
  expect(log).not.toContain('上海');expect(log).not.toContain('合成天气结果');expect(log).not.toContain('test-only');
});
it('keeps group/private style selection separate, snapshots it per request and styles failures without saving them',async()=>{
  const h=await harness();await h.app.replyStyle.select('group:100','机械');await h.app.replyStyle.select('direct:1','萝莉');
  await h.app.handleIncomingPayload(h.event('今天天气怎么样'));
  await h.app.handleIncomingPayload(h.event('今天天气怎么样','1',false));
  expect((h.payload.mock.calls[0]![1] as any).text).not.toMatch(/喵|诶/);expect((h.payload.mock.calls[1]![1] as any).text).toContain('诶');
  const before=h.app.conversations.getPersisted('group:100').contextTurns.length;
  h.prompt.mockRejectedValueOnce(new DirectApiError('http_status','HTTP_401'));
  await h.app.replyStyle.select('group:100','猫娘');await h.app.handleIncomingPayload(h.event('北京天气怎么样'));
  expect(String(h.error.mock.calls.at(-1)![1])).toContain('喵');expect(String(h.error.mock.calls.at(-1)![1])).toContain('诊断编号');
  expect(h.app.conversations.getPersisted('group:100').contextTurns.length).toBe(before);
  await h.app.diagnostics.flush();
});
it('does not intercept complex/quoted weather tasks or generic weather chat, and snapshots style hashes',async()=>{
  const h=await harness();await h.app.replyStyle.select('group:100','猫娘');
  await h.app.handleIncomingPayload(h.event('今天天气真好'));
  const p=h.prompt.mock.calls[0]![0];expect(p.replyProfile?.styleId).toBe('猫娘');expect(p.replyProfile?.styleVersion).toMatch(/^[a-f0-9]{12}$/);
  expect(h.prompt).toHaveBeenCalledOnce();
  await writeFile(path.join(h.dir,'styles/猫娘.txt'),'已编辑的新猫系口吻。');
  await h.app.handleIncomingPayload(h.event('分析明天的天气预报'));
  expect(h.prompt.mock.calls[1]![0].replyProfile?.styleVersion).not.toBe(p.replyProfile?.styleVersion);
  expect(h.app.getStatus().config.replyPipeline.version).toBe('full-scene-v3');await h.app.diagnostics.flush();
});
it('carries the same members pending weather clarification when they reply with just a city',async()=>{
  const h=await harness();await h.app.replyStyle.select('group:100','猫娘');
  await h.app.handleIncomingPayload(h.event('今天天气怎么样'));
  await h.app.handleIncomingPayload(h.event('北京'));
  const sent=h.prompt.mock.calls[0]![0];
  expect(sent.replyProfile?.scene).toBe('weather');
  expect(sent.historyContextLines?.join('\n')).toContain('今天天气怎么样');
  expect(sent.text).toBe('北京');await h.app.diagnostics.flush();
});
it('does not inherit another members pending city question or bypass disabled history',async()=>{
  const h=await harness();await h.app.handleIncomingPayload(h.event('今天天气怎么样'));
  await h.app.handleIncomingPayload(h.event('北京','2'));
  expect(h.prompt.mock.calls[0]![0].replyProfile?.scene).toBe('chat');
  expect(h.prompt.mock.calls[0]![0].historyContextLines).toEqual([]);
  await h.app.handleIncomingPayload(h.event('/context off'));
  await h.app.handleIncomingPayload(h.event('杭州'));
  expect(h.prompt.mock.calls[1]![0].replyProfile?.scene).toBe('chat');
  expect(h.prompt.mock.calls[1]![0].historyContextLines).toEqual([]);await h.app.diagnostics.flush();
});
