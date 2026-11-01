import { describe, expect, it } from 'vitest';
import { buildNapcatLoader } from './napcat-loader.js';
import { isQQAlreadyPatched, isQQProcessCommand } from './napcat-macos.js';

describe('NapCat macOS launcher mode switch', () => {
  const sampleNapcatShellDir = '/Users/example/Library/Containers/com.tencent.qq/Data/Documents/napcat';

  it('loads NapCat only in the official no-sandbox launch mode', () => {
    const loader = buildNapcatLoader({
      qqPackagePath: '/Applications/QQ.app/Contents/Resources/app/package.json',
      qqResourcesDir: '/Applications/QQ.app/Contents/Resources/app',
      napcatShellDir: sampleNapcatShellDir,
    });

    expect(loader).toContain('require("/Applications/QQ.app/Contents/Resources/app/app_launcher/index.js")');
    expect(loader).toContain(`await import("file://${sampleNapcatShellDir}/napcat.mjs")`);
    expect(loader).toContain('process.argv.includes("--no-sandbox")');
    expect(loader).toContain('if (hasNapcatParam)');
    expect(loader).toContain('} else {');
  });

  it('injects quick account before loading NapCat when requested', () => {
    const loader = buildNapcatLoader(
      {
        qqPackagePath: '/Applications/QQ.app/Contents/Resources/app/package.json',
        qqResourcesDir: '/Applications/QQ.app/Contents/Resources/app',
        napcatShellDir: sampleNapcatShellDir,
      },
      {
        quickAccount: '1234567890',
      },
    );

    expect(loader).toContain('process.env.NAPCAT_QUICK_ACCOUNT = process.env.NAPCAT_QUICK_ACCOUNT || "1234567890";');
    expect(loader.indexOf('NAPCAT_QUICK_ACCOUNT')).toBeLessThan(loader.indexOf('await import('));
  });

  it('treats helper processes as active QQ processes before patching', () => {
    expect(isQQProcessCommand('/Applications/QQ.app/Contents/MacOS/QQ')).toBe(true);
    expect(isQQProcessCommand('/Applications/QQ.app/Contents/Frameworks/QQ Helper.app/Contents/MacOS/QQ Helper')).toBe(true);
    expect(isQQProcessCommand('/Applications/QQ.app/Contents/MacOS/QQEXDOC.app/Contents/MacOS/QQEXDOC')).toBe(true);
    expect(isQQProcessCommand('/Applications/Chrome.app/Contents/MacOS/Chrome')).toBe(false);
  });

  it('detects already patched QQ packages', () => {
    expect(isQQAlreadyPatched({ main: 'loadNapCat.js' }, 'loadNapCat.js')).toBe(true);
    expect(isQQAlreadyPatched({ main: './app_launcher/index.js' }, 'loadNapCat.js')).toBe(false);
  });

  it('no longer hardcodes the old test token in the helper source', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./napcat-macos.ts', import.meta.url), 'utf8'),
    );

    expect(source).toContain("const DEFAULT_ONEBOT_TOKEN = '';");
    expect(source).toContain("const DEFAULT_WEBUI_TOKEN = '';");
    expect(source).toContain('applyEnvDefaults');
    expect(source).toContain('env.NAPCAT_WEBUI_TOKEN || env.WEBUI_TOKEN || DEFAULT_WEBUI_TOKEN');
  });
});
