import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface NapcatLoaderOptions {
  launcherDelayMs?: number;
  quickAccount?: string;
}

export function buildNapcatLoader(paths: {
  qqPackagePath: string;
  qqResourcesDir: string;
  napcatShellDir: string;
}, options: NapcatLoaderOptions = {}): string {
  const shellEntryUrl = pathToFileURL(path.join(paths.napcatShellDir, 'napcat.mjs')).href;
  const qqPackagePath = JSON.stringify(paths.qqPackagePath);
  const qqLauncherPath = JSON.stringify(path.join(paths.qqResourcesDir, 'app_launcher', 'index.js'));
  const quickAccount = options.quickAccount?.trim();
  const quickAccountLine = quickAccount
    ? `process.env.NAPCAT_QUICK_ACCOUNT = process.env.NAPCAT_QUICK_ACCOUNT || ${JSON.stringify(quickAccount)};\n\n`
    : '';

  return `const hasNapcatParam = process.argv.includes("--no-sandbox");
const packageInfo = require(${qqPackagePath});

if (hasNapcatParam) {
  ${quickAccountLine}(async () => {
    await import(${JSON.stringify(shellEntryUrl)});
  })();
} else {
  require(${qqLauncherPath});
  setImmediate(() => {
    global.launcher.installPathPkgJson.main = ((version) => {
      if (version >= 29271) return "./application.asar/app_launcher/index.js";
      if (version >= 28060) return "./application/app_launcher/index.js";
      return "./app_launcher/index.js";
    })(packageInfo.buildVersion);
  });
}
`;
}
