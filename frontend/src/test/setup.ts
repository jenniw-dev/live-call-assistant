// Node 25 exposes an incomplete experimental Storage global that shadows
// jsdom's implementation. Keep tests deterministic until that runtime issue is removed.
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(String(key)) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(String(key)); },
    setItem: (key, value) => { values.set(String(key), String(value)); },
  };
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: memoryStorage(),
});
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: memoryStorage(),
});

Object.defineProperty(globalThis, 'electronAPI', {
  configurable: true,
  writable: true,
  value: {
    isElectron: true,
    platform: 'darwin',
    minimize: () => {},
    hide: () => {},
    close: () => {},
    openExternal: () => {},
    credentials: {
      has: async () => false,
      save: async () => {},
      clear: async () => {},
    },
    runtime: {
      status: async () => ({
        hasCredential: true,
        backendState: 'ready',
        message: '',
        thinkingEnabled: false,
      }),
      setThinking: async () => ({
        hasCredential: true,
        backendState: 'ready',
        message: '',
        thinkingEnabled: false,
      }),
      relaunch: () => {},
      onStatus: () => () => {},
    },
  },
});
