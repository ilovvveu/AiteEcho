import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { loadMessageTestConfig as loadConfig } from '../test-support/config.js';
import { BotApplication } from './app.js';

it.each(['missing-id', 'rejected'] as const)('does not mark a generated answer as delivered after a real fake-OneBot %s response', async mode => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qq-delivery-e2e-'));
  let calls = 0;
  const api = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    calls++;
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'SYNTHETIC_FINAL' }] }] }));
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const address = api.address(); if (!address || typeof address === 'string') throw Error('address');
  const c = loadConfig({ AI_BACKEND: 'direct', DIRECT_API_MODEL: 'synthetic-test-model', DIRECT_API_REASONING: 'high', DIRECT_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`, QQ_CODEX_API_KEY: 'test-only',
    CONTEXT_BOUNDED: 'true', SESSION_FILE_PATH: path.join(dir, 'sessions.json'), BOT_HOST: '127.0.0.1', BOT_PORT: '0',
    ONEBOT_REVERSE_WS_HOST: '127.0.0.1', ONEBOT_REVERSE_WS_PORT: '0', ONEBOT_ALLOWED_USERS: '1', ONEBOT_OWNER_USERS: '1',
    ONEBOT_ALLOW_GROUP: 'true', ONEBOT_ALLOWED_GROUPS: '100', ONEBOT_PROGRESS_MODE: 'off', BOT_MENTION_JOURNAL_FILE: path.join(dir, 'journal.jsonl') });
  const app = new BotApplication(c, pino({ enabled: false })) as any;
  let socket: WebSocket | undefined;
  const actions: any[] = [];
  try {
    await app.start();
    const wsAddress = app.gateway.transport.server.address();
    socket = new WebSocket(`ws://127.0.0.1:${wsAddress.port}/onebot/v11/ws`); await once(socket, 'open');
    socket.on('message', raw => {
      const action = JSON.parse(raw.toString()); actions.push(action);
      const response = actions.length > 1 ? { status: 'ok', retcode: 0, data: { message_id: 901 } }
        : mode === 'rejected' ? { status: 'failed', retcode: 200, wording: 'PRIVATE_UPSTREAM_FAILURE' } : { status: 'ok', retcode: 0, data: {} };
      socket!.send(JSON.stringify({ echo: action.echo, ...response }));
    });
    // Invoke the actual application; all outbound actions use a real local reverse WebSocket.
    await app.handleIncomingPayload({ post_type: 'message', message_type: 'group', self_id: 999, group_id: 100, user_id: 1,
      message_id: 10, sender: { card: 'TEST_MEMBER' }, message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: ' SYNTHETIC_QUESTION' } }] });
    const code = mode === 'rejected' ? 'ONEBOT_SEND_REJECTED' : 'ONEBOT_SEND_UNCONFIRMED';
    expect(calls).toBe(1); expect(actions).toHaveLength(mode === 'rejected' ? 2 : 1);
    const status = app.getStatus();
    expect(status.ai.state).toBe('ok'); // API success is independent of QQ delivery failure.
    expect(status.ai.lastFailure).toMatchObject({ stage: 'qq_send', code });
    expect(status.ai.recent).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'turn_complete', outcome: 'error' })]));
    expect(status.pendingAcceptedMessages).toBe(0);
    expect(app.conversations.getPersisted('group:100')?.contextTurns ?? []).toHaveLength(0);
    const journal = (await readFile(path.join(dir, 'journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(journal.filter((e: any) => e.kind === 'reply' && e.purpose === 'reply')).toEqual([
      expect.objectContaining({ text: 'SYNTHETIC_FINAL', delivery: mode === 'rejected' ? 'rejected' : 'unconfirmed', errorCode: code }),
    ]);
    expect(journal.at(-1)).toMatchObject({ kind: 'processing_result', result: 'failed', errorCode: code });
    expect(JSON.stringify(status)).not.toMatch(/SYNTHETIC_QUESTION|PRIVATE_UPSTREAM_FAILURE|test-only/);
  } finally {
    socket?.close(); await app.stop(); api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()));
  }
});
