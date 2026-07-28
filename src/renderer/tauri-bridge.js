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
    startDrag: () => {
      // 返回 Promise，在 OS 拖拽循环结束时 resolve
      return appWindow.startDragging().catch(() => {});
    },
    setCompact: (compact) => { invoke('save_prefs', { prefs: { compact, version: '1.6.2', open_at_login: false } }); },

    fitContent: () => {
      // 测量并调整窗口至内容高度
      // Windows 透明窗口缩小后 hit-test 区域不更新是关键难题
      setTimeout(async () => {
        const h = document.body.scrollHeight;
        if (h <= 60) return;
        const targetH = h + 8;
        try {
          // 先放开最小尺寸 + 临时允许调整大小，强制 DWM 刷新窗口区域
          await appWindow.setResizable(true);
          await appWindow.setMinSize({ width: 200, height: 50 });
          // 设置目标尺寸
          await appWindow.setSize({ width: 420, height: targetH });
          // 恢复不可调大小
          await appWindow.setResizable(false);
          // 设置新的最小尺寸
          await appWindow.setMinSize({ width: 200, height: targetH });
        } catch (_) {}
      }, 100);
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
