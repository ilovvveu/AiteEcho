import { describe, expect, it, vi } from 'vitest';
import { GroupAccessGate, type GroupRole } from './group-access.js';

const policy = { id: '100', allowAllMembers: true, replyLimits: { admin: 5, member: 1 } };
describe('group tiers and per-user rolling reply limits', () => {
  it('always exempts the configured self, without a role API call', async () => {
    const role = vi.fn();
    const gate = new GroupAccessGate(['1'], role);
    const attempts = await Promise.all(Array.from({ length: 100 }, () => gate.check('100', '1', { ...policy, memberRules: { '1': { blocked: true } } })));
    expect(attempts.every((a) => a.allowed && a.tier === 'self' && a.limitPerMinute === null)).toBe(true);
    expect(role).not.toHaveBeenCalled();
  });
  it('allows five requests for each group owner/admin and one for each ordinary member', async () => {
    const gate = new GroupAccessGate(['1'], async (_g, u) => u === '2' ? 'owner' : u === '3' ? 'admin' : 'member');
    for (const id of ['2', '3']) {
      for (let n = 0; n < 5; n++) expect((await gate.check('100', id, policy)).allowed).toBe(true);
      expect((await gate.check('100', id, policy)).allowed).toBe(false);
    }
    expect((await gate.check('100', '4', policy)).allowed).toBe(true);
    expect((await gate.check('100', '4', policy)).reason).toBe('rate_limit');
    expect((await gate.check('100', '5', policy)).allowed).toBe(true);
    expect((await gate.check('200', '4', { ...policy, id: '200' })).allowed).toBe(true);
  });
  it('uses a rolling 60 seconds and rejected attempts do not extend cooldown', async () => {
    let now = 100000;
    const gate = new GroupAccessGate([], async () => 'member', () => now);
    expect((await gate.check('100', '2', policy)).allowed).toBe(true);
    now += 59000;
    expect((await gate.check('100', '2', policy)).retryAfterMs).toBe(1000);
    now += 1000;
    expect((await gate.check('100', '2', policy)).allowed).toBe(true);
  });
  it('does not overbook concurrent messages or duplicate in-flight role queries', async () => {
    let release!: (r: GroupRole) => void;
    const role = vi.fn(() => new Promise<GroupRole>((resolve) => { release = resolve; }));
    const gate = new GroupAccessGate([], role);
    const attempts = Array.from({ length: 12 }, () => gate.check('100', '2', policy));
    release('admin');
    const decisions = await Promise.all(attempts);
    expect(role).toHaveBeenCalledTimes(1);
    expect(decisions.filter((d) => d.allowed)).toHaveLength(5);
  });
  it('applies per-person special overrides before base roles', async () => {
    const role = vi.fn(async () => 'admin' as const);
    const gate = new GroupAccessGate([], role);
    const special = { ...policy, memberRules: { '2': { label: '测试员', limitPerMinute: 2 }, '3': { limitPerMinute: 0 }, '4': { blocked: true }, '5': { label: '仅标记' } } };
    expect((await gate.check('100', '2', special)).tier).toBe('special');
    expect((await gate.check('100', '2', special)).allowed).toBe(true);
    expect((await gate.check('100', '2', special)).allowed).toBe(false);
    for (let n = 0; n < 8; n++) expect((await gate.check('100', '3', special)).limitPerMinute).toBeNull();
    expect((await gate.check('100', '4', special)).reason).toBe('special_blocked');
    expect(role).not.toHaveBeenCalled();
    const labelOnly = await gate.check('100', '5', special);
    expect(labelOnly.tier).toBe('special');
    expect(labelOnly.limitPerMinute).toBe(5);
  });
  it('treats lookup failures as ordinary and refreshes role cache within 30 seconds', async () => {
    const failed = new GroupAccessGate([], async () => { throw new Error('unavailable'); });
    expect((await failed.check('100', '2', policy)).limitPerMinute).toBe(1);
    expect((await failed.check('100', '2', policy)).allowed).toBe(false);
    let now = 100000;
    let role: GroupRole = 'admin';
    const gate = new GroupAccessGate([], async () => role, () => now);
    expect((await gate.check('100', '3', policy)).allowed).toBe(true);
    role = 'member';
    now += 30000;
    const demoted = await gate.check('100', '3', policy);
    expect(demoted.limitPerMinute).toBe(1);
    expect(demoted.allowed).toBe(false);
  });
});
