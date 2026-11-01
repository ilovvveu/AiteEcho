import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Diagnostics, safeErrorCode } from './diagnostics.js';

describe('bounded diagnostic JSONL', () => {
  it('rotates bounded metadata-only files, writes privately and separates AI health from QQ', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qq-diagnostics-')); const file = path.join(dir, 'events.jsonl');
    const d = new Diagnostics(file, 500);
    expect(d.status().state).toBe('unknown');
    for (let i = 0; i < 30; i++) d.record('http_headers', 'ok', { correlationId: `trace-${i}`, httpStatus: 200 });
    d.record('api_complete', 'error', { code: 'TOTAL_TIMEOUT' }); await d.flush();
    expect(d.status().state).toBe('error'); expect(d.status().logHealthy).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(['events.jsonl', 'events.jsonl.1', 'events.jsonl.2', 'events.jsonl.3']);
    for (const name of await readdir(dir)) {
      expect((await stat(path.join(dir, name))).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(dir, name))).size).toBeLessThanOrEqual(500);
      for (const line of (await readFile(path.join(dir, name), 'utf8')).trim().split('\n')) expect(JSON.parse(line)).toHaveProperty('stage');
    }
    d.record('api_complete', 'ok'); expect(d.status().state).toBe('ok'); expect(d.status().lastSuccessAt).toBeDefined(); await d.flush();
  });
  it('only exposes safe error codes, never arbitrary exception text', () => {
    expect(safeErrorCode(Object.assign(new Error('secret'), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
    expect(safeErrorCode({ code: 'https://private?key=secret' })).toBe('UNEXPECTED');
  });
  it('persists response integrity measurements as private metadata without any headers or body fields',async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),'qq-integrity-log-')),file=path.join(dir,'events.jsonl');
    const d=new Diagnostics(file);d.record('response_integrity','error',{correlationId:'cut-731',code:'RESPONSE_ABORTED',
      httpStatus:200,bytes:120,expectedBytes:180,responseComplete:false,responseBodyStarted:true,
      requestConnection:'keep-alive',responseConnection:'close',responseFraming:'content-length'});
    await d.flush();const row=JSON.parse((await readFile(file,'utf8')).trim());
    expect(row).toMatchObject({bytes:120,expectedBytes:180,responseComplete:false,requestConnection:'keep-alive'});
    for(const field of ['headers','body','apiKey','url'])expect(row).not.toHaveProperty(field);
    expect((await stat(file)).mode&0o777).toBe(0o600);
  });
  it('records only bounded profile/version/scene metadata, not the style or user text',async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),'qq-profile-log-')),file=path.join(dir,'profile.jsonl');
    const d=new Diagnostics(file);d.record('reply_profile','ok',{styleId:'猫娘',styleVersion:'123456789abc',rulesVersion:'abcdef123456',scene:'weather',historyTurns:0,historyCandidates:6});
    await d.flush();const raw=await readFile(file,'utf8');expect(raw).toContain('猫娘');expect(raw).toContain('123456789abc');
    expect(raw).not.toContain('instructions');expect(raw).not.toContain('user');expect(raw).not.toContain('apiKey');
  });
});
