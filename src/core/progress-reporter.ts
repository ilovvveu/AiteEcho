import type { Logger } from 'pino';
import type { ACPBridgeState, VerboseMode } from '../types/agent.js';
import type { OneBotReplyContext } from '../types/onebot.js';
import { OneBotGateway } from '../channels/onebot/client.js';

function statusIcon(status: string): string {
  switch (status) {
    case 'completed':
      return '✅';
    case 'failed':
      return '❌';
    case 'in_progress':
      return '⏳';
    default:
      return '⏸️';
  }
}

function summarizePlan(state: ACPBridgeState): string[] {
  const plan = state.currentPlan;
  const entries = Array.isArray((plan as any)?.entries) ? ((plan as any).entries as Array<Record<string, unknown>>) : [];
  if (entries.length === 0) {
    return [];
  }

  const completed = entries.filter((entry) => entry.status === 'completed').length;
  const total = entries.length;
  const active =
    entries.find((entry) => entry.status === 'in_progress' || entry.status === 'active') ?? entries[0];
  const activeText =
    typeof active?.content === 'string'
      ? active.content
      : typeof active?.title === 'string'
        ? active.title
        : typeof active?.text === 'string'
          ? active.text
          : '计划更新';

  return [`📋 ${completed}/${total} 步完成`, `当前步骤：${activeText}`];
}

function summarizeTools(state: ACPBridgeState): string[] {
  return state.accumulatedToolCalls.slice(-3).map((call) => `${statusIcon(call.status)} ${call.title}`);
}

function summarizeThought(state: ACPBridgeState): string[] {
  const thought = state.accumulatedThoughts.at(-1);
  if (!thought) {
    return [];
  }
  const content = thought.content.length > 80 ? `${thought.content.slice(0, 80)}...` : thought.content;
  return [`💭 ${content}`];
}

function renderProgress(state: ACPBridgeState, verboseMode: VerboseMode): string {
  const lines = ['⏳ 正在处理中'];

  if (state.correlationId) {
    lines.push(`🔗 correlation: ${state.correlationId}`);
  }

  if (verboseMode !== 'normal') {
    lines.push(...summarizePlan(state));
    const tools = summarizeTools(state);
    if (tools.length > 0) {
      lines.push('🔧 最近工具调用：');
      lines.push(...tools.map((item) => `- ${item}`));
    }
  }

  if (verboseMode === 'debug') {
    lines.push(...summarizeThought(state));
  }

  return lines.join('\n').trim();
}

export class ProgressReporter {
  private timer: NodeJS.Timeout | null = null;
  private latestState: ACPBridgeState | null = null;
  private lastRendered = '';
  private sentCount = 0;
  private stopped = false;

  constructor(
    private readonly gateway: OneBotGateway,
    private readonly context: OneBotReplyContext,
    private readonly logger: Logger,
    private readonly mode: 'off' | 'message',
    private readonly verboseMode: VerboseMode,
    private readonly throttleMs: number,
    private readonly maxUpdates: number,
  ) {}

  async start(): Promise<void> {
    if (this.mode === 'off') {
      return;
    }
    await this.send('⏳ 已收到消息，开始处理中...');
  }

  update(state: ACPBridgeState): void {
    if (this.mode === 'off' || this.stopped) {
      return;
    }
    this.latestState = state;
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.throttleMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async flush(): Promise<void> {
    if (!this.latestState || this.sentCount >= this.maxUpdates) {
      return;
    }
    const rendered = renderProgress(this.latestState, this.verboseMode);
    if (!rendered || rendered === this.lastRendered) {
      return;
    }
    await this.send(rendered);
  }

  private async send(text: string): Promise<void> {
    this.lastRendered = text;
    this.sentCount += 1;
    try {
      await this.gateway.sendText(
        {
          ...this.context,
          replyToId: this.sentCount === 1 ? this.context.replyToId : undefined,
          purpose: 'progress',
        },
        text,
      );
    } catch (error) {
      this.logger.warn(
        {
          correlationId: this.context.correlationId,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to send progress message',
      );
    }
  }
}
