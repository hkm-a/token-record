'use strict';

// 自动更新（适配 portable 分发）：
// 从 GitHub Releases 查询最新版，比较 semver；有新版时自动下载新 exe，
// 写入升级批处理脚本，自启批处理后退出，由批处理完成替换并重启。
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

// 使用 https/http 拉取 JSON。
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

// 下载文件。
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

// ─── 自动下载并安装（便携 exe 接力） ─────────────────────────

// 计算当前 exe 路径（app.isPackaged 时就是自身，dev 模式取 package.json 所在目录占位）
function exePath() {
  // 在便携包中 process.execPath 就是 .exe 自身
  return process.execPath;
}

// 生成升级批处理脚本内容。
// oldExe: 当前运行中的 exe 路径
// newExe: 已下载到 temp 的新 exe 路径
// 返回脚本字符串。
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
  DEFAULT_API,
  normalizeVersion,
  compareSemver,
  pickPortableAsset,
  parseReleasePayload,
  fetchLatestRelease,
  checkForUpdate,
  httpDownload,
  downloadAndInstall,
  buildUpgradeBat,
  exePath,
};
