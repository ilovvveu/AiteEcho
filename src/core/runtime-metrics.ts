import type { BuildInfo } from './build-info.js';
import type { OneBotChatType } from '../types/onebot.js';

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) {
    return '';
  }
  const parts = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`);
  return `{${parts.join(',')}}`;
}

function metricLines(params: {
  name: string;
  help: string;
  type: 'counter' | 'gauge';
  values: Array<{
    value: number;
    labels?: Record<string, string>;
  }>;
}): string[] {
  const lines = [
    `# HELP ${params.name} ${params.help}`,
    `# TYPE ${params.name} ${params.type}`,
  ];
  for (const item of params.values) {
    lines.push(`${params.name}${formatLabels(item.labels)} ${item.value}`);
  }
  return lines;
}

type CounterSnapshot = {
  inboundMessagesTotal: number;
  inboundDuplicatesTotal: number;
  processedMessagesTotal: number;
  outboundMessagesTotal: number;
  acpPromptCallsTotal: number;
  acpPromptFailuresTotal: number;
  commandsByName: Map<string, number>;
  processedByKind: Map<'command' | 'user_message', number>;
  outboundByChatType: Map<OneBotChatType, number>;
  errorsByKind: Map<string, number>;
};

type DurationLabels = {
  chatType: 'private' | 'group';
  outcome: 'ok' | 'error' | 'dropped';
  transportMode: 'forward' | 'reverse';
};

type HistogramSeries = {
  labels: Record<string, string>;
  buckets: Map<number, number>;
  count: number;
  sum: number;
};

const DURATION_BUCKETS_SECONDS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] as const;

export class RuntimeMetrics {
  private readonly counters: CounterSnapshot = {
    inboundMessagesTotal: 0,
    inboundDuplicatesTotal: 0,
    processedMessagesTotal: 0,
    outboundMessagesTotal: 0,
    acpPromptCallsTotal: 0,
    acpPromptFailuresTotal: 0,
    commandsByName: new Map(),
    processedByKind: new Map(),
    outboundByChatType: new Map(),
    errorsByKind: new Map(),
  };

  private readonly turnDuration = new Map<string, HistogramSeries>();
  private readonly agentRoundtripDuration = new Map<string, HistogramSeries>();
  private readonly replySendDuration = new Map<string, HistogramSeries>();

  recordInboundMessage(): void {
    this.counters.inboundMessagesTotal += 1;
  }

  recordInboundDuplicate(): void {
    this.counters.inboundDuplicatesTotal += 1;
  }

  recordProcessedMessage(kind: 'command' | 'user_message'): void {
    this.counters.processedMessagesTotal += 1;
    this.bumpMap(this.counters.processedByKind, kind);
  }

  recordCommand(name: string): void {
    this.bumpMap(this.counters.commandsByName, name || 'unknown');
  }

  recordOutboundMessage(chatType: OneBotChatType): void {
    this.counters.outboundMessagesTotal += 1;
    this.bumpMap(this.counters.outboundByChatType, chatType);
  }

  recordAcpPromptCall(): void {
    this.counters.acpPromptCallsTotal += 1;
  }

  recordAcpPromptFailure(): void {
    this.counters.acpPromptFailuresTotal += 1;
  }

  recordError(kind: string): void {
    this.bumpMap(this.counters.errorsByKind, kind);
  }

  recordTurnDuration(seconds: number, labels: DurationLabels): void {
    this.observeHistogram(this.turnDuration, seconds, this.toMetricLabels(labels));
  }

  recordAgentRoundtrip(seconds: number, labels: DurationLabels): void {
    this.observeHistogram(this.agentRoundtripDuration, seconds, this.toMetricLabels(labels));
  }

  recordReplySend(seconds: number, labels: DurationLabels): void {
    this.observeHistogram(this.replySendDuration, seconds, this.toMetricLabels(labels));
  }

