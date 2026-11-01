import https from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, chmod, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket, type ClientOptions } from 'ws';
import type { AppConfig } from '../config/index.js';
import type { Diagnostics } from '../infra/diagnostics.js';

type VoiceConfig = AppConfig['voice'];
export class VoiceError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number, readonly upstreamCode?: string, readonly reason?: string) {
    super(code); this.name = 'VoiceError';
  }
}
export interface SpeechRequest { key: string; voiceId: string; model: string; text: string; timeoutMs: number; maxBytes: number; stability?: number }
export interface SpeechResult { audio: Buffer; requestId?: string; chargedChars?: number }
export type SpeechTransport = (request: SpeechRequest) => Promise<SpeechResult>;

export function prepareSpeechText(value: string, maxChars: number): { text: string; truncated: boolean } {
  let text = value.replace(/```[\s\S]*?```/gu, '代码请看文字。').replace(/\[CQ:[^\]\n]*\]/gu, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1').replace(/https?:\/\/[^\s<>]+/gu, '')
    .replace(/\bsk[-_][A-Za-z0-9_-]{16,}/gu, '密钥已隐藏').replace(/[*_`#]/gu, '').replace(/\s+/gu, ' ').trim();
  const chars = [...text], truncated = chars.length > maxChars;
  if (truncated) text = chars.slice(0, maxChars - 10).join('') + '，其余内容请看文字。';
  return { text, truncated };
}

export function validMp3(audio: Buffer): boolean {
  return audio.length >= 4 && (audio.subarray(0, 3).toString() === 'ID3' || (audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0));
}

/** Fixed official host; no redirect, proxy SDK, request stitching, or automatic paid retry. */
export const requestRestSpeech: SpeechTransport = async input => new Promise((resolve, reject) => {
  const payload = Buffer.from(JSON.stringify({text:input.text,model_id:input.model,
    ...(input.stability !== undefined ? {voice_settings:{stability:input.stability}} : {}),
    ...(input.model !== 'eleven_multilingual_v2' ? {language_code:'zh'} : {})}));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new VoiceError('TTS_TIMEOUT')), input.timeoutMs);
  const req = https.request(new URL(`https://api.elevenlabs.io/v1/text-to-speech/${input.voiceId}?output_format=mp3_44100_128`), {
    method:'POST',agent:false,signal:controller.signal,
    headers:{'xi-api-key':input.key,'content-type':'application/json',accept:'audio/mpeg','content-length':payload.length},
  }, response => {
    let bytes=0;const chunks:Buffer[]=[];
    const status=response.statusCode??0, success=status>=200&&status<300;
    response.on('data',(chunk:Buffer)=>{
      bytes+=chunk.length;
      if(bytes>(success?input.maxBytes:16384)){req.destroy(new VoiceError('TTS_RESPONSE_TOO_LARGE'));return;}
      chunks.push(chunk);
    });
    response.once('end',()=>{
      clearTimeout(timer);const audio=Buffer.concat(chunks);
      if(!success){
        let upstreamCode: string|undefined, reason: string|undefined;
        try {
          const detail=JSON.parse(audio.toString()).detail;
          const code=String(detail?.code??detail?.status??'');
          if(/^[A-Za-z0-9_-]{1,80}$/u.test(code))upstreamCode=code;
          const message=String(detail?.message??'');
          if(/free users.*library voices/iu.test(message))reason='VOICE_REQUIRES_PAID_PLAN';
          else if(/not enough|insufficient|quota|credits|balance/iu.test(message))reason='INSUFFICIENT_CREDITS';
        }catch{ /* Never propagate raw upstream bodies or error messages. */ }
        reject(new VoiceError(status===402?'TTS_PAYMENT_REQUIRED':status===401||status===403?'TTS_AUTH_PERMISSION':`TTS_HTTP_${status}`,status,upstreamCode,reason));return;
      }
      if(!String(response.headers['content-type']??'').toLowerCase().startsWith('audio/mpeg')||!validMp3(audio)){
        reject(new VoiceError('TTS_INVALID_AUDIO'));return;
      }
      const rawId=response.headers['request-id'],id=typeof rawId==='string'&&/^[A-Za-z0-9._:-]{1,128}$/u.test(rawId)?rawId:undefined;
      const cost=Number(response.headers['character-cost']);
      resolve({audio,requestId:id,chargedChars:Number.isFinite(cost)&&cost>=0?cost:undefined});
    });
    response.once('error',()=>{clearTimeout(timer);reject(controller.signal.aborted?controller.signal.reason:new VoiceError('TTS_BODY_FAILED'));});
    response.once('aborted',()=>{clearTimeout(timer);reject(new VoiceError('TTS_BODY_ABORTED'));});
  });
  req.once('error',error=>{clearTimeout(timer);reject(controller.signal.aborted?controller.signal.reason:error instanceof VoiceError?error:new VoiceError('TTS_NETWORK'));});
  req.end(payload);
});

