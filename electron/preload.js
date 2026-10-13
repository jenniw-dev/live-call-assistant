// ─────────────────────────────────────────────────────────────
// preload：主进程 ↔ 渲染进程的安全桥梁
// 只暴露窗口控制 API，不暴露 Node 能力
// ─────────────────────────────────────────────────────────────
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,

  // 窗口操作
  minimize: () => ipcRenderer.send('window:minimize'),
  hide: () => ipcRenderer.send('window:hide'),
  close: () => ipcRenderer.send('window:close'),
  openExternal: (url) => ipcRenderer.send('external:open', url),

  credentials: {
    has: () => ipcRenderer.invoke('credentials:has'),
    save: (key) => ipcRenderer.invoke('credentials:save', key),
    clear: () => ipcRenderer.invoke('credentials:clear'),
  },

  runtime: {
    status: () => ipcRenderer.invoke('runtime:status'),
    setThinking: (enabled) => ipcRenderer.invoke('runtime:set-thinking', Boolean(enabled)),
    relaunch: () => ipcRenderer.send('runtime:relaunch'),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('runtime:status-changed', listener);
      return () => ipcRenderer.removeListener('runtime:status-changed', listener);
    },
  },
});
