import { useCallback, useEffect, useRef, useState } from 'react';

export type BackendState = 'waiting-for-key' | 'starting' | 'ready' | 'error';

export interface ElectronRuntimeState {
  keyConfigured: boolean;
  backendState: BackendState;
  message: string;
  thinkingEnabled: boolean;
}

export interface ElectronRuntime extends ElectronRuntimeState {
  loading: boolean;
  refresh: () => Promise<void>;
}

const browserState: ElectronRuntimeState = {
  keyConfigured: true,
  backendState: 'ready',
  message: '',
  thinkingEnabled: false,
};

const electronLoadingState: ElectronRuntimeState = {
  keyConfigured: true,
  backendState: 'starting',
  message: '',
  thinkingEnabled: false,
};

type BridgeRuntimeState = Awaited<ReturnType<NonNullable<Window['electronAPI']>['runtime']['status']>>;

function normalizeRuntimeState(status: BridgeRuntimeState): ElectronRuntimeState {
  if (!status.hasCredential) {
    return {
      keyConfigured: false,
      backendState: 'waiting-for-key',
      message: '',
      thinkingEnabled: Boolean(status.thinkingEnabled),
    };
  }

  const backendState: BackendState = status.backendState === 'ready'
    ? 'ready'
    : status.backendState === 'error'
      ? 'error'
      : 'starting';
  return {
    keyConfigured: true,
    backendState,
    message: typeof status.message === 'string' ? status.message : '',
    thinkingEnabled: Boolean(status.thinkingEnabled),
  };
}

export function useElectronRuntime(): ElectronRuntime {
  const hasElectron = typeof window !== 'undefined' && Boolean(window.electronAPI);
  const [state, setState] = useState<ElectronRuntimeState>(
    hasElectron ? electronLoadingState : browserState,
  );
  const [loading, setLoading] = useState(hasElectron);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    const request = ++requestRef.current;
    try {
      const next = await api.runtime.status();
      if (!mountedRef.current || request !== requestRef.current) return;
      setState(normalizeRuntimeState(next));
    } catch {
      if (!mountedRef.current || request !== requestRef.current) return;
      setState(previous => ({
        ...previous,
        keyConfigured: true,
        backendState: 'error',
        message: 'Couldn’t get the local service status.',
      }));
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const api = window.electronAPI;
    mountedRef.current = true;
    if (!api) {
      setLoading(false);
      return;
    }

    const unsubscribe = api.runtime.onStatus(status => {
      if (!mountedRef.current) return;
      ++requestRef.current;
      setState(normalizeRuntimeState(status));
      setLoading(false);
    });
    void refresh();

    return () => {
      mountedRef.current = false;
      ++requestRef.current;
      unsubscribe();
    };
  }, [refresh]);

  return { loading, ...state, refresh };
}
