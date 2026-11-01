import { describe, expect, it } from 'vitest';
import { mergeDotEnvFiles, parseDotEnv } from './env-file.js';

describe('env-file helpers', () => {
  it('parses simple dotenv content', () => {
    expect(parseDotEnv('FOO=bar\nexport BAR=baz\n# comment\n')).toEqual({
      FOO: 'bar',
      BAR: 'baz',
    });
  });

  it('merges files in order so later files override earlier ones', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');

    const dir = await mkdtemp(path.join(tmpdir(), 'qq-ai-bot-env-'));
    const envPath = path.join(dir, '.env');
    const localPath = path.join(dir, '.env.local');

    await writeFile(envPath, 'FOO=base\nBAR=from-env\n', 'utf8');
    await writeFile(localPath, 'BAR=from-local\nBAZ=extra\n', 'utf8');

    expect(mergeDotEnvFiles([envPath, localPath], {})).toEqual({
      FOO: 'base',
      BAR: 'from-local',
      BAZ: 'extra',
    });
  });
});
