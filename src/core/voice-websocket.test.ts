import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { requestDialogueSpeech } from './voice.js';

async function serverFor(mode:'ok'|'partial'|'error'|'oversize'|'timeout'){
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  const addr=server.address();if(!addr||typeof addr==='string')throw new Error();const frames:any[]=[];
  server.on('connection',(socket,req)=>{
    expect(req.headers['xi-api-key']).toBe('SYNTHETIC_KEY');
    socket.on('message',raw=>{
      const msg=JSON.parse(raw.toString());frames.push(msg);if(!msg.close_socket)return;
      if(mode==='timeout')return;
      if(mode==='error'){socket.send(JSON.stringify({error:'payment_required',message:'PRIVATE_BODY'}));return;}
      const audio=Buffer.from(mode==='oversize'?'ID3'+'A'.repeat(2000):'ID3\x04TEST');
      socket.send(JSON.stringify({audio:audio.subarray(0,3).toString('base64')}));
      socket.send(JSON.stringify({audio:audio.subarray(3).toString('base64')}));
      if(mode==='partial'){socket.close();return;}
      socket.send(JSON.stringify({is_final_audio_for_turn:true}));socket.send(JSON.stringify({is_final:true}));
    });
  });
  const input={key:'SYNTHETIC_KEY',voiceId:'EXAVITQu4vr4xnSDxMaL',model:'eleven_v4_turbo',text:'中文测试',timeoutMs:300,maxBytes:1024,stability:0.5};
  const connect=(url:URL,options:any)=>{
    expect(url.host).toBe('api.elevenlabs.io');expect(url.searchParams.get('model_id')).toBe('eleven_v4_turbo');
    expect(url.searchParams.has('xi_api_key')).toBe(false);expect(options.followRedirects).toBe(false);
    return new WebSocket(`ws://127.0.0.1:${addr.port}`,options);
  };
  const stop=async()=>{for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));};
  return{input,connect,frames,stop};
}
it('registers one voice, sends only this text and collects final audio without history, speed or unsupported style controls',async()=>{
  const h=await serverFor('ok');
  try{
    const result=await requestDialogueSpeech(h.input,h.connect);expect(result.audio.toString()).toBe('ID3\x04TEST');
    expect(h.frames).toEqual([{voices:[h.input.voiceId],voice_settings:{stability:0.5}},
      {inputs:[{text:h.input.text,voice_id:h.input.voiceId,new_turn:false}]},{close_socket:true}]);
  }finally{await h.stop();}
});
it.each(['partial','error','oversize','timeout'] as const)('fails closed on %s rather than sending partial speech or retrying',async mode=>{
  const h=await serverFor(mode);const codes={partial:'TTS_INCOMPLETE_AUDIO',error:'TTS_PAYMENT_REQUIRED',oversize:'TTS_RESPONSE_TOO_LARGE',timeout:'TTS_TIMEOUT'};
  try{await expect(requestDialogueSpeech(h.input,h.connect)).rejects.toMatchObject({code:codes[mode]});expect(h.frames).toHaveLength(3);}
  finally{await h.stop();}
});
