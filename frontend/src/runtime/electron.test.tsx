import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useElectronRuntime } from './electron';

type RawStatus = ElectronRuntimeState;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function installRuntime(status: () => Promise<RawStatus>) {
  let listener: ((value: RawStatus) => void) | null = null;
  const unsubscribe = vi.fn();
  const onStatus = vi.fn((callback: (value: RawStatus) => void) => {
    listener = callback;
    return unsubscribe;
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { runtime: { status, onStatus } },
  });
  return {
    emit(value: RawStatus) { listener?.(value); },
    onStatus,
    unsubscribe,
  };
}

function Probe() {
  const runtime = useElectronRuntime();
  return (
    <div>
      <span data-testid="loading">{String(runtime.loading)}</span>
      <span data-testid="key">{String(runtime.keyConfigured)}</span>
      <span data-testid="state">{runtime.backendState}</span>
      <span data-testid="message">{runtime.message}</span>
      <span data-testid="thinking">{String(runtime.thinkingEnabled)}</span>
      <button onClick={() => { void runtime.refresh(); }}>重新整理</button>
    </div>
  );
}

const readyStatus = (message = ''): RawStatus => ({
  hasCredential: true,
  backendState: 'ready',
  message,
  thinkingEnabled: false,
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'electronAPI');
});

describe('useElectronRuntime', () => {
  it('取得初始狀態、正規化欄位且只訂閱一次', async () => {
    const bridge = installRuntime(vi.fn().mockResolvedValue({
      hasCredential: false,
      backendState: 'stopped',
      message: '後端訊息不應蓋過首次設定',
      thinkingEnabled: true,
    }));

    const view = render(<Probe />);

    expect(await screen.findByText('waiting-for-key')).toBeTruthy();
    expect(screen.getByTestId('key').textContent).toBe('false');
    expect(screen.getByTestId('message').textContent).toBe('');
    expect(screen.getByTestId('thinking').textContent).toBe('true');
    view.rerender(<Probe />);
    expect(bridge.onStatus).toHaveBeenCalledTimes(1);
  });

  it('讓訂閱狀態勝過較晚回來的初始請求並在卸載時取消訂閱', async () => {
    const initial = deferred<RawStatus>();
    const bridge = installRuntime(() => initial.promise);
    const view = render(<Probe />);

    act(() => bridge.emit({
      hasCredential: true,
      backendState: 'error',
      message: 'DeepSeek API Key 無效，請到設定中更換。',
      thinkingEnabled: false,
    }));
    initial.resolve(readyStatus('過期狀態'));
    await act(async () => { await initial.promise; });

    expect(screen.getByTestId('state').textContent).toBe('error');
    expect(screen.getByTestId('message').textContent).toContain('API Key 無效');
    view.unmount();
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
    expect(() => bridge.emit(readyStatus('卸載後狀態'))).not.toThrow();
  });

  it('重新整理發生競速時只採用最新請求結果', async () => {
    const older = deferred<RawStatus>();
    const newer = deferred<RawStatus>();
    const status = vi.fn()
      .mockResolvedValueOnce(readyStatus())
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    installRuntime(status);
    render(<Probe />);
    await screen.findByText('ready');

    fireEvent.click(screen.getByRole('button', { name: '重新整理' }));
    fireEvent.click(screen.getByRole('button', { name: '重新整理' }));
    newer.resolve({ ...readyStatus(), backendState: 'error', message: '最新錯誤' });
    await act(async () => { await newer.promise; });
    older.resolve(readyStatus('過期成功'));
    await act(async () => { await older.promise; });

    expect(screen.getByTestId('state').textContent).toBe('error');
    expect(screen.getByTestId('message').textContent).toBe('最新錯誤');
  });

  it('狀態請求失敗時安全結束載入且不產生未處理拒絕', async () => {
    installRuntime(() => Promise.reject(new Error('native secret detail')));
    render(<Probe />);

    expect((await screen.findByTestId('loading')).textContent).toBe('false');
    expect(screen.getByTestId('state').textContent).toBe('error');
    expect(screen.getByTestId('message').textContent).toBe('Couldn’t get the local service status.');
    expect(document.body.textContent).not.toContain('native secret detail');
  });
});
