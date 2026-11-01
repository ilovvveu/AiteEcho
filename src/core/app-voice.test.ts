import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { BotApplication } from './app.js';
import { loadMessageTestConfig as loadConfig } from '../test-support/config.js';
import { DirectApiBridge, DirectApiError } from '../agents/direct/bridge.js';
import { VoiceService, VoiceError } from './voice.js';
afterEach(()=>vi.restoreAllMocks());
async function harness(extra:Record<string,string>={}){
  const dir=await mkdtemp(path.join(tmpdir(),'qq-app-voice-'));
  const c=loadConfig({AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high',DIRECT_API_BASE_URL:'https://example.invalid/v1',QQ_CODEX_API_KEY:'fake-chat-key',CONTEXT_BOUNDED:'true',
    BOT_VOICE_ENABLED:'true',ELEVENLABS_VOICE_ID:'SyntheticVoice7310000',BOT_VOICE_GROUP_ENABLED:'true',ELEVENLABS_API_KEY:'fake-elevenlabs-test-key-731',BOT_VOICE_USAGE_FILE:path.join(dir,'usage.json'),
    SESSION_FILE_PATH:path.join(dir,'sessions.json'),BOT_DIAGNOSTIC_LOG:path.join(dir,'log.jsonl'),ONEBOT_ALLOWED_USERS:'1',ONEBOT_OWNER_USERS:'1',ONEBOT_ALLOWED_GROUPS:'100',ONEBOT_PROGRESS_MODE:'off',...extra});
  c.onebot.groupPolicies['100']={id:'100',allowAllMembers:true,requireMention:true,replyLimits:{admin:5,member:3}};
  const app=new BotApplication(c,pino({enabled:false})) as any;
  vi.spyOn(app.gateway,'getGroupMemberRole').mockResolvedValue('member');
  const text=vi.spyOn(app.gateway,'sendText').mockResolvedValue(undefined),payload=vi.spyOn(app.gateway,'sendPayload').mockResolvedValue([]);
  const sent=vi.spyOn(app.gateway,'sendVoice').mockResolvedValue('731');
  const synth=vi.spyOn(VoiceService.prototype,'synthesize').mockResolvedValue({audio:Buffer.from('ID3\x04FAKE'),text:'最终答案',truncated:false,cached:false});
  const prompt=vi.spyOn(DirectApiBridge.prototype,'sendPrompt').mockResolvedValue({text:'最终答案',images:[],sessionId:'direct-stateless',stopReason:'end_turn'});
  let seq=0;const event=(value:string,user='1',group=false,mention=true)=>({post_type:'message',message_type:group?'group':'private',group_id:group?'100':undefined,user_id:user,self_id:'999',message_id:String(++seq),
    message:[...(group&&mention?[{type:'at',data:{qq:'999'}}]:[]),{type:'text',data:{text:value}}]});
  return{app,c,text,payload,sent,synth,prompt,event,dir};
}
it('reports the configured group quotas instead of fixed personal defaults in local help',async()=>{
  const h=await harness({BOT_VOICE_GROUP_MEMBER_PER_MINUTE:'4',BOT_VOICE_GROUP_ADMIN_PER_MINUTE:'7',BOT_VOICE_GROUP_OWNER_PER_MINUTE:'2'});
  await h.app.handleIncomingPayload(h.event('/voice status','1',true));
  expect(h.text.mock.calls[0]?.[1]).toContain('普通群友4条，群主/管理员7条，机器人主人2条');
  expect(h.prompt).not.toHaveBeenCalled();expect(h.synth).not.toHaveBeenCalled();await h.app.diagnostics.flush();
});
it('reads customized voice thresholds and quotas in the actual reply path',async()=>{
  const h=await harness({BOT_VOICE_GROUP_MAX_CHARS:'3',BOT_VOICE_GROUP_MEMBER_PER_MINUTE:'2'});
  h.prompt.mockResolvedValue({text:'四个汉字',images:[],sessionId:'direct-stateless',stopReason:'end_turn'});
  await h.app.handleIncomingPayload(h.event('/语音 问题','2',true));
  expect(h.synth).not.toHaveBeenCalled();expect(h.payload).toHaveBeenCalledOnce();
  h.prompt.mockResolvedValue({text:'短答',images:[],sessionId:'direct-stateless',stopReason:'end_turn'});
  await h.app.handleIncomingPayload(h.event('/语音 问题2','3',true));
  await h.app.handleIncomingPayload(h.event('/语音 问题3','3',true));
  await h.app.handleIncomingPayload(h.event('/语音 问题4','3',true));
  expect(h.synth).toHaveBeenCalledTimes(2);expect(h.payload).toHaveBeenCalledTimes(2);
  await h.app.diagnostics.flush();
});
it('only explicit one-shot voice commands speak; normal replies stay text-only and final answer is sent first',async()=>{
  const h=await harness();await h.app.handleIncomingPayload(h.event('普通提问'));
  expect(h.synth).not.toHaveBeenCalled();await h.app.handleIncomingPayload(h.event('/语音 解释测试'));
  expect(h.prompt).toHaveBeenLastCalledWith(expect.objectContaining({text:'解释测试'}));
  expect(h.synth).toHaveBeenCalledWith('最终答案',expect.any(String));expect(h.sent).toHaveBeenCalledOnce();
  expect(h.payload.mock.invocationCallOrder.at(-1)!).toBeLessThan(h.synth.mock.invocationCallOrder[0]!);
  await h.app.handleIncomingPayload(h.event('下一条普通提问'));expect(h.synth).toHaveBeenCalledOnce();await h.app.diagnostics.flush();
});
it('keeps direct reading owner-private only without LLM/history/quote access',async()=>{
  const h=await harness();await h.app.handleIncomingPayload(h.event('/朗读 合成内容'));
  expect(h.prompt).not.toHaveBeenCalled();expect(h.synth).toHaveBeenCalledWith('合成内容',expect.any(String));
  expect(h.app.conversations.getPersisted('direct:1')).toBeUndefined();
  await h.app.handleIncomingPayload(h.event('/tts 不应调用','2',true));await h.app.handleIncomingPayload(h.event('/tts 不应调用','1',true,false));
  expect(h.synth).toHaveBeenCalledOnce();expect(h.text.mock.calls.some(c=>String(c[1]).includes('主人'))).toBe(true);await h.app.diagnostics.flush();
});
it('handles help, status, overlong reading and permanent switches locally without spending API quota',async()=>{
  const h=await harness();for(const text of ['/voice','/voice status','/voice on','/tts '+ '字'.repeat(301)])await h.app.handleIncomingPayload(h.event(text));
  expect(h.prompt).not.toHaveBeenCalled();expect(h.synth).not.toHaveBeenCalled();
  expect(JSON.stringify(h.app.getStatus())).not.toContain('fake-elevenlabs-test-key');await h.app.diagnostics.flush();
});
it('opens explicitly requested short group answers to owners and members, without accompanying text or persistent speech mode',async()=>{
  const h=await harness();
  await h.app.handleIncomingPayload(h.event('/语音 问题','1',true));
  await h.app.handleIncomingPayload(h.event('/voice 另一问题','2',true));
  expect(h.prompt).toHaveBeenCalledTimes(2);expect(h.synth).toHaveBeenCalledTimes(2);expect(h.sent).toHaveBeenCalledTimes(2);
  expect(h.sent).toHaveBeenCalledWith(expect.objectContaining({chatType:'group',targetId:'100'}),expect.any(Buffer),'最终答案');
  expect(h.text).not.toHaveBeenCalled();expect(h.payload).not.toHaveBeenCalled();
  expect(h.app.conversations.getPersisted('group:100').contextTurns).toHaveLength(2);
  await h.app.handleIncomingPayload(h.event('群内普通问题','2',true));
  expect(h.prompt).toHaveBeenCalledTimes(3);expect(h.synth).toHaveBeenCalledTimes(2);expect(h.payload).toHaveBeenCalledOnce();
  await h.app.diagnostics.flush();
});
it('does not allow other private users and reports the separate group/private boundaries',async()=>{
  const h=await harness();await h.app.handleIncomingPayload(h.event('/语音 问题','2'));
  await h.app.handleIncomingPayload(h.event('/朗读 内容','2'));
  expect(h.prompt).not.toHaveBeenCalled();expect(h.synth).not.toHaveBeenCalled();expect(h.sent).not.toHaveBeenCalled();
  expect(h.app.getStatus().config.voice).toMatchObject({ownerOnly:false,privateOnly:false,privateOwnerOnly:true,groupEnabled:true,groupMaxReplyChars:50,groupVoiceOnly:true,automatic:false});
  await h.app.diagnostics.flush();
});
it('preserves a successfully sent textual answer when TTS or QQ voice delivery fails; no extra LLM or poisoned history',async()=>{
  const h=await harness();h.synth.mockRejectedValueOnce(new VoiceError('TTS_PAYMENT_REQUIRED',402));
  await h.app.handleIncomingPayload(h.event('/voice 测试答案'));
  expect(h.prompt).toHaveBeenCalledOnce();expect(h.sent).not.toHaveBeenCalled();
  expect(h.app.conversations.getPersisted('direct:1').contextTurns[0].assistant).toBe('最终答案');
  expect(h.text.mock.calls.at(-1)![1]).toContain('诊断编号');
  h.sent.mockRejectedValueOnce(new Error('PRIVATE_UPSTREAM_BODY'));await h.app.handleIncomingPayload(h.event('/voice 再问一次'));
  expect(h.prompt).toHaveBeenCalledTimes(2);await h.app.diagnostics.flush();
  const log=await readFile(path.join(h.dir,'log.jsonl'),'utf8');expect(log).not.toContain('PRIVATE_UPSTREAM_BODY');expect(log).not.toContain('测试答案');
});
it('does not synthesize when the chatbot fails or voice has already been blocked',async()=>{
  const h=await harness();h.prompt.mockRejectedValueOnce(new DirectApiError('first_byte','FIRST_BYTE_TIMEOUT'));
  await h.app.handleIncomingPayload(h.event('/voice 问题'));expect(h.synth).not.toHaveBeenCalled();
  vi.spyOn(h.app.voice,'assertReady').mockImplementation(()=>{throw new VoiceError('TTS_PAYMENT_REQUIRED',402);});
  await h.app.handleIncomingPayload(h.event('/voice 另一问题'));expect(h.prompt).toHaveBeenCalledOnce();await h.app.diagnostics.flush();
});

