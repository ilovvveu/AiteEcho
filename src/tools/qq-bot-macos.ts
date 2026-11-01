import { execFile as execFileCallback, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, openSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import QRCode from 'qrcode';
import { once } from 'node:events';
import { copyFile, realpath } from 'node:fs/promises';
import { assertHelperTokens, isManagedBotProcess, writePrivateHelperJson } from './macos-safety.js';
import { buildNapcatLoader } from './napcat-loader.js';
import { mergeDotEnvFiles } from '../infra/env-file.js';

const execFile = promisify(execFileCallback);

const DEFAULT_BOT_PORT = 8080;
const DEFAULT_ONEBOT_PORT = 16700;
const DEFAULT_WS_PATH = '/onebot/v11/ws';
const DEFAULT_ACCESS_TOKEN = '';
const DEFAULT_WEBUI_TOKEN = '';
const DEFAULT_GROUP_CONFIG = './examples/group-rules.local.json';
const DEFAULT_GROUP_CONFIG_FALLBACK = './examples/group-rules.example.json';
const DEFAULT_QQ_APP = '/Applications/QQ.app';
const DEFAULT_LOGIN_WAIT_SECONDS = 180;
const QQ_PROCESS_MATCHERS = [
  '/Applications/QQ.app/Contents/MacOS/QQ',
  'QQ Helper',
  'QQEXDOC',
];

type Command = 'status' | 'repair' | 'login' | 'up';

interface CliOptions {
  command: Command;
  qqApp?: string;
  quickAccount?: string;
  json: boolean;
  waitLogin: boolean;
  waitSeconds: number;
}

interface BotMacosConfig {
  env: NodeJS.ProcessEnv;
  adminToken?: string;
  qqApp: string;
  botPort: number;
  onebotPort: number;
  wsPath: string;
  accessToken: string;
  webuiToken: string;
  groupConfigFile: string;
}

interface DerivedPaths {
  repoRoot: string;
  qqResourcesDir: string;
  qqPackagePath: string;
  qqBackupPath: string;
  qqDocumentsDir: string;
  napcatShellDir: string;
  napcatLoaderPath: string;
  napcatConfigDir: string;
  webuiConfigPath: string;
  onebotConfigPath: string;
  napcatConfigPath: string;
  botLogPath: string;
  botPidPath: string;
}

function parseArgs(argv: string[]): CliOptions {
  const [commandArg, ...rest] = argv;
  const command = (commandArg ?? 'status') as Command;
  if (!['status', 'repair', 'login', 'up'].includes(command)) {
    throw new Error(`unknown command: ${commandArg ?? ''}`);
  }

  const options: CliOptions = {
    command,
    json: false,
    waitLogin: true,
    waitSeconds: DEFAULT_LOGIN_WAIT_SECONDS,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    switch (current) {
      case '--qq-app':
        options.qqApp = rest[++index] ?? options.qqApp;
        break;
      case '--quick-account':
        options.quickAccount = rest[++index] ?? options.quickAccount;
        break;
      case '--json':
        options.json = true;
        break;
      case '--no-wait':
        options.waitLogin = false;
        break;
      case '--wait-seconds': {
        const parsed = Number(rest[++index]);
        if (Number.isFinite(parsed) && parsed >= 0) {
          options.waitSeconds = parsed;
        }
        break;
      }
      default:
        throw new Error(`unknown argument: ${current}`);
    }
  }

  return options;
}

function repoRootOf(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

function resolveBotMacosConfig(repoRoot: string, options: CliOptions): BotMacosConfig {
  const env = mergeDotEnvFiles(
    [
      path.join(repoRoot, '.env'),
      path.join(repoRoot, '.env.local'),
    ],
    process.env,
  );

  const groupConfigFromEnv = env.ONEBOT_GROUP_CONFIG_FILE?.trim();
  const groupConfigFile = groupConfigFromEnv && groupConfigFromEnv.length > 0
    ? path.resolve(repoRoot, groupConfigFromEnv)
    : path.resolve(repoRoot, DEFAULT_GROUP_CONFIG);

  return {
    env, adminToken: env.BOT_ADMIN_TOKEN,
    qqApp: options.qqApp || env.QQ_APP_PATH || env.QQ_APP || DEFAULT_QQ_APP,
    botPort: Number(env.BOT_PORT || DEFAULT_BOT_PORT),
    onebotPort: Number(env.ONEBOT_REVERSE_WS_PORT || DEFAULT_ONEBOT_PORT),
    wsPath: env.ONEBOT_REVERSE_WS_PATH || DEFAULT_WS_PATH,
    accessToken: env.ONEBOT_ACCESS_TOKEN || DEFAULT_ACCESS_TOKEN,
    webuiToken: env.NAPCAT_WEBUI_TOKEN || env.WEBUI_TOKEN || DEFAULT_WEBUI_TOKEN,
    groupConfigFile,
  };
}

export function isQQProcessCommand(command: string): boolean {
  return command.startsWith('/Applications/QQ.app/Contents/') && QQ_PROCESS_MATCHERS.some((matcher) => command.includes(matcher));
}

export function isQQAlreadyPatched(packageJson: Record<string, unknown>, expectedMain: string): boolean {
  return packageJson.main === expectedMain;
}

function derivePaths(repoRoot: string, qqApp: string): DerivedPaths {
  const home = os.homedir();
  const qqResourcesDir = path.join(qqApp, 'Contents', 'Resources', 'app');
  const qqPackagePath = path.join(qqResourcesDir, 'package.json');
  const qqDocumentsDir = path.join(home, 'Library', 'Containers', 'com.tencent.qq', 'Data', 'Documents');
  const napcatShellDir = path.join(qqDocumentsDir, 'napcat');
  const napcatLoaderPath = path.join(qqDocumentsDir, 'loadNapCat.js');
  const napcatConfigDir = path.join(
    home,
    'Library',
    'Containers',
    'com.tencent.qq',
    'Data',
    'Library',
    'Application Support',
    'QQ',
    'NapCat',
    'config',
  );

  return {
    repoRoot,
    qqResourcesDir,
    qqPackagePath,
    qqBackupPath: `${qqPackagePath}.qq-ai-bot.bak`,
    qqDocumentsDir,
    napcatShellDir,
    napcatLoaderPath,
    napcatConfigDir,
    webuiConfigPath: path.join(napcatConfigDir, 'webui.json'),
    onebotConfigPath: path.join(napcatConfigDir, 'onebot11.json'),
    napcatConfigPath: path.join(napcatConfigDir, 'napcat.json'),
    botLogPath: path.join(repoRoot, 'run-logs', 'bot.log'),
    botPidPath: path.join(repoRoot, 'run-logs', 'bot.pid'),
  };
}

async function ensureGroupConfigFile(repoRoot: string, targetPath: string): Promise<void> {
  if (existsSync(targetPath)) {
    return;
  }
  const fallback = path.resolve(repoRoot, DEFAULT_GROUP_CONFIG_FALLBACK);
  await mkdir(path.dirname(targetPath), { recursive: true });
  const source = existsSync(fallback) ? fallback : path.resolve(repoRoot, DEFAULT_GROUP_CONFIG);
  const content = await readFile(source, 'utf8');
  await writeFile(targetPath, content, 'utf8');
}

async function readJson(target: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(target)) {
    return undefined;
  }
  return JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
}

async function writeJson(target: string, data: Record<string, unknown>): Promise<void> {
  await writePrivateHelperJson(target, data);
}

async function ensureNapcatPatched(
  paths: DerivedPaths,
  config: BotMacosConfig,
  quickAccount?: string,
  forceQrLogin = false,
): Promise<void> {
  if (!existsSync(path.join(paths.napcatShellDir, 'napcat.mjs'))) {
    throw new Error(`NapCat shell is missing at ${paths.napcatShellDir}. Run: npm run setup:napcat:macos`);
  }

  const packageJson = (await readJson(paths.qqPackagePath)) ?? {};
  const expectedMain = path.relative(paths.qqResourcesDir, paths.napcatLoaderPath).split(path.sep).join(path.posix.sep);
  if (!isQQAlreadyPatched(packageJson, expectedMain)) {
    if (!existsSync(paths.qqBackupPath)) await copyFile(paths.qqPackagePath, paths.qqBackupPath);
    packageJson.main = expectedMain;
    try {
      await writeFileWithRetry(paths.qqPackagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        throw new Error(
          [
            `macOS blocked writing ${paths.qqPackagePath}.`,
            'Grant your terminal Full Disk Access, or run the one-time patch command from a trusted terminal:',
            '  npm run setup:napcat:macos',
            'After QQ has been patched once, bot:macos repair/up will not rewrite the app bundle.',
          ].join('\n'),
          { cause: error },
        );
      }
      throw error;
    }
  }

  await writeFile(
    paths.napcatLoaderPath,
    buildNapcatLoader(
      {
        qqPackagePath: paths.qqPackagePath,
        qqResourcesDir: paths.qqResourcesDir,
        napcatShellDir: paths.napcatShellDir,
      },
      { quickAccount: forceQrLogin ? undefined : quickAccount },
    ),
    'utf8',
  );

  await writeJson(paths.webuiConfigPath, {
    host: '127.0.0.1',
    port: 6099,
    prefix: '',
    token: config.webuiToken,
    loginRate: 3,
    accessControlMode: 'none',
    ipWhitelist: [],
    ipBlacklist: [],
    enableXForwardedFor: false,
  });
  await writeJson(paths.onebotConfigPath, {
    network: {
      httpServers: [],
      httpSseServers: [],
      httpClients: [],
      websocketServers: [],
      websocketClients: [
        {
          enable: true,
          name: 'qq-ai-bot-reverse-ws',
          url: `ws://127.0.0.1:${config.onebotPort}${config.wsPath}`,
          messagePostFormat: 'array',
          reportSelfMessage: false,
          reconnectInterval: 2000,
          token: config.accessToken,
          debug: false,
          heartInterval: 30000,
          verifyCertificate: true,
        },
      ],
      plugins: [],
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false,
    imageDownloadProxy: '',
    timeout: {
      baseTimeout: 10000,
      uploadSpeedKBps: 256,
      downloadSpeedKBps: 256,
      maxTimeout: 1800000,
    },
  });
  await writeJson(paths.napcatConfigPath, {
    fileLog: false,
    consoleLog: true,
    fileLogLevel: 'debug',
    consoleLogLevel: 'info',
    packetBackend: 'auto',
    packetServer: '',
    o3HookMode: 1,
    bypass: {
      hook: false,
      window: false,
      module: false,
      process: false,
      container: false,
      js: false,
    },
  });
}

async function writeFileWithRetry(target: string, content: string, attempts = 8): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await writeFile(target, content, 'utf8');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

async function listQQProcessIds(): Promise<number[]> {
  try {
    const { stdout } = await execFile('ps', ['ax', '-o', 'pid=,command=']);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) {
          return [];
        }
        const pid = Number(match[1]);
        const command = match[2];
        if (!Number.isFinite(pid) || !isQQProcessCommand(command)) {
          return [];
        }
        return [pid];
      });
  } catch {
    return [];
  }
}

