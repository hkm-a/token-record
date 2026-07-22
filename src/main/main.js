'use strict';

// Electron 主进程：创建桌面悬浮窗，定时刷新用量快照并通过 IPC 推送给渲染进程。
// 悬浮窗特性：无边框、透明背景（圆角由 CSS 绘制）、置顶、不可缩放、可拖动。

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { Store } = require('../core/store');

const REFRESH_MS = 2000; // 刷新间隔：兼顾实时性与开销
const WIN_W = 384;
const WIN_H = 588;

let win = null;
let tray = null;
let store = null;
let timer = null;

function createWindow() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: sw - WIN_W - 24, // 默认停靠右上角
    y: 28,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // 置顶层级设为屏保级，确保浮于绝大多数窗口之上。
  win.setAlwaysOnTop(true, 'screen-saver');
}

// 刷新一帧并推送给渲染层。
async function tick() {
  if (!store) return;
  try {
    const data = await store.refresh();
    store.persist(data.snapshot);
    if (win && !win.isDestroyed()) {
      win.webContents.send('snapshot', data);
    }
  } catch (err) {
    console.error('刷新失败：', err);
  }
}

// 系统托盘：提供显示/隐藏与退出，避免无边框窗口找不到入口。
function createTray() {
  // 用一个简单的 1x1 透明位图占位（无外部资源依赖），托盘主要提供右键菜单。
  const img = nativeImage.createEmpty();
  try {
    tray = new Tray(img);
  } catch (_err) {
    return; // 个别环境无托盘支持时静默跳过
  }
  const menu = Menu.buildFromTemplate([
    { label: '显示/隐藏', click: () => toggleWindow() },
    { label: '立即刷新', click: () => tick() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setToolTip('Token 消耗记录');
  tray.setContextMenu(menu);
  tray.on('click', () => toggleWindow());
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
  }
}

app.whenReady().then(() => {
  store = new Store();
  store.loadPersisted(); // 载入上次快照，UI 首帧从上次值平滑过渡
  createWindow();
  createTray();

  // 页面加载完成后立即出首帧，随后进入定时刷新。
  win.webContents.once('did-finish-load', () => {
    tick();
  });
  timer = setInterval(tick, REFRESH_MS);

  // 调试用：设置 TOKENREC_SHOT 时，等首帧动画稳定后离屏截图并退出，供本地验证外观。
  if (process.env.TOKENREC_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          const p = path.join(__dirname, '..', '..', '.cache', 'preview.png');
          require('fs').mkdirSync(path.dirname(p), { recursive: true });
          require('fs').writeFileSync(p, img.toPNG());
          console.log('已保存预览截图：' + p);
        } catch (err) {
          console.error('截图失败：', err);
        }
        app.quit();
      }, 2600);
    });
  }

  // 渲染进程控制通道
  ipcMain.on('quit', () => app.quit());
  ipcMain.on('minimize', () => win && win.hide());
  ipcMain.on('refresh-now', () => tick());
  ipcMain.on('toggle-pin', (_e, pinned) => {
    if (win) win.setAlwaysOnTop(!!pinned, 'screen-saver');
  });
});

app.on('window-all-closed', () => {
  if (timer) clearInterval(timer);
  app.quit();
});
