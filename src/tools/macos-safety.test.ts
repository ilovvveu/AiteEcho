import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertHelperTokens, assertHelperWsUrl, isManagedBotProcess, redactHelperConfig, writePrivateHelperJson } from './macos-safety.js';

describe('macOS helper safety without touching apps, accounts or processes', () => {
  it('writes private configuration and refuses symlinks without modifying the linked target', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'qq-helper-private-')), file = path.join(root, 'config.json'), link = path.join(root, 'link.json');
    await writeFile(file, 'old', { mode: 0o644 }); await writePrivateHelperJson(file, { token: 'synthetic-only' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const before = await readFile(file, 'utf8'); await symlink(file, link);
    await expect(writePrivateHelperJson(link, { token: 'different' })).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(before);
  });
  it('requires explicit independent credentials before modifying configuration', () => {
    for (const tokens of [['', ''], ['change-me', 'change-me'], ['a'.repeat(32), 'a'.repeat(32)]]) expect(() => assertHelperTokens(tokens[0]!, tokens[1]!)).toThrow();
    expect(() => assertHelperTokens('a'.repeat(32), 'b'.repeat(32))).not.toThrow();
    for (const url of ['https://example.org', 'ws://user:pass@example.org', 'ws://localhost/?access_token=private']) expect(() => assertHelperWsUrl(url)).toThrow();
    expect(() => assertHelperWsUrl('ws://127.0.0.1:16700/onebot/v11/ws')).not.toThrow();
  });
  it('redacts nested configuration credentials and token-bearing URLs', () => {
    const output = JSON.stringify(redactHelperConfig({ token: 'PRIVATE_A', network: [{ accessToken: 'PRIVATE_B', url: 'ws://user:pass@localhost/ws?access_token=PRIVATE_C#private' }], port: 6099 }));
    expect(output).not.toMatch(/PRIVATE_|user:pass|access_token/u); expect(output).toContain('6099'); expect(output).toContain('[redacted]');
  });
  it('only recognizes an exact recorded PID, command and working directory, never a broad node match', () => {
    const root = '/example/aite-echo';
    expect(isManagedBotProcess('731', 'node dist/index.js', root, root)).toBe(true);
    for (const pid of ['', '-1', '1', '731\n999', '1e3']) expect(isManagedBotProcess(pid, 'node dist/index.js', root, root)).toBe(false);
    expect(isManagedBotProcess('731', 'node dist/index.js', '/example/other', root)).toBe(false);
    expect(isManagedBotProcess('731', 'node dist/index.js --other', root, root)).toBe(false);
    expect(isManagedBotProcess('731', 'node another.js', root, root)).toBe(false);
  });
});
