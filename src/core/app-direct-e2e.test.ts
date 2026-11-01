import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import pino from 'pino';
import { expect, it } from 'vitest';
import { loadMessageTestConfig as loadConfig } from '../test-support/config.js';
import { BotApplication } from './app.js';

it.each([false, true])('handles fake-OneBot through HTTP (proxy fallback=%s), reports failure stages and excludes error history', async useProxy => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qq-direct-e2e-'));
  const sessions = path.join(dir, 'sessions.json'), log = path.join(dir, 'diagnostics.jsonl');
  await writeFile(sessions, JSON.stringify([{ conversationKey: 'direct:1', chatType: 'direct', targetId: '1', lastActivityAt: new Date().toISOString(),
    contextTurns: [{ at: Date.now(), user: 'OLD', assistant: 'stream disconnected before completion: error sending request for url (https://private.invalid)' }] }]));
  let calls = 0;
  const api = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); expect(request.stream).toBe(false); expect(body).not.toContain('private.invalid');
    expect(body).not.toContain('SYNTHETIC_ANSWER'); // Default-off must hold at the actual HTTP boundary.
    calls++; if (calls === 1) res.end(JSON.stringify({ status: 'completed', output: [
      {type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'PROCESS_MUST_NOT_REACH_QQ'}]},
      { type: 'message', role: 'assistant', phase:'final_answer',content: [{ type: 'output_text', text: 'SYNTHETIC_ANSWER\n\n来源：\nhttps://example.org/body', annotations: [{type:'url_citation',url:'https://example.org/annotation'}] }] }] }));
    else if(calls===2) { res.statusCode = 401; res.end('{"error":"test failure body must not enter logs"}'); }
    else {
      const socket=res.socket!,partial=JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'UNTRUSTED_PARTIAL_ANSWER'}]}]});
      res.writeHead(200,{'content-length':Buffer.byteLength(partial)+32});res.end(partial);setTimeout(()=>socket.end(),5);
    }
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const a = api.address(); if (!a || typeof a === 'string') throw new Error('address');
  let basePort = a.port, proxyUrl: string | undefined;
  const tunnels = new Set<Duplex>(); let tunnelCount = 0;
  const proxy = createServer();
  if (useProxy) {
    const closed = createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening');
    basePort = (closed.address() as { port: number }).port;
    await new Promise<void>(resolve => closed.close(() => resolve()));
    proxy.on('connect', (req, client, head) => {
      tunnelCount++; expect(req.headers.authorization).toBeUndefined();
      const upstream = connect(a.port, '127.0.0.1');
      for (const socket of [client, upstream]) { tunnels.add(socket); socket.on('close', () => tunnels.delete(socket)); }
      client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  }
  const config = loadConfig({ AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high', DIRECT_API_BASE_URL: `http://127.0.0.1:${basePort}/v1`, QQ_CODEX_API_KEY: 'test-e2e-key',
    DIRECT_API_LOCAL_PROXY_URL: proxyUrl,
    CONTEXT_BOUNDED: 'true', SESSION_FILE_PATH: sessions, BOT_DIAGNOSTIC_LOG: log, BOT_HOST: '127.0.0.1', BOT_PORT: '0',
    ONEBOT_REVERSE_WS_HOST: '127.0.0.1', ONEBOT_REVERSE_WS_PORT: '0', ONEBOT_ALLOWED_USERS: '1', ONEBOT_PROGRESS_MODE: 'off', ACP_AGENT_COMMAND: '/missing/codex' });
  const app = new BotApplication(config, pino({ enabled: false })) as any;
  let socket: WebSocket | undefined;
  try {
    await app.start();
    const address = app.gateway.transport.server.address();
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/onebot/v11/ws`);
    await once(socket, 'open');
    const replies: any[] = [];
    let notify: (() => void) | undefined;
    socket.on('message', raw => {
      const action = JSON.parse(raw.toString());
      socket!.send(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0, data: { message_id: String(900 + replies.length) } }));
      if (action.action === 'send_private_msg') { replies.push(action.params.message); notify?.(); }
    });
    const sendAndWait = async (id: number): Promise<void> => {
      const reply = new Promise<void>(resolve => { notify = resolve; });
      socket!.send(JSON.stringify({ post_type: 'message', message_type: 'private', self_id: 999, user_id: 1, message_id: id,
        message: [{ type: 'text', data: { text: `SYNTHETIC_QUESTION_${id}` } }] }));
      await reply;
      // Wait for persistence/finalization after QQ acknowledged its send action.
      for (let n = 0; n < 100 && app.pendingAcceptedMessages; n++) await new Promise(r => setTimeout(r, 2));
      expect(app.pendingAcceptedMessages).toBe(0);
    };
    await sendAndWait(1); await sendAndWait(2);
    expect(calls).toBe(2); expect(JSON.stringify(replies[0])).toContain('SYNTHETIC_ANSWER');
    expect(JSON.stringify(replies[0])).not.toContain('https://example.org');
    expect(JSON.stringify(replies[0])).not.toContain('PROCESS_MUST_NOT_REACH_QQ');
    expect(JSON.stringify(replies[1])).toContain('鉴权'); expect(JSON.stringify(replies[1])).toContain('诊断编号');
    expect(app.getStatus().onebot.connected).toBe(true); expect(app.getStatus().ai.state).toBe('error');
    expect(app.getStatus().ai.lastFailure.stage).toBe('http_status');
    await sendAndWait(3);expect(calls).toBe(3);
    expect(JSON.stringify(replies[2])).toContain('诊断编号');expect(JSON.stringify(replies[2])).not.toContain('UNTRUSTED_PARTIAL_ANSWER');
    expect(app.getStatus().ai.lastFailure.code).toBe('RESPONSE_ABORTED');
    const state = app.conversations.getPersisted('direct:1'); expect(state.contextTurns).toHaveLength(1); expect(state.contextTurns[0].assistant).toBe('SYNTHETIC_ANSWER');
    if (useProxy) expect(tunnelCount).toBe(3);
  } finally {
    socket?.close(); await app.stop(); api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()));
    for (const tunnel of tunnels) tunnel.destroy();
    if (useProxy) await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
  const raw = await readFile(log, 'utf8');
  expect(raw).toContain('"stage":"qq_send"'); expect(raw).toContain('"stage":"context_store"'); expect(raw).toContain('HTTP_401');
  expect(raw).toContain('"stage":"qq_link"'); expect(raw).toContain('"stage":"service_shutdown"');
  expect(raw).not.toContain('SYNTHETIC_QUESTION'); expect(raw).not.toContain('test-e2e-key'); expect(raw).not.toContain('test failure body');
  expect(raw).toContain('response_integrity');expect(raw).not.toContain('UNTRUSTED_PARTIAL_ANSWER');
  if (useProxy) { expect(raw).toContain('route_fallback'); expect(raw).toContain('local_proxy'); expect(raw).not.toContain(proxyUrl!); }
});
