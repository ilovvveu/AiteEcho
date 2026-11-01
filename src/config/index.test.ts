import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

describe('loadConfig', () => {
  it('has no personal voice or persona defaults, and validates configurable group voice policy', () => {
    expect(loadConfig({}).onebot).toMatchObject({ allowPrivate: false, allowGroup: false, ownerUsers: [] });
    expect(loadConfig({}).ai.direct).toMatchObject({ model: '', reasoning: 'medium' });
    expect(loadConfig({}).voice).toMatchObject({ enabled: false, voiceId: '', delivery: 'neutral', ffmpegCommand: 'ffmpeg' });
    expect(() => loadConfig({ BOT_VOICE_ENABLED: 'true', ELEVENLABS_API_KEY: 'synthetic-voice-key-73100' })).toThrow('ELEVENLABS_VOICE_ID');
    expect(loadConfig({ BOT_VOICE_GROUP_MAX_CHARS: '75', BOT_VOICE_GROUP_MEMBER_PER_MINUTE: '4',
      BOT_VOICE_GROUP_ADMIN_PER_MINUTE: '8', BOT_VOICE_GROUP_OWNER_PER_MINUTE: '10' }).voice)
      .toMatchObject({ groupMaxReplyChars: 75, groupRateLimits: { member: 4, admin: 8, self: 10, windowMs: 60000 } });
    for (const env of [{ BOT_VOICE_GROUP_MAX_CHARS: '0' }, { BOT_VOICE_GROUP_MEMBER_PER_MINUTE: '-1' }, { BOT_VOICE_GROUP_OWNER_PER_MINUTE: '121' }]) expect(() => loadConfig(env)).toThrow();
  });
  it('defaults admin and reverse OneBot to loopback and requires independent strong tokens for public listeners', () => {
    expect(loadConfig({}).server.host).toBe('127.0.0.1'); expect(loadConfig({}).onebot.reverseWsHost).toBe('127.0.0.1');
    expect(() => loadConfig({ BOT_HOST: '0.0.0.0' })).toThrow('BOT_ADMIN_TOKEN');
    expect(() => loadConfig({ BOT_ADMIN_TOKEN: 'change-me' })).toThrow('BOT_ADMIN_TOKEN');
    expect(() => loadConfig({ BOT_ADMIN_TOKEN: 'test-only-same-token-731492', ONEBOT_ACCESS_TOKEN: 'test-only-same-token-731492' })).toThrow('must be different');
    expect(() => loadConfig({ ONEBOT_REVERSE_WS_HOST: '0.0.0.0', ONEBOT_ACCESS_TOKEN: 'change-me' })).toThrow('access token');
    expect(loadConfig({ BOT_HOST: '0.0.0.0', BOT_ADMIN_TOKEN: 'test-only-admin-token-731492',
      ONEBOT_REVERSE_WS_HOST: '0.0.0.0', ONEBOT_ACCESS_TOKEN: 'test-only-onebot-token-731492' }).server.accessToken).toBe('test-only-admin-token-731492');
  });
  it('gives non-stream generation 90s to start its body while retaining the 120s hard deadline and explicit overrides', () => {
    expect(loadConfig({}).ai.direct).toMatchObject({ firstByteTimeoutMs: 90000, totalTimeoutMs: 120000, maxRetries: 1 });
    expect(loadConfig({ DIRECT_API_FIRST_BYTE_TIMEOUT_MS: '60000' }).ai.direct.firstByteTimeoutMs).toBe(60000);
    expect(() => loadConfig({ DIRECT_API_FIRST_BYTE_TIMEOUT_MS: '90001' })).toThrow();
  });
  it('keeps the standard tool-call limit unless the configured provider explicitly lacks that parameter', () => {
    expect(loadConfig({}).ai.direct.maxToolCallsSupported).toBe(true);
    expect(loadConfig({ DIRECT_API_MAX_TOOL_CALLS_SUPPORTED: 'false' }).ai.direct.maxToolCallsSupported).toBe(false);
  });
  it('only opts into an explicit numeric loopback HTTP CONNECT proxy without credentials', () => {
    expect(loadConfig({}).ai.direct.localProxyUrl).toBeUndefined();
    for (const url of ['http://127.0.0.1:1082', 'http://[::1]:8080']) {
      expect(loadConfig({ DIRECT_API_LOCAL_PROXY_URL: url }).ai.direct.localProxyUrl).toBe(url);
    }
    for (const url of ['invalid', 'https://127.0.0.1:1082', 'http://public.example:8080', 'http://localhost:1082',
      'http://127.0.0.1', 'http://u:p@127.0.0.1:1082', 'http://127.0.0.1:1082/path',
      'http://127.0.0.1:1082/?key=x', 'http://127.0.0.1:1082/#x', 'socks5://127.0.0.1:1082']) {
      expect(() => loadConfig({ DIRECT_API_LOCAL_PROXY_URL: url })).toThrow('loopback HTTP');
    }
  });
  it('accepts a separate trusted global reply rules file without changing preset selection', () => {
    const c=loadConfig({BOT_REPLY_RULES_FILE:'/tmp/reply-rules.json',BOT_REPLY_STYLE_DIR:'/tmp/styles'});
    expect(c.ai.replyRulesFile).toBe('/tmp/reply-rules.json');
    expect(c.ai.replyStyleDir).toBe('/tmp/styles');
    expect(loadConfig({}).ai.replyRulesFile).toBeUndefined();
  });
  it('requires an explicit safe endpoint, own key and bounded history for direct mode', () => {
    const env = { AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high', DIRECT_API_BASE_URL: 'https://example.invalid/v1', QQ_CODEX_API_KEY: 'test-only', CONTEXT_BOUNDED: 'true' };
    expect(loadConfig(env).ai.backend).toBe('direct');
    expect(() => loadConfig({ ...env, DIRECT_API_MODEL: '' })).toThrow('DIRECT_API_MODEL');
    expect(() => loadConfig({ ...env, DIRECT_API_BASE_URL: '' })).toThrow();
    expect(() => loadConfig({ ...env, QQ_CODEX_API_KEY: '' })).toThrow();
    expect(() => loadConfig({ ...env, CONTEXT_BOUNDED: 'false' })).toThrow();
    for (const url of ['http://public.example/v1', 'https://u:p@example.invalid/v1', 'https://example.invalid/v1?key=x', 'file:///tmp/key']) {
      expect(() => loadConfig({ ...env, DIRECT_API_BASE_URL: url })).toThrow();
    }
    expect(() => loadConfig({ ...env, DIRECT_API_MAX_RETRIES: '2' })).toThrow();
    expect(() => loadConfig({ ...env, DIRECT_API_TOTAL_TIMEOUT_MS: '300000' })).toThrow();
  });
  it('never promotes an ordinary whitelist into bot-owner privileges', () => {
    const config = loadConfig({ ONEBOT_ALLOWED_USERS: '123', ONEBOT_OWNER_USERS: '' });
    expect(config.onebot.allowedUsers).toEqual(['123']);
    expect(config.onebot.ownerUsers).toEqual([]);
  });
  it('loads public group tiers and validates special per-person overrides', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qq-tiers-config-'));
    const file = path.join(dir, 'groups.json');
    await writeFile(file, JSON.stringify({ groups: { '100': { allowAllMembers: true, requireMention: true, replyLimits: { admin: 5, member: 1 }, memberRules: { '2': { label: '特殊', limitPerMinute: 0 }, '3': { blocked: true } } } } }));
    const config = loadConfig({ ONEBOT_GROUP_CONFIG_FILE: file, ONEBOT_OWNER_USERS: '1', ONEBOT_ALLOWED_USERS: '1' });
    expect(config.onebot.groupPolicies['100']?.allowAllMembers).toBe(true);
    expect(config.onebot.groupPolicies['100']?.memberRules?.['2']?.limitPerMinute).toBe(0);
    expect(config.onebot.groupPolicies['100']?.memberRules?.['3']?.blocked).toBe(true);
    expect(config.onebot.allowedUsers).toEqual(['1']);
    await writeFile(file, JSON.stringify({ groups: { '100': { memberRules: { '2': { limitPerMinute: -1 } } } } }));
    expect(() => loadConfig({ ONEBOT_GROUP_CONFIG_FILE: file })).toThrow();
  });
  it('keeps new capabilities opt-in and validates attachment limits', () => {
    const defaults = loadConfig({});
    expect(defaults.ai.readDocuments).toBe(false);
    expect(defaults.ai.resolveReplies).toBe(false);
    expect(defaults.ai.webSearch).toBe(false);
    expect(defaults.ai.grokCompat).toBe(false);
    expect(defaults.onebot.inboundImageStream).toBe(false);
    expect(defaults.onebot.readGroupHistory).toBe(false);
    expect(loadConfig({ ONEBOT_READ_GROUP_HISTORY: 'true' }).onebot.readGroupHistory).toBe(true);
    expect(loadConfig({ ONEBOT_INBOUND_IMAGE_STREAM:'true' }).onebot.inboundImageStream).toBe(true);
    expect(loadConfig({ ACP_GROK_COMPAT: 'true' }).ai.grokCompat).toBe(true);
    const enabled = loadConfig({ ACP_READ_DOCUMENTS: 'true', ONEBOT_RESOLVE_REPLIES: 'true', ACP_WEB_SEARCH: 'true' });
    expect(enabled.ai.readDocuments && enabled.ai.resolveReplies && enabled.ai.webSearch).toBe(true);
    expect(() => loadConfig({ ACP_MAX_INBOUND_DOCUMENTS: '-1' })).toThrow();
    expect(() => loadConfig({ ACP_MAX_INBOUND_DOCUMENT_BYTES: '999999999' })).toThrow();
  });
  it('parses relaxed ACP agent args and basic switches', () => {
    const config = loadConfig({
      ACP_AGENT_COMMAND: 'traex',
      ACP_AGENT_ARGS_JSON: '[acp,serve]',
      ONEBOT_ALLOW_GROUP: 'false',
      ONEBOT_ALLOW_PRIVATE: 'true',
      ONEBOT_COMMAND_PREFIX: '!',
      ACP_DEFAULT_SYSTEM_PROMPT: 'be precise',
    });

    expect(config.ai.agentArgs).toEqual(['acp', 'serve']);
    expect(config.onebot.allowGroup).toBe(false);
    expect(config.onebot.allowPrivate).toBe(true);
    expect(config.onebot.commandPrefix).toBe('!');
    expect(config.onebot.defaultSystemPrompt).toBe('be precise');
  });

  it('defaults reverse ws port and traex args to the quickstart values', () => {
    const config = loadConfig({
      ACP_AGENT_COMMAND: 'traex',
    });

    expect(config.onebot.reverseWsPort).toBe(16700);
    expect(config.ai.agentArgs).toEqual(['acp', 'serve']);
  });

  it('loads per-group prompt policies from json file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qq-ai-bot-config-'));
    const filePath = path.join(dir, 'group-rules.json');
    await writeFile(
      filePath,
      JSON.stringify(
        {
          defaultSystemPrompt: 'global prompt',
          groups: {
            '123': {
              name: '测试群',
              enabled: true,
              requireMention: false,
              systemPrompt: 'group prompt',
            },
            '456': {
              enabled: false,
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const config = loadConfig({
      ONEBOT_GROUP_CONFIG_FILE: filePath,
    });

    expect(config.onebot.groupConfigFilePath).toBe(path.resolve(filePath));
    expect(config.onebot.defaultSystemPrompt).toBe('global prompt');
    expect(config.onebot.groupPolicies['123']).toEqual({
      id: '123',
      name: '测试群',
      enabled: true,
      requireMention: false,
      systemPrompt: 'group prompt',
    });
    expect(config.onebot.groupPolicies['456']).toEqual({
      id: '456',
      name: undefined,
      enabled: false,
      requireMention: undefined,
      systemPrompt: undefined,
    });
  });

  it('supports redis session store config', () => {
    const config = loadConfig({
      SESSION_STORE: 'redis',
      REDIS_URL: 'redis://127.0.0.1:6379/0',
      REDIS_KEY_PREFIX: 'qq-ai-bot-prod',
      SESSION_TTL_MINUTES: '30',
    });

    expect(config.storage.sessionStore).toBe('redis');
    expect(config.storage.redisUrl).toBe('redis://127.0.0.1:6379/0');
    expect(config.storage.redisKeyPrefix).toBe('qq-ai-bot-prod');
    expect(config.storage.sessionTtlMs).toBe(30 * 60 * 1000);
  });


  it('supports postgres session store config', () => {
    const config = loadConfig({
      SESSION_STORE: 'postgres',
      POSTGRES_URL: 'postgres://user:pass@127.0.0.1:5432/qq_ai_bot',
      POSTGRES_TABLE: 'custom_sessions',
      SESSION_TTL_MINUTES: '45',
    });

    expect(config.storage.sessionStore).toBe('postgres');
    expect(config.storage.postgresUrl).toBe('postgres://user:pass@127.0.0.1:5432/qq_ai_bot');
    expect(config.storage.postgresTable).toBe('custom_sessions');
    expect(config.storage.sessionTtlMs).toBe(45 * 60 * 1000);
  });

  it('supports inbound dedupe tuning config', () => {
    const config = loadConfig({
      ONEBOT_INBOUND_DEDUPE_WINDOW_MS: '45000',
      ONEBOT_INBOUND_DEDUPE_MAX_ENTRIES: '512',
    });

    expect(config.onebot.inboundDedupeWindowMs).toBe(45_000);
    expect(config.onebot.inboundDedupeMaxEntries).toBe(512);
  });

  it('resolves configured OneBot image cache roots', () => {
    const config = loadConfig({
      ONEBOT_INBOUND_IMAGE_LOCAL_ROOTS: './cache-a,/tmp/cache-b',
    });

    expect(config.onebot.inboundImageLocalRoots).toEqual([
      path.resolve('./cache-a'),
      '/tmp/cache-b',
    ]);
  });
});
