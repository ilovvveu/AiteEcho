import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMessageTestConfig as loadConfig } from '../test-support/config.js';
import { GroupMemberRules } from './group-member-rules.js';

describe('persistent special member rules', () => {
  it('serializes edits, preserves prompts/settings, backs up and reloads rules', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qq-member-rules-'));
    const file = path.join(dir, 'groups.json');
    try {
      await writeFile(file, JSON.stringify({ defaultSystemPrompt: 'preserve', groups: { '100': { systemPrompt: 'group prompt', allowAllMembers: true, requireMention: true, unrelated: 'keep' } } }));
      const config = loadConfig({ ONEBOT_OWNER_USERS: '1', ONEBOT_GROUP_CONFIG_FILE: file });
      const store = new GroupMemberRules(config);
      await Promise.all([store.set('100', '2', { label: '朋友', limitPerMinute: 3 }), store.set('100', '3', { blocked: true })]);
      const disk = JSON.parse(await readFile(file, 'utf8'));
      expect(disk.defaultSystemPrompt).toBe('preserve');
      expect(disk.groups['100'].unrelated).toBe('keep');
      expect(disk.groups['100'].memberRules['2'].limitPerMinute).toBe(3);
      expect(config.onebot.groupPolicies['100']?.memberRules?.['3']?.blocked).toBe(true);
      expect(loadConfig({ ONEBOT_GROUP_CONFIG_FILE: file }).onebot.groupPolicies['100']?.memberRules?.['2']?.label).toBe('朋友');
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await readdir(dir)).filter((name) => name.includes('.before-members-'))).toHaveLength(2);
      await store.set('100', '2');
      expect(config.onebot.groupPolicies['100']?.memberRules?.['2']).toBeUndefined();
      await expect(store.set('100', '1', { blocked: true })).rejects.toThrow('本人');
      await expect(store.set('100', '../escape', { blocked: true })).rejects.toThrow('QQ');
      await expect(store.set('100', '4', { limitPerMinute: -1 })).rejects.toThrow();
      expect(config.onebot.groupPolicies['100']?.memberRules?.['4']).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
