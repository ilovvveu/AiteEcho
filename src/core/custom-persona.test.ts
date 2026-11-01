import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import { buildDirectRequest } from '../agents/direct/bridge.js';
import { ReplyRules } from './reply-rules.js';

it('ships blank global persona and default style, leaving role choice to local configuration', () => {
  expect(new ReplyRules('examples/reply-rules.json').get().instructions).toBe('');
  expect(readFileSync('examples/styles/default.txt', 'utf8')).toBe('');
  const c = loadConfig({ AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high', DIRECT_API_BASE_URL: 'https://example.invalid/v1', QQ_CODEX_API_KEY: 'synthetic-test-key', CONTEXT_BOUNDED: 'true' });
  const built = buildDirectRequest(c, { text: '你好', historyContextLines: [] });
  const developer = JSON.stringify(built.body.input);
  expect(developer).not.toContain('成年女性虚拟角色');
  expect(built.stats.historyChars).toBe(0);
});

it('hot reloads a custom persona without source changes, restart, or an extra model request', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qq-custom-persona-')), file = path.join(dir, 'rules.json');
  await writeFile(file, JSON.stringify({ version: 1, sourceLinks: 'on_request', instructions: '用简短自然的口吻回答。' }));
  const rules = new ReplyRules(file);
  expect(rules.resolve('你好').instructions).toContain('用简短自然的口吻回答。');
  await writeFile(file, JSON.stringify({ version: 1, sourceLinks: 'on_request', instructions: '使用严谨的教学风格。' }));
  const c = loadConfig({ AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high', DIRECT_API_BASE_URL: 'https://example.invalid/v1', QQ_CODEX_API_KEY: 'synthetic-test-key', CONTEXT_BOUNDED: 'true' });
  const built = buildDirectRequest(c, { text: '解释一个概念', replyRules: rules.resolve('解释一个概念'), historyContextLines: [] });
  expect(JSON.stringify(built.body.input)).toContain('使用严谨的教学风格。');
  expect(JSON.stringify(built.body.input)).not.toContain('用简短自然的口吻回答。');
  expect(rules.resolve('请给来源').allowSourceLinks).toBe(true);
  expect(built.stats.inputChars).toBeLessThanOrEqual(10000);
  expect(built.stats.inputBytes).toBeLessThanOrEqual(20000);
});
