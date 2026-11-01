import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const CREDENTIALS = /\b(?:sk[-_][A-Za-z0-9_-]{20,}|g2a_[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u;
function forbiddenValues() { return JSON.parse(process.env.QQ_RELEASE_FORBIDDEN_VALUES || '[]').filter(v => typeof v === 'string' && v.length >= 6); }

// Only the inspected brand banner is publishable, not the whole asset archive.
const PUBLIC_IMAGES = new Map([
  ['assets/reverix-banner.png', '54f01966f1b05631fccd17767cc5761bb6b5710fdcc069a61e2b61ecae320e97'],
]);
function approvedImage(file, data) {
  return data.length <= 64 * 1024
    && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && createHash('sha256').update(data).digest('hex') === PUBLIC_IMAGES.get(file);
}

export const PUBLIC_ROOT_FILES = [
  '.dockerignore', '.env.example', '.env.docker.example', '.gitignore', '.npmrc', 'ARCHITECTURE.md', 'CONTRIBUTING.md',
  'Dockerfile', 'LICENSE', 'NOTICE', 'DISCLAIMER.md', 'README.md', 'ROADMAP.md', 'SECURITY.md', 'SUPPORT.md', 'docker-compose.demo.yml',
  'docker-compose.arm64.yml', 'eslint.config.js', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts',
  'examples/group-rules.example.json', 'examples/reply-rules.json', 'examples/reply-style.txt', 'deploy/napcat.onebot11.reverse-ws.json',
  ...PUBLIC_IMAGES.keys(),
];
export const PUBLIC_ROOT_DIRS = ['src', 'scripts', 'docs', 'examples/styles', '.github'];
export function publicFiles(root) {
  const files = [];
  const walk = relative => {
    const file = path.join(root, relative); if (!fs.existsSync(file)) return;
    const info = fs.lstatSync(file); assert.ok(!info.isSymbolicLink(), 'SYMLINK_NOT_PUBLISHABLE: ' + relative);
    if (info.isDirectory()) for (const name of fs.readdirSync(file)) walk(path.posix.join(relative, name));
    else if (info.isFile()) files.push(relative);
  };
  for (const relative of [...PUBLIC_ROOT_FILES, ...PUBLIC_ROOT_DIRS]) walk(relative);
  return files.sort();
}

export function auditSource(root) {
  const files = publicFiles(root), failures = [], forbidden = forbiddenValues();
  const paths = /^(?:\.env(?:\.local|\.docker)?|config|data|logs|runtime|release|run-logs|node_modules|\.git|\.venv)(?:\/|$)|(?:^|\/)(?:node_modules|\.git|\.venv)(?:\/|$)|\.local\.json$|\.(?:log|jsonl|sqlite\d*|db|pem|key|tgz)(?:$|[-.])/u;
  for (const file of files) {
    if (paths.test(file) && !/^\.env(?:\.docker)?\.example$/u.test(file)) failures.push({ file, rule: 'runtime-or-secret-file' });
    const data = fs.readFileSync(path.join(root, file));
    if (PUBLIC_IMAGES.has(file)) {
      if (!approvedImage(file, data)) failures.push({ file, rule: 'unapproved-image-content' });
      continue;
    }
    if (data.includes(0)) { failures.push({ file, rule: 'unexpected-binary' }); continue; }
    const text = data.toString('utf8');
    if (CREDENTIALS.test(text)) failures.push({ file, rule: 'credential-pattern' });
    if (forbidden.some(value => text.includes(value))) failures.push({ file, rule: 'private-deployment-value' });
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)
      && file !== 'src/agents/direct/fixtures/untrusted-tls.ts') failures.push({ file, rule: 'private-key' });
    if (!['LICENSE', 'NOTICE', 'scripts/audit-release.mjs'].includes(file) && /happysnaker|Shirong Lu/iu.test(text)) failures.push({ file, rule: 'upstream-promotion-outside-notice' });
    if (/\/(?:Users|home)\/(?!example(?:\/|$)|user(?:\/|$)|your[-_])[^/\s'"`]+\//u.test(text)) failures.push({ file, rule: 'personal-home-path' });
    if (file.endsWith('.md')) {
      for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
        const href = match[1]; if (/^(?:[a-z]+:|#)/iu.test(href)) continue;
        let target; try { target = decodeURIComponent(href.split('#')[0]); } catch { failures.push({ file, rule: 'invalid-link' }); continue; }
        if (target && !fs.existsSync(path.resolve(root, path.dirname(file), target))) failures.push({ file, rule: 'broken-local-link', target });
      }
    }
  }
  assert.ok(files.includes('LICENSE') && files.includes('NOTICE'), 'LICENSE_AND_NOTICE_REQUIRED');
  assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 Shirong Lu/u);
  return { files, failures };
}

export function auditPackage(root, names) {
  const forbidden = forbiddenValues(), failures = [];
  for (const file of names) {
    if (/^(?:\.env(?:\.local|\.docker)?|config|data|logs|runtime|release|node_modules)(?:\/|$)|\.test\.|\/fixtures\/|\/test-support\//u.test(file)) failures.push({ file, rule: 'unsafe-package-path' });
    const target = path.resolve(root, file);
    assert.ok(target.startsWith(path.resolve(root) + path.sep), 'PACKAGE_PATH_ESCAPE');
    const data = fs.readFileSync(target);
    if (PUBLIC_IMAGES.has(file)) {
      if (!approvedImage(file, data)) failures.push({ file, rule: 'unapproved-image-content' });
      continue;
    }
    const text = data.toString('utf8');
    if (data.includes(0)) failures.push({ file, rule: 'unexpected-package-binary' });
    if (CREDENTIALS.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)) failures.push({ file, rule: 'package-credential' });
    if (forbidden.some(value => text.includes(value))) failures.push({ file, rule: 'private-deployment-value' });
  }
  for (const required of ['dist/index.js', 'scripts/read-document.py', 'scripts/vision-ocr.swift', 'LICENSE', 'NOTICE', 'DISCLAIMER.md', ...PUBLIC_IMAGES.keys()]) if (!names.includes(required)) failures.push({ file: required, rule: 'missing-package-file' });
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = auditSource(root);
  if (source.failures.length) { console.error(JSON.stringify({ releaseAudit: 'failed', failures: source.failures }, null, 2)); process.exitCode = 1; }
  else {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const packed = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))[0];
    const names = packed.files.map(f => f.path);
    assert.deepEqual(auditPackage(root, names), [], 'UNSAFE_PACKAGE_CONTENT');
    console.log(JSON.stringify({ releaseAudit: 'passed', publicSourceFiles: source.files.length, packageFiles: names.length,
      testFixtureException: 'localhost-only synthetic TLS fixture; excluded from production package', privateFilesIncluded: 0,
      exactPrivateValueChecks: forbiddenValues().length }));
  }
}
