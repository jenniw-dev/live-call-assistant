import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DeepSeekSettings from './DeepSeekSettings';

const privateKey = () => `sk-${crypto.randomUUID().split('-').join('')}`;

const baseProps = () => ({
  backendState: 'ready' as const,
  message: '',
  thinkingEnabled: false,
  saveKey: vi.fn().mockResolvedValue(undefined),
  clearKey: vi.fn().mockResolvedValue(undefined),
  setThinking: vi.fn().mockResolvedValue(undefined),
  onClose: vi.fn(),
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('DeepSeekSettings', () => {
  it('以寫入專用密碼欄位更換金鑰並在成功後清空', async () => {
    const props = baseProps();
    render(<DeepSeekSettings {...props} />);
    const input = screen.getByLabelText('New DeepSeek API key') as HTMLInputElement;
    const key = privateKey();

    await userEvent.type(input, key);
    await userEvent.click(screen.getByRole('button', { name: 'Replace key securely' }));

    expect(props.saveKey).toHaveBeenCalledWith(key);
    expect(input.value).toBe('');
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    expect(document.body.textContent).not.toContain(key);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('更換失敗仍清空欄位且不顯示金鑰內容', async () => {
    const props = baseProps();
    const key = privateKey();
    props.saveKey.mockRejectedValue(new Error(key));
    render(<DeepSeekSettings {...props} />);
    const input = screen.getByLabelText('New DeepSeek API key') as HTMLInputElement;

    await userEvent.type(input, key);
    await userEvent.click(screen.getByRole('button', { name: 'Replace key securely' }));

    expect((await screen.findByRole('alert')).textContent).toContain("Couldn’t replace the DeepSeek API key");
    expect(input.value).toBe('');
    expect(document.body.textContent).not.toContain(key);
  });

  it('空白的新金鑰不會送出', async () => {
    const props = baseProps();
    render(<DeepSeekSettings {...props} />);
    const input = screen.getByLabelText('New DeepSeek API key') as HTMLInputElement;

    await userEvent.type(input, '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Replace key securely' }));

    expect(props.saveKey).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Enter a new DeepSeek API key');
    expect(input.value).toBe('');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('只有在應用內再次確認後才移除金鑰', async () => {
    const props = baseProps();
    render(<DeepSeekSettings {...props} />);

    await userEvent.click(screen.getByRole('button', { name: 'Remove API key' }));
    expect(props.clearKey).not.toHaveBeenCalled();
    expect(screen.getByText('You’ll go straight back to the first-time setup screen.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(props.clearKey).toHaveBeenCalledTimes(1);
  });

  it('切換Deep thinking並顯示安全的後端錯誤訊息', async () => {
    const props = baseProps();
    render(
      <DeepSeekSettings
        {...props}
        backendState="error"
        message="DeepSeek API Key 無效，請更換後再試一次。"
      />,
    );

    expect(screen.getByRole('status').textContent).toContain('DeepSeek API Key 無效');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Deep thinking' }));

    expect(props.setThinking).toHaveBeenCalledWith(true);
  });

  it('更換金鑰進行中會鎖定所有後端變更操作', async () => {
    const props = baseProps();
    const pending = deferred();
    props.saveKey.mockReturnValue(pending.promise);
    render(<DeepSeekSettings {...props} />);
    const input = screen.getByLabelText('New DeepSeek API key') as HTMLInputElement;

    await userEvent.type(input, privateKey());
    await userEvent.click(screen.getByRole('button', { name: 'Replace key securely' }));

    expect(screen.getByRole('checkbox', { name: 'Deep thinking' }).matches(':disabled')).toBe(true);
    expect((screen.getByRole('button', { name: 'Remove API key' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Deep thinking' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove API key' }));
    expect(props.setThinking).not.toHaveBeenCalled();
    expect(props.clearKey).not.toHaveBeenCalled();

    await act(async () => { pending.resolve(); });
    await waitFor(() => expect(input.disabled).toBe(false));
  });

  it('Answer mode切換進行中拒絕第二個金鑰變更', async () => {
    const props = baseProps();
    const pending = deferred();
    props.setThinking.mockReturnValue(pending.promise);
    render(<DeepSeekSettings {...props} />);
    const input = screen.getByLabelText('New DeepSeek API key') as HTMLInputElement;

    await userEvent.type(input, privateKey());
    await userEvent.click(screen.getByRole('checkbox', { name: 'Deep thinking' }));
    fireEvent.submit(input.closest('form')!);
    await userEvent.click(screen.getByRole('button', { name: 'Remove API key' }));

    expect(props.setThinking).toHaveBeenCalledTimes(1);
    expect(props.saveKey).not.toHaveBeenCalled();
    expect(props.clearKey).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(); });
  });

  it('移除金鑰進行中拒絕第二個Answer mode或更換操作', async () => {
    const props = baseProps();
    const pending = deferred();
    props.clearKey.mockReturnValue(pending.promise);
    render(<DeepSeekSettings {...props} />);
    const input = screen.getByLabelText('New DeepSeek API key') as HTMLInputElement;
    await userEvent.type(input, privateKey());
    await userEvent.click(screen.getByRole('button', { name: 'Remove API key' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

    fireEvent.submit(input.closest('form')!);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Deep thinking' }));

    expect(props.clearKey).toHaveBeenCalledTimes(1);
    expect(props.saveKey).not.toHaveBeenCalled();
    expect(props.setThinking).not.toHaveBeenCalled();
    expect(input.value).toBe('');
    await act(async () => { pending.resolve(); });
  });

  it('開啟時將焦點移入對話框並將 Tab 限制在其中', async () => {
    render(<DeepSeekSettings {...baseProps()} />);
    const close = screen.getByRole('button', { name: 'Close settings' });
    const remove = screen.getByRole('button', { name: 'Remove API key' });

    await waitFor(() => expect(document.activeElement).toBe(close));
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(remove);
    await userEvent.tab();
    expect(document.activeElement).toBe(close);
  });

  it('在一般佈局可用 Escape 關閉並還原原本焦點', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>開啟測試設定</button>
          {open && <DeepSeekSettings {...baseProps()} onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: '開啟測試設定' });
    await userEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'DeepSeek settings' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close settings' })));

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'DeepSeek settings' })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('更換金鑰未完成時關閉按鈕不會卸載對話框或重置鎖', async () => {
    const props = baseProps();
    const pending = deferred();
    props.saveKey.mockReturnValue(pending.promise);
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>開啟測試設定</button>
          {open && <DeepSeekSettings {...props} onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: '開啟測試設定' }));
    const input = screen.getByLabelText('New DeepSeek API key');
    await userEvent.type(input, privateKey());
    await userEvent.click(screen.getByRole('button', { name: 'Replace key securely' }));

    await userEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    const dialogWhilePending = screen.queryByRole('dialog', { name: 'DeepSeek settings' });
    await act(async () => { pending.resolve(); });

    expect(dialogWhilePending).not.toBeNull();
    expect(props.saveKey).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(screen.queryByRole('dialog', { name: 'DeepSeek settings' })).toBeNull();
  });

  it('Answer mode未完成時 Escape 不會卸載對話框或重置鎖', async () => {
    const props = baseProps();
    const pending = deferred();
    props.setThinking.mockReturnValue(pending.promise);
    render(<DeepSeekSettings {...props} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Deep thinking' }));

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'DeepSeek settings' }), { key: 'Escape' });
    const closeWhilePending = props.onClose.mock.calls.length;
    await act(async () => { pending.resolve(); });

    expect(closeWhilePending).toBe(0);
    expect(props.setThinking).toHaveBeenCalledTimes(1);
  });

  it('操作使當前焦點控制項停用時會將焦點移到對話框安全落點', async () => {
    const props = baseProps();
    const pending = deferred();
    props.saveKey.mockReturnValue(pending.promise);
    render(<DeepSeekSettings {...props} />);
    await userEvent.type(screen.getByLabelText('New DeepSeek API key'), privateKey());
    await userEvent.click(screen.getByRole('button', { name: 'Replace key securely' }));
    const dialog = screen.getByRole('dialog', { name: 'DeepSeek settings' });
    const activeWhilePending = document.activeElement as HTMLElement;
    const focusRecovered = dialog.contains(activeWhilePending)
      && !activeWhilePending.matches(':disabled');
    await act(async () => { pending.resolve(); });

    expect(focusRecovered).toBe(true);
  });

  it('移除當前焦點控制項後維持 Tab 與 Shift+Tab 在對話框內', async () => {
    render(<DeepSeekSettings {...baseProps()} />);
    const dialog = screen.getByRole('dialog', { name: 'DeepSeek settings' });
    await userEvent.click(screen.getByRole('button', { name: 'Remove API key' }));

    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close settings' }));
  });

  it('焦點嘗試離開對話框後仍能在文件層收回並用 Escape 關閉還原', async () => {
    const props = baseProps();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>開啟測試設定</button>
          <button type="button">對話框外控制項</button>
          {open && <DeepSeekSettings {...props} onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: '開啟測試設定' });
    const outside = screen.getByRole('button', { name: '對話框外控制項' });
    await userEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'DeepSeek settings' });

    outside.focus();
    const focusWasRecaptured = dialog.contains(document.activeElement);
    fireEvent.keyDown(outside, { key: 'Escape' });

    expect(focusWasRecaptured).toBe(true);
    expect(screen.queryByRole('dialog', { name: 'DeepSeek settings' })).toBeNull();
    expect(document.activeElement).toBe(opener);
    outside.focus();
    expect(document.activeElement).toBe(outside);
  });
});
