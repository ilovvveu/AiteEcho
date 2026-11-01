import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseBoolean, parseCsv, parseNumber } from '../utils/env.js';
import { loadDotEnv } from '../infra/env-file.js';
import { resolveAcpAgentArgs } from '../utils/acp-agent.js';
import { isLoopbackHost, strongAccessToken } from '../utils/network.js';
import type { PermissionStrategy, VerboseMode } from '../types/agent.js';

const oneBotModeSchema = z.enum(['forward', 'reverse']);
const progressModeSchema = z.enum(['off', 'message']);
const verboseModeSchema = z.enum(['normal', 'verbose', 'debug']);
const permissionStrategySchema = z.enum(['allow_once', 'allow_always', 'cancel']);
export const groupMemberRuleSchema = z.object({
  label: z.string().trim().min(1).max(40).optional(),
  limitPerMinute: z.number().int().min(0).max(120).optional(),
  blocked: z.boolean().optional(),
}).strict();
export type GroupMemberRule = z.infer<typeof groupMemberRuleSchema>;
const groupPolicySchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  requireMention: z.boolean().optional(),
  systemPrompt: z.string().optional(),
  allowAllMembers: z.boolean().optional(),
  replyLimits: z.object({
    admin: z.number().int().min(1).max(120),
    member: z.number().int().min(1).max(120),
  }).optional(),
  memberRules: z.record(z.string().regex(/^\d{1,20}$/u), groupMemberRuleSchema).optional(),
});
const groupPolicyFileSchema = z.object({
  defaultSystemPrompt: z.string().optional(),
  groups: z.record(z.string(), groupPolicySchema).default({}),
});

export interface GroupConversationPolicy {
  id: string;
  name?: string;
  enabled?: boolean;
  requireMention?: boolean;
  systemPrompt?: string;
  allowAllMembers?: boolean;
  replyLimits?: { admin: number; member: number };
  memberRules?: Record<string, GroupMemberRule>;
}

