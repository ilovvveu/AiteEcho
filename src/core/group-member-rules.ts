import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile, unlink } from 'node:fs/promises';
import type { AppConfig, GroupMemberRule } from '../config/index.js';
import { groupMemberRuleSchema } from '../config/index.js';

// Writes are serialized and atomic, preserving prompts and unrelated group
// settings. Each successful edit keeps a mode-0600, recoverable prior copy.
export class GroupMemberRules {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly config: AppConfig) {}

  set(groupId: string, userId: string, rule?: GroupMemberRule): Promise<void> {
    const task = this.writes.catch(() => undefined).then(async () => {
      const filename = this.config.onebot.groupConfigFilePath;
      const policy = this.config.onebot.groupPolicies[groupId];
      if (!filename || !policy) throw new Error('当前群未配置独立规则文件');
      if (!/^\d{1,20}$/u.test(userId)) throw new Error('QQ号格式无效');
      if (this.config.onebot.ownerUsers.includes(userId)) throw new Error('本人始终不限频，不设置特殊覆盖');
      const parsed = rule === undefined ? undefined : groupMemberRuleSchema.parse(rule);
      const before = await readFile(filename, 'utf8');
      const document = JSON.parse(before);
      if (!document.groups?.[groupId]) throw new Error('规则文件缺少当前群');
      const rules = { ...(document.groups[groupId].memberRules ?? {}) };
      if (parsed === undefined) delete rules[userId]; else rules[userId] = parsed;
      document.groups[groupId].memberRules = rules;
      const suffix = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
      const temp = `${filename}.${suffix}.tmp`;
      await writeFile(`${filename}.before-members-${suffix}`, before, { mode: 0o600, flag: 'wx' });
      try {
        await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temp, filename);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
      policy.memberRules = rules;
    });
    this.writes = task;
    return task;
  }
}
