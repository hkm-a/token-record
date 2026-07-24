'use strict';

// 自动更新（适配 portable 分发）：
// 从 GitHub Releases 查询最新版，比较 semver；有新版时下载便携 exe 或打开发布页。
// 不依赖 electron-updater 的 NSIS 差量（portable 无法原地静默替换进程文件）。

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DEFAULT_REPO = 'hkm-a/token-record';
const DEFAULT_API = `https://api.github.com/repos/${DEFAULT_REPO}/releases/latest`;

function normalizeVersion(v) {
  return String(v || '')
    .trim()
    .replace(/^v/i, '');
}

// 比较 a 与 b：1=a 更新，-1=a 更旧，0=相等。
function compareSemver(a, b) {
  const pa = normalizeVersion(a)
    .split(/[.+-]/)
    .map((n) => parseInt(n, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
  const pb = normalizeVersion(b)
    .split(/[.+-]/)
    .map((n) => parseInt(n, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function pickPortableAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  return (
    list.find((a) => /portable\.exe$/i.test(a.name || '')) ||
    list.find((a) => /\.exe$/i.test(a.name || '')) ||
    null
  );
}

// 解析 GitHub release JSON 为精简结构。
function parseReleasePayload(data) {
  const asset = pickPortableAsset(data.assets);
  return {
    version: normalizeVersion(data.tag_name || data.name),
    tag: data.tag_name || '',
    name: data.name || data.tag_name || '',
    htmlUrl: data.html_url || `https://github.com/${DEFAULT_REPO}/releases`,
    body: data.body || '',
    publishedAt: data.published_at || null,
    assetName: asset ? asset.name : null,
    downloadUrl: asset ? asset.browser_download_url : null,
    size: asset ? asset.size : null,
  };
}

// 使用 https/http 拉取 JSON（避免依赖全局 fetch 行为差异）。
function httpGetJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': opts.userAgent || 'token-record-updater',
          Accept: 'application/vnd.github+json',
          ...(opts.headers || {}),
        },
        timeout: opts.timeout || 20000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          httpGetJson(res.headers.location, opts).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GitHub API HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('检查更新超时'));
    });
  });
}

function httpDownload(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      {
        headers: { 'User-Agent': 'token-record-updater' },
        timeout: 120000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          httpDownload(res.headers.location, destPath, onProgress).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`下载失败 HTTP ${res.statusCode}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let received = 0;
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const out = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total) onProgress(received / total, received, total);
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(destPath)));
        out.on('error', reject);
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('下载超时'));
    });
  });
}

async function fetchLatestRelease(opts = {}) {
  const apiUrl = opts.apiUrl || DEFAULT_API;
  const data = await httpGetJson(apiUrl, opts);
  return parseReleasePayload(data);
}

async function checkForUpdate(currentVersion, opts = {}) {
  const fetchFn = opts.fetchLatest || fetchLatestRelease;
  const latest = await fetchFn(opts);
  const current = normalizeVersion(currentVersion);
  const cmp = compareSemver(latest.version, current);
  return {
    updateAvailable: cmp > 0,
    currentVersion: current,
    latestVersion: latest.version,
    latest,
  };
}

module.exports = {
  DEFAULT_REPO,
  DEFAULT_API,
  normalizeVersion,
  compareSemver,
  pickPortableAsset,
  parseReleasePayload,
  fetchLatestRelease,
  checkForUpdate,
  httpDownload,
};
