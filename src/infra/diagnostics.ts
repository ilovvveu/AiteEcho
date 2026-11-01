import { appendFile, chmod, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

export type DiagnosticFields = {
  correlationId?: string; attempt?: number; elapsedMs?: number; durationMs?: number;
  code?: string; httpStatus?: number; requestId?: string; bytes?: number;
  inputChars?: number; inputBytes?: number; historyChars?: number; imageCount?: number;
  truncated?: boolean; inputTokens?: number; outputTokens?: number; cachedTokens?: number;
  family?: number; fakeIp?: boolean; retry?: boolean; count?: number;
  styleId?: string; styleVersion?: string; rulesVersion?: string; scene?: string; sourceLinksAllowed?: boolean;
  historyTurns?: number; historyCandidates?: number; commentaryExcluded?: number; finalMessages?: number;
  expectedBytes?: number; responseComplete?: boolean; responseBodyStarted?: boolean;
  requestConnection?: 'keep-alive'; responseConnection?: 'keep-alive' | 'close' | 'unspecified' | 'other';
  responseFraming?: 'content-length' | 'chunked' | 'unspecified' | 'other';
  route?: 'direct' | 'local_proxy';
  requestSubmitted?: boolean; tlsEstablished?: boolean;
  requestFlushed?: boolean; failureStage?: string;
};
export interface DiagnosticEvent extends DiagnosticFields {
  at: string; stage: string; outcome: 'start' | 'ok' | 'error' | 'retry';
}

/** Deliberately no free-form messages, bodies, URLs, headers, keys, or chat text. */
export class Diagnostics {
  private writes: Promise<void> = Promise.resolve();
  private healthy = true;
  private lastSuccessAt?: string;
  private lastFailure?: DiagnosticEvent;
  private lastResult: 'unknown' | 'ok' | 'error' = 'unknown';
  private recent: DiagnosticEvent[] = [];
  private dropped = 0;
  private queued = 0;

  constructor(private readonly file?: string, private readonly maxBytes = 5 * 1024 * 1024) {}

  record(stage: string, outcome: DiagnosticEvent['outcome'], fields: DiagnosticFields = {}): void {
    const event: DiagnosticEvent = { at: new Date().toISOString(), stage, outcome, ...fields };
    this.recent.push(event);
    this.recent = this.recent.slice(-30);
    if (stage === 'api_complete' && outcome === 'ok') { this.lastResult = 'ok'; this.lastSuccessAt = event.at; }
    if (outcome === 'error' && (!['api_complete', 'turn_complete'].includes(stage)
      || this.lastFailure?.correlationId !== fields.correlationId)) this.lastFailure = event;
    if (stage === 'api_complete' && outcome === 'error') this.lastResult = 'error';
    if (!this.file) return;
    if (this.queued >= 1000) { this.dropped++; return; }
    this.queued++;
    this.writes = this.writes.then(async () => {
      const file = this.file!;
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const size = await stat(file).then(s => s.size).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
        return 0;
      });
      const line = `${JSON.stringify(event)}\n`;
      if (size + Buffer.byteLength(line) > this.maxBytes) {
        for (let i = 2; i >= 0; i--) {
          await rename(i ? `${file}.${i}` : file, `${file}.${i + 1}`).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== 'ENOENT') throw e;
          });
        }
      }
      await appendFile(file, line, { mode: 0o600 });
      await chmod(file, 0o600);
      this.healthy = true;
    }).catch(() => { this.healthy = false; }).finally(() => { this.queued--; });
  }

  status(): Record<string, unknown> {
    return { state: this.lastResult, lastSuccessAt: this.lastSuccessAt, lastFailure: this.lastFailure,
      logConfigured: Boolean(this.file), logHealthy: this.healthy, droppedLogEvents: this.dropped, recent: this.recent };
  }
  async flush(): Promise<void> { await this.writes; }
}

export function safeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNEXPECTED';
  return /^[A-Z0-9_]{1,60}$/u.test(code) ? code : 'UNEXPECTED';
}
