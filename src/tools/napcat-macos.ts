import { spawn, execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  copyFile,
  rename,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildNapcatLoader } from './napcat-loader.js';
import { assertHelperTokens, assertHelperWsUrl, redactHelperConfig, writePrivateHelperJson } from './macos-safety.js';
import { mergeDotEnvFiles } from '../infra/env-file.js';

const execFile = promisify(execFileCallback);

const DEFAULT_WS_URL = 'ws://127.0.0.1:16700/onebot/v11/ws';
const DEFAULT_ONEBOT_TOKEN = '';
const DEFAULT_WEBUI_TOKEN = '';
const DEFAULT_QQ_APP = '/Applications/QQ.app';
const NAPCAT_SHELL_URL = 'https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip';
const BACKUP_SUFFIX = '.qq-ai-bot.bak';
const QQ_PROCESS_MATCHERS = [
  '/Applications/QQ.app/Contents/MacOS/QQ',
  'QQ Helper',
  'QQEXDOC',
];

type Command = 'status' | 'install' | 'launch' | 'restore';

interface CliOptions {
  command: Command;
  wsUrl: string;
  onebotToken: string;
  webuiToken: string;
  qqApp: string;
  force: boolean;
  restart: boolean;
}

interface DerivedPaths {
  qqApp: string;
  qqResourcesDir: string;
  qqPackagePath: string;
  qqBackupPath: string;
  qqDocumentsDir: string;
  napcatShellDir: string;
  napcatLoaderPath: string;
  napcatWorkdir: string;
  napcatConfigDir: string;
  webuiConfigPath: string;
  onebotConfigPath: string;
  napcatConfigPath: string;
  patchedMain: string;
}