type VoiceSocketFactory = (url:URL,options:ClientOptions)=>WebSocket;
/** v4 Turbo uses the dialogue WebSocket, not the older single-voice REST endpoint. */
export function requestDialogueSpeech(input:SpeechRequest,connect:VoiceSocketFactory=(url,options)=>new WebSocket(url,options)):Promise<SpeechResult>{
  return new Promise((resolve,reject)=>{
    const url=new URL('wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input');
    url.searchParams.set('model_id',input.model);url.searchParams.set('output_format','mp3_44100_128');url.searchParams.set('language_code','zh');
    const socket=connect(url,{headers:{'xi-api-key':input.key},followRedirects:false,handshakeTimeout:Math.min(10000,input.timeoutMs),
      maxPayload:Math.ceil(input.maxBytes*4/3)+8192,perMessageDeflate:false});
    let settled=false,bytes=0,wireBytes=0,requestId:string|undefined;const chunks:Buffer[]=[];
    const finish=(error?:VoiceError):void=>{
      if(settled)return;settled=true;clearTimeout(timer);
      const audio=Buffer.concat(chunks);
      if(error)reject(error);else if(!validMp3(audio))reject(new VoiceError('TTS_INVALID_AUDIO'));else resolve({audio,requestId});
      if(socket.readyState!==WebSocket.CLOSED)socket.terminate();
    };
    const timer=setTimeout(()=>finish(new VoiceError('TTS_TIMEOUT')),input.timeoutMs);
    socket.once('upgrade',response=>{const id=response.headers['request-id'];if(typeof id==='string'&&/^[A-Za-z0-9._:-]{1,128}$/u.test(id))requestId=id;});
    socket.once('unexpected-response',(_req,response)=>{
      const status=response.statusCode??0;response.destroy();finish(new VoiceError(status===402?'TTS_PAYMENT_REQUIRED':status===401||status===403?'TTS_AUTH_PERMISSION':`TTS_HTTP_${status}`,status));
    });
    socket.once('open',()=>{
      if(settled)return;
      socket.send(JSON.stringify({voices:[input.voiceId],...(input.stability!==undefined?{voice_settings:{stability:input.stability}}:{})}));
      socket.send(JSON.stringify({inputs:[{text:input.text,voice_id:input.voiceId,new_turn:false}]}));
      socket.send(JSON.stringify({close_socket:true}));
    });
    socket.on('message',(raw,isBinary)=>{
      if(settled)return;
      const frame=Buffer.isBuffer(raw)?raw:raw instanceof ArrayBuffer?Buffer.from(raw):Buffer.concat(raw);
      wireBytes+=frame.length;
      if(isBinary||wireBytes>input.maxBytes*2+65536){finish(new VoiceError('TTS_RESPONSE_TOO_LARGE'));return;}
      try{
        const message=JSON.parse(frame.toString());
        if(message.error){
          const code=typeof message.error==='string'?message.error:'';
          const safe=/^[A-Za-z0-9_-]{1,80}$/u.test(code)?code:undefined;
          finish(new VoiceError(/payment|credits|quota/iu.test(code)?'TTS_PAYMENT_REQUIRED':/auth|permission/iu.test(code)?'TTS_AUTH_PERMISSION':'TTS_WS_ERROR',undefined,safe));return;
        }
        if(message.audio!==undefined){
          if(typeof message.audio!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/u.test(message.audio)){finish(new VoiceError('TTS_INVALID_AUDIO'));return;}
          const chunk=Buffer.from(message.audio,'base64');bytes+=chunk.length;
          if(bytes>input.maxBytes){finish(new VoiceError('TTS_RESPONSE_TOO_LARGE'));return;}chunks.push(chunk);
        }
        if(message.is_final===true)finish();
      }catch{finish(new VoiceError('TTS_INVALID_RESPONSE'));}
    });
    socket.once('error',()=>finish(new VoiceError('TTS_NETWORK')));
    socket.once('close',()=>{if(!settled)finish(new VoiceError('TTS_INCOMPLETE_AUDIO'));});
  });
}

