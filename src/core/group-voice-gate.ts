import type { GroupRole } from './group-access.js';

export const GROUP_VOICE_RATE_LIMITS = { member: 1, admin: 2, self: null, windowMs: 60_000 } as const;
export interface GroupVoiceLimits { member: number; admin: number; self: number | null; windowMs: number }
const MAX_KEYS = 4096;
type Slot = { at: number };
export interface VoiceReservation {
  allowed: boolean;
  limitPerMinute: number | null;
  settle(delivered: boolean): void;
}

/** Separate from normal replies: reserve atomically; only acknowledged voice uses a slot. */
export class GroupVoiceGate {
  private readonly buckets = new Map<string, Slot[]>();
  constructor(
    private readonly owners: string[],
    private readonly resolveRole: (group: string, user: string) => Promise<GroupRole>,
    private readonly now: () => number = Date.now,
    private readonly limits: GroupVoiceLimits = GROUP_VOICE_RATE_LIMITS,
  ) {}

  async reserve(group: string, user: string): Promise<VoiceReservation> {
    const isSelf = this.owners.includes(user);
    if (isSelf && this.limits.self === null) return { allowed: true, limitPerMinute: null, settle: () => {} };
    let role: GroupRole = 'member';
    if (!isSelf) try { role = await this.resolveRole(group, user); } catch { /* Fail to ordinary member. */ }
    const limit = isSelf ? this.limits.self! : role === 'admin' || role === 'owner' ? this.limits.admin : this.limits.member;
    const key = `${group}:${user}`, now = this.now();
    for (const [id, slots] of this.buckets) {
      const live = slots.filter(slot => slot.at > now - this.limits.windowMs);
      if (live.length) this.buckets.set(id, live); else this.buckets.delete(id);
    }
    const slots = this.buckets.get(key) ?? [];
    if (slots.length >= limit || (!this.buckets.has(key) && this.buckets.size >= MAX_KEYS)) {
      return { allowed: false, limitPerMinute: limit, settle: () => {} };
    }
    const slot = { at: now };
    slots.push(slot);
    this.buckets.set(key, slots);
    let settled = false;
    return {
      allowed: true, limitPerMinute: limit,
      settle: delivered => {
        if (settled) return;
        settled = true;
        if (delivered) { slot.at = this.now(); return; }
        const remaining = (this.buckets.get(key) ?? []).filter(item => item !== slot);
        if (remaining.length) this.buckets.set(key, remaining); else this.buckets.delete(key);
      },
    };
  }
}
