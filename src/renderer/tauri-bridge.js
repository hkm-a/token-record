// Tauri v2 桥接层：暴露与 Electron preload 相同的 window.api 接口
// 依赖 withGlobalTauri: true → window.__TAURI__ 可用
(function () {
  'use strict';
  if (!window.__TAURI__) return;

  const invoke = window.__TAURI__.core.invoke;
  const listen = window.__TAURI__.event.listen;
  const getCurrentWindow = window.__TAURI__.window.getCurrentWindow;
  const LogicalSize = window.__TAURI__.window.LogicalSize;
  const appWindow = getCurrentWindow();

  // ── 轮询（快照） ─────────────────────────────────
  let lastSnapshot = null;
  let pollTimer = null;
  let onDataCallback = null;
  // fitContent 最近一次应用的目标高度（0 表示尚未应用/需要重试）
  let lastFitH = 0;

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

    refreshNow: () => { feed(); },

    togglePin: (pinned) => { appWindow.setAlwaysOnTop(pinned); },
    setCompact: (compact) => { invoke('save_prefs', { prefs: { compact, version: '1.6.4', open_at_login: false } }); },

    // 窗口高度贴合内容。约束：
    // - 必须传 LogicalSize 实例——普通对象会被序列化成 {"undefined":…}，
    //   Rust 端反序列化失败导致 setSize 静默无效（1.6.2 死区的根源：
    //   窗口始终保持初始高度，内容下方的透明区域挡住鼠标点击）。
    // - 高度未变化时零窗口操作；此前每 tick 连发 6 次窗口调用
    //   （setResizable/setMinSize/setSize/setMaxSize…）造成周期性卡顿，
    //   且展开时被上次残留的 maxSize 钳制。窗口保持 resizable:false，
    //   程序化 setSize 不受该状态限制，无需任何 min/max 锁定。
    // - 立即执行：读 scrollHeight 自带强制同步布局，任何延时都会
    //   变成折叠/展开时可感知的窗口滞后。
    fitContent: async () => {
      if (document.body.classList.contains('dragging')) return;
      const h = document.body.scrollHeight;
      if (h <= 60) return; // 布局尚未就绪，跳过
      const targetH = h + 8;
      if (Math.abs(targetH - lastFitH) <= 1) return;
      lastFitH = targetH; // 先记账，避免相邻两次调用重复 resize
      try {
        await appWindow.setSize(new LogicalSize(420, targetH));
        await invoke('force_window_resize');
      } catch (e) {
        lastFitH = 0; // 失败允许下次重试
        console.warn('[tr] fitContent:', e);
      }
    },

    getVersion: () => invoke('get_version'),
    getPrefs: () => invoke('get_prefs'),

    startPolling,
    stopPolling,

    // 检查更新：返回 Promise<string|null>（有更新时返回最新版本号并同时
    // 触发 update-available 事件；无更新返回 null；失败时 reject）
    startUpdate: () => invoke('check_update'),
    applyUpdate: () => { invoke('apply_update'); },
  };
})();
