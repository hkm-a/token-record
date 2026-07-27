'use strict';

// Electron 主进程：桌面悬浮窗 + 系统托盘。
// 第 2 周：真托盘图标、关窗进托盘、位置记忆、开机自启、导出 CSV、打开价目覆盖。

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
  shell,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('../core/store');
const { defaultOverridePath } = require('../pricing/calculator');
const {
  loadPrefs,
  savePrefs,
  clampPosition,
  shouldStartHidden,
  buildLoginItemSettings,
} = require('./prefs');
const { checkForUpdate, downloadAndInstall } = require('./updater');

const REFRESH_MS = 2000;
// 展开高度仅作初值，随后按内容 fit 收紧，消除底部空白
const WIN_W = 420;
const EXPANDED_H = 560;
const COMPACT_H = 112; // 仅标题栏 + 两个大数字
const BODY_PAD = 24; // 与 style.css body padding*2 对齐
const APP_VERSION = require('../../package.json').version;
const UPDATE_CHECK_DELAY_MS = 12000; // 启动后延迟检查，避免抢首屏

let win = null;
let tray = null;
let store = null;
let timer = null;
let prefs = null;
let prefsFile = null;
let isQuitting = false;
let startHidden = false;

const singleLock = process.env.TOKENREC_SHOT ? true : app.requestSingleInstanceLock();
if (!singleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow(true);
  });
  bootstrap();
}

function projectRoot() {
  // 打包后 app.getAppPath 指向 asar；开发态指向仓库根
  return app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..', '..');
}

function iconPath(name) {
  // 开发：仓库 build/；打包：resources 旁或 extraResources
  const candidates = [
    path.join(__dirname, '..', '..', 'build', name),
    path.join(process.resourcesPath || '', 'build', name),
    path.join(projectRoot(), 'build', name),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return candidates[0];
}

function loadTrayImage() {
  const ico = iconPath('icon.ico');
  const png = iconPath('icon.png');
  let img = nativeImage.createEmpty();
  if (fs.existsSync(ico)) {
    img = nativeImage.createFromPath(ico);
  } else if (fs.existsSync(png)) {
    img = nativeImage.createFromPath(png);
  }
  if (img.isEmpty() && fs.existsSync(png)) {
    img = nativeImage.createFromPath(png);
  }
  // Windows 托盘建议较小尺寸
  if (!img.isEmpty()) {
    const size = img.getSize();
    if (size.width > 32) {
      img = img.resize({ width: 16, height: 16 });
    }
  }
  return img;
}

function persistPrefs(patch) {
  prefs = savePrefs(prefsFile, { ...prefs, ...patch });
  return prefs;
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const clamped = clampPosition(prefs.x, prefs.y, WIN_W, EXPANDED_H, wa);
  const defaultX = wa.x + wa.width - WIN_W - 24;
  const defaultY = wa.y + 28;

  win = new BrowserWindow({
    width: WIN_W,
    height: EXPANDED_H,
    x: clamped.x != null ? clamped.x : defaultX,
    y: clamped.y != null ? clamped.y : defaultY,
    icon: iconPath('icon.png'),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true, // 入口走托盘
    show: false, // 先隐藏，加载后再决定是否显示（自启静默）
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.setAlwaysOnTop(true, 'screen-saver');

  // 关闭 = 隐藏到托盘，不退出
  win.on('close', (e) => {
    if (!isQuitting && !process.env.TOKENREC_SHOT) {
      e.preventDefault();
      win.hide();
    }
  });

  // 拖动结束后记住位置
  const savePos = () => {
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    persistPrefs({ x, y });
  };
  win.on('moved', savePos);

  win.webContents.once('did-finish-load', () => {
    if (prefs.compact) {
      applyCompact(true);
      win.webContents.send('prefs', { compact: true, version: APP_VERSION });
    } else {
      win.webContents.send('prefs', { compact: false, version: APP_VERSION });
    }
    if (!startHidden) {
      win.show();
    }
  });
}

function showWindow(focus) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  if (focus !== false) win.focus();
}

function hideWindow() {
  if (!win || win.isDestroyed()) return;
  win.hide();
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) hideWindow();
  else showWindow(true);
}

function applyCompact(compact) {
  if (!win || win.isDestroyed()) return;
  win.setResizable(true);
  if (compact) {
    win.setSize(WIN_W, COMPACT_H, true);
  } else {
    win.setSize(WIN_W, EXPANDED_H, true);
  }
  win.setResizable(false);
  persistPrefs({ compact: !!compact });
  // 折叠/展开后都按真实 DOM 收紧高度
  setTimeout(() => fitWindowToContent(), 50);
}

// 按 #app 实际高度调整窗口，避免固定高度大于内容导致底部空白
async function fitWindowToContent() {
  if (!win || win.isDestroyed() || process.env.TOKENREC_SHOT) return;
  try {
    const contentH = await win.webContents.executeJavaScript(`
      (() => {
        const app = document.getElementById('app');
        if (!app) return 0;
        const rect = app.getBoundingClientRect();
        return Math.ceil(rect.height + ${BODY_PAD});
      })()
    `);
    if (!contentH || contentH < 80) return;
    const isCompact = !!(prefs && prefs.compact);
    const minH = isCompact ? 88 : 320;
    const maxH = isCompact ? 160 : 900;
    const target = Math.min(Math.max(contentH, minH), maxH);
    const [, curH] = win.getSize();
    if (Math.abs(curH - target) < 3) return;
    win.setResizable(true);
    win.setSize(WIN_W, target, true);
    win.setResizable(false);
  } catch (err) {
    console.error('fitWindowToContent 失败：', err);
  }
}

async function tick() {
  if (!store) return;
  try {
    const data = await store.refresh();
    store.persist(data.snapshot);
    if (win && !win.isDestroyed()) {
      win.webContents.send('snapshot', data);
    }
    if (tray && !tray.isDestroyed()) {
      const t = data.snapshot.period && data.snapshot.period.today;
      const tip =
        t != null
          ? `Token 记录 v${APP_VERSION}\n今日 $${(t.cost || 0).toFixed(2)} · ${Math.round(t.total || 0).toLocaleString()} tokens`
          : `Token 记录 v${APP_VERSION}`;
      tray.setToolTip(tip);
    }
  } catch (err) {
    console.error('刷新失败：', err);
  }
}

function isOpenAtLoginEnabled() {
  try {
    return !!app.getLoginItemSettings().openAtLogin;
  } catch (_err) {
    return !!prefs.openAtLogin;
  }
}

function setOpenAtLogin(enabled) {
  const settings = buildLoginItemSettings(enabled, {
    packaged: app.isPackaged,
    execPath: process.execPath,
    appPath: path.join(__dirname, '..', '..'),
  });
  try {
    app.setLoginItemSettings(settings);
  } catch (err) {
    console.error('设置开机自启失败：', err);
  }
  persistPrefs({ openAtLogin: !!enabled });
  rebuildTrayMenu();
}

function openPricingOverride() {
  const p = defaultOverridePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) {
      fs.writeFileSync(
        p,
        JSON.stringify(
          {
            _meta: {
              note: '覆盖 src/pricing/pricing.json 中同名模型单价；单位 USD / 百万 token',
            },
            models: {},
          },
          null,
          2
        ),
        'utf8'
      );
    }
    shell.openPath(p);
  } catch (err) {
    dialog.showErrorBox('打开价目文件失败', String(err && err.message ? err.message : err));
  }
}

