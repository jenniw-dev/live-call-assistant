// Electron preload 暴露的 API 类型声明
export {};

declare global {
  interface ElectronRuntimeState {
    hasCredential: boolean;
    thinkingEnabled: boolean;
    backendState: 'stopped' | 'starting' | 'ready' | 'error';
    message: string;
  }

  interface Window {
    electronAPI?: {
      isElectron: boolean;
      platform: string;
      minimize: () => void;
      hide: () => void;
      close: () => void;
      openExternal: (url: string) => void;
      credentials: {
        has: () => Promise<boolean>;
        save: (key: string) => Promise<void>;
        clear: () => Promise<void>;
      };
      runtime: {
        status: () => Promise<ElectronRuntimeState>;
        setThinking: (enabled: boolean) => Promise<ElectronRuntimeState>;
        relaunch: () => void;
        onStatus: (callback: (status: ElectronRuntimeState) => void) => () => void;
      };
    };
  }
}
