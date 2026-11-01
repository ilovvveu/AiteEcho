import type { GroupConversationPolicy } from '../config/index.js';

export type GroupRole = 'owner' | 'admin' | 'member';
export type GroupTier = 'self' | 'group_admin' | 'member' | 'special';
export interface GroupAccessDecision {
  allowed: boolean;
  tier: GroupTier;
  label?: string;
  limitPerMinute: number | null;
  remaining: number | null;
  retryAfterMs: number;
  reason?: 'rate_limit' | 'special_blocked' | 'capacity';
}

const WINDOW_MS = 60_000;
const MAX_KEYS = 4096;

export class GroupAccessGate {
  private readonly buckets = new Map<string, number[]>();
  private readonly roleCache = new Map<string, { role: GroupRole; expiresAt: number }>();
  private readonly pendingRoles = new Map<string, Promise<GroupRole>>();

  constructor(
    private readonly owners: string[],
    private readonly resolveRole: (groupId: string, userId: string) => Promise<GroupRole>,
    private readonly now: () => number = Date.now,
  ) {}

  async check(groupId: string, userId: string, policy?: GroupConversationPolicy): Promise<GroupAccessDecision> {
    if (this.owners.includes(userId)) return this.unlimited('self');
    const special = policy?.memberRules?.[userId];
    if (special?.blocked) {
      return { allowed: false, tier: 'special', label: special.label, limitPerMinute: 0, remaining: 0, retryAfterMs: 0, reason: 'special_blocked' };
    }
    if (special?.limitPerMinute === 0) return this.unlimited('special', special.label);
    if (!policy?.allowAllMembers && !policy?.replyLimits && !special) return this.unlimited('member');
    const key = `${groupId}:${userId}`;
    const role = special?.limitPerMinute !== undefined ? 'member' : await this.getRole(key, groupId, userId);
    const tier: GroupTier = special ? 'special' : role === 'owner' || role === 'admin' ? 'group_admin' : 'member';
    const limit = special?.limitPerMinute ?? (role === 'owner' || role === 'admin'
      ? policy?.replyLimits?.admin ?? 5 : policy?.replyLimits?.member ?? 1);
    // There is no await between checking and reserving a slot. Concurrent
    // incoming messages cannot overbook the same user's allowance.
    const now = this.now();
    for (const [id, times] of this.buckets) {
      const live = times.filter((time) => time > now - WINDOW_MS);
      if (live.length) this.buckets.set(id, live); else this.buckets.delete(id);
    }
    const times = this.buckets.get(key) ?? [];
    const common = { tier, label: special?.label, limitPerMinute: limit };
    if (times.length >= limit) {
      return { ...common, allowed: false, remaining: 0, retryAfterMs: Math.max(0, times[0]! + WINDOW_MS - now), reason: 'rate_limit' };
    }
    if (!this.buckets.has(key) && this.buckets.size >= MAX_KEYS) {
      return { ...common, allowed: false, remaining: 0, retryAfterMs: WINDOW_MS, reason: 'capacity' };
    }
    times.push(now);
    this.buckets.set(key, times);
    return { ...common, allowed: true, remaining: Math.max(0, limit - times.length), retryAfterMs: 0 };
  }

  async resolveGroupRole(groupId: string, userId: string): Promise<GroupRole> {
    return this.getRole(`${groupId}:${userId}`, groupId, userId);
  }

  private unlimited(tier: GroupTier, label?: string): GroupAccessDecision {
    return { allowed: true, tier, label, limitPerMinute: null, remaining: null, retryAfterMs: 0 };
  }

  private async getRole(key: string, groupId: string, userId: string): Promise<GroupRole> {
    const now = this.now();
    const cached = this.roleCache.get(key);
    if (cached && cached.expiresAt > now) return cached.role;
    const pending = this.pendingRoles.get(key);
    if (pending) return pending;
    const task = (async (): Promise<GroupRole> => {
      let role: GroupRole = 'member';
      try { role = await this.resolveRole(groupId, userId); } catch { /* Unknown roles receive the ordinary member limit. */ }
      for (const [id, entry] of this.roleCache) if (entry.expiresAt <= this.now()) this.roleCache.delete(id);
      if (this.roleCache.size >= MAX_KEYS) this.roleCache.delete(this.roleCache.keys().next().value!);
      this.roleCache.set(key, { role, expiresAt: this.now() + 30_000 });
      return role;
    })();
    this.pendingRoles.set(key, task);
    try { return await task; } finally { this.pendingRoles.delete(key); }
  }
}

export function groupTierLabel(tier: GroupTier): string {
  return { self: '本人', group_admin: '群主/管理员', member: '普通群友', special: '特殊标记' }[tier];
}
