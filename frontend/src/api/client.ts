import type { ChatResponse, HealthResponse } from '../types';
import { cancelAndThrowSafeStreamError } from './stream-error';

// 浏览器（Vite dev）：走相对路径，由 Vite proxy 转发到后端
// Electron（file:// 协议加载 dist）：直连后端 http://127.0.0.1:8001
export const API_BASE =
  typeof window !== 'undefined' && window.location.protocol === 'file:'
    ? 'http://127.0.0.1:8001'
    : '';

const connectionFailureMessage = 'Couldn’t reach the local service. Make sure the app is running, then try again.';
const serviceFailureMessage = 'DeepSeek is temporarily unavailable. Please try again in a moment.';

function httpFailureMessage(status: number): string {
  if (status === 401 || status === 403) {
    return 'The DeepSeek API key is invalid. Replace it in Settings and try again.';
  }
  if (status === 429) {
    return 'DeepSeek quota exceeded or too many requests. Check your balance and try again shortly.';
  }
  return serviceFailureMessage;
}

async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error(connectionFailureMessage);
  }
}

function requireSuccessfulResponse(response: Response): void {
  if (!response.ok) throw new Error(httpFailureMessage(response.status));
}

async function safeJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new Error(serviceFailureMessage);
  }
}

export async function askQuestion(question: string): Promise<ChatResponse> {
  const resp = await safeFetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });

  requireSuccessfulResponse(resp);
  return safeJson<ChatResponse>(resp);
}

// ─── 流式问答（SSE）────────────────────────────────────────

export interface StreamMeta {
  source: 'kb' | 'llm_refine' | 'llm' | 'llm_cache';
  score: number | null;
  file: string | null;
  matched_question: string | null;
}

export interface StreamCallbacks {
  onMeta: (meta: StreamMeta) => void;
  onDelta: (text: string) => void;
  onDone: (answer: string) => void;
}

export async function askQuestionStream(
  question: string,
  cb: StreamCallbacks,
): Promise<void> {
  const resp = await safeFetch(`${API_BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });

  requireSuccessfulResponse(resp);
  if (!resp.body) throw new Error(serviceFailureMessage);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    let readResult: ReadableStreamReadResult<Uint8Array>;
    try {
      readResult = await reader.read();
    } catch {
      return cancelAndThrowSafeStreamError(reader, connectionFailureMessage);
    }
    const { done, value } = readResult;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // 最后一段可能不完整，留到下一轮

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      let payload: { type: string; [k: string]: unknown };
      try {
        payload = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (payload.type === 'meta') {
        cb.onMeta(payload as unknown as StreamMeta);
      } else if (payload.type === 'delta') {
        cb.onDelta(payload.text as string);
      } else if (payload.type === 'done') {
        cb.onDone(payload.answer as string);
      } else if (payload.type === 'error') {
        const message = typeof payload.message === 'string' && payload.message
          ? payload.message
          : 'DeepSeek is temporarily unavailable';
        await cancelAndThrowSafeStreamError(reader, message);
      }
    }
  }
}

// ─── 问题优化（口语问题 → 技术问题改写）──────────────────────

export async function refineQuestion(question: string): Promise<{ original: string; refined: string }> {
  const resp = await safeFetch(`${API_BASE}/api/question/refine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  requireSuccessfulResponse(resp);
  return safeJson<{ original: string; refined: string }>(resp);
}

export async function rebuildIndex(): Promise<{ status: string; chunk_count: number }> {
  const resp = await safeFetch(`${API_BASE}/api/rebuild`, { method: 'POST' });
  requireSuccessfulResponse(resp);
  return safeJson<{ status: string; chunk_count: number }>(resp);
}

export async function checkHealth(): Promise<HealthResponse> {
  const resp = await safeFetch(`${API_BASE}/api/health`);
  requireSuccessfulResponse(resp);
  return safeJson<HealthResponse>(resp);
}
