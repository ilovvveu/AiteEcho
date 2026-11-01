import { mkdtemp, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { loadConfig } from '../config/index.js';
import { Diagnostics } from '../infra/diagnostics.js';
import { VoiceService, VoiceError, prepareSpeechText, voiceErrorMessage, type SpeechTransport } from './voice.js';

const audio:Buffer=Buffer.from('ID3\x04FAKE_SYNTHETIC_MP3');
async function harness(extra:Record<string,string>={}){
  const dir=await mkdtemp(path.join(tmpdir(),'qq-voice-')),usage=path.join(dir,'usage.json'),log=path.join(dir,'trace.jsonl');
  const c=loadConfig({BOT_VOICE_ENABLED:'true',ELEVENLABS_VOICE_ID:'SyntheticVoice7310000',ELEVENLABS_API_KEY:'test-secret-voice-key-731',BOT_VOICE_USAGE_FILE:usage,...extra});
  let now=Date.now();const transport=vi.fn<SpeechTransport>(async()=>({audio})),diagnostics=new Diagnostics(log);
  const service=new VoiceService(c.voice,diagnostics,transport,()=>now);
  return{service,transport,diagnostics,usage,log,tick:(ms:number)=>{now+=ms;}};
}
it('cleans presentation text and caps speech without sending keys, URLs, code or CQ payloads',()=>{
  const p=prepareSpeechText('**你好** [示例](https://example.org) [CQ:image,file=x] ' + 'sk_' + 'A'.repeat(24) + ' ```js\nSECRET_CODE\n```',300);
  expect(p.text).toContain('你好');expect(p.text).toContain('示例');expect(p.text).not.toMatch(/https|CQ:|TESTKEY|SECRET_CODE/);
  const long=prepareSpeechText('字'.repeat(800),300);expect([...long.text]).toHaveLength(300);expect(long.truncated).toBe(true);
});
it('reserves daily usage privately, caches repeats without new API cost and logs metadata only',async()=>{
  const h=await harness();await h.service.synthesize('合成测试','voice-731');await h.service.synthesize('合成测试','voice-732');
  expect(h.transport).toHaveBeenCalledOnce();expect(h.transport.mock.calls[0]).toBeDefined();
  expect(JSON.parse(await readFile(h.usage,'utf8')).chars).toBe(4);expect((await stat(h.usage)).mode&0o777).toBe(0o600);
  await h.diagnostics.flush();const log=await readFile(h.log,'utf8');
  expect(log).toContain('tts_cache');expect(log).not.toContain('合成测试');expect(log).not.toContain('test-secret-voice-key');
  expect(JSON.stringify(h.service.status())).not.toContain('test-secret-voice-key');
});
it('uses a configurable voice with a bounded v4 audio tag, counts it in budget, and never changes returned text',async()=>{
  const h=await harness({ELEVENLABS_DELIVERY:'lively'});
  const result=await h.service.synthesize('你好呀');
  expect(h.transport).toHaveBeenCalledWith(expect.objectContaining({voiceId:'SyntheticVoice7310000',model:'eleven_v4_turbo',text:'[happy] 你好呀'}));
  expect(result.text).toBe('你好呀');expect(JSON.parse(await readFile(h.usage,'utf8')).chars).toBe(11);
  expect(h.service.status()).toMatchObject({delivery:'lively',effectiveDelivery:'lively',privateOnly:true});
  h.tick(31000);await h.service.synthesize('字'.repeat(500));
  expect([...(h.transport.mock.calls[1]![0] as unknown as {text:string}).text]).toHaveLength(300);
  const legacy=await harness({ELEVENLABS_DELIVERY:'lively',ELEVENLABS_MODEL:'eleven_flash_v2_5'});
  await legacy.service.synthesize('你好呀');expect(legacy.transport).toHaveBeenCalledWith(expect.objectContaining({text:'你好呀'}));
  expect(legacy.service.status()).toMatchObject({effectiveDelivery:'neutral'});
});
it('rate-limits cache misses, keeps budget across service restart and resets on a new Beijing day',async()=>{
  const h=await harness({BOT_VOICE_DAILY_CHARS:'100'});await h.service.synthesize('甲'.repeat(60));
  await expect(h.service.synthesize('乙')).rejects.toMatchObject({code:'TTS_RATE_LIMIT'});h.tick(31000);
  await expect(h.service.synthesize('乙'.repeat(60))).rejects.toMatchObject({code:'TTS_DAILY_LIMIT'});
  const c=loadConfig({BOT_VOICE_ENABLED:'true',ELEVENLABS_VOICE_ID:'SyntheticVoice7310000',ELEVENLABS_API_KEY:'test-secret-voice-key-731',BOT_VOICE_USAGE_FILE:h.usage,BOT_VOICE_DAILY_CHARS:'100'});
  const next=new VoiceService(c.voice,h.diagnostics,h.transport);
  await expect(next.synthesize('丙'.repeat(60))).rejects.toMatchObject({code:'TTS_DAILY_LIMIT'});
  h.tick(86400000);await h.service.synthesize('明天测试');expect(h.transport).toHaveBeenCalledTimes(2);
});
it('fails closed for corrupt or symlink usage files',async()=>{
  const h=await harness();await writeFile(h.usage,'broken');
  await expect(h.service.synthesize('测试')).rejects.toMatchObject({code:'TTS_USAGE_FILE'});expect(h.transport).not.toHaveBeenCalled();
  const other=await harness();await symlink(h.usage,other.usage);
  await expect(other.service.synthesize('测试')).rejects.toMatchObject({code:'TTS_USAGE_FILE'});expect(other.transport).not.toHaveBeenCalled();
});
it('separates group timing from the private 30-second interval without bypassing daily budget or enablement',async()=>{
  const h=await harness({BOT_VOICE_GROUP_ENABLED:'true',BOT_VOICE_DAILY_CHARS:'100'});
  await h.service.synthesize('甲'.repeat(25),'group-1','group');
  await h.service.synthesize('乙'.repeat(25),'group-2','group');
  await h.service.synthesize('私聊','private-1');
  await h.service.synthesize('丙'.repeat(25),'group-3','group');
  await expect(h.service.synthesize('下一条私聊')).rejects.toMatchObject({code:'TTS_RATE_LIMIT'});
  await expect(h.service.synthesize('丁'.repeat(25),'group-4','group')).rejects.toMatchObject({code:'TTS_DAILY_LIMIT'});
  expect(h.transport).toHaveBeenCalledTimes(4);
  const closed=await harness();await expect(closed.service.synthesize('不应合成','group-closed','group')).rejects.toMatchObject({code:'TTS_GROUP_DISABLED'});
  expect(closed.transport).not.toHaveBeenCalled();
});
it('does not retry paid failures and blocks subsequent calls after payment/permission errors',async()=>{
  const h=await harness();h.transport.mockRejectedValueOnce(new VoiceError('TTS_PAYMENT_REQUIRED',402,'payment_required','VOICE_REQUIRES_PAID_PLAN'));
  await expect(h.service.synthesize('测试')).rejects.toMatchObject({code:'TTS_PAYMENT_REQUIRED'});h.tick(31000);
  await expect(h.service.synthesize('再试')).rejects.toMatchObject({code:'TTS_PAYMENT_REQUIRED'});expect(h.transport).toHaveBeenCalledOnce();
  expect(h.service.status()).toMatchObject({blockedCode:'TTS_PAYMENT_REQUIRED'});
  expect(voiceErrorMessage(new VoiceError('TTS_PAYMENT_REQUIRED',402,'payment_required','VOICE_REQUIRES_PAID_PLAN'))).toContain('音色');
});
it('does not charge for a group reply that would be truncated by the private TTS character budget',async()=>{
  const h=await harness({BOT_VOICE_GROUP_ENABLED:'true',BOT_VOICE_MAX_CHARS:'20',ELEVENLABS_DELIVERY:'lively'});
  await expect(h.service.synthesize('字'.repeat(20),'group-budget','group')).rejects.toMatchObject({code:'TTS_TEXT_TOO_LONG'});
  expect(h.transport).not.toHaveBeenCalled();
});
it('limits concurrent synthesis globally and bounds the cache to four entries',async()=>{
  const h=await harness();let release:((r:{audio:Buffer})=>void)|undefined;
  h.transport.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));const first=h.service.synthesize('第一条');
  await expect(h.service.synthesize('第二条')).rejects.toMatchObject({code:'TTS_BUSY'});
  for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,1));release!({audio});await first;
  for(let i=0;i<5;i++){h.tick(31000);await h.service.synthesize(`缓存${i}`);}
  expect((h.service as any).cache.size).toBe(4);
});
it('rejects empty, disabled and invalid audio without exposing raw failures',async()=>{
  const h=await harness();await expect(h.service.synthesize('https://example.org')).rejects.toMatchObject({code:'TTS_TEXT_EMPTY'});
  h.transport.mockResolvedValueOnce({audio:Buffer.from('{"error":"secret"}')});
  await expect(h.service.synthesize('测试')).rejects.toMatchObject({code:'TTS_INVALID_AUDIO'});
  const disabled=new VoiceService(loadConfig({}).voice,h.diagnostics,h.transport);
  await expect(disabled.synthesize('测试')).rejects.toMatchObject({code:'TTS_DISABLED'});
});
