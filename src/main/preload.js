'use strict';

// 预加载脚本：在隔离上下文中，通过 contextBridge 暴露最小、安全的 API 给渲染层。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 订阅主进程推送的快照（{ snapshot, delta, isFirst }）。
  onSnapshot: (callback) => {
    ipcRenderer.on('snapshot', (_event, data) => callback(data));
  },
  // 窗口控制
  quit: () => ipcRenderer.send('quit'),
  refreshNow: () => ipcRenderer.send('refresh-now'),
  togglePin: (pinned) => ipcRenderer.send('toggle-pin', pinned),
  setCompact: (compact) => ipcRenderer.send('set-compact', compact),
});
