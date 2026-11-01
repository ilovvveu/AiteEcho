// Grok's Responses endpoint accepts ordinary function tools, but not the
// namespace used by Codex multi-agent tools. Keep all unrelated capabilities.
export function withGrokCompatibility(env: NodeJS.ProcessEnv, enabled: boolean): NodeJS.ProcessEnv {
  if (!enabled) return { ...env };
  const config = env.CODEX_CONFIG ? JSON.parse(env.CODEX_CONFIG) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('CODEX_CONFIG 必须是 JSON 对象');
  }
  const features = config.features ?? {};
  if (typeof features !== 'object' || Array.isArray(features)) {
    throw new Error('CODEX_CONFIG.features 必须是 JSON 对象');
  }
  const overrides = { ...config, features: { ...features, multi_agent: false } };
  if (Object.hasOwn(overrides, 'features.multi_agent')) overrides['features.multi_agent'] = false;
  return { ...env, CODEX_CONFIG: JSON.stringify(overrides) };
}

// Some gateways return their failure envelope as assistant text and still emit
// end_turn. Do not treat that exact envelope as a successful model answer.
export function validateGrokReply(text: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim()); } catch { return text; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text;
  const envelope = parsed as Record<string, unknown>;
  if (Object.keys(envelope).length !== 1 || !envelope.error || typeof envelope.error !== 'object') return text;
  const error = envelope.error as Record<string, unknown>;
  if (typeof error.message === 'string' &&
    (error.code === 'upstream_error' || error.type === 'invalid_request_error' || error.type === 'api_error')) {
    // Never echo upstream error bodies: they may include URLs or credentials.
    throw new Error('Grok 接口返回错误，未生成有效回复；请稍后重试或检查接口兼容配置。');
  }
  return text;
}
