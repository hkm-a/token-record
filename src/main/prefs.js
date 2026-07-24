'use strict';

// 用户偏好：窗口位置、开机自启等。与 Electron 解耦，便于单测。

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  x: null,
  y: null,
  openAtLogin: false,
  compact: false,
};

function loadPrefs(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch (_err) {
    return { ...DEFAULTS };
  }
}

function savePrefs(filePath, prefs) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const data = { ...DEFAULTS, ...prefs };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

// 将窗口坐标限制在可用工作区内，避免显示器变更后窗口飞出屏幕。
function clampPosition(x, y, winW, winH, workArea) {
  if (x == null || y == null || !workArea) {
    return { x: null, y: null };
  }
  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = workArea.x + workArea.width - Math.min(winW, workArea.width);
  const maxY = workArea.y + workArea.height - Math.min(winH, workArea.height);
  return {
    x: Math.min(Math.max(Math.round(x), minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(Math.round(y), minY), Math.max(minY, maxY)),
  };
}

// 是否应以隐藏模式启动（开机自启 / 显式 --hidden）。
function shouldStartHidden(argv, loginWasHidden) {
  if (loginWasHidden) return true;
  return Array.isArray(argv) && argv.some((a) => a === '--hidden' || a === '--start-hidden');
}

// 组装 setLoginItemSettings 参数。
function buildLoginItemSettings(enabled, opts = {}) {
  const { packaged, execPath, appPath } = opts;
  if (packaged) {
    return {
      openAtLogin: !!enabled,
      openAsHidden: true,
      path: execPath,
      args: enabled ? ['--hidden'] : [],
    };
  }
  // 开发态：Electron 可执行文件 + 项目根目录
  return {
    openAtLogin: !!enabled,
    openAsHidden: true,
    path: execPath,
    args: enabled ? [appPath, '--hidden'] : [],
  };
}

module.exports = {
  DEFAULTS,
  loadPrefs,
  savePrefs,
  clampPosition,
  shouldStartHidden,
  buildLoginItemSettings,
};
