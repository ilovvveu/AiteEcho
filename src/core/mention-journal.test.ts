import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMessageTestConfig as loadConfig } from '../test-support/config.js';
import { normalizeOneBotEvent } from '../channels/onebot/normalize.js';
import { MentionJournal } from './mention-journal.js';

const event = (id = 1, text = 'PRIVATE_QUESTION') => normalizeOneBotEvent({ post_type: 'message', message_type: 'group', group_id: 100,
  group_name: '测试群', user_id: 1, self_id: 999, message_id: id, time: 1793174700,
  sender: { user_id: 1, nickname: '旧昵称', card: '当时群名片' },
  message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text } }] })!;
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'qq-mention-journal-'));
  const file = path.join(dir, 'mentions', 'events.jsonl');
  const config = loadConfig({ BOT_MENTION_JOURNAL_FILE: file, ONEBOT_ALLOWED_GROUPS: '100' });
  const journal = new MentionJournal(file, config.onebot);
  return { dir, file, config, journal, rows: async () => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
describe('local append-only mention journal', () => {
  it('records complete questions, identity snapshots, both timestamps, replies and delivery separately; no binary or URLs from media', async () => {
    const { journal, file, rows } = await fixture(); await journal.start();
    const e = event(); e.imageReferences = [{ url: 'https://private.invalid/key' }];
    await journal.begin(e, 'trace');
    await journal.observeReply({ context: { chatType: 'group', targetId: '100', correlationId: 'trace', purpose: 'reply' },
      outcome: 'acknowledged', messageId: '77', voiceText: 'PRIVATE_VOICE_TEXT', message: [{ type: 'record', data: { file: 'base64://DO_NOT_ARCHIVE_AUDIO' } }] });
    await journal.finish('trace');
    const all = await rows(); expect(all.map(row => row.kind)).toEqual(['question', 'reply', 'processing_result']);
    expect(all[0]).toMatchObject({ groupId: '100', groupName: '测试群', senderId: '1', senderName: '当时群名片', senderCard: '当时群名片', senderNickname: '旧昵称',
      questionMessageId: '1', text: 'PRIVATE_QUESTION', timeZone: 'Asia/Shanghai', recallStatus: 'not-verified', attachments: [{ type: 'image' }] });
    expect(all[0].messageAt).toBe(new Date(1793174700000).toISOString()); expect(all[0].messageAtLocal).toContain('2026-10-28');
    expect(all[1]).toMatchObject({ delivery: 'acknowledged', replyMessageId: '77', text: 'PRIVATE_VOICE_TEXT', mediaTypes: ['record'], clientVisibility: 'not-verified' });
    expect(JSON.stringify(all)).not.toMatch(/DO_NOT_ARCHIVE_AUDIO|private\.invalid/);
    expect((await stat(file)).mode & 0o777).toBe(0o600); expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(journal.status())).not.toContain('PRIVATE_');
  });
  it('ignores private messages, plain text mentions, other groups, own messages and unrelated proactive replies', async () => {
    const { journal, rows } = await fixture(); await journal.start();
    for (const e of [{ ...event(), mode: 'direct' as const }, { ...event(), explicitMention: false, cleanedText: '@999 fake' },
      { ...event(), conversationId: '200' }, { ...event(), isSelfMessage: true }]) await journal.begin(e, 'ignored');
    await journal.observeReply({ context: { chatType: 'group', targetId: '100', correlationId: 'untracked' }, message: 'IGNORED', outcome: 'acknowledged' });
    expect(await rows()).toEqual([]);
  });
  it('never truncates or prunes old content on startup, restart, finishing or historical timestamps', async () => {
    const { journal, file, config, rows } = await fixture(); const long = '完整原文'.repeat(2000);
    const old = event(1, long); old.timestamp = 0;
    await journal.begin(old, 'old'); await journal.finish('old');
    const saved = await readFile(file, 'utf8');
    const reloaded = new MentionJournal(file, config.onebot); await reloaded.start();
    expect(await readFile(file, 'utf8')).toBe(saved);
    await reloaded.begin(event(2), 'new'); reloaded.setResult('new', 'rate_limited', 'rate_limit'); await reloaded.finish('new');
    expect((await rows())[0].text).toBe(long); expect((await rows()).at(-1)).toMatchObject({ result: 'rate_limited' });
  });
  it('records failed and unconfirmed sends without calling them delivered', async () => {
    const { journal, rows } = await fixture(); await journal.begin(event(), 'trace');
    for (const outcome of ['failed', 'unconfirmed', 'rejected'] as const) await journal.observeReply({ context: { chatType: 'group', targetId: '100', correlationId: 'trace' }, message: 'ATTEMPT', outcome });
    journal.setResult('trace', 'failed', 'FIRST_BYTE_TIMEOUT'); await journal.finish('trace');
    expect((await rows()).filter(row => row.kind === 'reply').map(row => row.delivery)).toEqual(['failed', 'unconfirmed', 'rejected']);
    expect((await rows()).at(-1)).toMatchObject({ result: 'failed', errorCode: 'FIRST_BYTE_TIMEOUT' });
  });
  it('exposes disk failures without throwing, overwriting a target or leaking content', async () => {
    const { journal, file, dir, rows } = await fixture(); await journal.start();
    const target = path.join(dir, 'protected.txt'); await writeFile(target, 'DO_NOT_OVERWRITE');
    const link = path.join(dir, 'link.jsonl'); await symlink(target, link);
    const unsafe = new MentionJournal(link, loadConfig({}).onebot); await unsafe.begin(event(), 'bad'); await unsafe.finish('bad');
    expect(unsafe.status()).toMatchObject({ healthy: false, writeFailures: 2 });
    expect(await readFile(target, 'utf8')).toBe('DO_NOT_OVERWRITE'); expect(await rows()).toEqual([]);
    expect((await stat(file)).size).toBe(0);
  });
  it('keeps cloud paths disabled and defaults off', () => {
    expect(loadConfig({}).mentionJournal.file).toBeUndefined();
    expect(() => loadConfig({ BOT_MENTION_JOURNAL_FILE: '/example/Library/Mobile Documents/vault/log.jsonl' })).toThrow('outside iCloud');
  });
  it('does not interrupt a question for an invalid upstream timestamp', async () => {
    const { journal, rows } = await fixture(); const e = event(); e.timestamp = 1e30;
    await journal.begin(e, 'bad-time'); await journal.finish('bad-time');
    expect((await rows())[0]).toMatchObject({ text: 'PRIVATE_QUESTION' });
    expect((await rows())[0]).not.toHaveProperty('messageAt');
  });
});
