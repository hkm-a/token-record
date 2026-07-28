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
        if (h <= 60) return;
        const targetH = h + 8;
        try {
          await appWindow.setResizable(true);
          await appWindow.setMinSize({ width: 200, height: 50 });
          await appWindow.setSize({ width: 420, height: targetH });
          await invoke('force_window_resize');
          await appWindow.setResizable(false);
        } catch (_) {}
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
