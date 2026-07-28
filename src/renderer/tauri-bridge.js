// Tauri v2 桥接层：暴露与 Electron preload 相同的 window.api 接口
// 依赖 withGlobalTauri: true → window.__TAURI__ 可用
(function () {
  'use strict';
  if (!window.__TAURI__) return;

  const invoke = window.__TAURI__.core.invoke;
  const listen = window.__TAURI__.event.listen;
  const getCurrentWindow = window.__TAURI__.window.getCurrentWindow;
  const appWindow = getCurrentWindow();

  // ── 轮询（快照） ─────────────────────────────────
  let lastSnapshot = null;
  let pollTimer = null;
  let onDataCallback = null;

  const feed = () => {
    if (document.body.classList.contains('dragging')) return;
    invoke('get_snapshot')
      .then((data) => {
        if (lastSnapshot && data.snapshot.generatedAt === lastSnapshot.snapshot.generatedAt) return;
        if (lastSnapshot && data.snapshot.grand.total === lastSnapshot.snapshot.grand.total) {
          data.isFirst = false;
        }
        lastSnapshot = data;
        if (onDataCallback) onDataCallback(data);
      })
      .catch((e) => console.warn('[tr] snapshot:', e));
  };

  function startPolling() {
    if (pollTimer) return;
    feed();
    pollTimer = setInterval(feed, 2000);
  }
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ── API ──────────────────────────────────────────
  window.api = {

    onSnapshot: (callback) => {
      onDataCallback = callback;
      startPolling();
      listen('refresh-now', () => feed());
      return () => {
        stopPolling();
        onDataCallback = null;
      };
    },

    onPrefs: (callback) => {
      invoke('get_prefs').then(callback);
      listen('prefs-changed', () => invoke('get_prefs').then(callback));
    },

    onUpdateAvailable: (callback) => {
      listen('update-available', (e) => callback(e.payload));
    },

    onUpdateProgress: (callback) => {
      listen('update-download-progress', (e) => callback(e.payload));
    },

    hide: () => { appWindow.hide(); },
    quit: () => { invoke('quit_app'); },

    refreshNow: () => {
      invoke('get_snapshot')
        .then((data) => {
          lastSnapshot = data;
        })
        .catch(console.warn);
    },

    togglePin: (pinned) => { appWindow.setAlwaysOnTop(pinned); },
    setCompact: (compact) => { invoke('save_prefs', { prefs: { compact, version: '1.6.2', open_at_login: false } }); },

    fitContent: () => {
      setTimeout(async () => {
        const h = document.body.scrollHeight;
        console.log('[fitContent] scrollHeight=' + h);
        if (h <= 60) {
          console.log('[fitContent] too small, skip');
          return;
        }
        const targetH = h + 8;
        try {
          console.log('[fitContent] setResizable(true)');
          await appWindow.setResizable(true);
          console.log('[fitContent] setMinSize(200,50)');
          await appWindow.setMinSize({ width: 200, height: 50 });
          console.log('[fitContent] setSize(420,' + targetH + ')');
          await appWindow.setSize({ width: 420, height: targetH });
          console.log('[fitContent] force_window_resize');
          await invoke('force_window_resize');
          // 不用 setResizable(false) — 那会导致 DWM hit-test 回弹。
          // 改为设 min=max=targetH，窗口被锁定在目标尺寸但 resizable 状态不变。
          console.log('[fitContent] setMinSize(420,' + targetH + ')');
          await appWindow.setMinSize({ width: 420, height: targetH });
          if (appWindow.setMaxSize) {
            console.log('[fitContent] setMaxSize(420,' + targetH + ')');
            await appWindow.setMaxSize({ width: 420, height: targetH });
          }
          console.log('[fitContent] done, targetH=' + targetH);
        } catch (e) {
          console.warn('[fitContent] ERROR:', e);
        }
      }, 100);
    },

    getVersion: () => invoke('get_version'),
    getPrefs: () => invoke('get_prefs'),

    startPolling,
    stopPolling,

    startUpdate: () => {
      invoke('check_update')
        .catch((e) => console.warn('[tr] check_update failed:', e));
    },
    applyUpdate: () => { invoke('apply_update'); },
  };
})();
