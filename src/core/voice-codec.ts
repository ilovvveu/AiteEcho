import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VoiceError, validMp3 } from './voice.js';

export function validQqSilk(audio:Buffer):boolean{
  return audio.length>12&&audio[0]===2&&audio.subarray(1,10).toString()==='#!SILK_V3';
}

/** Isolated local conversion; no key/env inheritance, file uploads, shell or paid retries. */
export async function encodeQqVoice(audio:Buffer,ffmpegCommand:string,spawnWorker=spawn):Promise<Buffer>{
  if(!validMp3(audio)||audio.length>5*1024*1024)throw new VoiceError('QQ_VOICE_INVALID_INPUT');
  return new Promise((resolve,reject)=>{
    const worker=spawnWorker(process.execPath,[fileURLToPath(new URL('./voice-codec-worker.js',import.meta.url)),ffmpegCommand],{
      env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','pipe'],shell:false,
    });
    const chunks:Buffer[]=[];let bytes=0,stderr='',settled=false;
    const finish=(error?:VoiceError):void=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(error){
        worker.kill('SIGTERM');const killer=setTimeout(()=>worker.kill('SIGKILL'),500);killer.unref();
        worker.once('close',()=>clearTimeout(killer));reject(error);return;
      }
      const result=Buffer.concat(chunks);
      if(!validQqSilk(result))reject(new VoiceError('QQ_VOICE_INVALID_SILK'));else resolve(result);
    };
    const timer=setTimeout(()=>finish(new VoiceError('QQ_VOICE_TRANSCODE_TIMEOUT')),15000);
    worker.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2*1024*1024)finish(new VoiceError('QQ_VOICE_TOO_LARGE'));else chunks.push(chunk);});
    worker.stderr.on('data',(chunk:Buffer)=>{if(stderr.length<1024)stderr+=chunk.toString().slice(0,1024-stderr.length);});
    worker.stdin.on('error',()=>{});
    worker.once('error',()=>finish(new VoiceError('QQ_VOICE_WORKER_FAILED')));
    worker.once('close',code=>{
      const safe=stderr.trim();
      finish(code===0?undefined:new VoiceError(/^QQ_VOICE_[A-Z_]{1,45}$/u.test(safe)?safe:'QQ_VOICE_TRANSCODE_FAILED'));
    });
    worker.stdin.end(audio);
  });
}
