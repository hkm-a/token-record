'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeVersion,
  compareSemver,
  pickPortableAsset,
  parseReleasePayload,
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

test('checkForUpdate 有新版本', async () => {
  const result = await checkForUpdate('1.3.0', {
    fetchLatest: async () => ({
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
    fetchLatest: async () => ({
      version: '1.4.0',
      tag: 'v1.4.0',
      htmlUrl: 'https://example.com',
      downloadUrl: null,
      assetName: null,
      body: '',
      name: 'x',
    }),
  });
  assert.strictEqual(result.updateAvailable, false);
});