export interface AppConfig {
  voice: {
    enabled: boolean; groupEnabled: boolean; apiKey?: string; voiceId: string; model: string;
    maxChars: number; timeoutMs: number; maxAudioBytes: number; dailyChars: number; usageFile: string;
    stability: number;
    delivery: 'neutral' | 'lively';
    ffmpegCommand: string;
    groupMaxReplyChars: number;
    groupRateLimits: { member: number; admin: number; self: number | null; windowMs: number };
  };
  diagnostics: { file?: string; maxBytes: number };
  mentionJournal: { file?: string };
  context: {
    enabled: boolean;
    maxTurns: number;
    maxAgeMs: number;
    maxStoredChars: number;
    promptTurns: number;
    promptChars: number;
    codexHome?: string;
  };
  server: {
    host: string;
    port: number;
    accessToken?: string;
  };
  storage: {
    sessionStore: 'file' | 'redis' | 'postgres';
    dataDir: string;
    sessionFilePath: string;
    sessionTtlMs: number;
    redisUrl?: string;
    redisKeyPrefix: string;
    postgresUrl?: string;
    postgresTable: string;
  };
  onebot: {
    mode: 'forward' | 'reverse';
    accessToken?: string;
    forwardWsUrl: string;
    reverseWsHost: string;
    reverseWsPort: number;
    reverseWsPath: string;
    allowGroup: boolean;
    requireMentionInGroup: boolean;
    allowPrivate: boolean;
    allowGroupCommandsWithoutMention: boolean;
    allowedGroups: string[];
    blockedGroups: string[];
    allowedUsers: string[];
    ownerUsers: string[];
    blockedUsers: string[];
    commandPrefix: string;
    progressMode: 'off' | 'message';
    outboundMaxTextLength: number;
    inboundDedupeWindowMs: number;
    inboundDedupeMaxEntries: number;
    inboundImageLocalRoots: string[];
    inboundImageStream?: boolean;
    readGroupHistory?: boolean;
    defaultSystemPrompt?: string;
    groupConfigFilePath?: string;
    groupPolicies: Record<string, GroupConversationPolicy>;
  };
  ai: {
    backend: 'acp' | 'direct';
    direct: {
      baseUrl?: string; apiKey?: string; model: string; reasoning: 'low' | 'medium' | 'high'; sendHistory: boolean;
      localProxyUrl?: string; maxToolCallsSupported: boolean;
      totalTimeoutMs: number; firstByteTimeoutMs: number; connectTimeoutMs: number;
      maxRetries: number; maxInputChars: number; maxInputBytes: number; maxOutputTokens: number;
    };
    agentCommand: string;
    agentArgs: string[];
    workdir: string;
    clientName: string;
    replyStyleFile?: string;
    replyStyleDir?: string;
    replyStyleStateFile?: string;
    replyRulesFile?: string;
    reuseSession: boolean;
    verboseMode: VerboseMode;
    permissionStrategy: PermissionStrategy;
    progressThrottleMs: number;
    maxProgressUpdates: number;
    maxInboundImages: number;
    maxInboundImageBytes: number;
    localVisionOcr: boolean;
    localVisionOcrCommand?: string;
    localVisionOcrTimeoutMs: number;
    localVisionOcrMaxChars: number;
    readDocuments: boolean;
    documentPythonCommand: string;
    maxInboundDocuments: number;
    maxInboundDocumentBytes: number;
    maxDocumentChars: number;
    documentTimeoutMs: number;
    resolveReplies: boolean;
    webSearch: boolean;
    grokCompat?: boolean;
  };
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeGroupPolicy(
  id: string,
  value: z.infer<typeof groupPolicySchema>,
): GroupConversationPolicy {
  return {
    id,
    name: normalizeOptionalText(value.name),
    enabled: value.enabled,
    requireMention: value.requireMention,
    systemPrompt: normalizeOptionalText(value.systemPrompt),
    ...(value.allowAllMembers !== undefined ? { allowAllMembers: value.allowAllMembers } : {}),
    ...(value.replyLimits ? { replyLimits: value.replyLimits } : {}),
    ...(value.memberRules ? { memberRules: value.memberRules } : {}),
  };
}

function loadGroupPolicyFile(filePath: string | undefined): {
  groupConfigFilePath?: string;
  defaultSystemPrompt?: string;
  groupPolicies: Record<string, GroupConversationPolicy>;
} {
  const normalizedFilePath = normalizeOptionalText(filePath);
  if (!normalizedFilePath) {
    return {
      groupPolicies: {},
    };
  }

  const resolvedPath = path.resolve(normalizedFilePath);
  let fileContent: string;
  try {
    fileContent = readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    throw new Error(
      `failed to read ONEBOT_GROUP_CONFIG_FILE at ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }

  try {
    const parsed = groupPolicyFileSchema.parse(JSON.parse(fileContent));
    const groupPolicies = Object.fromEntries(
      Object.entries(parsed.groups).map(([groupId, value]) => [groupId, normalizeGroupPolicy(groupId, value)]),
    );
    return {
      groupConfigFilePath: resolvedPath,
      defaultSystemPrompt: normalizeOptionalText(parsed.defaultSystemPrompt),
      groupPolicies,
    };
  } catch (error) {
    throw new Error(
      `failed to parse ONEBOT_GROUP_CONFIG_FILE at ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) {
    loadDotEnv();
  }
  const dataDir = env.DATA_DIR || './data';
  const adminHost = env.BOT_HOST || '127.0.0.1';
  const adminToken = normalizeOptionalText(env.BOT_ADMIN_TOKEN);
  if (adminToken && !strongAccessToken(adminToken)) throw new Error('BOT_ADMIN_TOKEN must be a non-whitespace token of at least 24 characters');
  if (!isLoopbackHost(adminHost) && !adminToken) throw new Error('Non-loopback BOT_HOST requires BOT_ADMIN_TOKEN');
  const reverseHost = env.ONEBOT_REVERSE_WS_HOST || '127.0.0.1';
  const onebotToken = normalizeOptionalText(env.ONEBOT_ACCESS_TOKEN);
  if (adminToken && adminToken === onebotToken) throw new Error('Admin and OneBot access tokens must be different');
  if ((env.ONEBOT_MODE || 'reverse') === 'reverse' && !isLoopbackHost(reverseHost) && !strongAccessToken(onebotToken)) {
    throw new Error('Non-loopback OneBot listener requires an access token of at least 24 characters');
  }
  const mentionJournalFile = normalizeOptionalText(env.BOT_MENTION_JOURNAL_FILE);
  if (mentionJournalFile && /(?:^|\/)(?:Mobile Documents|CloudStorage)(?:\/|$)/u.test(path.resolve(mentionJournalFile))) {
    throw new Error('Mention journal must be stored locally outside iCloud/CloudStorage');
  }
  const groupPolicyFile = loadGroupPolicyFile(env.ONEBOT_GROUP_CONFIG_FILE);
  const defaultSystemPrompt =
    normalizeOptionalText(env.ACP_DEFAULT_SYSTEM_PROMPT) ?? groupPolicyFile.defaultSystemPrompt;
  const commandPrefix = normalizeOptionalText(env.ONEBOT_COMMAND_PREFIX) || '/';
  const sessionStore = z.enum(['file', 'redis', 'postgres']).parse(env.SESSION_STORE || 'file');
  const backend = z.enum(['acp', 'direct']).parse(env.AI_BACKEND || 'acp');
  const directBase = normalizeOptionalText(env.DIRECT_API_BASE_URL);
  const directModel = normalizeOptionalText(env.DIRECT_API_MODEL) || '';
  const directProxy = normalizeOptionalText(env.DIRECT_API_LOCAL_PROXY_URL);
  if (directProxy) {
    let url: URL;
    try { url = new URL(directProxy); } catch { throw new Error('Direct API proxy must be an explicit loopback HTTP URL'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Direct API proxy must be an explicit loopback HTTP URL');
    }
  }
  const voiceEnabled = parseBoolean(env.BOT_VOICE_ENABLED, false);
  let voiceKey = normalizeOptionalText(env.ELEVENLABS_API_KEY);
  if (voiceEnabled && !voiceKey && env.ELEVENLABS_API_KEY_FILE) {
    try {
      const stat = lstatSync(env.ELEVENLABS_API_KEY_FILE);
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0) throw new Error();
      voiceKey = readFileSync(env.ELEVENLABS_API_KEY_FILE, 'utf8').trim();
    } catch { throw new Error('ElevenLabs credential file must be a private regular file (0600)'); }
  }
  if (voiceEnabled && (!voiceKey || !/^[A-Za-z0-9_-]{20,256}$/u.test(voiceKey))) throw new Error('ElevenLabs credential is missing or invalid');
  const voiceId = normalizeOptionalText(env.ELEVENLABS_VOICE_ID) || '';
  if ((voiceEnabled || voiceId) && !/^[A-Za-z0-9]{15,64}$/u.test(voiceId)) throw new Error('ELEVENLABS_VOICE_ID must be explicitly configured');
  const voiceOwnerLimit = z.coerce.number().int().min(0).max(120).parse(env.BOT_VOICE_GROUP_OWNER_PER_MINUTE || 0);
  if (backend === 'direct') {
    if (!directModel || directModel.length > 200 || /\s/u.test(directModel)) throw new Error('DIRECT_API_MODEL must be explicitly configured');
    if (!directBase) throw new Error('DIRECT_API_BASE_URL is required for direct backend');
    const url = new URL(directBase);
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new Error('Direct API requires HTTPS without URL credentials, query or fragment');
    }
    if (!env[env.DIRECT_API_KEY_ENV || 'QQ_CODEX_API_KEY']) throw new Error('Direct API credential is not configured');
    if (!parseBoolean(env.CONTEXT_BOUNDED, false)) throw new Error('Direct backend requires CONTEXT_BOUNDED=true');
  }

  return {
    voice: {
      enabled: voiceEnabled, groupEnabled: parseBoolean(env.BOT_VOICE_GROUP_ENABLED, false), apiKey: voiceKey,
      voiceId,
      groupMaxReplyChars: z.coerce.number().int().min(1).max(1000).parse(env.BOT_VOICE_GROUP_MAX_CHARS || 50),
      groupRateLimits: {
        member: z.coerce.number().int().min(1).max(120).parse(env.BOT_VOICE_GROUP_MEMBER_PER_MINUTE || 1),
        admin: z.coerce.number().int().min(1).max(120).parse(env.BOT_VOICE_GROUP_ADMIN_PER_MINUTE || 2),
        self: voiceOwnerLimit || null, windowMs: 60_000,
      },
      model: z.enum(['eleven_v4_turbo', 'eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v3']).parse(env.ELEVENLABS_MODEL || 'eleven_v4_turbo'),
      stability: z.coerce.number().min(0).max(1).parse(env.ELEVENLABS_STABILITY || 0.5),
      delivery: z.enum(['neutral', 'lively']).parse(env.ELEVENLABS_DELIVERY || 'neutral'),
      ffmpegCommand: z.string().min(1).max(1024).regex(/^[^\r\n\0]+$/u).parse(env.BOT_VOICE_FFMPEG_COMMAND || 'ffmpeg'),
      maxChars: z.coerce.number().int().min(20).max(1000).parse(env.BOT_VOICE_MAX_CHARS || 300),
      timeoutMs: z.coerce.number().int().min(1000).max(60000).parse(env.BOT_VOICE_TIMEOUT_MS || 30000),
      maxAudioBytes: z.coerce.number().int().min(1024).max(5 * 1024 * 1024).parse(env.BOT_VOICE_MAX_BYTES || 2 * 1024 * 1024),
      dailyChars: z.coerce.number().int().min(100).max(100000).parse(env.BOT_VOICE_DAILY_CHARS || 2000),
      usageFile: normalizeOptionalText(env.BOT_VOICE_USAGE_FILE) || `${dataDir}/voice-usage.json`,
    },
    diagnostics: {
      file: normalizeOptionalText(env.BOT_DIAGNOSTIC_LOG),
      maxBytes: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).parse(env.BOT_DIAGNOSTIC_LOG_MAX_BYTES || 5 * 1024 * 1024),
    },
    mentionJournal: { file: mentionJournalFile ? path.resolve(mentionJournalFile) : undefined },
    context: {
      enabled: parseBoolean(env.CONTEXT_BOUNDED, false),
      maxTurns: z.coerce.number().int().min(1).max(100).parse(env.CONTEXT_MAX_TURNS || 100),
      maxAgeMs: z.coerce.number().min(1).max(168).parse(env.CONTEXT_MAX_AGE_HOURS || 24) * 3600_000,
      maxStoredChars: z.coerce.number().int().min(6000).max(200000).parse(env.CONTEXT_MAX_STORED_CHARS || 120000),
      promptTurns: z.coerce.number().int().min(1).max(20).parse(env.CONTEXT_PROMPT_TURNS || 12),
      promptChars: z.coerce.number().int().min(1000).max(16000).parse(env.CONTEXT_PROMPT_CHARS || 8000),
      codexHome: backend === 'direct' ? undefined : normalizeOptionalText(env.CODEX_HOME),
    },
    server: {
      host: adminHost,
      port: parseNumber(env.BOT_PORT, 8080),
      accessToken: adminToken,
    },
    storage: {
      sessionStore,
      dataDir,
      sessionFilePath: env.SESSION_FILE_PATH || `${dataDir}/sessions.json`,
      sessionTtlMs: parseNumber(env.SESSION_TTL_MINUTES, 120) * 60 * 1000,
      redisUrl: normalizeOptionalText(env.REDIS_URL),
      redisKeyPrefix: normalizeOptionalText(env.REDIS_KEY_PREFIX) || 'qq-ai-bot',
      postgresUrl: normalizeOptionalText(env.POSTGRES_URL),
      postgresTable: normalizeOptionalText(env.POSTGRES_TABLE) || 'qq_ai_bot_sessions',
    },
    onebot: {
      mode: oneBotModeSchema.parse(env.ONEBOT_MODE || 'reverse'),
      accessToken: onebotToken,
      forwardWsUrl: env.ONEBOT_FORWARD_WS_URL || 'ws://127.0.0.1:3001/onebot/v11/ws',
      reverseWsHost: reverseHost,
      reverseWsPort: parseNumber(env.ONEBOT_REVERSE_WS_PORT, 16700),
      reverseWsPath: env.ONEBOT_REVERSE_WS_PATH || '/onebot/v11/ws',
      allowGroup: parseBoolean(env.ONEBOT_ALLOW_GROUP, false),
      requireMentionInGroup: parseBoolean(env.ONEBOT_REQUIRE_MENTION_IN_GROUP, true),
      allowPrivate: parseBoolean(env.ONEBOT_ALLOW_PRIVATE, false),
      allowGroupCommandsWithoutMention: parseBoolean(env.ONEBOT_ALLOW_GROUP_COMMANDS_WITHOUT_MENTION, false),
      allowedGroups: parseCsv(env.ONEBOT_ALLOWED_GROUPS),
      blockedGroups: parseCsv(env.ONEBOT_BLOCKED_GROUPS),
      allowedUsers: parseCsv(env.ONEBOT_ALLOWED_USERS),
      ownerUsers: parseCsv(env.ONEBOT_OWNER_USERS),
      blockedUsers: parseCsv(env.ONEBOT_BLOCKED_USERS),
      commandPrefix,
      progressMode: progressModeSchema.parse(env.ONEBOT_PROGRESS_MODE || 'message'),
      outboundMaxTextLength: parseNumber(env.ONEBOT_OUTBOUND_MAX_TEXT_LENGTH, 1400),
      inboundDedupeWindowMs: parseNumber(env.ONEBOT_INBOUND_DEDUPE_WINDOW_MS, 120_000),
      inboundDedupeMaxEntries: parseNumber(env.ONEBOT_INBOUND_DEDUPE_MAX_ENTRIES, 2048),
      inboundImageLocalRoots: parseCsv(env.ONEBOT_INBOUND_IMAGE_LOCAL_ROOTS).map((root) => path.resolve(root)),
      inboundImageStream: parseBoolean(env.ONEBOT_INBOUND_IMAGE_STREAM, false),
      readGroupHistory: parseBoolean(env.ONEBOT_READ_GROUP_HISTORY, false),
      defaultSystemPrompt,
      groupConfigFilePath: groupPolicyFile.groupConfigFilePath,
      groupPolicies: groupPolicyFile.groupPolicies,
    },
    ai: {
      backend,
      direct: {
        baseUrl: directBase, apiKey: env[env.DIRECT_API_KEY_ENV || 'QQ_CODEX_API_KEY'],
        localProxyUrl: directProxy,
        maxToolCallsSupported: parseBoolean(env.DIRECT_API_MAX_TOOL_CALLS_SUPPORTED, true),
        model: directModel,
        reasoning: z.enum(['low', 'medium', 'high']).parse(env.DIRECT_API_REASONING || 'medium'),
        sendHistory: parseBoolean(env.DIRECT_API_SEND_HISTORY, false),
        totalTimeoutMs: z.coerce.number().int().min(1000).max(120000).parse(env.DIRECT_API_TOTAL_TIMEOUT_MS || 120000),
        firstByteTimeoutMs: z.coerce.number().int().min(1000).max(90000).parse(env.DIRECT_API_FIRST_BYTE_TIMEOUT_MS || 90000),
        connectTimeoutMs: z.coerce.number().int().min(500).max(15000).parse(env.DIRECT_API_CONNECT_TIMEOUT_MS || 10000),
        maxRetries: z.coerce.number().int().min(0).max(1).parse(env.DIRECT_API_MAX_RETRIES || '1'),
        maxInputChars: z.coerce.number().int().min(2000).max(16000).parse(env.DIRECT_API_MAX_INPUT_CHARS || 10000),
        maxInputBytes: z.coerce.number().int().min(4000).max(32000).parse(env.DIRECT_API_MAX_INPUT_BYTES || 20000),
        maxOutputTokens: z.coerce.number().int().min(256).max(8192).parse(env.DIRECT_API_MAX_OUTPUT_TOKENS || 4096),
      },
      agentCommand: env.ACP_AGENT_COMMAND || 'codex',
      agentArgs: resolveAcpAgentArgs(env.ACP_AGENT_ARGS_JSON, env.ACP_AGENT_COMMAND),
      workdir: env.ACP_AGENT_WORKDIR || process.cwd(),
      clientName: env.ACP_CLIENT_NAME || 'qq-ai-bot',
      replyStyleFile: normalizeOptionalText(env.BOT_REPLY_STYLE_FILE),
      replyStyleDir: normalizeOptionalText(env.BOT_REPLY_STYLE_DIR),
      replyStyleStateFile: normalizeOptionalText(env.BOT_REPLY_STYLE_STATE_FILE) || `${dataDir}/reply-styles.json`,
      replyRulesFile: normalizeOptionalText(env.BOT_REPLY_RULES_FILE),
      reuseSession: parseBoolean(env.ACP_REUSE_SESSION, true),
      verboseMode: verboseModeSchema.parse(env.ACP_VERBOSE_MODE || 'verbose'),
      permissionStrategy: permissionStrategySchema.parse(
        (env.ACP_PERMISSION_STRATEGY || 'allow_once') as PermissionStrategy,
      ),
      progressThrottleMs: parseNumber(env.ACP_PROGRESS_THROTTLE_MS, 800),
      maxProgressUpdates: parseNumber(env.ACP_MAX_PROGRESS_UPDATES, 6),
      maxInboundImages: parseNumber(env.ACP_MAX_INBOUND_IMAGES, 3),
      maxInboundImageBytes: parseNumber(env.ACP_MAX_INBOUND_IMAGE_BYTES, 6 * 1024 * 1024),
      localVisionOcr: parseBoolean(env.ACP_LOCAL_VISION_OCR, false),
      localVisionOcrCommand: normalizeOptionalText(env.ACP_LOCAL_VISION_OCR_COMMAND),
      localVisionOcrTimeoutMs: parseNumber(env.ACP_LOCAL_VISION_OCR_TIMEOUT_MS, 30_000),
      localVisionOcrMaxChars: parseNumber(env.ACP_LOCAL_VISION_OCR_MAX_CHARS, 6_000),
      readDocuments: parseBoolean(env.ACP_READ_DOCUMENTS, false),
      documentPythonCommand: env.ACP_DOCUMENT_PYTHON_COMMAND || 'python3',
      maxInboundDocuments: z.coerce.number().int().min(1).max(5).parse(env.ACP_MAX_INBOUND_DOCUMENTS || 2),
      maxInboundDocumentBytes: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).parse(env.ACP_MAX_INBOUND_DOCUMENT_BYTES || 10 * 1024 * 1024),
      maxDocumentChars: z.coerce.number().int().min(100).max(60_000).parse(env.ACP_MAX_DOCUMENT_CHARS || 20_000),
      documentTimeoutMs: z.coerce.number().int().min(1000).max(60_000).parse(env.ACP_DOCUMENT_TIMEOUT_MS || 20_000),
      resolveReplies: parseBoolean(env.ONEBOT_RESOLVE_REPLIES, false),
      webSearch: parseBoolean(env.ACP_WEB_SEARCH, false),
      grokCompat: parseBoolean(env.ACP_GROK_COMPAT, false),
    },
  };
}
