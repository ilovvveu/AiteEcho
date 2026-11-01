import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type PackageJsonShape = {
  name?: string;
  version?: string;
};

export interface BuildInfo {
  appName: string;
  version: string;
  gitCommit?: string;
  buildRef?: string;
  startedAt: string;
}

const startedAt = new Date().toISOString();

function loadPackageInfo(): PackageJsonShape {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.resolve(currentDir, '../../package.json');
  const raw = readFileSync(packageJsonPath, 'utf8');
  return JSON.parse(raw) as PackageJsonShape;
}

const packageInfo = loadPackageInfo();

export function getBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const gitCommit = env.APP_GIT_COMMIT?.trim() || undefined;
  const buildRef = env.APP_BUILD_REF?.trim() || undefined;

  return {
    appName: packageInfo.name || 'aite-echo',
    version: packageInfo.version || '0.0.0',
    gitCommit,
    buildRef,
    startedAt,
  };
}
