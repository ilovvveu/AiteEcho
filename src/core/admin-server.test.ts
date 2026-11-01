import pino from 'pino';
import { afterEach, expect, it } from 'vitest';
import { AdminServer } from './admin-server.js';

const running: AdminServer[] = [];
afterEach(async () => { for (const server of running.splice(0)) await server.stop(); });
async function fixture(token?: string) {
  const server = new AdminServer({ host: '127.0.0.1', port: 0, accessToken: token, logger: pino({ enabled: false }),
    getStatus: () => ({ onebot: { connected: true }, privateAccount: 'PRIVATE_ACCOUNT', privatePath: 'PRIVATE_PATH' }),
    getMetrics: () => 'PRIVATE_METRIC 1' });
  running.push(server); await server.start();
  const port = (server as any).server.address().port;
  return `http://127.0.0.1:${port}`;
}
it('defaults to local-only status access and returns minimal health/readiness', async () => {
  const base = await fixture();
  expect((await (await fetch(base + '/status')).json()).privateAccount).toBe('PRIVATE_ACCOUNT');
  for (const route of ['/healthz', '/readyz']) {
    const r = await fetch(base + route); expect(r.status).toBe(200); expect(await r.json()).toEqual({ ok: true });
    expect(r.headers.get('cache-control')).toBe('no-store');
  }
});
it('requires header-only Bearer auth for status/metrics, including localhost, without leaking private status or the token', async () => {
  const token = 'test-only-admin-token-731492', base = await fixture(token);
  for (const route of ['/status', '/metrics']) {
    for (const [suffix, headers] of [['', {}], ['?access_token=' + token, {}], ['', { authorization: 'Bearer wrong' }]] as const) {
      const r = await fetch(base + route + suffix, { headers }); expect(r.status).toBe(401);
      expect(await r.text()).not.toMatch(/PRIVATE_|test-only/);
    }
    expect((await fetch(base + route, { headers: { authorization: 'Bearer ' + token } })).status).toBe(200);
  }
  expect((await fetch(base + '/status', { method: 'POST' })).status).toBe(405);
  expect((await fetch(base + '/missing')).status).toBe(404);
});
it.each(['0.0.0.0', '::'])('refuses a public admin listener without a strong token: %s', async host => {
  const server = new AdminServer({ host, port: 0, logger: pino({ enabled: false }), getStatus: () => ({}), getMetrics: () => '' });
  await expect(server.start()).rejects.toThrow('BOT_ADMIN_TOKEN');
});
it('does not return full status from readiness when QQ is offline', async () => {
  const server = new AdminServer({ host: '127.0.0.1', port: 0, logger: pino({ enabled: false }),
    getStatus: () => ({ onebot: { connected: false }, privateAccount: 'PRIVATE_ACCOUNT' }), getMetrics: () => '' });
  running.push(server); await server.start();
  const response = await fetch(`http://127.0.0.1:${(server as any).server.address().port}/readyz`);
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ ok: false });
});
