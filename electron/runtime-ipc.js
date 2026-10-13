const ALLOWED_BACKEND_STATES = new Set(['stopped', 'starting', 'ready', 'error']);

function safeBackendStatus(status) {
  const backendState = ALLOWED_BACKEND_STATES.has(status && status.backendState)
    ? status.backendState
    : 'error';
  return {
    backendState,
    message: typeof (status && status.message) === 'string' ? status.message : '',
  };
}

function registerRuntimeIpc({
  ipcMain,
  app,
  keyStore,
  runtimeSettings,
  backend,
  broadcastStatus,
}) {
  const runtimeState = () => ({
    hasCredential: keyStore.has(),
    thinkingEnabled: runtimeSettings.getThinking(),
    ...safeBackendStatus(backend.getStatus()),
  });

  const onBackendStatus = (status) => {
    broadcastStatus({
      hasCredential: keyStore.has(),
      thinkingEnabled: runtimeSettings.getThinking(),
      ...safeBackendStatus(status),
    });
  };
  backend.on('status', onBackendStatus);

  ipcMain.handle('credentials:has', () => keyStore.has());
  ipcMain.handle('credentials:save', async (_event, key) => {
    keyStore.save(key);
    await backend.start({
      apiKey: keyStore.readForBackend(),
      thinking: runtimeSettings.getThinking(),
    });
  });
  ipcMain.handle('credentials:clear', async () => {
    keyStore.clear();
    broadcastStatus({
      hasCredential: false,
      thinkingEnabled: runtimeSettings.getThinking(),
      ...safeBackendStatus(backend.getStatus()),
    });
    await backend.stop();
  });
  ipcMain.handle('runtime:status', () => runtimeState());
  ipcMain.handle('runtime:set-thinking', async (_event, enabled) => {
    runtimeSettings.setThinking(Boolean(enabled));
    if (keyStore.has()) {
      await backend.start({
        apiKey: keyStore.readForBackend(),
        thinking: runtimeSettings.getThinking(),
      });
    }
    return runtimeState();
  });

  const onRelaunch = async () => {
    await backend.stop();
    app.relaunch();
    app.exit(0);
  };
  ipcMain.on('runtime:relaunch', onRelaunch);

  return {
    runtimeState,
    async startIfConfigured() {
      if (!keyStore.has()) return false;
      await backend.start({
        apiKey: keyStore.readForBackend(),
        thinking: runtimeSettings.getThinking(),
      });
      return true;
    },
    dispose() {
      backend.removeListener('status', onBackendStatus);
      ipcMain.removeHandler('credentials:has');
      ipcMain.removeHandler('credentials:save');
      ipcMain.removeHandler('credentials:clear');
      ipcMain.removeHandler('runtime:status');
      ipcMain.removeHandler('runtime:set-thinking');
      ipcMain.removeListener('runtime:relaunch', onRelaunch);
    },
  };
}

module.exports = { registerRuntimeIpc, safeBackendStatus };