  render(params: {
    build: BuildInfo;
    onebotConnected: boolean;
    onebotReconnectAttempts: number;
    activeConversations: number;
    persistedConversations: number;
  }): string {
    const buildInfoValue = {
      version: params.build.version,
      build_ref: params.build.buildRef || 'unknown',
      git_commit: params.build.gitCommit || 'unknown',
    };
    const startedAtSeconds = Math.floor(Date.parse(params.build.startedAt) / 1000);

    const lines: string[] = [];
    lines.push(
      ...metricLines({
        name: 'qq_ai_bot_build_info',
        help: 'Build metadata for qq-ai-bot.',
        type: 'gauge',
        values: [{ value: 1, labels: buildInfoValue }],
      }),
    );
    lines.push(
      ...metricLines({
        name: 'qq_ai_bot_process_started_at_seconds',
        help: 'Process start time in unix seconds.',
        type: 'gauge',
        values: [{ value: Number.isFinite(startedAtSeconds) ? startedAtSeconds : 0 }],
      }),
    );
    lines.push(
      ...metricLines({
        name: 'qq_ai_bot_onebot_connected',
        help: 'Whether the OneBot transport is currently connected.',
        type: 'gauge',
        values: [{ value: params.onebotConnected ? 1 : 0 }],
      }),
    );
    lines.push(
      ...metricLines({
        name: 'qq_ai_bot_onebot_reconnect_attempts',
        help: 'Current reconnect attempt count for the OneBot transport.',
        type: 'gauge',
        values: [{ value: params.onebotReconnectAttempts }],
      }),
    );
    lines.push(
      ...metricLines({
        name: 'qq_ai_bot_active_conversations',
        help: 'Number of active in-memory conversations.',
        type: 'gauge',
        values: [{ value: params.activeConversations }],
      }),
    );
    lines.push(
      ...metricLines({
        name: 'qq_ai_bot_persisted_conversations',
        help: 'Number of persisted conversations on disk.',
        type: 'gauge',
        values: [{ value: params.persistedConversations }],
      }),
    );
    lines.push(
      ...metricLines({
        name: 'qq_ai_bot_inbound_messages_total',
        help: 'Total inbound OneBot messages processed by the bridge.',
        type: 'counter',
        values: [{ value: this.counters.inboundMessagesTotal }],
      }),
    );
    lines.push(
      ...metricLines({
        name: 'qq_ai_bot_inbound_duplicates_total',
        help: 'Total inbound OneBot messages dropped by lightweight replay dedupe.',
        type: 'counter',
        values: [{ value: this.counters.inboundDuplicatesTotal }],
      }),
    );
    lines.push(
      ...metricLines({
        name: 'qq_ai_bot_processed_messages_total',
        help: 'Total processed messages grouped by kind.',
        type: 'counter',
        values: this.mapToValues(this.counters.processedByKind, 'kind'),
      }),
    );
    lines.push(
      ...metricLines({
        name: 'qq_ai_bot_commands_total',
        help: 'Total commands handled by command name.',
        type: 'counter',
        values: this.mapToValues(this.counters.commandsByName, 'command'),
      }),
    );
    lines.push(
      ...metricLines({
        name: 'qq_ai_bot_outbound_messages_total',
        help: 'Total outbound OneBot messages sent by chat type.',
        type: 'counter',
        values: this.mapToValues(this.counters.outboundByChatType, 'chat_type'),
      }),
    );
    lines.push(
      ...metricLines({
        name: 'qq_ai_bot_acp_prompt_calls_total',
        help: 'Total ACP prompt calls started.',
        type: 'counter',
        values: [{ value: this.counters.acpPromptCallsTotal }],
      }),
    );
    lines.push(
      ...metricLines({
        name: 'qq_ai_bot_acp_prompt_failures_total',
        help: 'Total ACP prompt failures.',
        type: 'counter',
        values: [{ value: this.counters.acpPromptFailuresTotal }],
      }),
    );
    lines.push(
      ...metricLines({
        name: 'qq_ai_bot_errors_total',
        help: 'Total runtime errors grouped by kind.',
        type: 'counter',
        values: this.mapToValues(this.counters.errorsByKind, 'kind'),
      }),
    );
    lines.push(
      ...this.histogramLines({
        name: 'qq_ai_bot_turn_duration_seconds',
        help: 'End-to-end user message turn duration from receive to final reply or failure.',
        series: this.turnDuration,
      }),
    );
    lines.push(
      ...this.histogramLines({
        name: 'qq_ai_bot_agent_roundtrip_seconds',
        help: 'ACP agent round-trip duration for user message prompts.',
        series: this.agentRoundtripDuration,
      }),
    );
    lines.push(
      ...this.histogramLines({
        name: 'qq_ai_bot_reply_send_seconds',
        help: 'OneBot final reply send action duration.',
        series: this.replySendDuration,
      }),
    );

    return `${lines.join('\n')}\n`;
  }

  private bumpMap<K>(map: Map<K, number>, key: K): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  private observeHistogram(
    map: Map<string, HistogramSeries>,
    seconds: number,
    labels: Record<string, string>,
  ): void {
    const value = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
    const key = JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));
    let series = map.get(key);
    if (!series) {
      series = {
        labels,
        buckets: new Map(DURATION_BUCKETS_SECONDS.map((bucket) => [bucket, 0])),
        count: 0,
        sum: 0,
      };
      map.set(key, series);
    }

    series.count += 1;
    series.sum += value;
    for (const bucket of DURATION_BUCKETS_SECONDS) {
      if (value <= bucket) {
        series.buckets.set(bucket, (series.buckets.get(bucket) ?? 0) + 1);
      }
    }
  }

  private histogramLines(params: {
    name: string;
    help: string;
    series: Map<string, HistogramSeries>;
  }): string[] {
    const lines = [
      `# HELP ${params.name} ${params.help}`,
      `# TYPE ${params.name} histogram`,
    ];

    for (const series of [...params.series.values()].sort((left, right) =>
      JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels)),
    )) {
      for (const bucket of DURATION_BUCKETS_SECONDS) {
        lines.push(
          `${params.name}_bucket${formatLabels({ ...series.labels, le: String(bucket) })} ${series.buckets.get(bucket) ?? 0}`,
        );
      }
      lines.push(`${params.name}_bucket${formatLabels({ ...series.labels, le: '+Inf' })} ${series.count}`);
      lines.push(`${params.name}_sum${formatLabels(series.labels)} ${this.formatNumber(series.sum)}`);
      lines.push(`${params.name}_count${formatLabels(series.labels)} ${series.count}`);
    }

    return lines;
  }

  private toMetricLabels(labels: DurationLabels): Record<string, string> {
    return {
      chat_type: labels.chatType,
      outcome: labels.outcome,
      transport_mode: labels.transportMode,
    };
  }

  private formatNumber(value: number): string {
    if (Number.isInteger(value)) {
      return String(value);
    }
    return String(Number(value.toFixed(6)));
  }

  private mapToValues<K extends string>(
    map: Map<K, number>,
    labelName: string,
  ): Array<{ value: number; labels?: Record<string, string> }> {
    if (map.size === 0) {
      return [{ value: 0, labels: { [labelName]: 'none' } }];
    }
    return [...map.entries()].map(([key, value]) => ({
      value,
      labels: { [labelName]: key },
    }));
  }
}
