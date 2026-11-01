import { describe, expect, it } from 'vitest';
import { validateGrokReply, withGrokCompatibility } from './grok-config.js';
import { withWebSearch } from './search-config.js';

describe('isolated Grok compatibility', () => {
  it('only disables multi-agent tools, preserving provider, high effort, search and credentials', () => {
    const config = { model: 'grok-chat-auto', model_reasoning_effort: 'high', features: { apps: false, goals: true, multi_agent: true }, model_providers: { relay: { base_url: 'https://example.test/v1' } } };
    const original = { CODEX_CONFIG: JSON.stringify(config), QQ_CODEX_API_KEY: 'test-only' };
    const env = withGrokCompatibility(withWebSearch(original, true), true);
    expect(JSON.parse(env.CODEX_CONFIG!)).toEqual({ ...config, web_search: 'live', features: { ...config.features, multi_agent: false } });
    expect(env.QQ_CODEX_API_KEY).toBe('test-only');
    expect(JSON.parse(original.CODEX_CONFIG)).toEqual(config);
    expect(withGrokCompatibility(original, false)).toEqual(original);
  });
  it('supports an empty override and overrides a competing dotted key', () => {
    expect(JSON.parse(withGrokCompatibility({}, true).CODEX_CONFIG!)).toEqual({ features: { multi_agent: false } });
    const env = withGrokCompatibility({ CODEX_CONFIG: '{"features.multi_agent":true}' }, true);
    expect(JSON.parse(env.CODEX_CONFIG!)['features.multi_agent']).toBe(false);
  });
  it('fails closed for malformed override objects', () => {
    for (const value of ['[]', 'null', '1', '{', '{"features":[]}', '{"features":true}']) {
      expect(() => withGrokCompatibility({ CODEX_CONFIG: value }, true)).toThrow();
    }
  });
  it('rejects a gateway error envelope without leaking its contents', () => {
    const text = JSON.stringify({ error: { code: 'upstream_error', type: 'invalid_request_error', message: 'SECRET https://example.test/private' } });
    expect(() => validateGrokReply(text)).toThrow('Grok 接口返回错误');
    try { validateGrokReply(text); } catch (e) { expect(String(e)).not.toContain('SECRET'); }
  });
  it('preserves ordinary replies and user documents containing error fields', () => {
    for (const text of ['正常回答', '{"error":"quoted data"}', '{"error":{"message":"example"}}', '{"error":{"code":"upstream_error","message":"example"},"explanation":"quoted"}']) {
      expect(validateGrokReply(text)).toBe(text);
    }
  });
});
