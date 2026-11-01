import { describe, expect, it } from 'vitest';
import { buildNapcatLoader } from './napcat-loader.js';
import { isQQAlreadyPatched, isQQProcessCommand } from './qq-bot-macos.js';

describe('qq-bot-macos orchestration assumptions', () => {
  const sampleNapcatShellDir = '/Users/example/Library/Containers/com.tencent.qq/Data/Documents/napcat';

  it('can build a QR-login loader without quick account injection', () => {
    const loader = buildNapcatLoader({
      qqPackagePath: '/Applications/QQ.app/Contents/Resources/app/package.json',
      qqResourcesDir: '/Applications/QQ.app/Contents/Resources/app',
      napcatShellDir: sampleNapcatShellDir,
    });

    expect(loader).not.toContain('NAPCAT_QUICK_ACCOUNT');
    expect(loader).toContain('process.argv.includes("--no-sandbox")');
  });

  it('can build a quick-login loader that sets the account before NapCat starts', () => {
    const loader = buildNapcatLoader(
      {
        qqPackagePath: '/Applications/QQ.app/Contents/Resources/app/package.json',
        qqResourcesDir: '/Applications/QQ.app/Contents/Resources/app',
        napcatShellDir: sampleNapcatShellDir,
      },
      { quickAccount: '1234567890' },
    );

    expect(loader).toContain('NAPCAT_QUICK_ACCOUNT');
    expect(loader.indexOf('NAPCAT_QUICK_ACCOUNT')).toBeLessThan(loader.indexOf('await import('));
  });

  it('up flow should stop QQ before patching the app bundle', () => {
    const orderedSteps = [
      'stopQQ',
      'ensureNapcatPatched',
      'stopBot',
      'startBot',
      'launchQQ',
    ];

    expect(orderedSteps.indexOf('stopQQ')).toBeLessThan(orderedSteps.indexOf('ensureNapcatPatched'));
  });

  it('treats helper processes as active QQ processes', () => {
    expect(isQQProcessCommand('/Applications/QQ.app/Contents/MacOS/QQ')).toBe(true);
    expect(
      isQQProcessCommand('/Applications/QQ.app/Contents/Frameworks/QQ Helper.app/Contents/MacOS/QQ Helper'),
    ).toBe(true);
    expect(
      isQQProcessCommand('/Applications/QQ.app/Contents/MacOS/QQEXDOC.app/Contents/MacOS/QQEXDOC'),
    ).toBe(true);
    expect(isQQProcessCommand('/Applications/Cursor.app/Contents/MacOS/Cursor')).toBe(false);
  });

  it('detects an already patched QQ package', () => {
    expect(
      isQQAlreadyPatched(
        {
          main: '../../../../../Users/example/Library/Containers/com.tencent.qq/Data/Documents/loadNapCat.js',
        },
        '../../../../../Users/example/Library/Containers/com.tencent.qq/Data/Documents/loadNapCat.js',
      ),
    ).toBe(true);
    expect(isQQAlreadyPatched({ main: './app_launcher/index.js' }, 'loadNapCat.js')).toBe(false);
  });

  it('no longer hardcodes machine-specific trae binary paths in the helper source', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./qq-bot-macos.ts', import.meta.url), 'utf8'),
    );

    expect(source).not.toMatch(/\/Users\/[^/]+\/\.local\/bin\/traex/u);
    expect(source).not.toMatch(/\/Users\/[^/]+\/GolandProjects\//u);
    expect(source).toContain('env: { ...config.env }');
    expect(source).not.toContain("pkill");
    expect(source).toContain("const DEFAULT_GROUP_CONFIG = './examples/group-rules.local.json';");
    expect(source).toContain("const DEFAULT_BOT_PORT = 8080;");
    expect(source).toContain("const DEFAULT_ACCESS_TOKEN = '';");
  });

  it('prints terminal QR code by default and keeps JSON as an explicit mode', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./qq-bot-macos.ts', import.meta.url), 'utf8'),
    );

    expect(source).toContain('Scan this QR code with the QQ account you want the bot to use');
    expect(source).toContain('renderTerminalQr');
    expect(source).toContain("case '--json'");
    expect(source).toContain("case '--no-wait'");
  });

  it('login flow can start or restart NapCat before giving up on QR generation', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./qq-bot-macos.ts', import.meta.url), 'utf8'),
    );

    expect(source).toContain('ensureNapcatReadyForLogin');
    expect(source).toContain('restartNapcatForQrLogin');
    expect(source).toContain('failed to get login qrcode after starting NapCat');
  });

  it('requires a production build before the bot:macos helper tries to launch dist/index.js', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./qq-bot-macos.ts', import.meta.url), 'utf8'),
    );

    expect(source).toContain('dist/index.js is missing.');
    expect(source).toContain('npm run build');
    expect(source).toContain('npm run dev');
  });
});