function repoRootOf(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

function buildDefaultWsUrl(env: NodeJS.ProcessEnv): string {
  const port = env.ONEBOT_REVERSE_WS_PORT || '16700';
  const wsPath = env.ONEBOT_REVERSE_WS_PATH || '/onebot/v11/ws';
  return `ws://127.0.0.1:${port}${wsPath}`;
}

function applyEnvDefaults(options: CliOptions, repoRoot: string): CliOptions {
  const env = mergeDotEnvFiles(
    [
      path.join(repoRoot, '.env'),
      path.join(repoRoot, '.env.local'),
    ],
    process.env,
  );

  return {
    ...options,
    wsUrl: options.wsUrl === DEFAULT_WS_URL ? buildDefaultWsUrl(env) : options.wsUrl,
    onebotToken: options.onebotToken === DEFAULT_ONEBOT_TOKEN ? env.ONEBOT_ACCESS_TOKEN || DEFAULT_ONEBOT_TOKEN : options.onebotToken,
    webuiToken:
      options.webuiToken === DEFAULT_WEBUI_TOKEN
        ? env.NAPCAT_WEBUI_TOKEN || env.WEBUI_TOKEN || DEFAULT_WEBUI_TOKEN
        : options.webuiToken,
    qqApp:
      options.qqApp === DEFAULT_QQ_APP
        ? env.QQ_APP_PATH || env.QQ_APP || DEFAULT_QQ_APP
        : options.qqApp,
  };
}

function parseArgs(argv: string[]): CliOptions {
  const [commandArg, ...rest] = argv;
  const command = (commandArg ?? 'status') as Command;
  if (!['status', 'install', 'launch', 'restore'].includes(command)) {
    throw new Error(`unknown command: ${commandArg ?? ''}`);
  }

  const options: CliOptions = {
    command,
    wsUrl: DEFAULT_WS_URL,
    onebotToken: DEFAULT_ONEBOT_TOKEN,
    webuiToken: DEFAULT_WEBUI_TOKEN,
    qqApp: DEFAULT_QQ_APP,
    force: false,
    restart: false,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    switch (current) {
      case '--ws-url':
        options.wsUrl = rest[++index] ?? options.wsUrl;
        break;
      case '--token':
        options.onebotToken = rest[++index] ?? options.onebotToken;
        break;
      case '--webui-token':
        options.webuiToken = rest[++index] ?? options.webuiToken;
        break;
      case '--qq-app':
        options.qqApp = rest[++index] ?? options.qqApp;
        break;
      case '--force':
        options.force = true;
        break;
      case '--restart':
        options.restart = true;
        break;
      default:
        throw new Error(`unknown argument: ${current}`);
    }
  }

  return options;
}

function derivePaths(qqApp: string): DerivedPaths {
  const home = os.homedir();
  const qqResourcesDir = path.join(qqApp, 'Contents', 'Resources', 'app');
  const qqPackagePath = path.join(qqResourcesDir, 'package.json');
  const qqDocumentsDir = path.join(home, 'Library', 'Containers', 'com.tencent.qq', 'Data', 'Documents');
  const napcatShellDir = path.join(qqDocumentsDir, 'napcat');
  const napcatLoaderPath = path.join(qqDocumentsDir, 'loadNapCat.js');
  const napcatWorkdir = path.join(
    home,
    'Library',
    'Containers',
    'com.tencent.qq',
    'Data',
    'Library',
    'Application Support',
    'QQ',
    'NapCat',
  );
  const napcatConfigDir = path.join(napcatWorkdir, 'config');
  const patchedMain = path.relative(qqResourcesDir, napcatLoaderPath).split(path.sep).join(path.posix.sep);

  return {
    qqApp,
    qqResourcesDir,
    qqPackagePath,
    qqBackupPath: `${qqPackagePath}${BACKUP_SUFFIX}`,
    qqDocumentsDir,
    napcatShellDir,
    napcatLoaderPath,
    napcatWorkdir,
    napcatConfigDir,
    webuiConfigPath: path.join(napcatConfigDir, 'webui.json'),
    onebotConfigPath: path.join(napcatConfigDir, 'onebot11.json'),
    napcatConfigPath: path.join(napcatConfigDir, 'napcat.json'),
    patchedMain,
  };
}

function log(message: string, extra?: unknown): void {
  if (extra === undefined) {
    console.log(`[napcat-macos] ${message}`);
    return;
  }
  console.log(`[napcat-macos] ${message}`, extra);
}

async function fileExists(target: string): Promise<boolean> {
  return existsSync(target);
}

async function ensureParentDir(target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
}

async function backupFileIfNeeded(target: string, backup: string, force: boolean): Promise<void> {
  if (await fileExists(target)) {
    if (!(await fileExists(backup)) || force) {
      await ensureParentDir(backup);
      await copyFile(target, backup);
    }
  }
}

async function readJson(target: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
}

function buildLoader(paths: DerivedPaths): string {
  return buildNapcatLoader({
    qqPackagePath: paths.qqPackagePath,
    qqResourcesDir: paths.qqResourcesDir,
    napcatShellDir: paths.napcatShellDir,
  });
}

export function isQQProcessCommand(command: string): boolean {
  return command.startsWith('/Applications/QQ.app/Contents/') && QQ_PROCESS_MATCHERS.some((matcher) => command.includes(matcher));
}

export function isQQAlreadyPatched(packageJson: Record<string, unknown>, expectedMain: string): boolean {
  return packageJson.main === expectedMain;
}

function buildWebUiConfig(token: string): Record<string, unknown> {
  return {
    host: '127.0.0.1',
    port: 6099,
    prefix: '',
    token,
    loginRate: 3,
    accessControlMode: 'none',
    ipWhitelist: [],
    ipBlacklist: [],
    enableXForwardedFor: false,
  };
}

function buildOneBotConfig(wsUrl: string, token: string): Record<string, unknown> {
  return {
    network: {
      httpServers: [],
      httpSseServers: [],
      httpClients: [],
      websocketServers: [],
      websocketClients: [
        {
          enable: true,
          name: 'qq-ai-bot-reverse-ws',
          url: wsUrl,
          messagePostFormat: 'array',
          reportSelfMessage: false,
          reconnectInterval: 2000,
          token,
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
  };
}

function buildNapcatConfig(): Record<string, unknown> {
  return {
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
  };
}

async function writeJson(target: string, data: Record<string, unknown>): Promise<void> {
  await writePrivateHelperJson(target, data);
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

async function downloadLatestShell(paths: DerivedPaths): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'napcat-shell-'));
  const zipPath = path.join(tempDir, 'NapCat.Shell.zip');
  const extractDir = path.join(tempDir, 'extract');

  try {
    log('downloading latest NapCat shell');
    const response = await fetch(NAPCAT_SHELL_URL, {
      headers: {
        'user-agent': 'qq-ai-bot/0.1.3',
      },
    });

    if (!response.ok) {
      throw new Error(`failed to download NapCat shell: ${response.status} ${response.statusText}`);
    }

    const body = Buffer.from(await response.arrayBuffer());
    await writeFile(zipPath, body);
    await mkdir(extractDir, { recursive: true });
    await execFile('unzip', ['-q', '-o', zipPath, '-d', extractDir]);

    const entries = await readdir(extractDir);
    if (!(await fileExists(path.join(extractDir, 'napcat.mjs')))) throw new Error('Downloaded shell does not contain napcat.mjs; existing shell was not changed');
    if (await fileExists(paths.napcatShellDir)) await rename(paths.napcatShellDir, `${paths.napcatShellDir}.backup-${Date.now()}`);
    await mkdir(paths.napcatShellDir, { recursive: true });

    for (const entry of entries) {
      await cp(path.join(extractDir, entry), path.join(paths.napcatShellDir, entry), {
        recursive: true,
      });
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function install(options: CliOptions): Promise<void> {
  assertHelperTokens(options.onebotToken, options.webuiToken);
  assertHelperWsUrl(options.wsUrl);
  const paths = derivePaths(options.qqApp);
  if (!(await fileExists(paths.qqPackagePath))) {
    throw new Error(`QQ package.json not found: ${paths.qqPackagePath}`);
  }

  if (await isQQRunning()) {
    await stopQQ();
  }

  await downloadLatestShell(paths);
  await mkdir(paths.qqDocumentsDir, { recursive: true });
  await mkdir(paths.napcatConfigDir, { recursive: true });

  await backupFileIfNeeded(paths.qqPackagePath, paths.qqBackupPath, options.force);

  const packageJson = await readJson(paths.qqPackagePath);
  if (!isQQAlreadyPatched(packageJson, paths.patchedMain)) {
    packageJson.main = paths.patchedMain;
    try {
      await writeFileWithRetry(paths.qqPackagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        throw new Error(
          [
            `macOS blocked writing ${paths.qqPackagePath}.`,
            'Close QQ completely and grant Terminal/Codex Full Disk Access, then rerun setup.',
          ].join('\n'),
          { cause: error },
        );
      }
      throw error;
    }
  }
  await writeFile(paths.napcatLoaderPath, buildLoader(paths), 'utf8');

  if (options.force) {
    await backupFileIfNeeded(paths.onebotConfigPath, `${paths.onebotConfigPath}${BACKUP_SUFFIX}`, true);
    await backupFileIfNeeded(paths.webuiConfigPath, `${paths.webuiConfigPath}${BACKUP_SUFFIX}`, true);
    await backupFileIfNeeded(paths.napcatConfigPath, `${paths.napcatConfigPath}${BACKUP_SUFFIX}`, true);
  }

  await writeJson(paths.webuiConfigPath, buildWebUiConfig(options.webuiToken));
  await writeJson(paths.onebotConfigPath, buildOneBotConfig(options.wsUrl, options.onebotToken));
  await writeJson(paths.napcatConfigPath, buildNapcatConfig());

  log('installation completed', {
    qqPackagePath: paths.qqPackagePath,
    backupPath: paths.qqBackupPath,
    loaderPath: paths.napcatLoaderPath,
    shellDir: paths.napcatShellDir,
    configDir: paths.napcatConfigDir,
    reverseWsUrl: options.wsUrl,
  });
}

async function isQQRunning(): Promise<boolean> {
  return (await listQQProcessIds()).length > 0;
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
  try {
    await execFile('osascript', ['-e', 'tell application "QQ" to quit']);
  } catch {
    // ignore
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!(await isQQRunning())) {
      return;
    }
    for (const pid of await listQQProcessIds()) {
      try { process.kill(pid, attempt < 10 ? 'SIGTERM' : 'SIGKILL'); } catch { /* already exited */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (await isQQRunning()) throw new Error('QQ did not stop; no app files were changed');
}

async function launch(options: CliOptions): Promise<void> {
  const paths = derivePaths(options.qqApp);
  const packageJson = await readJson(paths.qqPackagePath);
  if (packageJson.main !== paths.patchedMain) {
    throw new Error(`QQ is not patched for NapCat yet. Expected main=${paths.patchedMain}`);
  }
  if (!(await fileExists(path.join(paths.napcatShellDir, 'napcat.mjs')))) {
    throw new Error(`NapCat shell is missing at ${paths.napcatShellDir}`);
  }

  if (await isQQRunning()) {
    if (!options.restart) {
      throw new Error('QQ is currently running. Re-run with --restart or close QQ first.');
    }
    await stopQQ();
  }

  const child = spawn('open', ['-na', options.qqApp, '--args', '--no-sandbox'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  log('launched QQ in NapCat mode');
}

async function restore(options: CliOptions): Promise<void> {
  const paths = derivePaths(options.qqApp);
  if (!(await fileExists(paths.qqBackupPath))) {
    throw new Error(`backup file not found: ${paths.qqBackupPath}`);
  }
  if (await isQQRunning() && options.restart) {
    await stopQQ();
  }
  await copyFile(paths.qqBackupPath, paths.qqPackagePath);
  log('restored QQ package.json from backup', { backupPath: paths.qqBackupPath });
}

async function status(options: CliOptions): Promise<void> {
  const paths = derivePaths(options.qqApp);
  const qqPackageExists = await fileExists(paths.qqPackagePath);
  const shellEntryExists = await fileExists(path.join(paths.napcatShellDir, 'napcat.mjs'));
  const webuiConfigExists = await fileExists(paths.webuiConfigPath);
  const onebotConfigExists = await fileExists(paths.onebotConfigPath);
  const qqRunning = await isQQRunning();

  let packageJson: Record<string, unknown> | undefined;
  if (qqPackageExists) {
    packageJson = await readJson(paths.qqPackagePath);
  }

  let onebotConfig: Record<string, unknown> | undefined;
  if (onebotConfigExists) {
    onebotConfig = await readJson(paths.onebotConfigPath);
  }

  let webuiConfig: Record<string, unknown> | undefined;
  if (webuiConfigExists) {
    webuiConfig = await readJson(paths.webuiConfigPath);
  }

  console.log(
    JSON.stringify(
      {
        qqApp: options.qqApp,
        qqRunning,
        qqPackageExists,
        shellEntryExists,
        webuiConfigExists,
        onebotConfigExists,
        patched: packageJson?.main === paths.patchedMain,
        currentMain: packageJson?.main,
        expectedMain: paths.patchedMain,
        reverseWsClients:
          redactHelperConfig((onebotConfig?.network as { websocketClients?: unknown[] } | undefined)?.websocketClients ?? []),
        webui: redactHelperConfig(webuiConfig),
        paths,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const repoRoot = repoRootOf();
  const options = applyEnvDefaults(parseArgs(process.argv.slice(2)), repoRoot);

  switch (options.command) {
    case 'status':
      await status(options);
      return;
    case 'install':
      await install(options);
      return;
    case 'launch':
      await launch(options);
      return;
    case 'restore':
      await restore(options);
      return;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error);
  process.exit(1);
});
