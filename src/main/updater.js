'use strict';

// 自动更新（适配 portable 分发）：
// 从 GitHub Releases 查询最新版，比较 semver；有新版时自动下载新 exe，
// 写入升级批处理脚本，自启批处理后退出，由批处理完成替换并重启。
//
// 版本匹配策略：
//   - 只匹配严格 semver 标签（vMAJOR.MINOR.PATCH），跳过含额外后缀的标签
//   - 列出所有 release，按版本号降序选取高于当前版本的最新一个
//
// 便携 exe 无法原地覆盖运行中的文件，因此采用 批处理接力 方案：
//   exe A (运行中)
//     → 下载 exe B 到 temp
//     → 写出 upgrade.bat
//     → 静默启动 upgrade.bat
//     → 进程退出
//  upgrade.bat:
//     loop 等待原进程消失
//     copy /Y B → A（exe 路径）
//     del B
//     start A（带 --updated 参数）
//     del self

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');

const DEFAULT_REPO = 'hkm-a/token-record';
const DEFAULT_API_LIST = `https://api.github.com/repos/${DEFAULT_REPO}/releases?per_page=20`;
// 严格 semver 正则：vMAJOR.MINOR.PATCH，不允许额外后缀
const STRICT_SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

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

// 检查 tag 是否为严格 semver 格式（如 v1.5.8 或 1.5.8），不含 pre-release 或测试后缀
function isStrictSemverTag(tag) {
  return STRICT_SEMVER_RE.test(String(tag || ''));
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

// 从 release 列表中选出最佳候选版本（高于 currentVersion 且严格 semver）
function pickBestRelease(releases, currentVersion) {
  const current = normalizeVersion(currentVersion);
  const candidates = [];

  for (const r of releases) {
    // 跳过草稿与预发布
    if (r.draft || r.prerelease) continue;
    // 跳过非严格 semver 的 tag（如 v2.0.0-test）
    if (!isStrictSemverTag(r.tag_name)) continue;
    const parsed = parseReleasePayload(r);
    // 必须有可下载的 exe
    if (!parsed.downloadUrl) continue;
    // 必须高于当前版本
    if (compareSemver(parsed.version, current) <= 0) continue;
    candidates.push(parsed);
  }

  // 按版本号降序排列，取最高
  candidates.sort((a, b) => compareSemver(b.version, a.version));
  return candidates[0] || null;
}

// 使用 https/http 拉取 JSON，最多跟随 5 次重定向。
function httpGetJson(url, opts = {}) {
  const maxRedirect = 5;
  const redirects = opts._redirects != null ? opts._redirects : 0;
  if (redirects > maxRedirect) {
    return Promise.reject(new Error('重定向次数过多'));
  }
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
          httpGetJson(res.headers.location, { ...opts, _redirects: redirects + 1 }).then(resolve, reject);
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

// 下载文件，最多跟随 5 次重定向，支持进度回调。
function httpDownload(url, destPath, onProgress) {
  const maxRedirect = 5;
  const redirects = onProgress && onProgress._redirects != null ? onProgress._redirects : 0;
  if (redirects > maxRedirect) {
    return Promise.reject(new Error('下载重定向次数过多'));
  }
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
          const nextProgress = onProgress && { ...onProgress, _redirects: redirects + 1 };
          httpDownload(res.headers.location, destPath, nextProgress).then(resolve, reject);
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

// 获取 release 列表并过滤
async function fetchBestRelease(currentVersion, opts = {}) {
  const apiUrl = opts.apiUrl || DEFAULT_API_LIST;
  const list = await httpGetJson(apiUrl, opts);
  if (!Array.isArray(list)) {
    throw new Error('GitHub API 返回格式异常');
  }
  const best = pickBestRelease(list, currentVersion);
  return best;
}

async function checkForUpdate(currentVersion, opts = {}) {
  const fetchFn = opts.fetchBest || fetchBestRelease;
  const latest = await fetchFn(currentVersion, opts);
  const current = normalizeVersion(currentVersion);

  if (!latest) {
    return {
      updateAvailable: false,
      currentVersion: current,
      latestVersion: current,
      latest: null,
    };
  }

  const cmp = compareSemver(latest.version, current);
  return {
    updateAvailable: cmp > 0,
    currentVersion: current,
    latestVersion: latest.version,
    latest,
  };
}

// ─── 自动下载并安装（便携 exe 接力） ─────────────────────────

function exePath() {
  return process.execPath;
}

// 生成升级批处理脚本内容。
function buildUpgradeBat(oldExe, newExe) {
  const oldQuoted = JSON.stringify(oldExe);
  const newQuoted = JSON.stringify(newExe);
  return [
    '@echo off',
    'chcp 65001 >nul',
    '',
    `set "OLD=${oldExe}"`,
    `set "NEW=${newExe}"`,
    '',
    'REM 等待原进程退出',
    ':wait',
    `tasklist /fi "PID eq %PPID%" 2>nul | findstr /i "%PPID%" >nul`,
    'if errorlevel 1 goto copy',
    'timeout /t 1 /nobreak >nul',
    'goto wait',
    '',
    ':copy',
    'REM 替换 exe',
    'copy /Y "%NEW%" "%OLD%" >nul 2>&1',
    'if errorlevel 1 (',
    '  echo 替换失败 > "%TEMP%\\token-record-update-error.txt"',
    '  exit /b 1',
    ')',
    '',
    'REM 删除下载的临时文件',
    'del "%NEW%" 2>nul',
    '',
    'REM 启动新版本',
    'start "" "%OLD%" --updated',
    '',
    'REM 自毁',
    'del "%~f0" 2>nul',
  ].join('\r\n');
}

// 执行自动更新流程：
// 1. 下载新 exe 到系统 temp 目录
// 2. 写出 upgrade.bat
// 3. 启动 bat（detached）
// 4. 返回 { tempExe, batPath }，调用方应退出进程
function downloadAndInstall(latest, onProgress) {
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tokenrec-update-'));
  const assetName = latest.assetName || `TokenRecord-${latest.version}-portable.exe`;
  const tempExe = path.join(tempDir, assetName);
  const batPath = path.join(tempDir, 'upgrade.bat');

  return httpDownload(latest.downloadUrl, tempExe, onProgress).then(() => {
    const old = exePath();
    const batContent = buildUpgradeBat(old, tempExe);
    fs.writeFileSync(batPath, batContent, 'utf8');

    // 静默启动批处理（隐藏窗口）
    const child = spawn(batPath, [], {
      detached: true,
      stdio: 'ignore',
      shell: true,
      windowsHide: true,
    });
    child.unref();

    return { tempExe, batPath };
  });
}

module.exports = {
  DEFAULT_REPO,
  DEFAULT_API_LIST,
  normalizeVersion,
  compareSemver,
  isStrictSemverTag,
  pickPortableAsset,
  parseReleasePayload,
  pickBestRelease,
  fetchBestRelease,
  checkForUpdate,
  httpDownload,
  downloadAndInstall,
  buildUpgradeBat,
  exePath,
};
