import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { auditPackage, auditSource, publicFiles } from '../../scripts/audit-release.mjs';

afterEach(() => { delete process.env.QQ_RELEASE_FORBIDDEN_VALUES; });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-release-audit-test-'));
  fs.writeFileSync(path.join(root, 'LICENSE'), ['Copyright (c) 2026', 'Shirong', 'Lu'].join(' ') + '\nMIT');
  fs.writeFileSync(path.join(root, 'NOTICE'), 'Synthetic test only');
  fs.mkdirSync(path.join(root, 'src'));
  return root;
}
it('exports only the source allowlist, excluding private runtime files and local configuration', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, '.env.local'), 'PRIVATE_NOT_FOR_EXPORT');
  fs.mkdirSync(path.join(root, 'data')); fs.writeFileSync(path.join(root, 'data/sessions.json'), 'PRIVATE_CHAT');
  fs.mkdirSync(path.join(root, 'examples')); fs.writeFileSync(path.join(root, 'examples/group-rules.local.json'), 'PRIVATE_GROUP');
  expect(publicFiles(root)).toEqual(['LICENSE', 'NOTICE']);
  expect(auditSource(root).failures).toEqual([]);
});
it('rejects source symlinks, credential patterns and exact private values without printing their contents', () => {
  const root = fixture(), file = path.join(root, 'src/example.ts');
  process.env.QQ_RELEASE_FORBIDDEN_VALUES = JSON.stringify(['SYNTHETIC_PRIVATE_DEPLOYMENT']);
  fs.writeFileSync(file, 'sk-' + 'A'.repeat(32) + '\nSYNTHETIC_PRIVATE_DEPLOYMENT');
  const failures = auditSource(root).failures;
  expect(failures.map(f => f.rule)).toEqual(['credential-pattern', 'private-deployment-value']);
  expect(JSON.stringify(failures)).not.toContain('SYNTHETIC_PRIVATE_DEPLOYMENT');
  fs.symlinkSync(path.join(root, 'LICENSE'), path.join(root, 'src/linked.ts'));
  expect(() => publicFiles(root)).toThrow('SYMLINK_NOT_PUBLISHABLE');
});
it('also scans actual compiled package content and refuses fixtures in production artifacts', () => {
  const root = fixture(); fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist/index.js'), 'sk-' + 'B'.repeat(32));
  fs.writeFileSync(path.join(root, 'dist/old.test.js'), 'synthetic');
  const failures = auditPackage(root, ['dist/index.js', 'dist/old.test.js']);
  expect(failures).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'package-credential' }), expect.objectContaining({ rule: 'unsafe-package-path' })]));
});

it('allows only the inspected banner bytes without opening the whole assets directory', () => {
  const root = fixture(), banner = 'assets/reverix-banner.png';
  fs.mkdirSync(path.join(root, 'assets'));
  fs.copyFileSync(new URL('../../assets/reverix-banner.png', import.meta.url), path.join(root, banner));
  fs.writeFileSync(path.join(root, 'assets/not-for-release.png'), Buffer.from([137, 0, 1]));
  expect(publicFiles(root)).toEqual(['LICENSE', 'NOTICE', banner]);
  expect(auditSource(root).failures).toEqual([]);
  expect(auditPackage(root, [banner]).filter(f => f.file === banner)).toEqual([]);
  expect(auditPackage(root, []).filter(f => f.file === banner)).toEqual([{ file: banner, rule: 'missing-package-file' }]);
});

it('rejects altered banner content in source and package, including appended hidden data', () => {
  const root = fixture(), banner = 'assets/reverix-banner.png';
  fs.mkdirSync(path.join(root, 'assets'));
  const original = fs.readFileSync(new URL('../../assets/reverix-banner.png', import.meta.url));
  fs.writeFileSync(path.join(root, banner), Buffer.concat([original, Buffer.from('UNREVIEWED_CONTENT')]));
  expect(auditSource(root).failures).toContainEqual({ file: banner, rule: 'unapproved-image-content' });
  expect(auditPackage(root, [banner])).toContainEqual({ file: banner, rule: 'unapproved-image-content' });
  fs.writeFileSync(path.join(root, 'src/unexpected.png'), original);
  expect(auditSource(root).failures).toContainEqual({ file: 'src/unexpected.png', rule: 'unexpected-binary' });
  expect(auditPackage(root, ['src/unexpected.png'])).toContainEqual({ file: 'src/unexpected.png', rule: 'unexpected-package-binary' });
});