export const requestSpeech:SpeechTransport=input=>input.model==='eleven_v4_turbo'?requestDialogueSpeech(input):requestRestSpeech(input);

export function voiceErrorMessage(error: unknown): string {
  const e=error instanceof VoiceError?error:undefined;
  if(e?.code==='TTS_PAYMENT_REQUIRED')return e.reason==='VOICE_REQUIRES_PAID_PLAN'
    ? '当前音色不允许免费账户通过API使用，请本人更换免费可用音色或确认套餐；没有自动充值。'
    : '语音服务要求付款或可用额度不足，请本人确认试用额度、API资格和音色权限；没有自动充值。';
  if(e?.code==='TTS_AUTH_PERMISSION')return '语音密钥或接口权限不足，请本人检查Text to Speech权限。';
  if(e?.code==='TTS_DISABLED')return '当前语音尚未启用，普通文字回复不受影响。';
  if(e?.code==='TTS_BUSY')return '正在合成另一条语音，请稍后再试。';
  if(e?.code==='TTS_RATE_LIMIT')return '语音试用每30秒最多一次，请稍后再试。';
  if(e?.code==='TTS_DAILY_LIMIT')return '已到本机语音每日字符保护上限，今天不再发起新合成。';
  if(e?.code==='TTS_TEXT_EMPTY')return '没有可朗读的正文，请提供文字。';
  if(e?.code==='TTS_TIMEOUT')return '语音合成超时，未自动重试；文字回答仍保留。';
  if(e?.code==='TTS_USAGE_FILE')return '语音用量保护文件不可用，已暂停新合成，请本人检查本机文件。';
  if(e?.code.startsWith('QQ_VOICE_'))return '语音已合成，但本地QQ语音转码失败，未自动重新合成；文字回答仍保留。';
  return '本次语音未能完成，未自动重试；文字回答仍保留。';
}

