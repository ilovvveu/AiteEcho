import { spawn, type ChildProcess } from 'node:child_process';
import { encode } from 'silk-wasm';

let decoder:ChildProcess|undefined;
process.once('SIGTERM',()=>{decoder?.kill('SIGKILL');process.exit(1);});

async function main():Promise<void>{
  const input:Buffer[]=[];let inputBytes=0;
  for await(const chunk of process.stdin){
    inputBytes+=chunk.length;if(inputBytes>5*1024*1024)throw Error('QQ_VOICE_TOO_LARGE');input.push(chunk);
  }
  const pcm=await new Promise<Buffer>((resolve,reject)=>{
    const child=spawn(process.argv[2]||'ffmpeg',['-hide_banner','-loglevel','error','-protocol_whitelist','pipe',
      '-f','mp3','-i','pipe:0','-vn','-ac','1','-ar','24000','-f','s16le','pipe:1'],{stdio:['pipe','pipe','pipe'],shell:false});
    decoder=child;const output:Buffer[]=[];let size=0,settled=false;
    const finish=(error?:string):void=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(error){child.kill('SIGKILL');reject(Error(error));}else resolve(Buffer.concat(output));
    };
    const timer=setTimeout(()=>finish('QQ_VOICE_TRANSCODE_TIMEOUT'),5000);
    child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>24000*2*120)finish('QQ_VOICE_TOO_LONG');else output.push(chunk);});
    child.stderr.resume();child.stdin.on('error',()=>{});
    child.once('error',()=>finish('QQ_VOICE_FFMPEG_UNAVAILABLE'));
    child.once('close',code=>finish(code===0&&size>0?undefined:'QQ_VOICE_DECODE_FAILED'));
    child.stdin.end(Buffer.concat(input));
  });
  const silk=await encode(pcm,24000);
  if(silk.duration<=0||silk.duration>120000||silk.data.byteLength>2*1024*1024)throw Error('QQ_VOICE_TOO_LONG');
  process.stdout.write(Buffer.from(silk.data));
}
main().catch(error=>{
  const code=error instanceof Error&&/^QQ_VOICE_[A-Z_]{1,45}$/u.test(error.message)?error.message:'QQ_VOICE_TRANSCODE_FAILED';
  process.stderr.write(code);process.exitCode=1;
});
