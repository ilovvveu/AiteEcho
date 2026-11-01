import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { type spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { encodeQqVoice, validQqSilk } from './voice-codec.js';
afterEach(()=>vi.useRealTimers());
const mp3=Buffer.from('ID3\x04TEST'),silk=Buffer.from('\x02#!SILK_V3TEST');
function harness(){
 const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});
 const create=vi.fn(()=>child);return{child,create,spawn:create as unknown as typeof spawn};
}
it('converts only MP3 in an isolated worker without API-key environment or shell and returns Tencent SILK bytes',async()=>{
 const h=harness(),p=encodeQqVoice(mp3,'/trusted/ffmpeg',h.spawn);
 h.child.stdout.write(silk);h.child.emit('close',0);await expect(p).resolves.toEqual(silk);
 expect(h.create).toHaveBeenCalledWith(process.execPath,expect.arrayContaining(['/trusted/ffmpeg']),expect.objectContaining({shell:false,env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C'}}));
 expect(validQqSilk(silk)).toBe(true);expect(validQqSilk(mp3)).toBe(false);
 await expect(encodeQqVoice(Buffer.from('https://example.org'),'/trusted/ffmpeg',h.spawn)).rejects.toMatchObject({code:'QQ_VOICE_INVALID_INPUT'});
 expect(h.create).toHaveBeenCalledOnce();
});
it('requires real SILK and sanitizes failures while keeping component-specific errors',async()=>{
 const a=harness(),p=encodeQqVoice(mp3,'ffmpeg',a.spawn);a.child.stdout.write(mp3);a.child.emit('close',0);
 await expect(p).rejects.toMatchObject({code:'QQ_VOICE_INVALID_SILK'});
 const b=harness(),q=encodeQqVoice(mp3,'ffmpeg',b.spawn);b.child.stderr.write('QQ_VOICE_FFMPEG_UNAVAILABLE');b.child.emit('close',1);
 await expect(q).rejects.toMatchObject({code:'QQ_VOICE_FFMPEG_UNAVAILABLE'});
 const c=harness(),r=encodeQqVoice(mp3,'ffmpeg',c.spawn);c.child.stderr.write('PRIVATE_RAW_ERROR_KEY');c.child.emit('close',1);
 await expect(r).rejects.toMatchObject({code:'QQ_VOICE_TRANSCODE_FAILED'});
});
it('bounds local output and timeout, terminating the worker without retrying',async()=>{
 const a=harness(),p=encodeQqVoice(mp3,'ffmpeg',a.spawn);a.child.stdout.write(Buffer.alloc(2*1024*1024+1));
 await expect(p).rejects.toMatchObject({code:'QQ_VOICE_TOO_LARGE'});expect(a.child.kill).toHaveBeenCalledWith('SIGTERM');
 vi.useFakeTimers();const b=harness(),q=encodeQqVoice(mp3,'ffmpeg',b.spawn);const assertion=expect(q).rejects.toMatchObject({code:'QQ_VOICE_TRANSCODE_TIMEOUT'});
 await vi.advanceTimersByTimeAsync(15001);await assertion;expect(b.child.kill).toHaveBeenCalledOnce();expect(b.create).toHaveBeenCalledOnce();
});
