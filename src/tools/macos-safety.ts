import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { strongAccessToken } from '../utils/network.js';

export function assertHelperTokens(onebot: string, webui: string): void {
  if (!strongAccessToken(onebot) || !strongAccessToken(webui) || onebot === webui) {
    throw new Error('Configure separate random ONEBOT_ACCESS_TOKEN and NAPCAT_WEBUI_TOKEN (24+ characters) before modifying QQ/NapCat');
  }
}

export function assertHelperWsUrl(value: string): void {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OneBot URL must be WS/WSS without credentials, query or fragment');
  }
}

/** Diagnostics may show structure, never reusable secrets or token-bearing URLs. */
export function redactHelperConfig(value: unknown, key = ''): unknown {
  if (/token|secret|password|authorization|credential|api.?key/iu.test(key)) return value ? '[redacted]' : '';
  if (Array.isArray(value)) return value.map(item => redactHelperConfig(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactHelperConfig(v, k)]));
  if (typeof value === 'string' && /url/iu.test(key)) {
    try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
    catch { return '[invalid-url]'; }
  }
  return value;
}

export function isManagedBotProcess(pidText: string, command: string, cwd: string, root: string, node = process.execPath): boolean {
  if (!/^[1-9]\d*$/u.test(pidText.trim()) || !Number.isSafeInteger(Number(pidText)) || Number(pidText) <= 1) return false;
  if (path.resolve(cwd) !== path.resolve(root)) return false;
  const entry = path.join(root, 'dist/index.js');
  return [node + ' ' + entry, node + ' dist/index.js', 'node ' + entry, 'node dist/index.js'].includes(command.trim());
}

export async function writePrivateHelperJson(target: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try { if (!(await lstat(target)).isFile()) throw new Error('Refusing a non-regular helper config file'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8'); await file.sync(); await file.close();
    await rename(temporary, target);
  } catch (error) {
    await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error;
  }
}
