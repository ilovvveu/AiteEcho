import { createServer, type IncomingMessage, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Logger } from 'pino';
import { isLoopbackHost, strongAccessToken } from '../utils/network.js';

export interface AdminServerDeps {
  host: string;
  port: number;
  accessToken?: string;
  logger: Logger;
  getStatus: () => Record<string, unknown>;
  getMetrics: () => string;
}

export class AdminServer {
  private server: Server | null = null;

  constructor(private readonly deps: AdminServerDeps) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    if ((!isLoopbackHost(this.deps.host) || this.deps.accessToken) && !strongAccessToken(this.deps.accessToken)) {
      throw new Error('Non-loopback admin binding requires a strong BOT_ADMIN_TOKEN');
    }

    this.server = createServer((req, res) => {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      if (req.method !== 'GET') {
        res.statusCode = 405; res.setHeader('allow', 'GET'); res.end('Method not allowed'); return;
      }
      let pathname: string;
      try { pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname; }
      catch { res.statusCode = 400; res.end('Bad request'); return; }
      if (pathname === '/healthz') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (pathname === '/readyz') {
        const status = this.deps.getStatus();
        const ready = (status.onebot as { connected?: boolean } | undefined)?.connected === true;
        res.statusCode = ready ? 200 : 503;
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: ready })); return;
      }
      if (pathname !== '/status' && pathname !== '/metrics') { res.statusCode = 404; res.end('Not found'); return; }
      if (!this.authorized(req)) {
        res.statusCode = 401; res.setHeader('www-authenticate', 'Bearer'); res.end('Unauthorized'); return;
      }
      if (pathname === '/status') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(this.deps.getStatus(), null, 2));
        return;
      }
      if (pathname === '/metrics') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
        res.end(this.deps.getMetrics());
        return;
      }
      res.statusCode = 404;
      res.end('Not found');
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.deps.port, this.deps.host, () => {
        this.server?.off('error', reject);
        resolve();
      });
    });

    this.deps.logger.info(
      { host: this.deps.host, port: this.deps.port },
      'admin server listening',
    );
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.deps.accessToken) {
      const address = req.socket.remoteAddress?.replace(/^::ffff:/u, '') ?? '';
      return isLoopbackHost(this.deps.host) && isLoopbackHost(address);
    }
    const expected = Buffer.from(`Bearer ${this.deps.accessToken}`);
    const received = Buffer.from(req.headers.authorization ?? '');
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const current = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      current.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
