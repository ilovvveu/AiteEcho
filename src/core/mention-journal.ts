import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config/index.js';
import type { NormalizedOneBotEvent, OutboundObservation } from '../types/onebot.js';
import { safeErrorCode } from '../infra/diagnostics.js';

type Scope = { correlationId: string; groupId: string; questionMessageId?: string; senderId: string; senderName?: string };
type Result = 'finished' | 'failed' | 'policy_blocked' | 'rate_limited' | 'queue_full' | 'queue_expired';

/** Independent, append-only local record. Never a model prompt, session store, or rotating diagnostic log. */
export class MentionJournal {
  private writes: Promise<void> = Promise.resolve();
  private readonly active = new Map<string, { scope: Scope; result: Result; code?: string }>();
  private healthy = true;
  private written = 0;
  private failures = 0;
  private pending = 0;
  private lastErrorCode?: string;
  constructor(private readonly file: string | undefined, private readonly config: AppConfig['onebot']) {}

  status() {
    return { enabled: Boolean(this.file), healthy: this.healthy, writtenEvents: this.written, writeFailures: this.failures,
      pendingWrites: this.pending, activeRequests: this.active.size, lastErrorCode: this.lastErrorCode,
      retention: 'no-automatic-deletion', scope: 'explicit-group-mentions-only', feedsModelContext: false };
  }

  private async withFile(write?: string): Promise<void> {
    if (!this.file) return;
    const parent = path.dirname(this.file);
    if (/(?:^|\/)(?:Mobile Documents|CloudStorage)(?:\/|$)/u.test(path.resolve(this.file))) throw Object.assign(new Error('cloud path'), { code: 'CLOUD_PATH_FORBIDDEN' });
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (/(?:^|\/)(?:Mobile Documents|CloudStorage)(?:\/|$)/u.test(await realpath(parent))) throw Object.assign(new Error('cloud path'), { code: 'CLOUD_PATH_FORBIDDEN' });
    const file = await open(this.file, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      if (!(await file.stat()).isFile()) throw Object.assign(new Error('not regular'), { code: 'INVALID_JOURNAL_FILE' });
      await file.chmod(0o600);
      if (write !== undefined) { await file.writeFile(write); await file.sync(); }
    } finally { await file.close(); }
  }

  private enqueue(record?: Record<string, unknown>): Promise<void> {
    if (!this.file) return Promise.resolve();
    const at = new Date();
    const line = record ? JSON.stringify({ version: 1, recordedAt: at.toISOString(),
      recordedAtLocal: at.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }), timeZone: 'Asia/Shanghai', ...record }) + '\n' : undefined;
    this.pending++;
    this.writes = this.writes.then(async () => {
      try { await this.withFile(line); this.healthy = true; if (record) this.written++; }
      catch (error) { this.healthy = false; this.failures++; this.lastErrorCode = safeErrorCode(error); }
      finally { this.pending--; }
    });
    return this.writes;
  }

  start(): Promise<void> { return this.enqueue(); }
  flush(): Promise<void> { return this.writes; }

  async begin(event: NormalizedOneBotEvent, correlationId: string): Promise<void> {
    if (!this.file || event.mode !== 'group' || !event.explicitMention || event.isSelfMessage || !this.config.allowGroup
      || this.config.blockedGroups.includes(event.conversationId)
      || (this.config.allowedGroups.length > 0 && !this.config.allowedGroups.includes(event.conversationId))
      || this.config.groupPolicies[event.conversationId]?.enabled === false || this.active.has(correlationId)) return;
    const scope: Scope = { correlationId, groupId: event.conversationId, questionMessageId: event.messageId,
      senderId: event.senderId, senderName: event.senderName };
    // Preserve the received text, not the shortened/command-normalized model input.
    const text = Array.isArray(event.raw.message) ? event.raw.message.map(part => {
      if (part.type === 'text') return typeof part.data?.text === 'string' ? part.data.text : '';
      if (part.type === 'at') return String(part.data?.qq) === event.selfId ? '' : `@${String(part.data?.qq ?? '')}`;
      if (part.type === 'face') return `[表情:${String(part.data?.id ?? '')}]`;
      return '';
    }).join('').trim() : event.cleanedText;
    const messageDate = new Date(event.timestamp ?? NaN);
    const validMessageDate = Number.isFinite(messageDate.getTime());
    this.active.set(correlationId, { scope, result: 'finished' });
    await this.enqueue({ kind: 'question', ...scope, botId: event.selfId,
      groupName: typeof event.raw.group_name === 'string' ? event.raw.group_name : this.config.groupPolicies[event.conversationId]?.name,
      senderCard: event.raw.sender?.card, senderNickname: event.raw.sender?.nickname,
      messageAt: validMessageDate ? messageDate.toISOString() : undefined,
      messageAtLocal: validMessageDate ? messageDate.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) : undefined,
      text, mentionedUserIds: event.mentionedUserIds, replyToId: event.replyToId,
      attachments: [...(event.imageReferences ?? []).map(() => ({ type: 'image' })),
        ...(event.documentReferences ?? []).map(item => ({ type: 'file', name: item.name, size: item.size })),
        ...event.unsupportedMedia.map(item => ({ type: item.segmentType, name: item.name }))],
      recallStatus: 'not-verified' });
  }

  setResult(correlationId: string, result: Result, code?: string): void {
    const item = this.active.get(correlationId);
    if (item) { item.result = result; item.code = code; }
  }

  async observeReply(event: OutboundObservation): Promise<void> {
    const item = event.context.correlationId ? this.active.get(event.context.correlationId) : undefined;
    if (!item || event.context.chatType !== 'group' || event.context.targetId !== item.scope.groupId) return;
    const segments = typeof event.message === 'string' ? [{ type: 'text', data: { text: event.message } }] : event.message;
    const text = event.voiceText ?? segments.filter(part => part.type === 'text').map(part => (part.data as Record<string, unknown> | undefined)?.text ?? '').join('');
    await this.enqueue({ kind: 'reply', ...item.scope, purpose: event.context.purpose ?? 'reply',
      delivery: event.outcome, replyMessageId: event.messageId, errorCode: event.errorCode, retcode: event.retcode,
      text, mediaTypes: segments.filter(part => part.type !== 'text' && part.type !== 'reply').map(part => part.type),
      clientVisibility: 'not-verified' });
  }

  async finish(correlationId: string): Promise<void> {
    const item = this.active.get(correlationId); if (!item) return;
    await this.enqueue({ kind: 'processing_result', ...item.scope, result: item.result, errorCode: item.code });
    this.active.delete(correlationId);
  }
}
