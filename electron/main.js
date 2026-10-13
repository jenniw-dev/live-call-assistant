// ─────────────────────────────────────────────────────────────
// Live Call Assistant — Electron 主进程
// 职责：窗口管理（无边框/置顶）、显示/隐藏快捷键
// 不涉及任何业务逻辑，业务仍走 HTTP → FastAPI(8001)
// ─────────────────────────────────────────────────────────────
const { spawn } = require('child_process');
const {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  safeStorage,
  session,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { BackendManager } = require('./backend-manager');
const { configureDisplayCapture } = require('./display-capture');
const { KeyStore } = require('./key-store');
const { createQuitCoordinator } = require('./quit-coordinator');
const { registerRuntimeIpc } = require('./runtime-ipc');
const { RuntimeSettings } = require('./runtime-settings');
const { configureWindowSecurity, registerExternalLinkIpc } = require('./window-security');

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL; // 开发模式由 npm run electron-dev 注入

let win = null;
let backendManager = null;
let quitCoordinator = null;
let runtimeController = null;
let disposeExternalLinkIpc = null;

// ── 窗口位置/尺寸记忆：移动或调整大小后落盘，下次启动恢复 ──
function boundsFile() {
  return path.join(app.getPath('userData'), 'window-bounds.json');
}

function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    if (b && b.width >= 760 && b.height >= 520) return b;
  } catch { /* 首次启动/损坏 → 用默认值 */ }
  return null;
}

function saveBounds() {
  if (!win) return;
  try {
    fs.writeFileSync(boundsFile(), JSON.stringify(win.getBounds()));
  } catch { /* 磁盘异常静默 */ }
}

function createWindow() {
  win = new BrowserWindow({
    ...(loadBounds() || { width: 1280, height: 820 }), // 全布局（左右卡片+输入坞）默认尺寸
    minWidth: 760,
    minHeight: 520,
    frame: false,                 // 无边框
    transparent: true,            // 半透明背景（配合前端毛玻璃）
    alwaysOnTop: true,            // 置顶：桌面任意应用之上
    resizable: true,              // 可调整大小
    hasShadow: false,             // 透明窗口关阴影，避免黑边
    skipTaskbar: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,     // 安全：渲染进程不能直接碰 Node
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  configureWindowSecurity(win.webContents);

  // 位置记忆：移动/调整后保存
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);

  // 置顶显示在通话软件（Zoom/Teams/Meet）上方，方便客服边听边看
  win.setAlwaysOnTop(true, 'screen-saver');

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL); // 开发：Vite dev server（自带 /api 代理）
  } else {
    win.loadFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html')); // 生产：构建产物
  }

  win.on('closed', () => { win = null; });
}

// ── 显示 / 隐藏 ───────────────────────────────────────────────
function toggleVisible() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver'); // show 后重新确保置顶
  }
}

function registerShortcuts() {
  // Ctrl+Shift+Space → 显示/隐藏浮窗
  globalShortcut.register('CommandOrControl+Shift+Space', toggleVisible);
}

// ── IPC：渲染进程（前端按钮）→ 主进程 ──────────────────────────
function registerIpc() {
  ipcMain.on('window:minimize', () => win && win.minimize());
  ipcMain.on('window:hide', () => win && win.hide());
  ipcMain.on('window:close', () => app.quit());
  disposeExternalLinkIpc = registerExternalLinkIpc({ ipcMain, shell });
}

function setupBackendRuntime() {
  const resourcesPath = path.resolve(process.resourcesPath);
  const userDataPath = path.resolve(app.getPath('userData'));
  const keyStore = new KeyStore({ safeStorage, userDataPath });
  const runtimeSettings = new RuntimeSettings({ userDataPath });
  backendManager = new BackendManager({
    spawn,
    fetch: globalThis.fetch,
    resourcesPath,
    userDataPath,
  });
  runtimeController = registerRuntimeIpc({
    ipcMain,
    app,
    keyStore,
    runtimeSettings,
    backend: backendManager,
    broadcastStatus: (status) => {
      if (win && !win.isDestroyed()) win.webContents.send('runtime:status-changed', status);
    },
  });
  quitCoordinator = createQuitCoordinator({
    app,
    backend: backendManager,
    dispose: () => {
      runtimeController?.dispose();
      runtimeController = null;
      disposeExternalLinkIpc?.();
      disposeExternalLinkIpc = null;
    },
  });
  void runtimeController.startIfConfigured().catch(() => {
    // BackendManager already emitted a renderer-safe status.
  });
}

// ── 系统音频捕获（监听客户声音）─────────────────────────────
// Electron 就緒後才註冊。macOS 由系統選擇器決定分享來源；
// Windows loopback 僅存在於 display-capture.js 的非 macOS 分支。
app.whenReady().then(() => {
  configureDisplayCapture({ session, desktopCapturer, platform: process.platform });
  createWindow();
  registerIpc();
  registerShortcuts();
  setupBackendRuntime();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', (event) => {
  globalShortcut.unregisterAll();
  if (quitCoordinator) void quitCoordinator(event);
});

app.on('window-all-closed', () => {
  app.quit();
});
