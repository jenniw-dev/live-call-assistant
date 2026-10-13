import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';

type RawStatus = ElectronRuntimeState;

const readyStatus = (): RawStatus => ({
  hasCredential: true,
  backendState: 'ready',
  message: '',
  thinkingEnabled: false,
});

const privateKey = () => `sk-${crypto.randomUUID().split('-').join('')}`;

function installApi(status: ReturnType<typeof vi.fn>) {
  let listener: ((value: RawStatus) => void) | null = null;
  const save = vi.fn().mockResolvedValue(undefined);
  const clear = vi.fn().mockResolvedValue(undefined);
  const setThinking = vi.fn().mockResolvedValue(readyStatus());
  const relaunch = vi.fn();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      isElectron: true,
      platform: 'darwin',
      minimize: vi.fn(),
      hide: vi.fn(),
      close: vi.fn(),
      credentials: { has: vi.fn(), save, clear },
      runtime: {
        status,
        setThinking,
        relaunch,
        onStatus: vi.fn((callback: (value: RawStatus) => void) => {
          listener = callback;
          return vi.fn();
        }),
      },
    },
  });
  return {
    save,
    clear,
    setThinking,
    relaunch,
    emit(value: RawStatus) { listener?.(value); },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App Electron runtime gating', () => {
  it('等待初始狀態時顯示準備畫面', () => {
    installApi(vi.fn(() => new Promise(() => {})));
    render(<App />);

    expect(screen.getByText('Starting Live Call Assistant…')).toBeTruthy();
    expect(screen.queryAllByText(/Live transcript/)).toHaveLength(0);
  });

  it('首次使用優先顯示設定而不是後端錯誤，儲存後重新整理', async () => {
    const status = vi.fn()
      .mockResolvedValueOnce({
        hasCredential: false,
        backendState: 'error',
        message: '不應出現的後端錯誤',
        thinkingEnabled: false,
      })
      .mockResolvedValueOnce(readyStatus());
    const api = installApi(status);
    render(<App />);

    const input = await screen.findByLabelText('DeepSeek API Key');
    const key = privateKey();
    expect(screen.queryByText('不應出現的後端錯誤')).toBeNull();
    await userEvent.type(input, key);
    await userEvent.click(screen.getByRole('button', { name: 'Save securely and start' }));

    expect(api.save).toHaveBeenCalledWith(key);
    await waitFor(() => expect(screen.queryByLabelText('DeepSeek API Key')).toBeNull());
    expect(document.body.textContent).not.toContain(key);
    const storedValues = Array.from(
      { length: window.localStorage.length },
      (_, index) => window.localStorage.getItem(window.localStorage.key(index) ?? '') ?? '',
    );
    expect(storedValues.join('')).not.toContain(key);
  });

  it('後端錯誤保留原始安全訊息並可直接開啟設定', async () => {
    installApi(vi.fn().mockResolvedValue({
      ...readyStatus(),
      backendState: 'error',
      message: 'DeepSeek API Key 無效，請更換後再試一次。',
    }));
    render(<App />);

    expect(await screen.findByText('DeepSeek API Key 無效，請更換後再試一次。')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open DeepSeek settings' }));

    expect(screen.getByRole('dialog', { name: 'DeepSeek settings' })).toBeTruthy();
  });

  it('服務就緒後可從完整版工具列開啟設定', async () => {
    installApi(vi.fn().mockResolvedValue(readyStatus()));
    render(<App />);

    await screen.findAllByText(/Live transcript/);
    await userEvent.click(screen.getByRole('button', { name: 'Open DeepSeek settings' }));

    expect(screen.getByRole('dialog', { name: 'DeepSeek settings' })).toBeTruthy();
  });

  it('運行時錯誤暫時遮罩介面但不清除已辨識或編輯的問題', async () => {
    const api = installApi(vi.fn().mockResolvedValue(readyStatus()));
    render(<App />);
    const input = await screen.findByPlaceholderText(/The caller’s question is transcribed here/);
    fireEvent.change(input, { target: { value: '請保留這段已辨識問題' } });

    act(() => api.emit({
      ...readyStatus(),
      backendState: 'error',
      message: 'DeepSeek is temporarily unavailable。',
    }));
    expect(screen.getByText('DeepSeek is temporarily unavailable。')).toBeTruthy();
    act(() => api.emit(readyStatus()));

    expect((await screen.findByPlaceholderText(/The caller’s question is transcribed here/) as HTMLTextAreaElement).value)
      .toBe('請保留這段已辨識問題');
  });

  it('設定中的Answer mode切換會透過安全橋接並重新整理狀態', async () => {
    const status = vi.fn()
      .mockResolvedValueOnce(readyStatus())
      .mockResolvedValueOnce({ ...readyStatus(), thinkingEnabled: true });
    const api = installApi(status);
    render(<App />);
    await screen.findAllByText(/Live transcript/);
    await userEvent.click(screen.getByRole('button', { name: 'Open DeepSeek settings' }));

    await userEvent.click(screen.getByRole('checkbox', { name: 'Deep thinking' }));

    expect(api.setThinking).toHaveBeenCalledWith(true);
    await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Deep thinking' }) as HTMLInputElement).checked).toBe(true));
  });

  it('Remove金鑰後立即返回首次設定畫面', async () => {
    const status = vi.fn()
      .mockResolvedValueOnce(readyStatus())
      .mockResolvedValueOnce({
        hasCredential: false,
        backendState: 'stopped',
        message: '',
        thinkingEnabled: false,
      });
    const api = installApi(status);
    render(<App />);
    await screen.findAllByText(/Live transcript/);
    await userEvent.click(screen.getByRole('button', { name: 'Open DeepSeek settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove API key' }));

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(api.clear).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('heading', { name: 'Set up DeepSeek' })).toBeTruthy();
  });

  it('後端關閉尚未完成時已根據即時狀態返回首次設定', async () => {
    const status = vi.fn()
      .mockResolvedValueOnce(readyStatus())
      .mockResolvedValue({
        hasCredential: false,
        backendState: 'stopped',
        message: '',
        thinkingEnabled: false,
      });
    const api = installApi(status);
    let finishClear: (() => void) | undefined;
    let clearSettled = false;
    api.clear.mockImplementation(() => new Promise<void>((resolve) => {
      finishClear = () => {
        clearSettled = true;
        resolve();
      };
    }));
    render(<App />);
    await screen.findAllByText(/Live transcript/);
    await userEvent.click(screen.getByRole('button', { name: 'Open DeepSeek settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove API key' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

    act(() => api.emit({
      hasCredential: false,
      backendState: 'ready',
      message: '',
      thinkingEnabled: false,
    }));

    expect(await screen.findByRole('heading', { name: 'Set up DeepSeek' })).toBeTruthy();
    expect(clearSettled).toBe(false);
    await act(async () => { finishClear?.(); });
    expect(screen.getByRole('heading', { name: 'Set up DeepSeek' })).toBeTruthy();
  });

  it('移除金鑰未完成時立即顯示首次設定但阻擋新金鑰送出', async () => {
    const noKeyStatus: RawStatus = {
      hasCredential: false,
      backendState: 'stopped',
      message: '',
      thinkingEnabled: false,
    };
    const status = vi.fn()
      .mockResolvedValueOnce(readyStatus())
      .mockResolvedValue(noKeyStatus);
    const api = installApi(status);
    let finishClear: (() => void) | undefined;
    api.clear.mockImplementation(() => new Promise<void>((resolve) => {
      finishClear = resolve;
    }));
    render(<App />);
    await screen.findAllByText(/Live transcript/);
    await userEvent.click(screen.getByRole('button', { name: 'Open DeepSeek settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove API key' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

    act(() => api.emit({ ...noKeyStatus, backendState: 'ready' }));
    const input = await screen.findByLabelText('DeepSeek API Key') as HTMLInputElement;
    const blockedKey = privateKey();
    const inputWasDisabled = input.disabled;
    const busyWasVisible = screen.queryByText('Finishing removal of the old key, please wait…') !== null;
    await userEvent.type(input, blockedKey);
    await userEvent.click(screen.getByRole('button', { name: /Save securely and start|Finishing removal/ }));
    const savesBeforeClearSettled = api.save.mock.calls.length;

    await act(async () => { finishClear?.(); });
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(inputWasDisabled).toBe(true);
    expect(busyWasVisible).toBe(true);
    expect(savesBeforeClearSettled).toBe(0);

    const replacementKey = privateKey();
    await userEvent.type(input, replacementKey);
    await userEvent.click(screen.getByRole('button', { name: 'Save securely and start' }));
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save).toHaveBeenCalledWith(replacementKey);
  });

  it('移除儲存失敗時保留設定與已配置狀態', async () => {
    const api = installApi(vi.fn().mockResolvedValue(readyStatus()));
    let failClear: ((error: Error) => void) | undefined;
    api.clear.mockImplementation(() => new Promise<void>((_resolve, reject) => {
      failClear = reject;
    }));
    render(<App />);
    await screen.findAllByText(/Live transcript/);
    await userEvent.click(screen.getByRole('button', { name: 'Open DeepSeek settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove API key' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect((screen.getByRole('button', { name: 'Close settings' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { failClear?.(new Error('native keychain error')); });

    expect((await screen.findByRole('alert')).textContent).toContain("Couldn’t remove the API key");
    expect(screen.getByRole('dialog', { name: 'DeepSeek settings' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Set up DeepSeek' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Close settings' }) as HTMLButtonElement).disabled).toBe(false);
    const key = privateKey();
    await userEvent.type(screen.getByLabelText('New DeepSeek API key'), key);
    await userEvent.click(screen.getByRole('button', { name: 'Replace key securely' }));
    expect(api.save).toHaveBeenCalledWith(key);
  });
});
