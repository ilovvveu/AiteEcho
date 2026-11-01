import type * as schema from '@agentclientprotocol/sdk';

export type VerboseMode = 'normal' | 'verbose' | 'debug';
export type PermissionStrategy = 'allow_once' | 'allow_always' | 'cancel';

export interface AgentImageInput {
  mimeType: string;
  base64Data: string;
  sourceUrl?: string;
}

export type InboundImageFailureReason =
  | 'invalid_source'
  | 'blocked_source'
  | 'resolve_failed'
  | 'http_error'
  | 'timeout'
  | 'too_large'
  | 'not_image'
  | 'download_failed';

export interface InboundImageFailure {
  index: number;
  reason: InboundImageFailureReason;
}

export interface InboundImageProcessingReport {
  received: number;
  delivered: number;
  omittedByLimit: number;
  failures: InboundImageFailure[];
}

export interface AgentImageOutput {
  mimeType: string;
  base64Data: string;
  uri?: string;
}

export interface ToolCallEntry {
  toolCallId: string;
  title: string;
  kind?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  timestamp: Date;
}

export interface ThoughtEntry {
  content: string;
  timestamp: Date;
}

export interface ACPBridgeState {
  currentPlan?: schema.Plan;
  accumulatedThoughts: ThoughtEntry[];
  accumulatedToolCalls: ToolCallEntry[];
  accumulatedText: string;
  accumulatedImages: AgentImageOutput[];
  verboseMode: VerboseMode;
  correlationId?: string;
  currentRunId?: string;
}

export interface ACPAgentCapabilities {
  canLoadSession: boolean;
  canListSessions: boolean;
  canCloseSession: boolean;
  promptCapabilities?: schema.PromptCapabilities;
}

export interface AgentResponse {
  text: string;
  images: AgentImageOutput[];
  stopReason?: schema.StopReason;
  usage?: schema.Usage | null;
  sessionId: string;
}