it.each([
  ['49 Chinese characters','字'.repeat(49),true],
  ['exactly 50 characters','字'.repeat(50),true],
  ['51 characters','字'.repeat(51),false],
  ['50 emoji code points','😀'.repeat(50),true],
  ['51 emoji code points','😀'.repeat(51),false],
  ['punctuation counts','字'.repeat(49)+'！',true],
  ['interior spaces count','字'.repeat(25)+' '+'字'.repeat(25),false],
  ['raw final markup must not bypass the limit','**'+'字'.repeat(49)+'**',false],
])('enforces the group final-answer boundary: %s',async(_label,answer,speaks)=>{
  const h=await harness();h.prompt.mockResolvedValueOnce({text:String(answer),images:[],sessionId:'direct-stateless',stopReason:'end_turn'});
  await h.app.handleIncomingPayload(h.event('/语音 测试边界','2',true));
  expect(h.prompt).toHaveBeenCalledOnce();expect(h.synth).toHaveBeenCalledTimes(speaks?1:0);expect(h.sent).toHaveBeenCalledTimes(speaks?1:0);
  expect(h.text).not.toHaveBeenCalled();expect(h.payload).toHaveBeenCalledTimes(speaks?0:1);
  if(!speaks)expect(h.payload).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({text:answer}));
  expect(h.app.conversations.getPersisted('group:100').contextTurns[0].assistant).toBe(answer);
  await h.app.diagnostics.flush();
});
it('keeps no-mention, other groups, direct reading, and disabled group speech outside the paid route',async()=>{
  const h=await harness();
  await h.app.handleIncomingPayload(h.event('/语音 不应处理','2',true,false));
  await h.app.handleIncomingPayload({...h.event('/语音 不应处理','2',true),group_id:'200'});
  await h.app.handleIncomingPayload(h.event('/朗读 不应朗读','1',true));
  await h.app.handleIncomingPayload(h.event('/tts 不应朗读','2',true));
  expect(h.prompt).not.toHaveBeenCalled();expect(h.synth).not.toHaveBeenCalled();expect(h.sent).not.toHaveBeenCalled();
  const closed=await harness({BOT_VOICE_GROUP_ENABLED:'false'});
  await closed.app.handleIncomingPayload(closed.event('/语音 问题','1',true));
  expect(closed.prompt).not.toHaveBeenCalled();expect(closed.synth).not.toHaveBeenCalled();
  expect(closed.app.getStatus().config.voice).toMatchObject({privateOnly:true,ownerOnly:true,groupEnabled:false});
  await h.app.diagnostics.flush();await closed.app.diagnostics.flush();
});
it('handles group help/status/on locally and suppresses progress for voice-only answers',async()=>{
  const h=await harness({ONEBOT_PROGRESS_MODE:'message'});
  for(const command of ['/voice','/voice status','/voice on'])await h.app.handleIncomingPayload(h.event(command,'1',true));
  expect(h.prompt).not.toHaveBeenCalled();expect(h.synth).not.toHaveBeenCalled();
  expect(String(h.text.mock.calls[0]![1])).toContain('只发语音');h.text.mockClear();
  await h.app.handleIncomingPayload(h.event('/语音 问题','1',true));
  expect(h.sent).toHaveBeenCalledOnce();expect(h.text).not.toHaveBeenCalled();expect(h.payload).not.toHaveBeenCalled();
  await h.app.diagnostics.flush();
});
it.each([['member',3,1],['admin',5,2],['group owner',5,2],['self',7,7]] as const)('enforces separate voice and normal limits, falling back only while normal quota remains: %s',async(tier,normalLimit,voiceLimit)=>{
  const h=await harness();vi.mocked(h.app.gateway.getGroupMemberRole).mockResolvedValue(tier==='admin'?'admin':tier==='group owner'?'owner':'member');
  const user=tier==='self'?'1':'2';
  for(let n=0;n<normalLimit+(tier==='self'?0:1);n++)await h.app.handleIncomingPayload(h.event('/语音 问题',user,true));
  expect(h.prompt).toHaveBeenCalledTimes(normalLimit);expect(h.synth).toHaveBeenCalledTimes(voiceLimit);expect(h.sent).toHaveBeenCalledTimes(voiceLimit);
  expect(h.payload).toHaveBeenCalledTimes(normalLimit-voiceLimit);expect(h.text).not.toHaveBeenCalled();
  if(tier!=='self')expect(h.app.gateway.getGroupMemberRole).toHaveBeenCalledOnce();
  await h.app.diagnostics.flush();
});
it('counts ordinary replies and short voices in the same normal allowance, without charging voice quota for long answers',async()=>{
  const h=await harness();
  h.prompt.mockResolvedValueOnce({text:'字'.repeat(51),images:[],sessionId:'direct-stateless',stopReason:'end_turn'});
  await h.app.handleIncomingPayload(h.event('/语音 长答案','2',true));
  await h.app.handleIncomingPayload(h.event('/语音 短答案','2',true));
  await h.app.handleIncomingPayload(h.event('普通问题','2',true));
  await h.app.handleIncomingPayload(h.event('/语音 不应处理','2',true));
  expect(h.prompt).toHaveBeenCalledTimes(3);expect(h.synth).toHaveBeenCalledOnce();expect(h.sent).toHaveBeenCalledOnce();expect(h.payload).toHaveBeenCalledTimes(2);
  await h.app.diagnostics.flush();
});
it('does not consume a voice slot on failure, but still charges the normal reply allowance',async()=>{
  const h=await harness();h.synth.mockRejectedValueOnce(new VoiceError('TTS_BUSY'));
  for(let n=0;n<4;n++)await h.app.handleIncomingPayload(h.event('/语音 问题','2',true));
  expect(h.prompt).toHaveBeenCalledTimes(3);expect(h.synth).toHaveBeenCalledTimes(2);expect(h.sent).toHaveBeenCalledOnce();expect(h.payload).toHaveBeenCalledTimes(2);
  await h.app.diagnostics.flush();
});
it.each(['synthesis','QQ delivery'])('falls back once to the complete text after group %s failure without extra model calls',async(stage)=>{
  const h=await harness();
  if(stage==='synthesis')h.synth.mockRejectedValueOnce(new VoiceError('TTS_RATE_LIMIT'));
  else h.sent.mockRejectedValueOnce(new Error('PRIVATE_UPSTREAM_BODY'));
  await h.app.handleIncomingPayload(h.event('/语音 测试答案','2',true));
  expect(h.prompt).toHaveBeenCalledOnce();expect(h.synth).toHaveBeenCalledOnce();expect(h.text).not.toHaveBeenCalled();
  expect(h.payload).toHaveBeenCalledOnce();expect(h.payload).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({text:'最终答案'}));
  expect(h.app.conversations.getPersisted('group:100').contextTurns[0].assistant).toBe('最终答案');
  await h.app.diagnostics.flush();const log=await readFile(path.join(h.dir,'log.jsonl'),'utf8');
  expect(log).toContain('GROUP_VOICE_TEXT_FALLBACK');expect(log).not.toContain('PRIVATE_UPSTREAM_BODY');expect(log).not.toContain('测试答案');
});
it('never blocks a long group textual answer on TTS readiness or attempts a paid truncated excerpt',async()=>{
  const h=await harness();const ready=vi.spyOn(h.app.voice,'assertReady').mockImplementation(()=>{throw new VoiceError('TTS_PAYMENT_REQUIRED',402);});
  const answer='字'.repeat(51);h.prompt.mockResolvedValueOnce({text:answer,images:[],sessionId:'direct-stateless',stopReason:'end_turn'});
  await h.app.handleIncomingPayload(h.event('/语音 问题','2',true));
  expect(ready).not.toHaveBeenCalled();expect(h.synth).not.toHaveBeenCalled();expect(h.sent).not.toHaveBeenCalled();
  expect(h.payload).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({text:answer}));await h.app.diagnostics.flush();
});
it('does not send a truncated voice as a successful voice-only group answer',async()=>{
  const h=await harness();h.synth.mockResolvedValueOnce({audio:Buffer.from('ID3\x04FAKE'),text:'不完整的答案',truncated:true,cached:false});
  await h.app.handleIncomingPayload(h.event('/语音 问题','2',true));
  expect(h.sent).not.toHaveBeenCalled();expect(h.payload).toHaveBeenCalledOnce();
  expect(h.payload).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({text:'最终答案'}));await h.app.diagnostics.flush();
});
it('keeps image attachments without duplicating short voiced text',async()=>{
  const h=await harness();h.prompt.mockResolvedValueOnce({text:'这是一张图',images:[{mimeType:'image/png',base64Data:'dGVzdA=='}],sessionId:'direct-stateless',stopReason:'end_turn'});
  await h.app.handleIncomingPayload(h.event('/语音 问题','2',true));
  expect(h.sent).toHaveBeenCalledOnce();expect(h.payload).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({text:'',mediaImages:expect.any(Array)}));
  expect(h.payload.mock.calls[0]![1]).toMatchObject({mediaImages:[expect.anything()]});await h.app.diagnostics.flush();
});
it('voices short local clarifications without invoking the model or duplicating text',async()=>{
  const h=await harness();await h.app.handleIncomingPayload(h.event('/语音 天气怎么样','2',true));
  expect(h.prompt).not.toHaveBeenCalled();expect(h.synth).toHaveBeenCalledOnce();expect(h.sent).toHaveBeenCalledOnce();
  expect(h.payload).not.toHaveBeenCalled();expect(h.text).not.toHaveBeenCalled();await h.app.diagnostics.flush();
});
