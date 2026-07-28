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
      // 测量并调整窗口至内容高度
      // Windows 透明窗口缩小后 DWM hit-test 区域不更新：
      // 根本原因是 DwmEnableBlurBehindWindow 创建的 blur region
      // 在窗口缩小后没有被 DWM 重算。
      // 解法：临时拆卸 blur → 设尺寸(SWP_FRAMECHANGED) → 重建 blur
      setTimeout(async () => {
        const h = document.body.scrollHeight;
        if (h <= 60) return;
        const targetH = h + 8;
        try {
          // 1. 拆卸 DWM blur，释放旧 blur region
          await invoke('set_window_blur', { enabled: false });
          // 2. 调整窗口
          await appWindow.setResizable(true);
          await appWindow.setMinSize({ width: 200, height: 50 });
          await appWindow.setSize({ width: 420, height: targetH });
          // 3. 强制 DWM 刷新窗口区域（SWP_FRAMECHANGED）
          await invoke('force_window_resize');
          await appWindow.setResizable(false);
          // 4. 等待一小段时间让 DWM 完成更新
          await new Promise(r => setTimeout(r, 50));
          // 5. 重建 blur region（新的 region 匹配新窗口尺寸）
          await invoke('set_window_blur', { enabled: true });
        } catch (_) {}
      }, 100);
    },

    getVersion: () => invoke('get_version'),
    getPrefs: () => invoke('get_prefs'),

    setBlur: (enabled) => { invoke('set_window_blur', { enabled }); },
    startUpdate: () => {
      invoke('check_update')
        .catch((e) => console.warn('[tr] check_update failed:', e));
    },
    applyUpdate: () => { invoke('apply_update'); },
  };
})();
