import { describe, expect, it, vi } from 'vitest';
import { GroupVoiceGate } from './group-voice-gate.js';
import type { GroupRole } from './group-access.js';

describe('independent per-member rolling voice reservations', () => {
  it('uses configurable member, admin and owner quotas rather than personal fixed rules', async () => {
    const gate = new GroupVoiceGate(['1'], async (_g, u) => u === '2' ? 'admin' : 'member', Date.now,
      { member: 2, admin: 3, self: 1, windowMs: 60_000 });
    for (const [user, limit] of [['1', 1], ['2', 3], ['3', 2]] as const) {
      for (let i = 0; i < limit; i++) { const r = await gate.reserve('100', user); expect(r.allowed).toBe(true); r.settle(true); }
      expect((await gate.reserve('100', user)).allowed).toBe(false);
    }
  });
  it('exempts the bot owner, not group owners, and keeps users and groups isolated', async () => {
    const role = vi.fn(async (_g: string, u: string): Promise<GroupRole> => u === '2' ? 'owner' : u === '3' ? 'admin' : 'member');
    const gate = new GroupVoiceGate(['1'], role);
    for (let i=0;i<20;i++) { const r=await gate.reserve('100','1'); expect(r.allowed).toBe(true);expect(r.limitPerMinute).toBeNull();r.settle(true); }
    expect(role).not.toHaveBeenCalled();
    for (const u of ['2','3']) { for(let i=0;i<2;i++) { const r=await gate.reserve('100',u);expect(r.allowed).toBe(true);r.settle(true); }expect((await gate.reserve('100',u)).allowed).toBe(false); }
    const member=await gate.reserve('100','4');member.settle(true);
    expect((await gate.reserve('100','4')).allowed).toBe(false);
    expect((await gate.reserve('100','5')).allowed).toBe(true);
    expect((await gate.reserve('200','4')).allowed).toBe(true);
  });
  it('refunds failed delivery exactly once and retains successful delivery for a rolling 60 seconds', async () => {
    let now=100_000;const gate=new GroupVoiceGate([],async()=> 'member',()=>now);
    const failed=await gate.reserve('100','2');expect((await gate.reserve('100','2')).allowed).toBe(false);
    failed.settle(false);const sent=await gate.reserve('100','2');expect(sent.allowed).toBe(true);sent.settle(true);failed.settle(false);
    now+=59_000;expect((await gate.reserve('100','2')).allowed).toBe(false);
    now+=1000;expect((await gate.reserve('100','2')).allowed).toBe(true);
  });
  it('starts the successful voice window at delivery rather than at synthesis start', async () => {
    let now=100_000;const gate=new GroupVoiceGate([],async()=> 'member',()=>now);
    const r=await gate.reserve('100','2');now+=20_000;r.settle(true);
    now+=40_000;expect((await gate.reserve('100','2')).allowed).toBe(false);
    now+=20_000;expect((await gate.reserve('100','2')).allowed).toBe(true);
  });
  it('cannot overbook concurrent reservations and safely defaults failed role lookup to member', async () => {
    const gate=new GroupVoiceGate([],async()=> {throw new Error('unavailable');});
    const slots=await Promise.all(Array.from({length:12},()=>gate.reserve('100','2')));
    expect(slots.filter(s=>s.allowed)).toHaveLength(1);slots.find(s=>s.allowed)!.settle(false);
    expect((await gate.reserve('100','2')).allowed).toBe(true);
  });
  it('retains previous deliveries on demotion and bounds the number of tracked members', async () => {
    let role:GroupRole='admin';const gate=new GroupVoiceGate([],async()=>role);
    const first=await gate.reserve('100','2');first.settle(true);role='member';
    expect((await gate.reserve('100','2')).allowed).toBe(false);
    for(let i=0;i<4096;i++) (gate as any).buckets.set(`full:${i}`,[{at:Date.now()}]);
    expect((await gate.reserve('100','new')).allowed).toBe(false);
  });
});
