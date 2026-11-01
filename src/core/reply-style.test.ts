import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { ReplyStyle } from './reply-style.js';
describe('reply style preset', () => {
  it('defaults to blank, lists new files, persists per-chat selection, and reloads edited text', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qq-style-presets-'));
    const directory = path.join(dir, 'presets'); await mkdir(directory);
    const stateFile = path.join(dir, 'data/styles.json');
    await writeFile(path.join(directory, 'default.txt'), '');
    await writeFile(path.join(directory, '自然.txt'), '自然简洁');
    const opts = { directory, stateFile }, log = pino({ enabled: false });
    const style = new ReplyStyle(undefined, log, opts);
    expect(style.current('group:100')).toBe('default'); expect(style.get('group:100')).toBe('');
    expect(style.list()).toEqual(['default', '自然']);
    await style.select('group:100', '自然');
    expect(style.get('group:100')).toBe('自然简洁'); expect(style.get('direct:1')).toBe('');
    expect((await stat(stateFile)).mode & 0o777).toBe(0o600);
    const restored = new ReplyStyle(undefined, log, opts);
    expect(restored.current('group:100')).toBe('自然');
    await writeFile(path.join(directory, '自然.txt'), '自然一点也详细一点');
    expect(restored.get('group:100')).toBe('自然一点也详细一点');
    await writeFile(path.join(directory, '严谨.txt'), '用严谨语气');
    expect(restored.list()).toContain('严谨'); await restored.select('group:100', '严谨');
    expect(restored.get('group:100')).toBe('用严谨语气');
    await restored.select('group:100', 'default'); expect(restored.get('group:100')).toBe('');
    expect(JSON.parse(await readFile(stateFile, 'utf8')).conversations).toEqual({});
  });
  it('rejects paths, reserved names, symlinks and invalid presets without changing selection', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qq-style-invalid-'));
    const style = new ReplyStyle(undefined, pino({ enabled: false }), { directory: dir, stateFile: path.join(dir, 'state.json') });
    await writeFile(path.join(dir, 'ok.txt'), '保持'); await style.select('group:100', 'ok');
    await writeFile(path.join(dir, 'huge.txt'), 'x'.repeat(5000));
    await symlink(path.join(dir, 'ok.txt'), path.join(dir, 'link.txt'));
    for (const id of ['../ok', '/etc/passwd', 'missing', 'list', 'show', 'reset', 'link', 'huge']) await expect(style.select('group:100', id)).rejects.toThrow();
    expect(style.current('group:100')).toBe('ok'); expect(style.get('group:100')).toBe('保持');
    await expect(style.select('arbitrary-key', 'ok')).rejects.toThrow();
  });
  it('serializes switches in different conversations without dropping either selection', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qq-style-parallel-'));
    await writeFile(path.join(dir, 'a.txt'), 'A'); await writeFile(path.join(dir, 'b.txt'), 'B');
    const stateFile = path.join(dir, 'state.json');
    const style = new ReplyStyle(undefined, pino({ enabled: false }), { directory: dir, stateFile });
    await Promise.all([style.select('group:100', 'a'), style.select('direct:1', 'b')]);
    expect(JSON.parse(await readFile(stateFile, 'utf8')).conversations).toEqual({ 'group:100': 'a', 'direct:1': 'b' });
  });
  it('hot-reloads edits and retains the last valid preset on oversized or missing data', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qq-style-')), file = path.join(dir, 'style.txt');
    await writeFile(file, '自然简短');
    const style = new ReplyStyle(file, pino({ enabled: false }));
    expect(style.get()).toBe('自然简短');
    await writeFile(file, '温和详细一些'); expect(style.get()).toBe('温和详细一些');
    await writeFile(file, 'x'.repeat(20000)); expect(style.get()).toBe('温和详细一些');
    await writeFile(file, ''); expect(style.get()).toBe('');
    expect(new ReplyStyle(undefined, pino({ enabled: false })).get()).toBe('');
  });
});
