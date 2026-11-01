import type {
  NormalizedOneBotEvent,
  InboundImageReference,
  InboundDocumentReference,
  OneBotMessageEvent,
  OneBotMessageSegment,
  UnsupportedInboundMedia,
} from '../../types/onebot.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function classifyUnsupportedMedia(segmentType: string): UnsupportedInboundMedia['kind'] {
  if (segmentType === 'record' || segmentType === 'audio' || segmentType === 'voice') {
    return 'audio';
  }
  if (segmentType === 'video' || segmentType === 'short_video') {
    return 'video';
  }
  if (segmentType === 'file') {
    return 'file';
  }
  return 'unknown';
}

function inferUnsupportedMediaName(data: Record<string, unknown>): string | undefined {
  return asString(data.name) ?? asString(data.file_name) ?? asString(data.filename);
}

function inferUnsupportedMediaUrl(data: Record<string, unknown>): string | undefined {
  return asString(data.url) ?? asString(data.file) ?? asString(data.path);
}

function normalizeSegments(message: OneBotMessageEvent['message'], rawMessage?: string): OneBotMessageSegment[] {
  if (Array.isArray(message)) {
    return message;
  }
  if (typeof message === 'string') {
    return [{ type: 'text', data: { text: message } }];
  }
  if (typeof rawMessage === 'string' && rawMessage.length > 0) {
    return [{ type: 'text', data: { text: rawMessage } }];
  }
  return [];
}

export function normalizeOneBotEvent(raw: unknown): NormalizedOneBotEvent | null {
  if (!isRecord(raw)) {
    return null;
  }

  const event = raw as OneBotMessageEvent;
  if (event.post_type !== 'message') {
    return null;
  }
  if (event.message_type !== 'private' && event.message_type !== 'group') {
    return null;
  }

  const senderId = asString(event.user_id ?? event.sender?.user_id);
  if (!senderId) {
    return null;
  }
  const selfId = asString(event.self_id);
  const conversationId = event.message_type === 'group' ? asString(event.group_id) : senderId;
  if (!conversationId) {
    return null;
  }

  const segments = normalizeSegments(event.message, event.raw_message);
  const textParts: string[] = [];
  const questionParts: string[] = [];
  const mediaUrls: string[] = [];
  const imageReferences: InboundImageReference[] = [];
  const documentReferences: InboundDocumentReference[] = [];
  const unsupportedMedia: UnsupportedInboundMedia[] = [];
  const mentionedUserIds: string[] = [];
  let replyToId: string | undefined;

  for (const segment of segments) {
    const data = isRecord(segment.data) ? segment.data : {};
    if (segment.type === 'text') {
      const text = asText(data.text);
      if (text) {
        textParts.push(text);
        questionParts.push(text);
      }
      continue;
    }
    if (segment.type === 'at') {
      const qq = asString(data.qq);
      if (qq) {
        mentionedUserIds.push(qq);
        textParts.push(`@${qq}`);
        if (qq !== selfId) questionParts.push(`@${qq}`);
      }
      continue;
    }
    if (segment.type === 'image') {
      const url = asString(data.url);
      const file = asString(data.file);
      if (url || file) {
        imageReferences.push({ url, file });
      }
      if (url) {
        mediaUrls.push(url);
      }
      continue;
    }
    if (segment.type === 'reply') {
      replyToId = asString(data.id) ?? replyToId;
      continue;
    }

    if (segment.type === 'file') {
      const size = Number(data.file_size ?? data.size);
      documentReferences.push({
        name: inferUnsupportedMediaName(data) ?? asString(data.file),
        fileId: asString(data.file_id ?? data.id),
        url: asString(data.url),
        size: Number.isFinite(size) && size >= 0 ? size : undefined,
      });
      continue;
    }

    if (segment.type === 'record' || segment.type === 'audio' || segment.type === 'voice' || segment.type === 'video' || segment.type === 'short_video') {
      unsupportedMedia.push({
        kind: classifyUnsupportedMedia(segment.type),
        segmentType: segment.type,
        name: inferUnsupportedMediaName(data),
        url: inferUnsupportedMediaUrl(data),
      });
      continue;
    }

    const fallbackText = asText(data.text);
    if (fallbackText) {
      textParts.push(fallbackText);
      questionParts.push(fallbackText);
    }
  }

  const senderName = asString(event.sender?.card) ?? asString(event.sender?.nickname);
  const segmentText = textParts.join('').trim();
  const rawText =
    (typeof event.raw_message === 'string' && event.raw_message.trim().length > 0
      ? event.raw_message.trim()
      : segmentText) ||
    (mediaUrls.length > 0 ? mediaUrls.map(() => '[image]').join(' ') : '');
  const normalizedText = segmentText || (Array.isArray(event.message) ? '' : rawText);

  const explicitMention = Boolean(selfId && mentionedUserIds.includes(selfId));
  const cleanedText =
    event.message_type === 'group' && explicitMention
      ? questionParts.join('').trim().replace(/^[,:，：]\s*/u, '')
      : normalizedText;

  return {
    id: `${conversationId}:${asString(event.message_id) ?? 'unknown'}`,
    mode: event.message_type === 'group' ? 'group' : 'direct',
    conversationId,
    replyTarget: conversationId,
    senderId,
    senderName,
    messageId: asString(event.message_id),
    selfId,
    rawText,
    cleanedText,
    commandText: cleanedText,
    replyToId,
    mediaUrls,
    imageReferences,
    documentReferences,
    unsupportedMedia,
    mentionedUserIds,
    wasMentioned: event.message_type === 'private' ? true : explicitMention,
    explicitMention,
    isSelfMessage: Boolean(selfId && senderId === selfId),
    timestamp: typeof event.time === 'number' ? event.time * 1000 : undefined,
    raw: event,
  };
}
