import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

let loaded = false;

export function parseDotEnv(content: string): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separatorIndex = normalized.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    const rawValue = normalized.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      entries[key] = rawValue.slice(1, -1);
      continue;
    }

    entries[key] = rawValue;
  }

  return entries;
}

export function mergeDotEnvFiles(
  filePaths: string[],
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...baseEnv };

  for (const filePath of filePaths) {
    const resolvedPath = path.resolve(filePath);
    if (!existsSync(resolvedPath)) {
      continue;
    }

    const parsed = parseDotEnv(readFileSync(resolvedPath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      merged[key] = value;
    }
  }

  return merged;
}

export function loadDotEnv(filePath = '.env'): void {
  if (loaded || process.env.VITEST) {
    return;
  }
  loaded = true;

  const requestedPath = path.resolve(filePath);
  const filePaths =
    path.basename(requestedPath) === '.env'
      ? [requestedPath, path.resolve(path.dirname(requestedPath), '.env.local')]
      : [requestedPath];
  const merged = mergeDotEnvFiles(filePaths, {});

  if (Object.keys(merged).length === 0) {
    return;
  }

  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
