import https from 'node:https';
import http from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { requestSpeech } from './voice.js';
afterEach(()=>vi.restoreAllMocks());

it('posts only this speech text to the official endpoint and validates binary audio; no stitching or redirect/retry',async()=>{
  let calls=0;const bodies:any[]=[];const incoming:any[]=[];
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);bodies.push(JSON.parse(Buffer.concat(chunks).toString()));calls++;
    if(calls===1){res.setHeader('content-type','audio/mpeg');res.setHeader('request-id','test-731');res.end(Buffer.from('ID3\x04TEST'));}
    else if(calls===2){res.statusCode=402;res.end(JSON.stringify({detail:{status:'payment_required',message:'Free users cannot use library voices via the API. SECRET_BODY'}}));}
    else if(calls===3){res.statusCode=302;res.setHeader('location','https://evil.invalid/steal');res.end('redirect');}
    else {res.setHeader('content-type','application/json');res.end('{"secret":"BODY"}');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error();
  vi.spyOn(https,'request').mockImplementation(((url:any,options:any,callback:any)=>{
    incoming.push({url:String(url),headers:options.headers});return http.request(`http://127.0.0.1:${address.port}/speech`,options,callback);
  })as any);
  const input={key:'SYNTHETIC_KEY_NOT_PRIVATE',voiceId:'EXAVITQu4vr4xnSDxMaL',model:'eleven_flash_v2_5',text:'只读本轮',timeoutMs:1000,maxBytes:1024};
  try{
    const result=await requestSpeech(input);expect(result.audio.subarray(0,3).toString()).toBe('ID3');
    expect(incoming[0].url).toMatch(/^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\//);
    expect(incoming[0].headers['xi-api-key']).toBe(input.key);
    expect(bodies[0]).toEqual({text:input.text,model_id:input.model,language_code:'zh'});
    await expect(requestSpeech(input)).rejects.toMatchObject({code:'TTS_PAYMENT_REQUIRED',reason:'VOICE_REQUIRES_PAID_PLAN'});
    await expect(requestSpeech(input)).rejects.toMatchObject({code:'TTS_HTTP_302'});expect(calls).toBe(3);
    await expect(requestSpeech(input)).rejects.toMatchObject({code:'TTS_INVALID_AUDIO'});
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
it('enforces a total timeout even when the server sends no response',async()=>{
  const server=http.createServer(()=>{});server.listen(0,'127.0.0.1');await once(server,'listening');
  const a=server.address();if(!a||typeof a==='string')throw new Error();
  vi.spyOn(https,'request').mockImplementation(((url:any,options:any,callback:any)=>http.request(`http://127.0.0.1:${a.port}`,options,callback))as any);
  try{await expect(requestSpeech({key:'SYNTHETIC_KEY',voiceId:'EXAVITQu4vr4xnSDxMaL',model:'eleven_flash_v2_5',text:'测试',timeoutMs:40,maxBytes:1024})).rejects.toMatchObject({code:'TTS_TIMEOUT'});}
  finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
