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
      const feed = () =>
        invoke('get_snapshot')
          .then((data) => {
            // 对比 generatedAt，数据未变化则跳过
            if (lastSnapshot && data.snapshot.generatedAt === lastSnapshot.snapshot.generatedAt) return;
            // 对比 grand.total，未变化则跳过动画
            if (lastSnapshot && data.snapshot.grand.total === lastSnapshot.snapshot.grand.total) {
              // 数据量未变但仍需更新 UI（不触发动画），直接设 isFirst=false
              data.isFirst = false;
            }
            lastSnapshot = data;
            callback(data);
          })
          .catch((e) => console.warn('[tr] snapshot:', e));
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
          // 直接通知前端
          const evt = new CustomEvent('tr-snapshot', { detail: data });
          window.dispatchEvent(evt);
        })
        .catch(console.warn);
    },

    togglePin: (pinned) => { appWindow.setAlwaysOnTop(pinned); },
    setCompact: (compact) => { invoke('save_prefs', { prefs: { compact, version: '1.5.8', open_at_login: false } }); },

    fitContent: () => {
      const h = document.documentElement.scrollHeight;
      appWindow.setSize({ width: 400, height: Math.min(h + 20, 600) });
    },

    getVersion: () => invoke('get_version'),
    getPrefs: () => invoke('get_prefs'),

    startUpdate: () => { invoke('check_update'); },
    applyUpdate: () => { invoke('apply_update'); },
  };
})();
