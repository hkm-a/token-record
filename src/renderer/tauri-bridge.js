// Tauri v2 桥接层：暴露与 Electron preload 相同的 window.api 接口
// 依赖 withGlobalTauri: true → window.__TAURI__ 可用
(function () {
  'use strict';
  if (!window.__TAURI__) return;

  const invoke = window.__TAURI__.core.invoke;
  const listen = window.__TAURI__.event.listen;
  const getCurrentWindow = window.__TAURI__.window.getCurrentWindow;
  const appWindow = getCurrentWindow();

  // 缓存上次快照，仅在数据变化时通知前端（防止鬼畜刷新）
  let lastSnapshot = null;

  window.api = {

    onSnapshot: (callback) => {
      const feed = () => {
        // 拖拽期间暂停轮询，避免 IPC + DOM 更新导致卡顿
        if (document.body.classList.contains('dragging')) return;
        invoke('get_snapshot')
          .then((data) => {
            if (lastSnapshot && data.snapshot.generatedAt === lastSnapshot.snapshot.generatedAt) return;
            if (lastSnapshot && data.snapshot.grand.total === lastSnapshot.snapshot.grand.total) {
              data.isFirst = false;
            }
            lastSnapshot = data;
            callback(data);
          })
          .catch((e) => console.warn('[tr] snapshot:', e));
      };
      feed();
      const id = setInterval(feed, 2000);
      listen('refresh-now', () => feed());
      return () => clearInterval(id);
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
      // 测量实际内容高度并调整窗口
      // 先放开最小尺寸约束，允许窗口缩小（Windows DWM 透明窗口需此步）
      appWindow.setMinSize({ width: 200, height: 50 }).catch(() => {});
      setTimeout(() => {
        const h = document.body.scrollHeight;
        if (h > 60) {
          const targetH = h + 8;
          // Windows 透明窗口缩小后 hit-test 区域可能不更新，
          // 两步设尺寸强制 DWM 刷新窗口可见区域
          const interim = Math.max(60, targetH - 20);
          appWindow
            .setSize({ width: 420, height: interim })
            .then(() => appWindow.setSize({ width: 420, height: targetH }))
            .catch(() => {});
        }
      }, 80);
    },

    getVersion: () => invoke('get_version'),
    getPrefs: () => invoke('get_prefs'),

    startUpdate: () => {
      invoke('check_update')
        .catch((e) => console.warn('[tr] check_update failed:', e));
    },
    applyUpdate: () => { invoke('apply_update'); },
  };
})();
