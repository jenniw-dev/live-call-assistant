import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../audio/capture', () => ({
  startSystemCapture: vi.fn(),
}));

vi.mock('../audio/asrSocket', () => ({
  asrWsUrl: () => 'ws://localhost/test',
  AsrSocket: class {
    async open() {}
    sendAudio() {}
    sendControl() {}
    close() {}
  },
}));

import { startSystemCapture } from '../audio/capture';
import AudioRecorder from './AudioRecorder';

afterEach(() => {
  cleanup();
  vi.mocked(startSystemCapture).mockReset();
});

describe('AudioRecorder permission recovery', () => {
  it('在權限或無聲指引旁提供restart動作', async () => {
    const relaunch = vi.fn();
    window.electronAPI!.runtime.relaunch = relaunch;
    vi.mocked(startSystemCapture).mockRejectedValue(new Error(
      '無法開始系統音訊分享。請到「系統設定 → Privacy & Security」允許後Restart app。',
    ));
    render(<AudioRecorder onTranscript={vi.fn()} disabled={false} preferBackend={false} />);

    await userEvent.click(screen.getByRole('button', { name: /Click to start capturing system audio/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Restart app' }));

    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('一般暫時錯誤不顯示不必要的restart按鈕', async () => {
    vi.mocked(startSystemCapture).mockRejectedValue(new Error('無法啟動系統音訊分享，請稍後再試。'));
    render(<AudioRecorder onTranscript={vi.fn()} disabled={false} preferBackend={false} />);

    await userEvent.click(screen.getByRole('button', { name: /Click to start capturing system audio/ }));
    expect(await screen.findByText(/無法啟動系統音訊分享/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restart app' })).toBeNull();
  });

  it('無聲警告不會停止擷取、提交或清除辨識文字', async () => {
    let callbacks: Parameters<typeof startSystemCapture>[0] | null = null;
    const stop = vi.fn();
    const onTranscript = vi.fn();
    vi.mocked(startSystemCapture).mockImplementation(async cb => {
      callbacks = cb;
      return { stop, sourceLabel: 'System audio', webrtcNs: true, sampleRate: 48_000 };
    });
    render(<AudioRecorder onTranscript={onTranscript} disabled={false} preferBackend={false} />);
    await userEvent.click(screen.getByRole('button', { name: /Click to start capturing system audio/ }));
    await screen.findByText(/Listening/);

    act(() => callbacks?.onSilence?.('沒有收到系統音訊，請Restart app。'));

    expect(screen.getByText(/沒有收到系統音訊/)).toBeTruthy();
    expect(stop).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Listening/ })).toBeTruthy();
  });
});
