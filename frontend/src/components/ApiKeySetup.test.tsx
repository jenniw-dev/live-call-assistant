import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ApiKeySetup from './ApiKeySetup';

const privateKey = () => `sk-${crypto.randomUUID().split('-').join('')}`;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('ApiKeySetup', () => {
  it('安全儲存非空白金鑰、清空欄位且不寫入瀏覽器儲存空間', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeySetup save={save} />);
    const input = screen.getByLabelText('DeepSeek API Key') as HTMLInputElement;
    const key = privateKey();

    await userEvent.type(input, key);
    await userEvent.click(screen.getByRole('button', { name: 'Save securely and start' }));

    expect(save).toHaveBeenCalledWith(key);
    expect(input.value).toBe('');
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.body.textContent).not.toContain(key);
  });

  it('阻擋空白輸入並顯示可理解的提示', async () => {
    const save = vi.fn();
    render(<ApiKeySetup save={save} />);
    const input = screen.getByLabelText('DeepSeek API Key') as HTMLInputElement;

    await userEvent.type(input, '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Save securely and start' }));

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText('Enter your DeepSeek API key')).toBeTruthy();
    expect(input.value).toBe('');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('儲存失敗時清空欄位且不把金鑰帶入錯誤訊息', async () => {
    const key = privateKey();
    const save = vi.fn().mockRejectedValue(new Error(key));
    render(<ApiKeySetup save={save} />);
    const input = screen.getByLabelText('DeepSeek API Key') as HTMLInputElement;

    await userEvent.type(input, key);
    await userEvent.click(screen.getByRole('button', { name: 'Save securely and start' }));

    expect((await screen.findByRole('alert')).textContent).toContain("Couldn’t save the key or start DeepSeek");
    expect(input.value).toBe('');
    expect(document.body.textContent).not.toContain(key);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