async function stopQQ(): Promise<void> {
  await execFile('osascript', ['-e', 'tell application "QQ" to quit']).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const pids = await listQQProcessIds();
    if (pids.length === 0) {
      return;
    }
    for (const pid of pids) {
      try {
        process.kill(pid, attempt < 10 ? 'SIGTERM' : 'SIGKILL');
      } catch {
        // ignore already exited process
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function launchQQ(qqApp: string): Promise<void> {
  const child = spawn('open', ['-na', qqApp, '--args', '--no-sandbox'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function stopBot(paths: DerivedPaths): Promise<void> {
  if (!existsSync(paths.botPidPath)) return;
  const pidText = (await readFile(paths.botPidPath, 'utf8')).trim();
  if (!/^[1-9]\d*$/u.test(pidText) || !Number.isSafeInteger(Number(pidText)) || Number(pidText) <= 1) throw new Error('Invalid managed bot PID; refusing to stop any process');
  const pid = Number(pidText);
  let command: string, cwd: string;
  try {
    command = (await execFile('ps', ['-p', pidText, '-o', 'command='])).stdout.trim();
    const output = (await execFile('lsof', ['-a', '-p', pidText, '-d', 'cwd', '-Fn'])).stdout;
    const directory = output.split('\n').find(line => line.startsWith('n'))?.slice(1);
    if (!directory) throw new Error('Missing process working directory');
    cwd = await realpath(directory);
  } catch {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; }
    throw new Error('Could not prove bot process ownership; no process was stopped');
  }
  if (!isManagedBotProcess(pidText, command, cwd, await realpath(paths.repoRoot))) throw new Error('PID belongs to another process; no process was stopped');
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 60; i++) {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Managed bot did not stop; refusing to launch a duplicate');
}

async function startBot(paths: DerivedPaths, config: BotMacosConfig): Promise<void> {
  if (!existsSync(path.join(paths.repoRoot, 'dist', 'index.js'))) {
    throw new Error(
      [
        'dist/index.js is missing.',
        'Run `npm run build` before using `npm run bot:macos -- up` or `npm run bot:macos -- repair`.',
        'For the standard source-mode quickstart, use `npm run dev` instead.',
      ].join('\n'),
    );
  }
  await mkdir(path.dirname(paths.botLogPath), { recursive: true });
  const logFd = openSync(paths.botLogPath, 'a', 0o600);
  const child = spawn(process.execPath, [path.join(paths.repoRoot, 'dist/index.js')], {
    cwd: paths.repoRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...config.env },
  });
  closeSync(logFd);
  await once(child, 'spawn');
  child.unref();
  await writeFile(paths.botPidPath, `${child.pid}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function fetchJson(url: string, token?: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000), headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function napcatCredential(config: BotMacosConfig): Promise<string | null> {
  try {
    const hashed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${config.webuiToken}.napcat`));
    const hash = Buffer.from(hashed).toString('hex');
    const response = await fetch('http://127.0.0.1:6099/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { data?: { Credential?: string } };
    return body.data?.Credential ?? null;
  } catch {
    return null;
  }
}

async function fetchNapcatStatus(config: BotMacosConfig): Promise<Record<string, unknown> | null> {
  const credential = await napcatCredential(config);
  if (!credential) {
    return null;
  }
  try {
    const response = await fetch('http://127.0.0.1:6099/api/QQLogin/CheckLoginStatus', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function fetchNapcatLoginInfo(config: BotMacosConfig): Promise<Record<string, unknown> | null> {
  const credential = await napcatCredential(config);
  if (!credential) {
    return null;
  }
  try {
    const response = await fetch('http://127.0.0.1:6099/api/QQLogin/GetQQLoginInfo', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function waitForNapcatWebUi(seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch('http://127.0.0.1:6099/webui', {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}


async function ensureNapcatReadyForLogin(paths: DerivedPaths, config: BotMacosConfig): Promise<void> {
  if (await waitForNapcatWebUi(2)) {
    return;
  }

  await stopQQ();
  await ensureNapcatPatched(paths, config, undefined, true);
  await launchQQ(config.qqApp);
  await waitForNapcatWebUi(30);
}

async function restartNapcatForQrLogin(paths: DerivedPaths, config: BotMacosConfig): Promise<void> {
  await stopQQ();
  await ensureNapcatPatched(paths, config, undefined, true);
  await launchQQ(config.qqApp);
  await waitForNapcatWebUi(30);
}

async function refreshQrCode(config: BotMacosConfig): Promise<string | null> {
  const credential = await napcatCredential(config);
  if (!credential) {
    return null;
  }
  const headers = {
    authorization: `Bearer ${credential}`,
    'content-type': 'application/json',
  };
  try {
    await fetch('http://127.0.0.1:6099/api/QQLogin/SetQuickLoginQQ', {
      method: 'POST',
      headers,
      body: JSON.stringify({ uin: '' }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);

    await fetch('http://127.0.0.1:6099/api/QQLogin/RefreshQRcode', {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (attempt > 0) {
        await fetch('http://127.0.0.1:6099/api/QQLogin/RefreshQRcode', {
          method: 'POST',
          headers,
          body: '{}',
          signal: AbortSignal.timeout(3000),
        }).catch(() => undefined);
      }

      const response = await fetch('http://127.0.0.1:6099/api/QQLogin/GetQQLoginQrcode', {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      if (response?.ok) {
        const body = (await response.json()) as { data?: { qrcode?: string } };
        const qr = body.data?.qrcode;
        if (qr) {
          return qr;
        }
      }

      const status = await fetchNapcatStatus(config);
      const qrFromStatus = (status?.data as { qrcodeurl?: string } | undefined)?.qrcodeurl;
      if (qrFromStatus) {
        return qrFromStatus;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch {
    return null;
  }
  return null;
}

async function writeQrPng(repoRoot: string, qr: string): Promise<string> {
  const outputPath = path.join(repoRoot, 'run-logs', 'qq-login-qr.png');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await QRCode.toFile(outputPath, qr);
  return outputPath;
}

async function renderTerminalQr(qr: string): Promise<string> {
  return QRCode.toString(qr, {
    type: 'terminal',
    small: true,
  });
}

async function waitForLogin(config: BotMacosConfig, seconds: number): Promise<{
  loginStatus: Record<string, unknown> | null;
  loginInfo: Record<string, unknown> | null;
}> {
  const deadline = Date.now() + seconds * 1000;
  let loginStatus: Record<string, unknown> | null = null;
  let loginInfo: Record<string, unknown> | null = null;

  while (Date.now() <= deadline) {
    loginStatus = await fetchNapcatStatus(config);
    loginInfo = await fetchNapcatLoginInfo(config);
    const isLogin = (loginStatus?.data as { isLogin?: boolean } | undefined)?.isLogin === true;
    if (isLogin) {
      return { loginStatus, loginInfo };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return { loginStatus, loginInfo };
}

function printHumanStatus(botStatus: Record<string, unknown> | null, napcatStatus: Record<string, unknown> | null): void {
  const onebot = botStatus?.onebot as { connected?: boolean } | undefined;
  const napcat = napcatStatus?.data as { isLogin?: boolean; loginError?: string } | undefined;
  console.log(`bot: ${botStatus?.ok ? 'ok' : 'unreachable'}`);
  console.log(`onebot: ${onebot?.connected ? 'connected' : 'disconnected'}`);
  console.log(`napcat login: ${napcat?.isLogin ? 'logged in' : 'not logged in'}`);
  if (napcat?.loginError) {
    console.log(`napcat login error: ${napcat.loginError}`);
  }
}

async function commandStatus(config: BotMacosConfig, options: CliOptions): Promise<void> {
  const botStatus = await fetchJson(`http://127.0.0.1:${config.botPort}/status`, config.adminToken);
  const napcatStatus = await fetchNapcatStatus(config);
  if (options.json) {
    console.log(JSON.stringify({ botStatus, napcatStatus }, null, 2));
    return;
  }
  printHumanStatus(botStatus, napcatStatus);
}

async function commandRepair(paths: DerivedPaths, config: BotMacosConfig, options: CliOptions): Promise<void> {
  await stopQQ();
  await ensureGroupConfigFile(paths.repoRoot, config.groupConfigFile);
  await ensureNapcatPatched(paths, config, options.quickAccount);
  await stopBot(paths);
  await startBot(paths, config);
  if (options.json) {
    console.log(JSON.stringify({ ok: true, repaired: true }, null, 2));
    return;
  }
  console.log('repair complete: bot restarted and NapCat config refreshed.');
}

async function commandLogin(paths: DerivedPaths, config: BotMacosConfig, options: CliOptions): Promise<void> {
  await ensureNapcatReadyForLogin(paths, config);

  const loginStatus = await fetchNapcatStatus(config);
  const loginInfo = await fetchNapcatLoginInfo(config);
  const isLogin = (loginStatus?.data as { isLogin?: boolean } | undefined)?.isLogin === true;
  if (isLogin) {
    if (options.json) {
      console.log(JSON.stringify({ ok: true, alreadyLoggedIn: true, loginStatus, loginInfo }, null, 2));
      return;
    }
    const info = loginInfo?.data as { uin?: string; nick?: string } | undefined;
    console.log(`already logged in: ${info?.uin || 'unknown'} ${info?.nick || ''}`.trim());
    return;
  }

  let qr = await refreshQrCode(config);
  if (!qr) {
    await restartNapcatForQrLogin(paths, config);
    qr = await refreshQrCode(config);
  }
  if (!qr) {
    throw new Error('failed to get login qrcode after starting NapCat. Try `npm run bot:macos -- up` and rerun login.');
  }
  const qrcodePng = await writeQrPng(paths.repoRoot, qr);

  if (options.json) {
    console.log(JSON.stringify({ ok: true, alreadyLoggedIn: false, qrcodeUrl: qr, qrcodePng }, null, 2));
  } else {
    console.log('Scan this QR code with the QQ account you want the bot to use:\n');
    console.log(await renderTerminalQr(qr));
    console.log(`QR URL: ${qr}`);
    console.log(`QR PNG: ${qrcodePng}`);
  }

  if (!options.waitLogin) {
    return;
  }

  if (!options.json) {
    console.log(`Waiting up to ${options.waitSeconds}s for login...`);
  }
  const result = await waitForLogin(config, options.waitSeconds);
  const loggedIn = (result.loginStatus?.data as { isLogin?: boolean } | undefined)?.isLogin === true;
  if (options.json) {
    console.log(JSON.stringify({ ok: loggedIn, loginStatus: result.loginStatus, loginInfo: result.loginInfo }, null, 2));
    return;
  }
  if (loggedIn) {
    const info = result.loginInfo?.data as { uin?: string; nick?: string } | undefined;
    console.log(`login complete: ${info?.uin || 'unknown'} ${info?.nick || ''}`.trim());
  } else {
    console.log('login not completed before timeout; rerun `npm run bot:macos -- login` to refresh the QR code.');
  }
}

async function commandUp(paths: DerivedPaths, config: BotMacosConfig, options: CliOptions): Promise<void> {
  await stopQQ();
  await ensureGroupConfigFile(paths.repoRoot, config.groupConfigFile);
  await ensureNapcatPatched(paths, config, options.quickAccount);
  await stopBot(paths);
  await startBot(paths, config);
  await launchQQ(config.qqApp);
  await new Promise((resolve) => setTimeout(resolve, 10_000));

  let botStatus = await fetchJson(`http://127.0.0.1:${config.botPort}/status`, config.adminToken);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const connected = ((botStatus?.onebot as { connected?: boolean } | undefined)?.connected ?? false) === true;
    if (connected) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    botStatus = await fetchJson(`http://127.0.0.1:${config.botPort}/status`, config.adminToken);
  }

  const napcatStatus = await fetchNapcatStatus(config);
  const qr = napcatStatus && ((napcatStatus.data as { qrcodeurl?: string } | undefined)?.qrcodeurl as string | undefined);
  const loginInfo = await fetchNapcatLoginInfo(config);

  if (options.json) {
    console.log(JSON.stringify({ ok: true, botStatus, napcatStatus, loginInfo, qrcodeUrl: qr || null }, null, 2));
    return;
  }

  printHumanStatus(botStatus, napcatStatus);
  const isLogin = (napcatStatus?.data as { isLogin?: boolean } | undefined)?.isLogin === true;
  if (!isLogin && qr) {
    const qrcodePng = await writeQrPng(paths.repoRoot, qr);
    console.log('\nQQ is not logged in. Scan this QR code:\n');
    console.log(await renderTerminalQr(qr));
    console.log(`QR URL: ${qr}`);
    console.log(`QR PNG: ${qrcodePng}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = repoRootOf();
  const config = resolveBotMacosConfig(repoRoot, options);
  const paths = derivePaths(repoRoot, config.qqApp);
  if (options.command !== 'status') {
    assertHelperTokens(config.accessToken, config.webuiToken);
    if (config.env.ONEBOT_MODE && config.env.ONEBOT_MODE !== 'reverse') throw new Error('This helper only manages reverse OneBot mode');
  }

  switch (options.command) {
    case 'status':
      await commandStatus(config, options);
      return;
    case 'repair':
      await commandRepair(paths, config, options);
      return;
    case 'login':
      await commandLogin(paths, config, options);
      return;
    case 'up':
      await commandUp(paths, config, options);
      return;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error);
  process.exit(1);
});
