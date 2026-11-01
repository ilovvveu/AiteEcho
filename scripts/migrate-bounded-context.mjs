// One-time, offline migration. Run only while this bot is stopped.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { pruneContext } from '../dist/core/bounded-context.js';

const [runtime, codexHome, backup] = process.argv.slice(2);
if (!runtime || !codexHome || !backup) throw new Error('runtime, independent Codex home and backup directory required');
const filename = path.join(runtime, 'data/sessions.json');
const records = JSON.parse(await fs.readFile(filename, 'utf8'));
const limits = { maxTurns: 100, maxAgeMs: 86400000, maxStoredChars: 120000, promptTurns: 12, promptChars: 8000 };
const ids = new Set(records.map(r => r.remoteSessionId).filter(id => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id ?? '')));
const files = new Map();
async function walk(dir, depth = 0) {
  let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3 && (depth === 0 ? /^\d{4}$/u : /^\d{2}$/u).test(e.name)) await walk(p, depth + 1);
    else if (e.isFile() && e.name.startsWith('rollout-')) for (const id of ids) if (e.name.endsWith(`-${id}.jsonl`)) files.set(id, p);
  }
}
await walk(path.join(codexHome, 'sessions'));
async function extract(file) {
  if (!file) return [];
  const turns = []; let user, answer;
  for await (const line of readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    const p = r.payload;
    if (r.type === 'event_msg' && p?.type === 'task_complete' && user) {
      const final = typeof p.last_agent_message === 'string' ? p.last_agent_message : answer;
      if (final?.trim()) turns.push({ at: Date.parse(r.timestamp), user, assistant: final });
      user = undefined; answer = undefined;
      if (turns.length > 100) turns.shift();
      continue;
    }
    if (r.type !== 'response_item' || p?.type !== 'message') continue;
    const text = (p.content ?? []).filter(c => typeof c.text === 'string').map(c => c.text).join('\n');
    if (p.role === 'user') {
      const marker = '[用户消息]\n', start = text.indexOf(marker);
      if (start >= 0) {
        const author = text.match(/发送者[^\n]*/u)?.[0] ?? '旧会话用户';
        user = `${author}\n${text.slice(start + marker.length).split('\n\n[附加说明]')[0].slice(0, 1800)}`;
        answer = undefined;
      }
    } else if (p.role === 'assistant' && p.phase === 'final_answer' && user && text.trim()) {
      answer = text;
    }
  }
  return pruneContext(turns, limits);
}
await fs.mkdir(path.join(backup, 'legacy-rollouts'), { recursive: true, mode: 0o700 });
await fs.copyFile(filename, path.join(backup, 'sessions-before-migration.json'));
const summary = [];
for (const record of records) {
  const file = files.get(record.remoteSessionId);
  record.contextTurns = pruneContext(record.contextTurns ?? await extract(file), limits);
  delete record.remoteSessionId;
  summary.push({ turns: record.contextTurns.length, chars: JSON.stringify(record.contextTurns).length });
  if (file) await fs.copyFile(file, path.join(backup, 'legacy-rollouts', path.basename(file)));
}
const temp = `${filename}.context-migration.tmp`;
await fs.writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
await fs.rename(temp, filename);
// Only previously indexed, already backed-up rollout files leave the active store.
for (const file of files.values()) await fs.unlink(file);
console.log(JSON.stringify({ migratedConversations: summary, archivedLegacyRollouts: files.size, bodiesPrinted: false }));
