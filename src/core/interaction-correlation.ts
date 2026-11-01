import { createHash } from 'node:crypto';
import type { NormalizedOneBotEvent } from '../types/onebot.js';

function stableTextPart(value: string | undefined): string {
  if (!value) {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function buildInboundDedupeKey(event: NormalizedOneBotEvent): string {
  const messageId = event.messageId?.trim();
  if (messageId) {
    return `mid:${event.mode}:${event.conversationId}:${messageId}`;
  }

  const replyToId = event.replyToId?.trim() || 'none';
  const timestampBucket = event.timestamp ? String(Math.floor(event.timestamp / 1000)) : 'no-ts';
  const cleanedText = stableTextPart(event.cleanedText || event.rawText);
  const mediaPart = event.mediaUrls.slice(0, 3).join(',');

  return [
    'fallback',
    event.mode,
    event.conversationId,
    event.senderId,
    replyToId,
    timestampBucket,
    cleanedText,
    mediaPart,
  ].join(':');
}

export function deriveInboundCorrelationId(event: NormalizedOneBotEvent): string {
  const messageId = event.messageId?.trim();
  if (messageId) {
    return `ob11-${event.mode === 'group' ? 'g' : 'd'}-${event.conversationId}-${messageId}`;
  }
  return `ob11-${shortHash(buildInboundDedupeKey(event))}`;
}
