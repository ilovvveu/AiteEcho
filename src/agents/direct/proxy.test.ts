import { createServer, type Server, type RequestListener } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect, createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config/index.js';
import { Diagnostics } from '../../infra/diagnostics.js';
import { DirectApiBridge, DirectApiError } from './bridge.js';
import { key, cert } from './fixtures/untrusted-tls.js';

const servers: Server[] = [], sockets = new Set<Socket>();
const rawServers: TcpServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy(); sockets.clear();
  for (const server of servers.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const server of rawServers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
});
async function listen(server: Server): Promise<number> {
  servers.push(server); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return (server.address() as { port: number }).port;
}
async function setup(mode: 'ok' | 'partial' | '401' | 'silent' | 'proxy503' | 'proxy407' | 'stall_once' | 'reset_once' = 'ok', tls = false) {
  let calls = 0, tunnels = 0;
  const connectHeaders: unknown[] = [];
  const body = JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] });
  const handler: RequestListener = async (req, res) => {
    calls++; for await (const chunk of req) { void chunk; }
    if (calls === 1 && mode === 'stall_once') return;
    if (calls === 1 && mode === 'reset_once') { req.socket.destroy(); return; }
    if (mode === '401') { res.writeHead(401); res.end('{}'); return; }
    if (mode === 'partial') {
      const socket = res.socket!;
      res.writeHead(200, { 'content-length': Buffer.byteLength(body) + 10 }); res.end(body);
      setTimeout(() => socket.end(), 5); return;
    }
    res.end(body);
  };
  const target = await listen(tls ? createTlsServer({ key, cert }, handler) : createServer(handler));
  const proxy = createServer();
  proxy.on('connect', (req, socket, head) => {
    tunnels++; connectHeaders.push(req.headers);
    if (mode === 'silent') { socket.on('end', () => socket.destroy()); socket.resume(); return; }
    if (mode === 'proxy503' || mode === 'proxy407') { socket.end(`HTTP/1.1 ${mode === 'proxy503' ? 503 : 407} Error\r\nContent-Length: 0\r\n\r\n`); return; }
    const upstream = connect(target, '127.0.0.1'); sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
  });
  const port = await listen(proxy);
  const config = loadConfig({ AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high', DIRECT_API_BASE_URL: `${tls ? 'https://localhost' : 'http://127.0.0.1'}:${target}/v1`,
    DIRECT_API_LOCAL_PROXY_URL: `http://127.0.0.1:${port}`, QQ_CODEX_API_KEY: 'SYNTHETIC_KEY', CONTEXT_BOUNDED: 'true' });
  const diagnostics = new Diagnostics(); const bridge = new DirectApiBridge(config, diagnostics);
  const preferProxy = () => { (bridge as any).preferProxyUntil = Date.now() + 60000; };
  return { config, diagnostics, bridge, preferProxy, counts: () => ({ calls, tunnels }), connectHeaders };
}
async function brokenHandshake(mode: 'reset' | 'silent') {
  const chunks: Buffer[] = [];
  const server = createTcpServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.on('data', data => { chunks.push(typeof data === 'string' ? Buffer.from(data) : data); if (mode === 'reset') socket.destroy(); });
  });
  rawServers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { port: (server.address() as { port: number }).port, chunks };
}
async function trustedChild(config: ReturnType<typeof loadConfig>, count = 1) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qq-pre-send-tls-'));
  const ca = path.join(directory, 'synthetic-local-ca.pem'); await writeFile(ca, cert);
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { loadConfig } from './src/config/index.ts';
    import { Diagnostics } from './src/infra/diagnostics.ts';
    import { DirectApiBridge } from './src/agents/direct/bridge.ts';
    const c = loadConfig(${JSON.stringify({ AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high', DIRECT_API_BASE_URL: config.ai.direct.baseUrl,
      DIRECT_API_LOCAL_PROXY_URL: config.ai.direct.localProxyUrl, QQ_CODEX_API_KEY: 'SYNTHETIC_KEY', CONTEXT_BOUNDED: 'true' })});
    c.ai.direct.connectTimeoutMs = ${config.ai.direct.connectTimeoutMs};
    c.ai.direct.firstByteTimeoutMs = ${config.ai.direct.firstByteTimeoutMs};
    c.ai.direct.totalTimeoutMs = ${config.ai.direct.totalTimeoutMs};
    c.ai.direct.maxRetries = ${config.ai.direct.maxRetries};
    const d = new Diagnostics(), b = new DirectApiBridge(c, d), outcomes = [];
    for (let n = 0; n < ${count}; n++) {
      try { outcomes.push({ text: (await b.sendPrompt({ text: 'SYNTHETIC_QUESTION_' + n })).text }); }
      catch (e) { outcomes.push({ code: e.code, stage: e.stage, transportState: e.transportState }); }
    }
    await b.stop(); await new Promise(resolve => setTimeout(resolve, 25));
    console.log(JSON.stringify({ outcomes, diagnostics: d.status() }));
  `], { cwd: process.cwd(), env: { ...process.env, NODE_EXTRA_CA_CERTS: ca }, timeout: 5000 });
  expect(result.stderr).not.toContain('Unhandled');
  return JSON.parse(result.stdout.trim());
}
describe('explicit local proxy fallback', () => {
  it.each(['reset', 'silent'] as const)('recovers a real TLS %s before API submission with only one POST', async mode => {
    const f = await setup('ok', true), broken = await brokenHandshake(mode);
    f.config.ai.direct.baseUrl = `https://localhost:${broken.port}/v1`;
    // Allow localhost IPv6/IPv4 selection and parallel-suite scheduling to finish
    // before asserting a TLS-stage failure rather than a TCP-stage timeout.
    f.config.ai.direct.connectTimeoutMs = 1000; f.config.ai.direct.firstByteTimeoutMs = 500;
    const result = await trustedChild(f.config);
    expect(result.outcomes).toEqual([{ text: 'OK' }]);
    expect(f.counts()).toEqual({ calls: 1, tunnels: 1 });
    expect(result.diagnostics.recent).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'tls', outcome: 'retry', route: 'direct', requestSubmitted: false, tlsEstablished: false }),
      expect.objectContaining({ stage: 'route_fallback', route: 'local_proxy' }),
      expect.objectContaining({ stage: 'request_submit', route: 'local_proxy', requestSubmitted: true, tlsEstablished: true }),
    ]));
    const observed = Buffer.concat(broken.chunks);
    expect(observed[0]).toBe(0x16); // TLS ClientHello, never HTTP authorization/payload.
    expect(observed.toString()).not.toMatch(/POST |SYNTHETIC_KEY|SYNTHETIC_QUESTION/);
  });
  it('does not start the first-byte clock or send HTTP bytes before a stalled TLS handshake', async () => {
    const f = await setup('ok', true), broken = await brokenHandshake('silent');
    f.config.ai.direct.baseUrl = `https://localhost:${broken.port}/v1`;
    f.config.ai.direct.connectTimeoutMs = 500; f.config.ai.direct.firstByteTimeoutMs = 10; f.config.ai.direct.maxRetries = 0;
    const result = await trustedChild(f.config);
    expect(result.outcomes).toEqual([{ code: 'CONNECT_TIMEOUT', stage: 'tls', transportState: { requestSubmitted: false, tlsEstablished: false } }]);
    expect(f.counts()).toEqual({ calls: 0, tunnels: 0 });
    expect(result.diagnostics.recent.some((e: any) => e.stage === 'request_submit')).toBe(false);
  });
  it.each(['stall_once', 'reset_once'] as const)('never replays a submitted HTTPS POST on %s; only the next user request changes route', async mode => {
    const f = await setup(mode, true); f.config.ai.direct.firstByteTimeoutMs = 500;
    const result = await trustedChild(f.config, 2);
    expect(result.outcomes[0]).toMatchObject({ code: mode === 'stall_once' ? 'FIRST_BYTE_TIMEOUT' : 'ECONNRESET',
      transportState: { requestSubmitted: true, tlsEstablished: true } });
    expect(result.outcomes[1]).toEqual({ text: 'OK' });
    expect(f.counts()).toEqual({ calls: 2, tunnels: 1 });
    expect(result.diagnostics.recent.some((e: any) => e.stage === 'route_fallback')).toBe(false);
    expect(result.diagnostics.recent).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'route_preference', route: 'local_proxy' }),
    ]));
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/SYNTHETIC_KEY|SYNTHETIC_QUESTION|localhost|127\.0\.0\.1/);
  });
  it('does not route-switch on an unproven TLS failure or on a mislabeled already-submitted request', async () => {
    for (const state of [undefined, { requestSubmitted: true, tlsEstablished: false }]) {
      const f = await setup();
      const request = vi.spyOn(f.bridge as any, 'request').mockRejectedValue(new DirectApiError('tls', 'ECONNRESET', true, undefined, undefined, state));
      await expect(f.bridge.sendPrompt({ text: 'Q' })).rejects.toMatchObject({ code: 'ECONNRESET' });
      expect(request.mock.calls.map(args => args[5])).toEqual(state ? ['direct'] : ['direct', 'direct']);
      expect(f.counts()).toEqual({ calls: 0, tunnels: 0 });
    }
  });
  it('recovers a real refused direct connection via a real CONNECT tunnel, with exactly one API POST', async () => {
    const f = await setup();
    const closed = createServer(), port = await listen(closed);
    await new Promise<void>(resolve => closed.close(() => resolve()));
    f.config.ai.direct.baseUrl = `http://127.0.0.1:${port}/v1`;
    expect((await f.bridge.sendPrompt({ text: 'SYNTHETIC_QUESTION' })).text).toBe('OK');
    expect(f.counts()).toEqual({ calls: 1, tunnels: 1 });
    expect((f.diagnostics.status().recent as any[]).find(e => e.stage === 'route_fallback')).toMatchObject({ route: 'local_proxy', code: 'ECONNREFUSED' });
  });
  it('falls back only after a pre-connect failure, then briefly avoids the broken direct route', async () => {
    const f = await setup();
    const real = (f.bridge as any).request.bind(f.bridge);
    const routes: string[] = [];
    vi.spyOn(f.bridge as any, 'request').mockImplementation(async (...args: any[]) => {
      routes.push(args[5]);
      if (args[5] === 'direct') throw new DirectApiError('tcp_connect', 'CONNECT_TIMEOUT', true);
      return real(...args);
    });
    expect((await f.bridge.sendPrompt({ text: 'PRIVATE_CURRENT' })).text).toBe('OK');
    expect((await f.bridge.sendPrompt({ text: 'PRIVATE_CURRENT_2' })).text).toBe('OK');
    expect(routes).toEqual(['direct', 'local_proxy', 'local_proxy']);
    expect(f.counts()).toEqual({ calls: 2, tunnels: 2 });
    expect(f.connectHeaders).not.toEqual([]);
    expect(JSON.stringify(f.connectHeaders)).not.toContain('SYNTHETIC_KEY');
    const log = JSON.stringify(f.diagnostics.status());
    expect(log).toContain('route_fallback'); expect(log).toContain('local_proxy');
    expect(log).not.toMatch(/PRIVATE_CURRENT|SYNTHETIC_KEY|127\.0\.0\.1/);
  });
  it('uses direct normally with fallback enabled and retries direct after preference expiry', async () => {
    const f = await setup();
    expect((await f.bridge.sendPrompt({ text: 'Q' })).text).toBe('OK');
    expect(f.counts()).toEqual({ calls: 1, tunnels: 0 });
    (f.bridge as any).preferProxyUntil = Date.now() - 1;
    expect((await f.bridge.sendPrompt({ text: 'Q' })).text).toBe('OK');
    expect(f.counts()).toEqual({ calls: 2, tunnels: 0 });
  });
  it('returns to direct if a preferred proxy fails before forwarding; total attempts remain two', async () => {
    const f = await setup('proxy503'); f.preferProxy();
    expect((await f.bridge.sendPrompt({ text: 'Q' })).text).toBe('OK');
    expect(f.counts()).toEqual({ calls: 1, tunnels: 1 });
    expect((f.bridge as any).preferProxyUntil).toBe(0);
  });
  it('does not use an unconfigured proxy or add attempts when retries are disabled', async () => {
    for (const configured of [false, true]) {
      const f = await setup();
      if (!configured) f.config.ai.direct.localProxyUrl = undefined;
      else f.config.ai.direct.maxRetries = 0;
      const request = vi.spyOn(f.bridge as any, 'request').mockRejectedValue(new DirectApiError('dns', 'ENOTFOUND', true));
      await expect(f.bridge.sendPrompt({ text: 'Q' })).rejects.toMatchObject({ code: 'ENOTFOUND' });
      expect(request).toHaveBeenCalledTimes(configured ? 1 : 2); expect(f.counts().tunnels).toBe(0);
    }
  });
  it.each(['tls', 'http_headers', 'first_byte', 'api_body'])('does not switch routes after %s', async stage => {
    const f = await setup();
    const request = vi.spyOn(f.bridge as any, 'request').mockRejectedValue(new DirectApiError(stage, 'CONNECT_TIMEOUT', true));
    await expect(f.bridge.sendPrompt({ text: 'Q' })).rejects.toMatchObject({ stage });
    expect(request.mock.calls.map(args => args[5])).toEqual(['direct', 'direct']);
    expect(f.counts().tunnels).toBe(0);
  });
  it.each(['partial', '401'] as const)('does not replay a %s proxied API response', async mode => {
    const f = await setup(mode); f.preferProxy();
    await expect(f.bridge.sendPrompt({ text: 'Q' })).rejects.toMatchObject({ code: mode === '401' ? 'HTTP_401' : 'RESPONSE_ABORTED' });
    expect(f.counts()).toEqual({ calls: 1, tunnels: 1 });
  });
  it('does not replay proxy authentication errors or send API credentials in CONNECT', async () => {
    const f = await setup('proxy407'); f.preferProxy();
    await expect(f.bridge.sendPrompt({ text: 'Q' })).rejects.toMatchObject({ code: 'PROXY_HTTP_407' });
    expect(f.counts()).toEqual({ calls: 0, tunnels: 1 });
    expect(JSON.stringify(f.connectHeaders)).not.toContain('SYNTHETIC_KEY');
  });
  it('retains target TLS certificate validation through the proxy without falling back to insecure HTTP', async () => {
    const f = await setup('ok', true); f.preferProxy();
    await expect(f.bridge.sendPrompt({ text: 'Q' })).rejects.toMatchObject({ stage: 'tls', code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect(f.counts()).toEqual({ calls: 0, tunnels: 1 });
    expect((f.diagnostics.status().recent as any[]).some(e => e.stage === 'route_fallback')).toBe(false);
  });
  it.each(['ok', 'partial'] as const)('survives real TLS %s-response teardown in a fresh process without uncaught abort errors', async mode => {
    const f = await setup(mode, true);
    const directory = await mkdtemp(path.join(tmpdir(), 'qq-proxy-tls-'));
    const ca = path.join(directory, 'synthetic-local-ca.pem'); await writeFile(ca, cert);
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { loadConfig } from './src/config/index.ts';
      import { Diagnostics } from './src/infra/diagnostics.ts';
      import { DirectApiBridge } from './src/agents/direct/bridge.ts';
      const c = loadConfig(${JSON.stringify({ AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high', DIRECT_API_BASE_URL: f.config.ai.direct.baseUrl,
        DIRECT_API_LOCAL_PROXY_URL: f.config.ai.direct.localProxyUrl, QQ_CODEX_API_KEY: 'SYNTHETIC_KEY', CONTEXT_BOUNDED: 'true' })});
      const b = new DirectApiBridge(c, new Diagnostics());
      b.preferProxyUntil = Date.now() + 60000;
      let outcome;
      try { outcome = (await b.sendPrompt({ text: 'Q' })).text; }
      catch (error) { outcome = error.code; }
      await b.stop(); await new Promise(resolve => setTimeout(resolve, 30));
      console.log(JSON.stringify({ outcome }));
    `], { cwd: process.cwd(), env: { ...process.env, NODE_EXTRA_CA_CERTS: ca }, timeout: 4000 });
    expect(result.stderr).not.toContain('Unhandled');
    expect(JSON.parse(result.stdout.trim())).toEqual({ outcome: mode === 'ok' ? 'OK' : 'RESPONSE_ABORTED' });
    expect(f.counts()).toEqual({ calls: 1, tunnels: 1 });
  });
  it.each(['connect', 'cancel', 'total'])('bounds and cleans up a hanging CONNECT on %s', async kind => {
    const f = await setup('silent'); f.preferProxy(); f.config.ai.direct.maxRetries = 0;
    f.config.ai.direct.connectTimeoutMs = kind === 'connect' ? 40 : 2000;
    f.config.ai.direct.totalTimeoutMs = kind === 'total' ? 40 : 2000;
    const start = Date.now();
    const result = f.bridge.sendPrompt({ text: 'Q' });
    if (kind === 'cancel') setTimeout(() => { void f.bridge.stop(); }, 40);
    await expect(result).rejects.toMatchObject({ code: kind === 'connect' ? 'CONNECT_TIMEOUT' : kind === 'cancel' ? 'CANCELLED' : 'TOTAL_TIMEOUT' });
    expect(Date.now() - start).toBeLessThan(500);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(f.counts()).toEqual({ calls: 0, tunnels: 1 });
    expect(sockets.size).toBe(0);
  });
});
