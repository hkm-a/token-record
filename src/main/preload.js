'use strict';

// 预加载脚本：在隔离上下文中，通过 contextBridge 暴露最小 API 给渲染层。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onSnapshot: (callback) => {
    ipcRenderer.on('snapshot', (_event, data) => callback(data));
  },
  onPrefs: (callback) => {
    ipcRenderer.on('prefs', (_event, data) => callback(data));
  },
  // 关闭按钮：隐藏到托盘（真正退出走托盘菜单）
  hide: () => ipcRenderer.send('hide-window'),
  quit: () => ipcRenderer.send('quit'),
  refreshNow: () => ipcRenderer.send('refresh-now'),
  togglePin: (pinned) => ipcRenderer.send('toggle-pin', pinned),
  setCompact: (compact) => ipcRenderer.send('set-compact', compact),
  // 按内容收紧窗口高度，消除底部空白
  fitContent: () => ipcRenderer.send('fit-content'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  getPrefs: () => ipcRenderer.invoke('get-prefs'),
});