function exportCsvFromTray() {
  if (!store || !store.last || !store.last.byDay) {
    // 尝试先刷新
    tick().then(() => doExport()).catch(() => doExport());
    return;
  }
  doExport();
}

function doExport() {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const downloads = app.getPath('downloads');
    const out = path.join(downloads, `token-record-${day}.csv`);
    const byDay = (store.last && store.last.byDay) || {};
    store.exportCsv(out, byDay);
    shell.showItemInFolder(out);
  } catch (err) {
    dialog.showErrorBox('导出 CSV 失败', String(err && err.message ? err.message : err));
  }
}

async function runUpdateCheck(opts = {}) {
  const silent = !!opts.silent;
  try {
    const result = await checkForUpdate(APP_VERSION);
    if (!result.updateAvailable) {
      if (!silent) {
        dialog.showMessageBox({
          type: 'info',
          title: '检查更新',
          message: `已是最新版本 v${result.currentVersion}`,
          detail: result.latest && result.latest.htmlUrl ? `发布页：${result.latest.htmlUrl}` : '',
          buttons: ['好的'],
        });
      }
      return result;
    }

    const latest = result.latest;

    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `Token 记录 v${result.latestVersion} 可用`,
      detail: [
        `当前：v${result.currentVersion}  → 最新：v${result.latestVersion}`,
        latest.assetName ? `安装包：${latest.assetName}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      buttons: latest.downloadUrl
        ? ['下载并更新', '稍后']
        : ['打开发布页', '稍后'],
      defaultId: 0,
      cancelId: latest.downloadUrl ? 1 : 1,
    });

    if (latest.downloadUrl && response === 0) {
      // 自动下载 → 替换 → 重启
      try {
        // 静默下载新版本
        await downloadAndInstall(latest);
        // 下载完成，提示重启
        await dialog.showMessageBox({
          type: 'info',
          title: '更新完成',
          message: `Token 记录 v${result.latestVersion} 已就绪，即将自动重启。`,
          buttons: ['好的'],
        });
        isQuitting = true;
        app.quit();
      } catch (err) {
        dialog.showErrorBox('更新失败', String(err && err.message ? err.message : err));
        if (latest.htmlUrl) shell.openExternal(latest.htmlUrl);
      }
    } else if (
      (latest.downloadUrl && response === 1) ||
      (!latest.downloadUrl && response === 0)
    ) {
      if (latest.htmlUrl) shell.openExternal(latest.htmlUrl);
    }
    return result;
  } catch (err) {
    if (!silent) {
      dialog.showErrorBox('检查更新失败', String(err && err.message ? err.message : err));
    } else {
      console.error('静默检查更新失败：', err);
    }
    return null;
  }
}

function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const openLogin = isOpenAtLoginEnabled();
  const menu = Menu.buildFromTemplate([
    {
      label: `Token 记录 v${APP_VERSION}`,
      enabled: false,
    },
    { type: 'separator' },
    { label: '显示 / 隐藏', click: () => toggleWindow() },
    { label: '立即刷新', click: () => tick() },
    { type: 'separator' },
    { label: '导出…', click: () => exportCsvFromTray() },
    { label: '价目覆盖', click: () => openPricingOverride() },
    { label: '检查更新', click: () => runUpdateCheck({ silent: false }) },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: openLogin,
      click: (item) => setOpenAtLogin(item.checked),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const img = loadTrayImage();
  try {
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  } catch (_err) {
    return;
  }
  tray.setToolTip(`Token 记录 v${APP_VERSION}`);
  rebuildTrayMenu();
  tray.on('click', () => toggleWindow());
  tray.on('double-click', () => showWindow(true));
}

function bootstrap() {
  app.whenReady().then(() => {
    prefsFile = path.join(app.getPath('userData'), 'prefs.json');
    prefs = loadPrefs(prefsFile);

    let loginHidden = false;
    try {
      loginHidden = !!app.getLoginItemSettings().wasOpenedAsHidden;
    } catch (_err) {
      loginHidden = false;
    }
    startHidden = shouldStartHidden(process.argv, loginHidden);

    // 同步偏好中的自启开关到系统（以系统为准回写）
    try {
      const sys = app.getLoginItemSettings();
      if (typeof sys.openAtLogin === 'boolean') {
        prefs.openAtLogin = sys.openAtLogin;
      }
    } catch (_err) {
      /* ignore */
    }

    store = new Store();
    store.loadPersisted();
    createWindow();
    createTray();

    win.webContents.once('did-finish-load', () => {
      tick();
    });
    timer = setInterval(tick, REFRESH_MS);

    // 启动后静默检查更新（截图模式跳过）
    if (!process.env.TOKENREC_SHOT) {
      setTimeout(async () => {
        const result = await runUpdateCheck({ silent: true });
        if (result && result.updateAvailable && win && !win.isDestroyed()) {
          win.webContents.send('update-available', {
            latestVersion: result.latestVersion,
            currentVersion: result.currentVersion,
          });
        }
      }, UPDATE_CHECK_DELAY_MS);
    }

    if (process.env.TOKENREC_SHOT) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            win.show();
            if (process.env.TOKENREC_COMPACT) {
              applyCompact(true);
              await win.webContents.executeJavaScript("document.body.classList.add('compact')");
              await new Promise((r) => setTimeout(r, 350));
            }
            const img = await win.webContents.capturePage();
            const p = path.join(__dirname, '..', '..', '.cache', 'preview.png');
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, img.toPNG());
            console.log('已保存预览截图：' + p);
          } catch (err) {
            console.error('截图失败：', err);
          }
          isQuitting = true;
          app.quit();
        }, 2600);
      });
    }

    ipcMain.on('hide-window', () => hideWindow());
    ipcMain.on('quit', () => {
      isQuitting = true;
      app.quit();
    });
    ipcMain.on('start-update', async () => {
      // 用户从 UI 点了版本号 → 静默下载并重启
      try {
        const { checkForUpdate, downloadAndInstall } = require('./updater');
        const result = await checkForUpdate(APP_VERSION);
        if (!result || !result.updateAvailable) return;
        await downloadAndInstall(result.latest);
        dialog.showMessageBox({
          type: 'info',
          title: '更新完成',
          message: `Token 记录 v${result.latestVersion} 已就绪，即将重启。`,
          buttons: ['好的'],
        }).then(() => {
          isQuitting = true;
          app.quit();
        });
      } catch (err) {
        console.error('自动更新失败：', err);
      }
    });
    ipcMain.on('toggle-pin', (_e, pinned) => {
      if (win) win.setAlwaysOnTop(!!pinned, 'screen-saver');
    });
    ipcMain.on('set-compact', (_e, compact) => {
      applyCompact(!!compact);
    });
    ipcMain.on('fit-content', () => {
      fitWindowToContent();
    });
    ipcMain.handle('get-version', () => APP_VERSION);
    ipcMain.handle('get-prefs', () => ({
      openAtLogin: isOpenAtLoginEnabled(),
      version: APP_VERSION,
      compact: !!prefs.compact,
    }));
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (timer) clearInterval(timer);
  });

  // 隐藏窗口时不退出；无窗口时也不要误退（托盘常驻）
  app.on('window-all-closed', (e) => {
    if (process.platform !== 'darwin' && !isQuitting) {
      // 阻止默认退出：托盘仍在
    }
  });
}
