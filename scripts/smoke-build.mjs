import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await mkdtemp(path.join(tmpdir(), 'aite-echo-build-smoke-'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
const port = await freePort(), wsPort = await freePort();
let apiCalls = 0, qqActions = 0, socket, child;
const api = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body); assert.equal(request.stream, false); apiCalls++;
  res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text: 'BUILD_SMOKE_OK' }] }] }));
});
api.listen(0, '127.0.0.1'); await once(api, 'listening');
try {
  child = spawn(process.execPath, [path.join(root, 'dist/index.js')], { cwd: data, stdio: ['ignore', 'ignore', 'pipe'], env: {
    PATH: process.env.PATH, LOG_LEVEL: 'silent', AI_BACKEND: 'direct', CONTEXT_BOUNDED: 'true', DATA_DIR: data,
    SESSION_FILE_PATH: path.join(data, 'sessions.json'), DIRECT_API_BASE_URL: `http://127.0.0.1:${api.address().port}/v1`,
    QQ_CODEX_API_KEY: 'synthetic-smoke-only', BOT_HOST: '127.0.0.1', BOT_PORT: String(port), BOT_ADMIN_TOKEN: '',
    DIRECT_API_MODEL: 'synthetic-smoke-model', ONEBOT_ALLOW_PRIVATE: 'true', ONEBOT_ALLOW_GROUP: 'false',
    ONEBOT_MODE: 'reverse', ONEBOT_REVERSE_WS_HOST: '127.0.0.1', ONEBOT_REVERSE_WS_PORT: String(wsPort),
    ONEBOT_ACCESS_TOKEN: 'synthetic-onebot-smoke-token-731', ONEBOT_ALLOWED_USERS: '1', ONEBOT_OWNER_USERS: '1',
    ONEBOT_GROUP_CONFIG_FILE: '', ONEBOT_PROGRESS_MODE: 'off', ACP_VERBOSE_MODE: 'normal',
    BOT_VOICE_ENABLED: 'false', BOT_MENTION_JOURNAL_FILE: '', BOT_DIAGNOSTIC_LOG: '',
    ACP_AGENT_COMMAND: '/intentionally-missing/codex', HTTPS_PROXY: 'http://127.0.0.1:1',
  } });
  child.stderr.resume();
  let online = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(200) })).ok) { online = true; break; } } catch { /* startup */ }
    if (child.exitCode !== null) throw Error('BUILT_PROCESS_EXITED_EARLY'); await wait(50);
  }
  assert.ok(online, 'BUILT_PROCESS_NOT_HEALTHY');
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('FAKE_ONEBOT_REPLY_TIMEOUT')), 8000);
    socket = new WebSocket(`ws://127.0.0.1:${wsPort}/onebot/v11/ws`, { headers: { authorization: 'Bearer synthetic-onebot-smoke-token-731' } });
    socket.on('error', reject);
    socket.on('message', raw => {
      const action = JSON.parse(raw.toString()); qqActions++; assert.equal(action.action, 'send_private_msg');
      socket.send(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0, data: { message_id: 731 } }));
      clearTimeout(timer); resolve(action.params.message);
    });
  });
  await once(socket, 'open');
  socket.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 1, self_id: 999, message_id: 17,
    message: [{ type: 'text', data: { text: 'Synthetic build check.' } }] }));
  assert.match(JSON.stringify(await reply), /BUILD_SMOKE_OK/u);
  let completed = false;
  for (let i = 0; i < 40; i++) {
    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    if (!status.pendingAcceptedMessages) { assert.equal(status.build.appName, 'aite-echo'); completed = true; break; }
    await wait(20);
  }
  assert.ok(completed, 'BUILT_PROCESS_DID_NOT_FINISH_TURN');
  assert.equal(apiCalls, 1); assert.equal(qqActions, 1);
  console.log(JSON.stringify({ buildSmoke: 'passed', localApiRequests: apiCalls, fakeOneBotActions: qqActions, paidApiCalls: 0, realQqMessages: 0 }));
} finally {
  socket?.terminate();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM'); const killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await once(child, 'exit').catch(() => {}); clearTimeout(killTimer);
  }
  api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
}
