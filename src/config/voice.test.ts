import { mkdtemp, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from './index.js';
it('defaults speech off with independent bounds and rejects unsafe keys/voice IDs or unrestricted limits',()=>{
  expect(loadConfig({}).voice).toMatchObject({enabled:false,groupEnabled:false,maxChars:300,dailyChars:2000,model:'eleven_v4_turbo',stability:0.5,voiceId:'',delivery:'neutral'});
  expect(loadConfig({BOT_VOICE_GROUP_ENABLED:'true'}).voice.groupEnabled).toBe(true);
  expect(()=>loadConfig({ELEVENLABS_DELIVERY:'unbounded-style'})).toThrow();
  expect(()=>loadConfig({ELEVENLABS_STABILITY:'2'})).toThrow();
  expect(()=>loadConfig({BOT_VOICE_ENABLED:'true'})).toThrow('credential');
  expect(()=>loadConfig({BOT_VOICE_ENABLED:'true',ELEVENLABS_API_KEY:'secret\r\nheader'})).toThrow('credential');
  expect(()=>loadConfig({ELEVENLABS_VOICE_ID:'../../secret'})).toThrow();
  expect(()=>loadConfig({BOT_VOICE_TIMEOUT_MS:'999999'})).toThrow();
  expect(()=>loadConfig({BOT_VOICE_MAX_CHARS:'999999'})).toThrow();
  expect(()=>loadConfig({BOT_VOICE_DAILY_CHARS:'999999999'})).toThrow();
});
it('reads only a private regular credential file when enabled, not a symlink or public credential file',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qq-voice-key-')),file=path.join(dir,'tts.key'),link=path.join(dir,'link.key');
  await writeFile(file,'fake-key-voice-private-731',{mode:0o600});await chmod(file,0o600);
  const env={BOT_VOICE_ENABLED:'true',ELEVENLABS_VOICE_ID:'SyntheticVoice7310000',ELEVENLABS_API_KEY_FILE:file};
  expect(loadConfig(env).voice.apiKey).toBe('fake-key-voice-private-731');
  await symlink(file,link);expect(()=>loadConfig({...env,ELEVENLABS_API_KEY_FILE:link})).toThrow('private regular');
  await chmod(file,0o644);expect(()=>loadConfig(env)).toThrow('private regular');
  expect(loadConfig({...env,BOT_VOICE_ENABLED:'false'}).voice.apiKey).toBeUndefined();
});
