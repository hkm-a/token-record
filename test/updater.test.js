'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeVersion,
  compareSemver,
  isStrictSemverTag,
  pickPortableAsset,
  parseReleasePayload,
  pickBestRelease,
  checkForUpdate,
} = require('../src/main/updater');

test('normalizeVersion 去掉 v 前缀', () => {
  assert.strictEqual(normalizeVersion('v1.3.0'), '1.3.0');
  assert.strictEqual(normalizeVersion('1.3.0'), '1.3.0');
});

test('compareSemver 比较版本号', () => {
  assert.strictEqual(compareSemver('1.4.0', '1.3.0'), 1);
  assert.strictEqual(compareSemver('1.3.0', '1.4.0'), -1);
  assert.strictEqual(compareSemver('1.3.0', 'v1.3.0'), 0);
  assert.strictEqual(compareSemver('1.3.1', '1.3.0'), 1);
});

test('isStrictSemverTag 正确识别严格 semver', () => {
  assert.strictEqual(isStrictSemverTag('v1.5.8'), true);
  assert.strictEqual(isStrictSemverTag('1.5.8'), true);
  assert.strictEqual(isStrictSemverTag('v2.0.0'), true);
  assert.strictEqual(isStrictSemverTag('v2.0.0-test'), false, '含后缀应排除');
  assert.strictEqual(isStrictSemverTag('v1.5.8-beta'), false, 'pre-release 应排除');
  assert.strictEqual(isStrictSemverTag('v1.5'), false, '不完整 semver 应排除');
  assert.strictEqual(isStrictSemverTag('latest'), false, '非 semver 应排除');
  assert.strictEqual(isStrictSemverTag(''), false, '空字符串应排除');
});

test('pickPortableAsset 优先 portable.exe', () => {
  const a = pickPortableAsset([
    { name: 'notes.txt' },
    { name: 'TokenRecord-1.4.0.exe' },
    { name: 'TokenRecord-1.4.0-portable.exe' },
  ]);
  assert.strictEqual(a.name, 'TokenRecord-1.4.0-portable.exe');
});

test('parseReleasePayload 提取下载信息', () => {
  const r = parseReleasePayload({
    tag_name: 'v1.4.0',
    name: 'Token 记录 v1.4.0',
    html_url: 'https://github.com/hkm-a/token-record/releases/tag/v1.4.0',
    body: 'notes',
    assets: [
      {
        name: 'TokenRecord-1.4.0-portable.exe',
        browser_download_url: 'https://example.com/a.exe',
        size: 100,
      },
    ],
  });
  assert.strictEqual(r.version, '1.4.0');
  assert.ok(r.downloadUrl.includes('a.exe'));
});

test('pickBestRelease 选择最高严格 semver 版本', () => {
  const releases = [
    { tag_name: 'v2.0.0-test', draft: false, prerelease: false, assets: [{ name: 'x-portable.exe', browser_download_url: 'https://ex.com/x.exe', size: 100 }] },
    { tag_name: 'v1.5.7', draft: false, prerelease: false, assets: [{ name: 'TokenRecord-1.5.7-portable.exe', browser_download_url: 'https://ex.com/1.5.7.exe', size: 100 }] },
    { tag_name: 'v1.5.6', draft: false, prerelease: false, assets: [{ name: 'TokenRecord-1.5.6-portable.exe', browser_download_url: 'https://ex.com/1.5.6.exe', size: 100 }] },
    { tag_name: 'v1.4.0', draft: false, prerelease: false, assets: [] },
  ];
  const best = pickBestRelease(releases, '1.5.0');
  assert.ok(best, '应有候选版本');
  assert.strictEqual(best.version, '1.5.7', '应跳过 v2.0.0-test（非严格 semver）和 v1.4.0（无 asset）');
  assert.ok(best.downloadUrl.includes('1.5.7'));
});

test('pickBestRelease 过滤掉草稿和预发布', () => {
  const releases = [
    { tag_name: 'v1.6.0', draft: true, prerelease: false, assets: [{ name: 'x-portable.exe', browser_download_url: 'https://ex.com/x.exe', size: 100 }] },
    { tag_name: 'v1.5.8', draft: false, prerelease: false, assets: [{ name: 'x-portable.exe', browser_download_url: 'https://ex.com/x.exe', size: 100 }] },
  ];
  const best = pickBestRelease(releases, '1.5.0');
  assert.strictEqual(best.version, '1.5.8', '应跳过 draft');
});

test('pickBestRelease 当前已是最新时返回 null', () => {
  const releases = [
    { tag_name: 'v1.5.7', draft: false, prerelease: false, assets: [{ name: 'x-portable.exe', browser_download_url: 'https://ex.com/x.exe', size: 100 }] },
  ];
  const best = pickBestRelease(releases, '1.5.7');
  assert.strictEqual(best, null, '无更高版本');
});

test('checkForUpdate 有新版本', async () => {
  const result = await checkForUpdate('1.3.0', {
    fetchBest: async () => ({
      version: '1.4.0',
      tag: 'v1.4.0',
      htmlUrl: 'https://example.com',
      downloadUrl: 'https://example.com/a.exe',
      assetName: 'a.exe',
      body: '',
      name: 'x',
    }),
  });
  assert.strictEqual(result.updateAvailable, true);
  assert.strictEqual(result.latestVersion, '1.4.0');
});

test('checkForUpdate 已是最新', async () => {
  const result = await checkForUpdate('1.4.0', {
    fetchBest: async () => null,
  });
  assert.strictEqual(result.updateAvailable, false);
  assert.strictEqual(result.latestVersion, '1.4.0');
});