/** Caller enforces owner-private/group permissions; global bounded usage and RAM cache. */
export class VoiceService {
  private busy=false;
  private lastAttempt=Number.NEGATIVE_INFINITY;
  private blocked?:VoiceError;
  private readonly cache=new Map<string,{audio:Buffer;until:number}>();
  constructor(private readonly config:VoiceConfig,private readonly diagnostics:Diagnostics,
    private readonly transport:SpeechTransport=requestSpeech,private readonly now:()=>number=Date.now){}
  status():Record<string,unknown>{return {enabled:this.config.enabled,configured:Boolean(this.config.apiKey),model:this.config.model,stability:this.config.stability,
    voiceId:this.config.voiceId,voiceLabel:this.config.voiceId?'自定义音色':'未配置',
    delivery:this.config.delivery,effectiveDelivery:this.deliveryPrefix()?'lively':'neutral',
    transport:this.config.model==='eleven_v4_turbo'?'elevenlabs-dialogue-websocket':'elevenlabs-tts-https',qqAudioFormat:'silk-local',
    maxChars:this.config.maxChars,dailyChars:this.config.dailyChars,ownerOnly:!this.config.groupEnabled,privateOnly:!this.config.groupEnabled,
    privateOwnerOnly:true,groupEnabled:this.config.groupEnabled,groupMaxReplyChars:this.config.groupMaxReplyChars,groupVoiceOnly:true,
    groupTriggerCommands:['语音','voice'],groupRateLimits:this.config.groupRateLimits,groupSharedCooldown:false,
    directReadOwnerPrivateOnly:true,automatic:false,busy:this.busy,
    blockedCode:this.blocked?.code,blockedReason:this.blocked?.reason};}
  assertReady():void{
    if(!this.config.enabled||!this.config.apiKey)throw new VoiceError('TTS_DISABLED');
    if(this.blocked)throw this.blocked;
    if(this.busy)throw new VoiceError('TTS_BUSY');
  }
  private deliveryPrefix():string{
    return this.config.delivery==='lively'&&['eleven_v4_turbo','eleven_v3'].includes(this.config.model)?'[happy] ':'';
  }
  private async reserve(chars:number):Promise<void>{
    const file=this.config.usageFile,day=new Date(this.now()+8*3600_000).toISOString().slice(0,10);
    let used=0;
    try {
      const stat=await lstat(file);
      if(!stat.isFile()||stat.size>4096)throw new Error();
      const value=JSON.parse(await readFile(file,'utf8'));
      if(value.version!==1||!/^\d{4}-\d{2}-\d{2}$/u.test(value.day)||!Number.isSafeInteger(value.chars)||value.chars<0)throw new Error();
      if(value.day===day)used=value.chars;
    }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new VoiceError('TTS_USAGE_FILE');}
    if(used+chars>this.config.dailyChars)throw new VoiceError('TTS_DAILY_LIMIT');
    try {
      await mkdir(path.dirname(file),{recursive:true,mode:0o700});
      const temp=`${file}.${randomUUID()}.tmp`;
      await writeFile(temp,JSON.stringify({version:1,day,chars:used+chars})+'\n',{mode:0o600,flag:'wx'});
      await chmod(temp,0o600);await rename(temp,file);
    }catch{throw new VoiceError('TTS_USAGE_FILE');}
  }
  async synthesize(value:string,correlationId?:string,scope:'private'|'group'='private'):Promise<{audio:Buffer;text:string;truncated:boolean;cached:boolean}>{
    this.assertReady();
    if(scope==='group'&&!this.config.groupEnabled)throw new VoiceError('TTS_GROUP_DISABLED');
    const prefix=this.deliveryPrefix();
    const prepared=prepareSpeechText(value,this.config.maxChars-prefix.length);
    if(scope==='group'&&prepared.truncated)throw new VoiceError('TTS_TEXT_TOO_LONG');
    if(!prepared.text)throw new VoiceError('TTS_TEXT_EMPTY');
    const speechText=prefix+prepared.text;
    const key=createHash('sha256').update(`${this.config.voiceId}:${this.config.model}:${this.config.stability}:${speechText}`).digest('hex');
    const cached=this.cache.get(key);
    if(cached&&cached.until>this.now()){
      this.diagnostics.record('tts_cache','ok',{correlationId,bytes:cached.audio.length});
      return{...prepared,audio:cached.audio,cached:true};
    }
    if(scope==='private'&&this.now()-this.lastAttempt<30000)throw new VoiceError('TTS_RATE_LIMIT');
    this.busy=true;
    const started=this.now();
    this.diagnostics.record('tts_request','start',{correlationId,inputChars:[...speechText].length});
    try {
      await this.reserve([...speechText].length);if(scope==='private')this.lastAttempt=this.now();
      const result=await this.transport({key:this.config.apiKey!,voiceId:this.config.voiceId,model:this.config.model,text:speechText,
        timeoutMs:this.config.timeoutMs,maxBytes:this.config.maxAudioBytes,stability:this.config.stability});
      if(result.audio.length>this.config.maxAudioBytes||!validMp3(result.audio))throw new VoiceError('TTS_INVALID_AUDIO');
      for(const[id,item]of this.cache)if(item.until<=this.now())this.cache.delete(id);
      while(this.cache.size>=4)this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key,{audio:result.audio,until:this.now()+600000});
      this.diagnostics.record('tts_request','ok',{correlationId,bytes:result.audio.length,durationMs:this.now()-started,requestId:result.requestId,
        count:result.chargedChars,truncated:prepared.truncated});
      return{...prepared,audio:result.audio,cached:false};
    }catch(error){
      const e=error instanceof VoiceError?error:new VoiceError('TTS_FAILED');
      if(['TTS_PAYMENT_REQUIRED','TTS_AUTH_PERMISSION'].includes(e.code))this.blocked=e;
      this.diagnostics.record('tts_request','error',{correlationId,code:e.code,httpStatus:e.httpStatus,durationMs:this.now()-started});
      throw e;
    }finally{this.busy=false;}
  }
}
