import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { loadDotEnv } from '../infra/env-file.js';

loadDotEnv();
const accessToken = process.env.E2E_ONEBOT_ACCESS_TOKEN || 'e2e-change-me';

async function allocatePort(preferred?: number): Promise<number> {
  if (Number.isFinite(preferred) && Number(preferred) > 0) {
    return Number(preferred);
  }

  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate ephemeral port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.once('error', reject);
  });
}

function bootBot(botPort: number, reverseWsPort: number): ReturnType<typeof spawn> {
  return spawn(process.execPath, ['node_modules/.bin/tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BOT_PORT: String(botPort),
      ONEBOT_MODE: 'reverse',
      ONEBOT_REVERSE_WS_PORT: String(reverseWsPort),
      ONEBOT_REVERSE_WS_PATH: '/onebot/v11/ws',
      ONEBOT_ACCESS_TOKEN: accessToken,
      ONEBOT_ALLOW_GROUP: 'false',
      ONEBOT_ALLOW_PRIVATE: 'true',
      ONEBOT_ALLOWED_USERS: '123456',
      ACP_AGENT_COMMAND: process.env.ACP_AGENT_COMMAND || 'traex',
      ACP_AGENT_ARGS_JSON: process.env.ACP_AGENT_ARGS_JSON || '["acp","serve"]',
      ACP_AGENT_WORKDIR: process.env.ACP_AGENT_WORKDIR || process.cwd(),
      ACP_VERBOSE_MODE: 'verbose',
      ACP_PERMISSION_STRATEGY: process.env.ACP_PERMISSION_STRATEGY || 'cancel',
      ACP_PROGRESS_THROTTLE_MS: '300',
      ACP_MAX_PROGRESS_UPDATES: '10',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForBotReady(botPort: number, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${botPort}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // ignore
    }
    await delay(250);
  }

  throw new Error(`bot did not become healthy within ${timeoutMs}ms`);
}

async function runClient(reverseWsPort: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${reverseWsPort}/onebot/v11/ws`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('timed out waiting for final OneBot reply'));
    }, 60_000);

    socket.once('open', () => {
      console.log('CLIENT_CONNECTED');
      socket.send(
        JSON.stringify({
          post_type: 'message',
          message_type: 'private',
          user_id: 123456,
          self_id: 999999,
          message_id: 1,
          raw_message: '请只回复 E2E_OK',
          message: '请只回复 E2E_OK',
          sender: { user_id: 123456, nickname: 'tester' },
          time: Math.floor(Date.now() / 1000),
        }),
      );
    });

    socket.on('message', (data) => {
      const payload = JSON.parse(data.toString()) as {
        action?: string;
        params?: { message?: unknown };
        echo?: string;
      };
      console.log('BOT_OUT', JSON.stringify(payload));

      if (payload.action) {
        socket.send(
          JSON.stringify({
            status: 'ok',
            retcode: 0,
            data: { message_id: Date.now() },
            echo: payload.echo,
          }),
        );
      }

      if (payload.action === 'send_private_msg' || payload.action === 'send_group_msg') {
        const message = payload.params?.message;
        const flattened = typeof message === 'string' ? message : JSON.stringify(message);
        if (flattened.includes('E2E_OK')) {
          clearTimeout(timer);
          socket.close();
          resolve();
        }
      }
    });

    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    socket.once('close', () => {
      clearTimeout(timer);
    });
  });
}

async function main(): Promise<void> {
  const botPort = await allocatePort(process.env.E2E_BOT_PORT ? Number(process.env.E2E_BOT_PORT) : undefined);
  const reverseWsPort = await allocatePort(
    process.env.E2E_ONEBOT_PORT ? Number(process.env.E2E_ONEBOT_PORT) : undefined,
  );
  const bot = bootBot(botPort, reverseWsPort);
  let stdout = '';
  let stderr = '';
  let cleanupError: Error | null = null;

  bot.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });
  bot.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  try {
    await waitForBotReady(botPort);
    await runClient(reverseWsPort);
    console.log('E2E_OK');
  } finally {
    bot.kill('SIGINT');
    await Promise.race([once(bot, 'exit'), delay(5_000)]);
    if (bot.exitCode && bot.exitCode !== 0 && bot.exitCode !== 130) {
      cleanupError = new Error(
        `bot exited with ${bot.exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
      );
    }
  }

  if (cleanupError) {
    throw cleanupError;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
