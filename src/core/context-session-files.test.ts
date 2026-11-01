import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeOwnedSessionFiles } from './context-session-files.js';
const id = '11111111-2222-3333-4444-555555555555';
describe('owned context session cleanup', () => {
  it('deletes only the exact owned rollout ID and preserves unrelated files', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'qq-context-files-'));
    const dir = path.join(home, 'sessions/2026/10/23'); await mkdir(dir, { recursive: true });
    const owned = path.join(dir, `rollout-date-${id}.jsonl`), other = path.join(dir, 'rollout-unrelated.jsonl');
    await writeFile(owned, 'private'); await writeFile(other, 'preserved');
    expect(await removeOwnedSessionFiles(home, id)).toBe(true);
    await expect(readFile(owned)).rejects.toThrow();
    expect(await readFile(other, 'utf8')).toBe('preserved');
    expect(await removeOwnedSessionFiles(home, '../../outside')).toBe(false);
  });
  it('does not traverse symbolic links in session directories', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'qq-context-links-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'qq-context-outside-'));
    const file = path.join(outside, `rollout-date-${id}.jsonl`); await writeFile(file, 'protected');
    await symlink(outside, path.join(home, 'sessions'));
    expect(await removeOwnedSessionFiles(home, id)).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('protected');
  });
});
