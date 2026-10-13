import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  askQuestion,
  askQuestionStream,
  checkHealth,
  rebuildIndex,
  refineQuestion,
} from './client';

const callbacks = () => ({
  onMeta: vi.fn(),
  onDelta: vi.fn(),
  onDone: vi.fn(),
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API 安全錯誤邊界', () => {
  it('所有連線失敗只顯示可行動的繁體中文，不外洩原生錯誤', async () => {
    const privateMarker = `credential-${crypto.randomUUID()}`;
    const nativeMessage = `TypeError: fetch failed at 127.0.0.1 with ${privateMarker}`;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError(nativeMessage)));
    const requests = [
      () => askQuestion('測試問題'),
      () => askQuestionStream('測試問題', callbacks()),
      () => refineQuestion('測試問題'),
      () => rebuildIndex(),
      () => checkHealth(),
    ];

    for (const request of requests) {
      await expect(request()).rejects.toThrow('Couldn’t reach the local service. Make sure the app is running, then try again.');
      await expect(request()).rejects.not.toThrow(nativeMessage);
    }
  });

  it('非成功 HTTP 回應不讀取或顯示伺服器內文', async () => {
    const privateBody = `upstream stack trace and credential-${crypto.randomUUID()}`;
    const response = () => new Response(
      JSON.stringify({ detail: privateBody }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response()));
    const requests = [
      () => askQuestion('測試問題'),
      () => askQuestionStream('測試問題', callbacks()),
      () => refineQuestion('測試問題'),
      () => rebuildIndex(),
      () => checkHealth(),
    ];

    for (const request of requests) {
      await expect(request()).rejects.toThrow('DeepSeek is temporarily unavailable. Please try again in a moment.');
      await expect(request()).rejects.not.toThrow(privateBody);
    }
  });

  it('保留 SSE 已分類的安全提示', async () => {
    const safeMessage = 'The DeepSeek API key is invalid. Replace it in Settings and try again.';
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ type: 'error', message: safeMessage })}\n`,
        ));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    await expect(askQuestionStream('測試問題', callbacks())).rejects.toThrow(safeMessage);
  });

  it('串流讀取器失敗只顯示本機連線提示', async () => {
    const privateMarker = `reader-private-${crypto.randomUUID()}`;
    const body = new ReadableStream({
      pull() {
        throw new Error(privateMarker);
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    const request = askQuestionStream('測試問題', callbacks());
    await expect(request).rejects.toThrow('Couldn’t reach the local service. Make sure the app is running, then try again.');
    await expect(request).rejects.not.toThrow(privateMarker);
  });
});
