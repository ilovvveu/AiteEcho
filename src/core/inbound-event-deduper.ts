import type { NormalizedOneBotEvent } from '../types/onebot.js';
import { buildInboundDedupeKey } from './interaction-correlation.js';

type SeenEvent = {
  key: string;
  seenAt: number;
};

export type DedupeResult = {
  duplicate: boolean;
  key: string;
};

export class InboundEventDeduper {
  private readonly seen = new Map<string, SeenEvent>();

  constructor(
    private readonly windowMs: number,
    private readonly maxEntries: number,
  ) {}

  check(event: NormalizedOneBotEvent, now = Date.now()): DedupeResult {
    this.cleanup(now);
    const key = buildInboundDedupeKey(event);
    const existing = this.seen.get(key);
    if (existing && now - existing.seenAt <= this.windowMs) {
      existing.seenAt = now;
      this.seen.delete(key);
      this.seen.set(key, existing);
      return { duplicate: true, key };
    }

    this.seen.set(key, { key, seenAt: now });
    this.trimToLimit();
    return { duplicate: false, key };
  }

  isDuplicate(event: NormalizedOneBotEvent, now = Date.now()): boolean {
    return this.check(event, now).duplicate;
  }

  size(): number {
    return this.seen.size;
  }

  private cleanup(now: number): void {
    for (const [key, value] of this.seen) {
      if (now - value.seenAt > this.windowMs) {
        this.seen.delete(key);
      }
    }
  }

  private trimToLimit(): void {
    if (this.seen.size <= this.maxEntries) {
      return;
    }
    const overflow = this.seen.size - this.maxEntries;
    const keys = this.seen.keys();
    for (let i = 0; i < overflow; i += 1) {
      const next = keys.next();
      if (next.done) {
        return;
      }
      this.seen.delete(next.value);
    }
  }
}
