import type { Logger } from 'pino';
import type { AppConfig } from '../../config/index.js';
import type {
  OneBotOutboundImage,
  OneBotActionResponse,
  OneBotReplyContext,
  PlannedOutboundPayload,
  TransportStatusPatch,
  NormalizedOneBotEvent,
  InboundDocumentReference,
  OutboundObservation,
} from '../../types/onebot.js';
import { planOutboundPayload } from './outbound.js';
import { OneBotActionError } from './errors.js';
import { resolveLocalOutboundImage } from './local-image.js';
import { validMp3, VoiceError } from '../../core/voice.js';
import { encodeQqVoice } from '../../core/voice-codec.js';
import type { DiagnosticFields } from '../../infra/diagnostics.js';
import { safeErrorCode } from '../../infra/diagnostics.js';
import { normalizeQuotedMessage } from '../../core/reply-context.js';
import type { GroupRole } from '../../core/group-access.js';
import {
  type ActionTransport,
  startForwardWsTransport,
  startReverseWsTransport,
} from './transport.js';

export class OneBotGateway {
  private transport: ActionTransport | null = null;
  private readonly messageScopes = new Map<string, string>();
  private latestStatus: Required<TransportStatusPatch> = {
    connected: false,
    reconnectAttempts: 0,
    lastConnectedAt: null,
    lastDisconnect: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastEventAt: null,
    lastError: null,
  };

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly onOutboundMessage?: (chatType: OneBotReplyContext['chatType']) => void,
    private readonly onTransportStatus?: (patch: TransportStatusPatch) => void,
    private readonly onVoiceEncode?: (outcome:'start'|'ok'|'error',fields:DiagnosticFields)=>void,
    private readonly onOutboundObservation?: (event: OutboundObservation) => Promise<void> | void,
  ) {}

  async start(onEvent: (payload: unknown) => Promise<void>): Promise<void> {
    const onStatus = (patch: TransportStatusPatch): void => {
      const changed = (patch.connected !== undefined && patch.connected !== this.latestStatus.connected)
        || (Boolean(patch.lastError) && patch.lastError !== this.latestStatus.lastError);
      this.latestStatus = {
        ...this.latestStatus,
        ...patch,
      };
      if (changed) this.onTransportStatus?.(patch);
    };

    if (this.config.onebot.mode === 'forward') {
      this.transport = startForwardWsTransport({
        url: this.config.onebot.forwardWsUrl,
        accessToken: this.config.onebot.accessToken,
        onEvent,
        onStatus,
      });
      this.logger.info({ url: this.config.onebot.forwardWsUrl }, 'onebot forward websocket connecting');
      return;
    }

    this.transport = await startReverseWsTransport({
      host: this.config.onebot.reverseWsHost,
      port: this.config.onebot.reverseWsPort,
      path: this.config.onebot.reverseWsPath,
      accessToken: this.config.onebot.accessToken,
      onEvent,
      onStatus,
    });
    this.logger.info(
      {
        host: this.config.onebot.reverseWsHost,
        port: this.config.onebot.reverseWsPort,
        path: this.config.onebot.reverseWsPath,
      },
      'onebot reverse websocket listening',
    );
  }

  async stop(): Promise<void> {
    await this.transport?.close();
    this.transport = null;
  }

  isReady(): boolean {
    return this.transport?.isReady() ?? false;
  }

  getStatus(): Required<TransportStatusPatch> {
    return this.latestStatus;
  }

  async resolveInboundImageFile(file: string, event?: NormalizedOneBotEvent): Promise<string | undefined> {
    if (!this.transport) {
      throw new Error('onebot transport is not initialized');
    }
    if (this.config.onebot.inboundImageStream) {
      if (!event || !this.transport.readImageStream) throw new Error('图片流缺少消息范围或传输支持');
      if (!/^[A-Za-z0-9._{}()[\]-]{1,512}$/u.test(file) || file === '.' || file === '..') throw new Error('图片标识不可用');
      // Never turn a raw CQ string or a forged file ID into a local file read.
      // Authoritative get_msg must show the exact image segment in this chat.
      let proven = false;
      for (const id of new Set([event.messageId, event.replyToId].filter((value): value is string => Boolean(value)))) {
        if (!/^-?\d{1,24}$/u.test(id)) continue;
        const response = await this.transport.sendAction('get_msg', { message_id: id });
        if (response.status === 'failed' || (response.retcode !== undefined && response.retcode !== 0) || !response.data || String(response.data.message_id) !== id) continue;
        try {
          normalizeQuotedMessage({ ...event, replyToId: id }, response.data, this.messageScopes.get(id));
          const segments = response.data.message;
          if (Array.isArray(segments) && segments.some(segment => segment?.type === 'image' && segment.data?.file === file)) { proven = true; break; }
        } catch { /* Cross-chat or unproven private-message data cannot authorize a stream. */ }
      }
      if (!proven) throw new Error('图片标识不属于当前消息或当前引用');
      const data = await this.transport.readImageStream(file, this.config.ai.maxInboundImageBytes);
      return `base64://${data}`;
    }
    const response = await this.transport.sendAction('get_image', { file });
    if ((response.status && response.status !== 'ok') || (response.retcode !== undefined && response.retcode !== 0)) {
      throw new Error(response.wording || response.msg || 'OneBot get_image failed');
    }

    const base64 = response.data?.base64 ?? response.data?.base64_data;
    if (typeof base64 === 'string' && base64.trim()) {
      return base64.startsWith('base64://') ? base64 : `base64://${base64.trim()}`;
    }
    const url = response.data?.url;
    if (typeof url === 'string' && url.trim()) return url.trim();
    const resolvedFile = response.data?.file;
    if (typeof resolvedFile === 'string' && resolvedFile.trim()) {
      return resolvedFile.trim();
    }
    return undefined;
  }

  private rememberMessage(id: string, scope: string): void {
    this.messageScopes.set(id, scope);
    if (this.messageScopes.size > 2048) {
      this.messageScopes.delete(this.messageScopes.keys().next().value!);
    }
  }

  async getGroupMemberRole(groupId: string, userId: string): Promise<GroupRole> {
    if (!this.transport) throw new Error('onebot transport is not initialized');
    const response = await this.transport.sendAction('get_group_member_info', {
      group_id: groupId, user_id: userId, no_cache: true,
    });
    const data = response.data;
    if ((response.status && response.status !== 'ok') || (response.retcode !== undefined && response.retcode !== 0)
      || !data || String(data.group_id) !== groupId || String(data.user_id) !== userId
      || !['owner', 'admin', 'member'].includes(String(data.role))) {
      this.logger.warn({ groupId, userId }, 'group role unavailable; apply ordinary member quota');
      throw new Error('群身份查询失败');
    }
    return data.role as GroupRole;
  }

  rememberInbound(event: NormalizedOneBotEvent): void {
    if (event.messageId) this.rememberMessage(event.messageId, `${event.mode}:${event.conversationId}`);
  }

  async resolveGroupHistoryTarget(event: NormalizedOneBotEvent, target: { kind: 'id' | 'name' | 'reply'; value: string }): Promise<string> {
    if (event.mode !== 'group' || !/^\d{1,20}$/u.test(event.conversationId) || !this.transport) throw new Error('历史分析仅支持当前群');
    if (target.kind === 'id') {
      if (!/^\d{1,20}$/u.test(target.value)) throw new Error('请使用有效QQ号或真实@成员');
      return target.value;
    }
    if (target.kind === 'reply') {
      try {
        if (target.value !== event.replyToId || !/^-?\d{1,24}$/u.test(target.value)) throw new Error('invalid reply');
        const response = await this.transport.sendAction('get_msg', { message_id: target.value }, 3000);
        if (response.status === 'failed' || (response.retcode !== undefined && response.retcode !== 0) || !response.data || String(response.data.message_id) !== target.value) throw new Error('invalid reply response');
        const quote = normalizeQuotedMessage(event, response.data, this.messageScopes.get(target.value));
        if (!/^\d{1,20}$/u.test(quote.senderId)) throw new Error('invalid reply sender');
        return quote.senderId;
      } catch { throw new Error('无法确认本群引用消息的发言人，请真实@或使用QQ号指定对象'); }
    }
    if (!target.value.trim() || target.value.length > 80) throw new Error('请使用真实@或QQ号指定一位成员');
    let response: OneBotActionResponse;
    try { response = await this.transport.sendAction('get_group_member_list', { group_id: event.conversationId }, 3000); }
    catch { throw new Error('暂时无法核对群昵称，请改用真实@或QQ号'); }
    const data: unknown = response.data;
    if (response.status === 'failed' || (response.retcode !== undefined && response.retcode !== 0) || !Array.isArray(data) || data.length > 5000) throw new Error('暂时无法核对群昵称，请改用真实@或QQ号');
    const matches = new Set<string>();
    for (const member of data) {
      if (!member || typeof member !== 'object' || String(member.group_id) !== event.conversationId || !/^\d{1,20}$/u.test(String(member.user_id))) continue;
      if ([member.card, member.nickname].some(name => typeof name === 'string' && name.trim() === target.value.trim())) matches.add(String(member.user_id));
    }
    if (matches.size === 0) throw new Error('本群没有找到完全匹配的昵称，请使用真实@或QQ号');
    if (matches.size !== 1) throw new Error('本群存在同名成员，请使用真实@或QQ号确定一人');
    return [...matches][0]!;
  }

  async getGroupHistoryPage(event: NormalizedOneBotEvent, cursor: string | undefined, count: number, timeoutMs: number): Promise<unknown[]> {
    if (!this.transport || event.mode !== 'group' || !/^\d{1,20}$/u.test(event.conversationId)) throw new Error('history scope unavailable');
    if (!Number.isSafeInteger(count) || count < 1 || count > 50 || (cursor !== undefined && !/^-?\d{1,24}$/u.test(cursor))) throw new Error('invalid history page');
    const response = await this.transport.sendAction('get_group_msg_history', {
      group_id: event.conversationId,
      ...(cursor !== undefined ? { message_seq: cursor } : {}),
      count, reverse_order: true, disable_get_url: true, parse_mult_msg: false,
    }, timeoutMs);
    const messages = response.data?.messages;
    if (response.status === 'failed' || (response.retcode !== undefined && response.retcode !== 0) || !Array.isArray(messages) || messages.length > count) throw new Error('history page unavailable');
    return messages;
  }

  async resolveQuotedMessage(event: NormalizedOneBotEvent): Promise<NormalizedOneBotEvent> {
    if (!this.transport || !event.replyToId || !/^-?\d{1,24}$/u.test(event.replyToId)) {
      throw new Error('引用消息标识不可用');
    }
    const scope = this.messageScopes.get(event.replyToId);
    if (scope && scope !== `${event.mode}:${event.conversationId}`) throw new Error('引用消息跨会话');
    const response = await this.transport.sendAction('get_msg', { message_id: event.replyToId });
    if (response.status === 'failed' || (response.retcode !== undefined && response.retcode !== 0) || !response.data) {
      throw new Error('引用消息已失效或无法获取');
    }
    return normalizeQuotedMessage(event, response.data, scope);
  }

  async resolveInboundDocument(
    reference: InboundDocumentReference,
    event: NormalizedOneBotEvent,
  ): Promise<{ source: string; name?: string }> {
    if (!this.transport || !reference.fileId || !/^[A-Za-z0-9._{}()[\]-]{1,512}$/u.test(reference.fileId)) {
      throw new Error('文件标识不可用');
    }
    // Resolve a download URL first: unlike get_file this does not download an
    // unbounded attachment into QQ's own data directory.
    const action = event.mode === 'group' ? 'get_group_file_url' : 'get_private_file_url';
    const response = await this.transport.sendAction(action, {
      file_id: reference.fileId,
      ...(event.mode === 'group' ? { group_id: event.conversationId } : {}),
    });
    const source = response.data?.url;
    if ((response.retcode !== undefined && response.retcode !== 0) || response.status === 'failed' || typeof source !== 'string' || !source) {
      throw new Error('QQ 无法解析文件下载地址');
    }
    return { source, name: reference.name };
  }

  async sendText(context: OneBotReplyContext, text: string): Promise<string | undefined> {
    this.logger.info(
      {
        correlationId: context.correlationId,
        purpose: context.purpose ?? 'reply',
        chatType: context.chatType,
        targetId: context.targetId,
        replyToId: context.replyToId,
        textChars: text.length,
      },
      'sending onebot text message',
    );
    return this.sendConversationMessage({
      ...context,
      message: this.buildMessageSegments({
        text,
        replyToId: context.replyToId,
      }),
    });
  }

  async sendVoice(context: OneBotReplyContext, audio: Buffer, voiceText?: string): Promise<string> {
    if (!Buffer.isBuffer(audio) || audio.length > 5 * 1024 * 1024 || !validMp3(audio)) throw new Error('invalid outbound voice');
    const started=Date.now();let silk:Buffer;
    this.onVoiceEncode?.('start',{correlationId:context.correlationId,bytes:audio.length});
    try{
      silk=await encodeQqVoice(audio,this.config.voice.ffmpegCommand);
      this.onVoiceEncode?.('ok',{correlationId:context.correlationId,bytes:silk.length,durationMs:Date.now()-started});
    }catch(error){
      this.onVoiceEncode?.('error',{correlationId:context.correlationId,code:error instanceof VoiceError?error.code:'QQ_VOICE_TRANSCODE_FAILED',durationMs:Date.now()-started});
      throw error;
    }
    const id = await this.sendConversationMessage({ ...context, voiceText,
      message: [{type:'record',data:{file:`base64://${silk.toString('base64')}`,name:'reply.silk'}}] });
    return id!;
  }

  async sendPayload(
    context: OneBotReplyContext,
    params: {
      text: string;
      mediaUrls?: string[];
      mediaImages?: OneBotOutboundImage[];
    },
  ): Promise<string[]> {
    this.logger.info(
      {
        correlationId: context.correlationId,
        purpose: context.purpose ?? 'reply',
        chatType: context.chatType,
        targetId: context.targetId,
        replyToId: context.replyToId,
        textChars: params.text.length,
        mediaUrls: params.mediaUrls?.length ?? 0,
        mediaImages: params.mediaImages?.length ?? 0,
      },
      'sending onebot payload',
    );
    const plan = planOutboundPayload({
      text: params.text,
      mediaUrls: params.mediaUrls,
      mediaImages: params.mediaImages,
      maxTextLength: this.config.onebot.outboundMaxTextLength,
    });
    return this.sendPlannedPayload(context, plan);
  }

  async sendPlannedPayload(
    context: OneBotReplyContext,
    plan: PlannedOutboundPayload,
  ): Promise<string[]> {
    const messageIds: string[] = [];
    let first = true;
    for (const action of plan.actions) {
      if (action.kind === 'text' && action.text) {
        const messageId = await this.sendConversationMessage({
          ...context,
          replyToId: first ? context.replyToId : undefined,
          message: this.buildMessageSegments({
            text: action.text,
            replyToId: first ? context.replyToId : undefined,
          }),
        });
        if (messageId) {
          messageIds.push(messageId);
        }
      }
      if (action.kind === 'image' && action.image) {
        const image = await resolveLocalOutboundImage(action.image);
        const messageId = await this.sendConversationMessage({
          ...context,
          replyToId: first ? context.replyToId : undefined,
          message: this.buildMessageSegments({
            image,
            replyToId: first ? context.replyToId : undefined,
          }),
        });
        if (messageId) {
          messageIds.push(messageId);
        }
      }
      first = false;
    }
    return messageIds;
  }

  private buildMessageSegments(params: {
    text?: string;
    image?: OneBotOutboundImage;
    replyToId?: string;
  }): string | Array<Record<string, unknown>> {
    const segments: Array<Record<string, unknown>> = [];
    if (params.replyToId) {
      segments.push({
        type: 'reply',
        data: { id: params.replyToId },
      });
    }
    if (params.text) {
      segments.push({
        type: 'text',
        data: { text: params.text },
      });
    }
    if (params.image) {
      segments.push({
        type: 'image',
        data: { file: this.toOneBotImageFile(params.image) },
      });
    }
    if (segments.length === 1 && params.text && !params.replyToId) {
      return params.text;
    }
    return segments;
  }

  private toOneBotImageFile(image: OneBotOutboundImage): string {
    if (image.kind === 'url') {
      return image.value;
    }
    if (image.kind === 'file') {
      return image.value;
    }
    return `base64://${image.value}`;
  }

  private async sendConversationMessage(params: {
    correlationId?: string;
    chatType: OneBotReplyContext['chatType'];
    targetId: string;
    replyToId?: string;
    purpose?: OneBotReplyContext['purpose'];
    voiceText?: string;
    message: string | Array<Record<string, unknown>>;
  }): Promise<string | undefined> {
    if (!this.transport) {
      throw new OneBotActionError('ONEBOT_NOT_CONNECTED');
    }
    const action = params.chatType === 'group' ? 'send_group_msg' : 'send_private_msg';
    const actionParams =
      params.chatType === 'group'
        ? { group_id: params.targetId, message: params.message }
        : { user_id: params.targetId, message: params.message };

    const observe = async (outcome: OutboundObservation['outcome'], messageId?: string, retcode?: number, errorCode?: string) => {
      try { await this.onOutboundObservation?.({ context: params, message: params.message, voiceText: params.voiceText, outcome, messageId, retcode, errorCode }); }
      catch { this.logger.warn('outbound journal observer failed'); }
    };
    let response: OneBotActionResponse;
    // Give NapCat's own send confirmation time to return; reads keep their existing shorter deadlines.
    try { response = await this.transport.sendAction(action, actionParams, 30_000); }
    catch (error) { await observe('failed', undefined, undefined, safeErrorCode(error)); throw error; }
    const observedId = this.extractMessageId(response);
    const rejected = response.status === 'failed' || (response.retcode !== undefined && response.retcode !== 0);
    const acknowledged = !rejected && (response.status === undefined || response.status === 'ok') && Boolean(observedId);
    const failure = rejected ? new OneBotActionError('ONEBOT_SEND_REJECTED', false, response.retcode)
      : acknowledged ? undefined : new OneBotActionError('ONEBOT_SEND_UNCONFIRMED', true, response.retcode);
    await observe(rejected ? 'rejected' : acknowledged ? 'acknowledged' : 'unconfirmed', observedId, response.retcode, failure?.code);
    if (failure) throw failure;
    this.onOutboundMessage?.(params.chatType);
    const messageId = this.extractMessageId(response);
    if (messageId) this.rememberMessage(messageId, `${params.chatType}:${params.targetId}`);
    this.logger.info(
      {
        correlationId: params.correlationId,
        chatType: params.chatType,
        targetId: params.targetId,
        replyToId: params.replyToId,
        messageId,
      },
      'onebot send action completed',
    );
    return messageId;
  }

  private extractMessageId(response: OneBotActionResponse): string | undefined {
    const messageId = response.data?.message_id;
    if ((typeof messageId === 'string' && messageId.trim().length > 0)
      || (typeof messageId === 'number' && Number.isSafeInteger(messageId) && messageId !== 0)) {
      return String(messageId);
    }
    return undefined;
  }
}
