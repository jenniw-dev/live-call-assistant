function normalizeExternalUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function configureWindowSecurity(webContents) {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (event) => event.preventDefault());
}

function registerExternalLinkIpc({ ipcMain, shell }) {
  const listener = (_event, value) => {
    const url = normalizeExternalUrl(value);
    if (!url) return;
    void Promise.resolve(shell.openExternal(url)).catch(() => {
      // External application failures are non-fatal and contain no renderer data.
    });
  };
  ipcMain.on('external:open', listener);
  return () => ipcMain.removeListener('external:open', listener);
}

module.exports = {
  configureWindowSecurity,
  normalizeExternalUrl,
  registerExternalLinkIpc,
};
