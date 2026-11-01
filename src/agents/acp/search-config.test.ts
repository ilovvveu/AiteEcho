import { describe, expect, it } from 'vitest';
import { webSearchContextLines, withWebSearch } from './search-config.js';

describe('isolated web search configuration', () => {
  it('preserves provider, model, other overrides and the original environment', () => {
    const original = { CODEX_CONFIG: '{"model":"test-model","sandbox_mode":"read-only","web_search":"disabled"}', QQ_CODEX_API_KEY: 'test-only' };
    const env = withWebSearch(original, true);
    expect(JSON.parse(env.CODEX_CONFIG!)).toEqual({ model: 'test-model', sandbox_mode: 'read-only', web_search: 'live' });
    expect(env.QQ_CODEX_API_KEY).toBe('test-only');
    expect(JSON.parse(original.CODEX_CONFIG).web_search).toBe('disabled');
    expect(withWebSearch(original, false)).toEqual(original);
    expect(() => withWebSearch({ CODEX_CONFIG: '[]' }, true)).toThrow();
  });
  it('requires real searches, source links and minimizes query disclosure', () => {
    expect(webSearchContextLines(false)).toEqual([]);
    expect(webSearchContextLines(true).join('\n')).toContain('实际调用 web_search');
    expect(webSearchContextLines(true).join('\n')).toContain('不发送 QQ 账号');
    expect(webSearchContextLines(true, false).join('\n')).toContain('默认不显示来源链接');
    expect(webSearchContextLines(true, false).join('\n')).not.toContain('须附');
  });
});
