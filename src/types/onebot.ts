export type OneBotChatType = 'direct' | 'group';

export interface OneBotMessageSegment {
  type: string;
  data?: Record<string, unknown>;
}

export type UnsupportedInboundMediaKind = 'audio' | 'video' | 'file' | 'unknown';

export interface UnsupportedInboundMedia {
  kind: UnsupportedInboundMediaKind;
  segmentType: string;
  name?: string;
  url?: string;
}

export interface InboundImageReference {
  url?: string;
  file?: string;
}

export interface InboundDocumentReference {
  name?: string;
  fileId?: string;
  url?: string;
  size?: number;
}

export interface OneBotActionResponse {
  status?: string;
  retcode?: number;
  data?: Record<string, unknown>;
  echo?: string;
  msg?: string;
  wording?: string;
}

export interface OneBotMessageEvent {
  post_type?: string;
  message_type?: string;
  sub_type?: string;
  user_id?: string | number;
  group_id?: string | number;
  self_id?: string | number;
  message_id?: string | number;
  raw_message?: string;
  message?: string | OneBotMessageSegment[];
  sender?: {
    user_id?: string | number;
    nickname?: string;
    card?: string;
  };
  time?: number;
  [key: string]: unknown;
}

export interface NormalizedOneBotEvent {
  id: string;
  mode: OneBotChatType;
  conversationId: string;
  replyTarget: string;
  senderId: string;
  senderName?: string;
  messageId?: string;
  selfId?: string;
  rawText: string;
  cleanedText: string;
  commandText: string;
  replyToId?: string;
  mediaUrls: string[];
  imageReferences?: InboundImageReference[];
  documentReferences?: InboundDocumentReference[];
  unsupportedMedia: UnsupportedInboundMedia[];
  mentionedUserIds: string[];
  wasMentioned: boolean;
  explicitMention: boolean;
  isSelfMessage: boolean;
  timestamp?: number;
  raw: OneBotMessageEvent;
}

export type OneBotReplyPurpose = 'command' | 'progress' | 'reply' | 'error';

export interface OneBotReplyContext {
  chatType: OneBotChatType;
  targetId: string;
  replyToId?: string;
  correlationId?: string;
  purpose?: OneBotReplyPurpose;
}

export interface OutboundObservation {
  context: OneBotReplyContext;
  message: string | Array<Record<string, unknown>>;
  voiceText?: string;
  outcome: 'acknowledged' | 'rejected' | 'unconfirmed' | 'failed';
  messageId?: string;
  retcode?: number;
  errorCode?: string;
}

export type OneBotOutboundImage =
  | {
      kind: 'url';
      value: string;
      mimeType?: string;
    }
  | {
      kind: 'base64';
      value: string;
      mimeType?: string;
    }
  | {
      kind: 'file';
      value: string;
      mimeType?: string;
    };

export interface PlannedOutboundAction {
  kind: 'text' | 'image';
  text?: string;
  image?: OneBotOutboundImage;
}

export interface PlannedOutboundPayload {
  actions: PlannedOutboundAction[];
  cleanedText: string;
  imageUrls: string[];
}

export interface TransportStatusPatch {
  connected?: boolean;
  reconnectAttempts?: number;
  lastConnectedAt?: number | null;
  lastDisconnect?: string | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  lastEventAt?: number | null;
  lastError?: string | null;
}
