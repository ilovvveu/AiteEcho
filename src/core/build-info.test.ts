import { describe, expect, it } from 'vitest';
import { getBuildInfo } from './build-info.js';
import pkg from '../../package.json' with { type: 'json' };

describe('getBuildInfo', () => {
  it('returns package version and optional build metadata', () => {
    const info = getBuildInfo({
      APP_GIT_COMMIT: 'abc123',
      APP_BUILD_REF: 'release-2026-07-02',
    } as NodeJS.ProcessEnv);

    expect(info.appName).toBe(pkg.name);
    expect(info.version).toBe(pkg.version);
    expect(info.gitCommit).toBe('abc123');
    expect(info.buildRef).toBe('release-2026-07-02');
    expect(typeof info.startedAt).toBe('string');
    expect(info.startedAt.length).toBeGreaterThan(10);
  });
});
