import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import type * as schema from '@agentclientprotocol/sdk';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/index.js';
import type {
  ACPAgentCapabilities,
  ACPBridgeState,
  AgentImageInput,
  AgentImageOutput,
  AgentResponse,
  InboundImageProcessingReport,
  PermissionStrategy,
  ToolCallEntry,
} from '../../types/agent.js';
import type { UnsupportedInboundMedia } from '../../types/onebot.js';
import { buildPromptBlocks } from './prompt.js';
import { sanitizeAcpAgentText } from './text.js';
import { withWebSearch } from './search-config.js';
import { validateGrokReply, withGrokCompatibility } from './grok-config.js';

function summarizeText(value: unknown, maxLength = 200): string | undefined {
  if (value == null) {
    return undefined;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) {
    return undefined;
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function extractToolArguments(toolCall: Record<string, unknown>): unknown {
  return (
    toolCall.arguments ??
    toolCall.args ??
    toolCall.input ??
    toolCall.parameters ??
    toolCall.parameter ??
    toolCall.argumentsText
  );
}

function extractToolOutput(toolCallUpdate: Record<string, unknown>): unknown {
  return (
    toolCallUpdate.output ??
    toolCallUpdate.result ??
    toolCallUpdate.content ??
    toolCallUpdate.response ??
    toolCallUpdate.data ??
    toolCallUpdate.message
  );
}

function formatPlanEntry(plan: schema.Plan): string | undefined {
  const entries = Array.isArray((plan as any).entries)
    ? ((plan as any).entries as Array<Record<string, unknown>>)
    : [];
  const activeEntry =
    entries.find((entry) => entry.status === 'in_progress' || entry.status === 'active') ?? entries[0];

  if (!activeEntry) {
    return undefined;
  }

  const candidate = activeEntry.title || activeEntry.text || activeEntry.description || activeEntry.content;
  return typeof candidate === 'string' && candidate.trim() ? candidate : undefined;
}

function pickPermissionOption(
  options: schema.PermissionOption[],
  strategy: PermissionStrategy,
): schema.PermissionOption | undefined {
  if (strategy === 'cancel') {
    return undefined;
  }
  const preferredKind = strategy === 'allow_always' ? 'allow_always' : 'allow_once';
  return (
    options.find((option) => option.kind === preferredKind) ??
    options.find((option) => option.kind === 'allow_once') ??
    options[0]
  );
}

function extractImageOutput(content: schema.ContentBlock): AgentImageOutput | null {
  if (content.type !== 'image' || typeof content.data !== 'string' || typeof content.mimeType !== 'string') {
    return null;
  }
  return {
    mimeType: content.mimeType,
    base64Data: content.data,
    uri: typeof content.uri === 'string' ? content.uri : undefined,
  };
}

export class ACPAgentBridge {
  private process: ChildProcess | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private promptChain: Promise<void> = Promise.resolve();
  private queuedPromptCount = 0;
  private state: ACPBridgeState;
  private capabilities: ACPAgentCapabilities = {
    canLoadSession: false,
    canListSessions: false,
    canCloseSession: false,
  };
  private remoteSessionId?: string;
  private progressCallback?: (state: ACPBridgeState) => void;
  private acceptingPromptUpdates = false;
  private lastPromptContentWasTool = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly hooks?: {
      onPromptStarted?: () => void;
      onPromptFailed?: () => void;
    },
  ) {
    this.state = {
      accumulatedText: '',
      accumulatedImages: [],
      accumulatedThoughts: [],
      accumulatedToolCalls: [],
      verboseMode: config.ai.verboseMode,
    };
  }

  getSessionId(): string | undefined {
    return this.remoteSessionId;
  }

  getCapabilities(): ACPAgentCapabilities {
    return this.capabilities;
  }

  getState(): ACPBridgeState {
    return {
      ...this.state,
      accumulatedImages: [...this.state.accumulatedImages],
      accumulatedThoughts: [...this.state.accumulatedThoughts],
      accumulatedToolCalls: [...this.state.accumulatedToolCalls],
    };
  }

  async ensureStarted(sessionId?: string): Promise<void> {
    if (!this.process) {
      try {
        await this.startProcess();
        await this.initializeConnection();
      } catch (error) {
        await this.stop();
        throw error;
      }
    }
    if (!this.connection) {
      throw new Error('ACP connection is not initialized');
    }
    if (!this.remoteSessionId) {
      await this.createOrLoadSession(sessionId);
    }
  }

  async sendPrompt(params: {
    freshSession?: boolean;
    onSessionReady?: (id: string) => Promise<void>;
    text: string;
    images?: AgentImageInput[];
    imageProcessingReport?: InboundImageProcessingReport;
    unsupportedMedia?: UnsupportedInboundMedia[];
    sessionIdHint?: string;
    systemPrompt?: string;
    contextLines?: string[];
    historyContextLines?: string[];
    includeHistory?: boolean;
    replyRules?: { instructions: string; allowSourceLinks: boolean; appendSourceList?: boolean; version?: string };
    replyProfile?: { styleId: string; styleVersion: string; rulesVersion: string; scene: import('../../core/reply-profile.js').ReplyScene };
    correlationId?: string;
    onProgress?: (state: ACPBridgeState) => void;
  }): Promise<AgentResponse> {
    return this.enqueuePrompt(async () => this.sendPromptInternal(params));
  }

  private async sendPromptInternal(params: {
    freshSession?: boolean;
    onSessionReady?: (id: string) => Promise<void>;
    text: string;
    images?: AgentImageInput[];
    imageProcessingReport?: InboundImageProcessingReport;
    unsupportedMedia?: UnsupportedInboundMedia[];
    sessionIdHint?: string;
    systemPrompt?: string;
    contextLines?: string[];
    historyContextLines?: string[];
    includeHistory?: boolean;
    replyRules?: { instructions: string; allowSourceLinks: boolean; appendSourceList?: boolean; version?: string };
    replyProfile?: { styleId: string; styleVersion: string; rulesVersion: string; scene: import('../../core/reply-profile.js').ReplyScene };
    correlationId?: string;
    onProgress?: (state: ACPBridgeState) => void;
  }): Promise<AgentResponse> {
    if (params.freshSession) await this.stop();
    this.state = {
      accumulatedText: '',
      accumulatedImages: [],
      accumulatedThoughts: [],
      accumulatedToolCalls: [],
      currentPlan: undefined,
      verboseMode: this.config.ai.verboseMode,
      correlationId: params.correlationId,
      currentRunId: randomUUID(),
    };
    await this.ensureStarted(params.freshSession ? undefined : params.sessionIdHint);
    this.lastPromptContentWasTool = false;
    if (!this.connection || !this.remoteSessionId) {
      throw new Error('ACP session is not ready');
    }

    await params.onSessionReady?.(this.remoteSessionId);

    this.progressCallback = params.onProgress;

    const prompt = buildPromptBlocks({
      text: params.text,
      images: params.images,
      imageProcessingReport: params.imageProcessingReport,
      unsupportedMedia: params.unsupportedMedia,
      promptCapabilities: this.capabilities.promptCapabilities,
      systemPrompt: params.systemPrompt,
      contextLines: params.contextLines,
    });
    const sessionId = this.remoteSessionId;
    this.hooks?.onPromptStarted?.();
    this.logger.info(
      {
        correlationId: params.correlationId,
        sessionId,
        reusedSession: !params.freshSession && Boolean(params.sessionIdHint),
        imageCount: params.images?.length ?? 0,
        imageReceivedCount: params.imageProcessingReport?.received ?? 0,
        imageFailureCount: params.imageProcessingReport?.failures.length ?? 0,
        unsupportedMediaCount: params.unsupportedMedia?.length ?? 0,
      },
      'dispatching ACP prompt',
    );

    try {
      this.acceptingPromptUpdates = true;
      let response = await this.connection.prompt({
        sessionId,
        prompt,
      });

      await new Promise((resolve) => setTimeout(resolve, 120));
      if (this.config.ai.grokCompat && response.stopReason === 'end_turn' && this.lastPromptContentWasTool) {
        // Some Grok streams end immediately after a hosted search call. Keep
        // the same session and request a final answer once, never an unbounded
        // retry and never pretend the preceding commentary is the answer.
        this.logger.info({ correlationId: params.correlationId }, 'bounded Grok continuation after tool-only ending');
        this.state.accumulatedText = '';
        this.lastPromptContentWasTool = false;
        response = await this.connection.prompt({
          sessionId,
          prompt: [{ type: 'text', text: '刚才的工具调用已经结束。请根据本轮用户问题和已返回的工具结果，直接给出最终答案及实际来源URL。不要再次调用工具，不要只说计划；如果工具没有返回可用结果，请如实说明失败。不要重复旧会话回答。' }],
        });
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (this.lastPromptContentWasTool || !this.state.accumulatedText.trim()) {
          throw new Error('Grok 工具流程结束后仍未生成最终答复，请稍后重试。');
        }
      }

      const text = sanitizeAcpAgentText(this.state.accumulatedText);
      return {
        text: this.config.ai.grokCompat ? validateGrokReply(text) : text,
        images: [...this.state.accumulatedImages],
        stopReason: response.stopReason,
        usage: response.usage,
        sessionId: this.remoteSessionId ?? sessionId,
      };
    } catch (error) {
      this.hooks?.onPromptFailed?.();
      if (this.isRecoverableConnectionError(error)) {
        this.logger.warn(
          {
            correlationId: params.correlationId,
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          },
          'ACP connection dropped during prompt; resetting bridge state',
        );
        try {
          await this.stop();
        } catch (stopError) {
          this.logger.warn(
            {
              correlationId: params.correlationId,
              error: stopError instanceof Error ? stopError.message : String(stopError),
            },
            'failed to stop ACP bridge after connection drop',
          );
        }
      }
      throw error;
    } finally {
      this.acceptingPromptUpdates = false;
      this.progressCallback = undefined;
    }
  }

  async stop(): Promise<void> {
    this.acceptingPromptUpdates = false;
    if (this.connection && this.remoteSessionId && this.capabilities.canCloseSession) {
      try {
        await this.connection.closeSession?.({ sessionId: this.remoteSessionId });
      } catch (error) {
        this.logger.debug(
          {
            correlationId: this.state.correlationId,
            error: error instanceof Error ? error.message : String(error),
          },
          'failed to close ACP session gracefully',
        );
      }
    }

    if (this.process) {
      const proc = this.process;
      this.process = null;
      this.connection = null;
      this.remoteSessionId = undefined;
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 3_000);
        proc.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }

  private async startProcess(): Promise<void> {
    const agentEnv = withGrokCompatibility(withWebSearch(process.env, this.config.ai.webSearch), this.config.ai.grokCompat ?? false);
    const childProcess = spawn(this.config.ai.agentCommand, this.config.ai.agentArgs, {
      cwd: this.config.ai.workdir,
      env: agentEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!childProcess.stdin || !childProcess.stdout) {
      throw new Error('failed to start ACP agent subprocess');
    }

    childProcess.stderr?.on('data', (data: Buffer) => {
      this.logger.debug(
        {
          correlationId: this.state.correlationId,
          stderr: data.toString(),
        },
        'acp agent stderr',
      );
    });
    childProcess.once('error', (error) => {
      this.logger.error(
        {
          correlationId: this.state.correlationId,
          error: error.message,
        },
        'acp agent process failed',
      );
    });
    childProcess.once('exit', (code, signal) => {
      this.logger.info(
        {
          correlationId: this.state.correlationId,
          code,
          signal,
        },
        'acp agent process exited',
      );
      this.process = null;
      this.connection = null;
      this.remoteSessionId = undefined;
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(childProcess.stdin) as WritableStream,
      Readable.toWeb(childProcess.stdout) as ReadableStream,
    );

    this.process = childProcess;
    this.connection = new acp.ClientSideConnection(() => this.createClientHandlers(), stream);
  }

  private async initializeConnection(): Promise<void> {
    if (!this.connection) {
      throw new Error('ACP connection missing during initialize');
    }

    const initResult = await this.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: {
        name: this.config.ai.clientName,
        version: '0.1.3',
      },
      clientCapabilities: {},
    });

    this.capabilities = {
      canLoadSession: initResult.agentCapabilities?.loadSession === true,
      canListSessions: Boolean(initResult.agentCapabilities?.sessionCapabilities?.list),
      canCloseSession: Boolean(initResult.agentCapabilities?.sessionCapabilities?.close),
      promptCapabilities: initResult.agentCapabilities?.promptCapabilities,
    };

    this.logger.info(
      {
        correlationId: this.state.correlationId,
        canLoadSession: this.capabilities.canLoadSession,
        canListSessions: this.capabilities.canListSessions,
        canCloseSession: this.capabilities.canCloseSession,
      },
      'initialized ACP connection',
    );
  }

  private async createOrLoadSession(sessionId?: string): Promise<void> {
    if (!this.connection) {
      throw new Error('ACP connection missing during session creation');
    }

    if (sessionId && this.capabilities.canLoadSession) {
      try {
        await this.connection.loadSession({
          sessionId,
          cwd: this.config.ai.workdir,
          mcpServers: [],
        });
        this.remoteSessionId = sessionId;
        this.logger.info(
          {
            correlationId: this.state.correlationId,
            sessionId,
          },
          'loaded existing ACP session',
        );
        return;
      } catch (error) {
        this.logger.warn(
          {
            correlationId: this.state.correlationId,
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          },
          'failed to load ACP session, falling back to new session',
        );
      }
    }

    const newSession = await this.connection.newSession({
      cwd: this.config.ai.workdir,
      mcpServers: [],
    });
    this.remoteSessionId = newSession.sessionId;
    this.logger.info(
      {
        correlationId: this.state.correlationId,
        sessionId: this.remoteSessionId,
      },
      'created new ACP session',
    );
  }

  private enqueuePrompt<T>(task: () => Promise<T>): Promise<T> {
    const queuedAhead = this.queuedPromptCount;
    this.queuedPromptCount += 1;

    const run = this.promptChain.catch(() => undefined).then(async () => {
      if (queuedAhead > 0) {
        this.logger.warn(
          {
            correlationId: this.state.correlationId,
            queuedAhead,
          },
          'serialized concurrent ACP prompt on the same conversation',
        );
      }
      try {
        return await task();
      } finally {
        this.queuedPromptCount = Math.max(0, this.queuedPromptCount - 1);
      }
    });

    this.promptChain = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  private isRecoverableConnectionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('ACP connection closed') ||
      message.includes('ACP connection is not initialized') ||
      message.includes('ACP session is not ready')
    );
  }

  private createClientHandlers(): acp.Client {
    return {
      sessionUpdate: async (params) => {
        this.handleSessionUpdate(params);
      },
      requestPermission: async (params) => {
        const option = this.acceptingPromptUpdates
          ? pickPermissionOption(params.options, this.config.ai.permissionStrategy) : undefined;
        if (!option) {
          return {
            outcome: {
              outcome: 'cancelled',
            },
          };
        }
        this.logger.info(
          {
            correlationId: this.state.correlationId,
            toolCallId: params.toolCall.toolCallId,
            title: params.toolCall.title,
            selected: option.kind,
            preview: summarizeText(extractToolArguments(params.toolCall as Record<string, unknown>)),
          },
          'auto-handled ACP permission request',
        );
        return {
          outcome: {
            outcome: 'selected',
            optionId: option.optionId,
          },
        };
      },
    };
  }

  private handleSessionUpdate(params: schema.SessionNotification): void {
    // loadSession replays past assistant/tool messages. They are context, not
    // this turn's output; also reject stray notifications from another session.
    if (!this.acceptingPromptUpdates || params.sessionId !== this.remoteSessionId) return;
    const update = params.update;
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      this.lastPromptContentWasTool = true;
    } else if (update.sessionUpdate === 'agent_message_chunk') {
      const content = (update as schema.SessionNotification['update'] & { content: schema.ContentBlock }).content;
      if (content.type === 'image' || (content.type === 'text' && content.text.trim())) this.lastPromptContentWasTool = false;
    }

    if (update.sessionUpdate === 'plan' && this.state.verboseMode !== 'normal') {
      this.state.currentPlan = update as schema.Plan;
      this.emitProgress();
      this.logger.debug(
        {
          correlationId: this.state.correlationId,
          activeStep: formatPlanEntry(update as schema.Plan),
        },
        'received ACP plan update',
      );
      return;
    }

    if (update.sessionUpdate === 'agent_thought_chunk' && this.state.verboseMode === 'debug') {
      const thought = update as schema.SessionNotification['update'] & { content?: { type: string; text?: string } };
      if (thought.content?.type === 'text' && typeof thought.content.text === 'string') {
        this.state.accumulatedThoughts = [
          ...this.state.accumulatedThoughts,
          { timestamp: new Date(), content: thought.content.text },
        ].slice(-5);
        this.emitProgress();
      }
      return;
    }

    if (update.sessionUpdate === 'tool_call' && this.state.verboseMode !== 'normal') {
      const toolCall = update as Record<string, unknown>;
      const toolCallId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : '';
      const title = typeof toolCall.title === 'string' ? toolCall.title : 'Unknown Tool';
      const kind = typeof toolCall.kind === 'string' ? toolCall.kind : undefined;
      const status = (typeof toolCall.status === 'string' ? toolCall.status : 'pending') as ToolCallEntry['status'];
      if (toolCallId) {
        this.upsertToolCall({
          toolCallId,
          title,
          kind,
          status,
          timestamp: new Date(),
        });
        this.state.accumulatedText = '';
        this.emitProgress();
        this.logger.debug(
          {
            correlationId: this.state.correlationId,
            toolCallId,
            title,
            kind,
            status,
            preview: summarizeText(extractToolArguments(toolCall)),
          },
          'received ACP tool_call update',
        );
      }
      return;
    }

    if (update.sessionUpdate === 'tool_call_update' && this.state.verboseMode !== 'normal') {
      const toolCallUpdate = update as Record<string, unknown>;
      const toolCallId = typeof toolCallUpdate.toolCallId === 'string' ? toolCallUpdate.toolCallId : '';
      const status = (typeof toolCallUpdate.status === 'string'
        ? toolCallUpdate.status
        : 'pending') as ToolCallEntry['status'];
      if (toolCallId) {
        this.upsertToolCall({
          toolCallId,
          title: this.findToolCallTitle(toolCallId),
          status,
          timestamp: new Date(),
        });
        this.state.accumulatedText = '';
        this.emitProgress();
        this.logger.debug(
          {
            correlationId: this.state.correlationId,
            toolCallId,
            status,
            preview: summarizeText(extractToolOutput(toolCallUpdate)),
          },
          'received ACP tool_call_update',
        );
      }
      return;
    }

    if (update.sessionUpdate === 'agent_message_chunk') {
      const messageChunk = update as schema.SessionNotification['update'] & { content: schema.ContentBlock };
      if (messageChunk.content.type === 'text') {
        this.state.accumulatedText += messageChunk.content.text;
      } else if (messageChunk.content.type === 'image') {
        const image = extractImageOutput(messageChunk.content);
        if (image) {
          this.state.accumulatedImages = [...this.state.accumulatedImages, image];
        }
      }
      return;
    }
  }

  private emitProgress(): void {
    this.progressCallback?.(this.getState());
  }

  private findToolCallTitle(toolCallId: string): string {
    return this.state.accumulatedToolCalls.find((item) => item.toolCallId === toolCallId)?.title || toolCallId;
  }

  private upsertToolCall(entry: ToolCallEntry): void {
    const index = this.state.accumulatedToolCalls.findIndex((item) => item.toolCallId === entry.toolCallId);
    if (index >= 0) {
      const updated = [...this.state.accumulatedToolCalls];
      updated[index] = {
        ...updated[index],
        ...entry,
      };
      this.state.accumulatedToolCalls = updated;
      return;
    }
    this.state.accumulatedToolCalls = [...this.state.accumulatedToolCalls, entry].slice(-10);
  }
}
