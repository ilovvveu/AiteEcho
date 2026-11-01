import type { OneBotChatType } from './onebot.js';
import type { VerboseMode } from './agent.js';

export type ConversationProgressMode = 'off' | 'message';

export interface ContextTurn {
  at: number;
  user: string;
  assistant: string;
  senderId?: string;
  styleId?: string;
  styleVersion?: string;
  rulesVersion?: string;
  scene?: string;
  topic?: 'weather' | 'general';
}

export interface PersistedConversationState {
  conversationKey: string;
  chatType: OneBotChatType;
  targetId: string;
  remoteSessionId?: string;
  progressModeOverride?: ConversationProgressMode;
  verboseModeOverride?: VerboseMode;
  sendHistoryOverride?: boolean;
  lastActivityAt: string;
  contextTurns?: ContextTurn[];
  retiredSessionIds?: string[];
}

export interface RuntimeConversationMeta {
  conversationKey: string;
  chatType: OneBotChatType;
  targetId: string;
}
