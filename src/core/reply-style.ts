import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { chmod, copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { contentVersion } from './reply-profile.js';

const STYLE_ID = /^[\p{L}\p{N}_-]{1,40}$/u;
const CONVERSATION_KEY = /^(group|direct):\d{1,20}$/u;
const RESERVED = new Set(['list', 'show', 'reset']);

/** Small local presets, hot-reloaded; selections are separate from expiring chat history. */
export class ReplyStyle {
  private readonly cache = new Map<string, { signature: string; text: string }>();
  private selections: Record<string, string> = {};
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly filename: string | undefined,
    private readonly logger: Logger,
    private readonly presets?: { directory?: string; stateFile?: string },
  ) {
    if (presets?.directory && presets.stateFile) {
      try {
        const stat = lstatSync(presets.stateFile);
        if (!stat.isFile() || stat.size > 65536) throw new Error('invalid state file');
        const saved = JSON.parse(readFileSync(presets.stateFile, 'utf8'));
        if (saved.version !== 1 || !saved.conversations || typeof saved.conversations !== 'object' || Array.isArray(saved.conversations)) throw new Error('invalid state');
        this.selections = Object.fromEntries(Object.entries(saved.conversations).filter(([key, id]) => CONVERSATION_KEY.test(key) && typeof id === 'string' && STYLE_ID.test(id) && !RESERVED.has(id)) as [string, string][]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn('style selections unavailable; using blank default');
      }
    }
  }

  isPresetMode(): boolean { return Boolean(this.presets?.directory); }
  current(conversationKey: string): string { return this.selections[conversationKey] ?? 'default'; }
  snapshot(conversationKey: string): { id: string; text: string; version: string } {
    const id = this.current(conversationKey), text = this.get(conversationKey);
    return { id, text, version: contentVersion(text) };
  }

  list(): string[] {
    if (!this.presets?.directory) return [];
    let names: string[] = [];
    try {
      names = readdirSync(this.presets.directory, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.txt') && STYLE_ID.test(e.name.slice(0, -4)))
        .map(e => e.name.slice(0, -4)).filter(id => !RESERVED.has(id));
    } catch { this.logger.warn('style preset directory unavailable'); }
    return ['default', ...names.filter(n => n !== 'default').sort()];
  }

  private readText(filename: string): string {
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.size > 16384) throw new Error('invalid style file');
    const signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    const cached = this.cache.get(filename);
    if (cached?.signature === signature) return cached.text;
    const text = readFileSync(filename, 'utf8').trim();
    if (text.length > 4000) throw new Error('style too long');
    this.cache.set(filename, { signature, text });
    return text;
  }

  get(conversationKey = ''): string {
    const id = this.current(conversationKey);
    const filename = this.presets?.directory ? path.join(this.presets.directory, `${id}.txt`) : this.filename;
    if (!filename) return '';
    try {
      return this.readText(filename);
    } catch {
      this.logger.warn('reply style preset unavailable; retaining this preset last valid text');
      return this.cache.get(filename)?.text ?? '';
    }
  }

  select(conversationKey: string, requested: string): Promise<void> {
    const task = this.writes.catch(() => undefined).then(async () => {
      const directory = this.presets?.directory, stateFile = this.presets?.stateFile;
      if (!directory || !stateFile || !CONVERSATION_KEY.test(conversationKey) || !STYLE_ID.test(requested) || RESERVED.has(requested)) throw new Error('invalid style selection');
      if (requested !== 'default' && !this.list().includes(requested)) throw new Error('unknown preset');
      // Validate before changing state. Default is always a safe empty fallback.
      if (requested !== 'default') this.readText(path.join(directory, `${requested}.txt`));
      const next = { ...this.selections };
      if (requested === 'default') delete next[conversationKey]; else next[conversationKey] = requested;
      const raw = `${JSON.stringify({ version: 1, conversations: next }, null, 2)}\n`;
      if (Buffer.byteLength(raw) > 65536) throw new Error('too many style selections');
      await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      try { await copyFile(stateFile, `${stateFile}.bak`); await chmod(`${stateFile}.bak`, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const temp = `${stateFile}.tmp`;
      await writeFile(temp, raw, { mode: 0o600 }); await chmod(temp, 0o600); await rename(temp, stateFile);
      this.selections = next;
    });
    this.writes = task;
    return task;
  }
}
