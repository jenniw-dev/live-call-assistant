/**
 * Streaming ASR WebSocket 客户端（需求第一/十二条）：
 *
 *   前端 PCM frames → ws://后端/api/audio/stream → partial/final 实时文本
 *
 * 健壮性：
 *   - 断线自动重连（指数退避 0.5/1/2/4s），重连期间音频短时缓冲（≈5s，
 *     环形丢弃最旧），恢复后补发 —— 不丢话、不阻塞；
 *   - 重连耗尽 → onFatal 由调用方友好提示，不卡死界面；
 *   - 后端降级本地引擎 / 异常均通过事件透出。
 */

export interface AsrSocketHandlers {
  onReady: (engine: string, vad: string) => void;
  onPartial: (text: string, sentenceId: number, engineMs: number) => void;
  onFinal: (text: string, sentenceId: number, engineMs: number) => void;
  onVad: (speech: boolean) => void;
  onFallback: (reason: string) => void;
  onError: (message: string, recoverable: boolean) => void;
  /** 连接状态变化（断线重连中可提示用户） */
  onConnChange: (connected: boolean) => void;
  /** 致命错误（重连耗尽），调用方应停止并提示 */
  onFatal: (message: string) => void;
  /** 静音 1.5s 且已有识别文本 → 问题已完整、可发送（仅 UI 信号，绝不自动提交） */
  onQuestionReady?: (sentenceId: number) => void;
  /** Backend WASAPI loopback capture started（source=backend，device=播放设备名） */
  onCaptureInfo?: (source: string, device: string) => void;
  /** Backend capture unavailable → 调用方降级前端 getDisplayMedia 采集 */
  onCaptureError?: (message: string) => void;
}

const RECONNECT_DELAYS = [500, 1000, 2000, 4000];
const MAX_BUFFER_FRAMES = 160;   // ≈5.1s @ 32ms/帧（短时缓冲，超出丢最旧）

export function asrWsUrl(): string {
  if (typeof window === 'undefined') return '';
  // Electron file:// 直连后端；浏览器走 Vite 代理（ws:true）
  if (window.location.protocol === 'file:') return 'ws://127.0.0.1:8001/api/audio/stream';
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/api/audio/stream`;
}

export class AsrSocket {
  private ws: WebSocket | null = null;
  private opened = false;
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private buffer: Int16Array[] = [];
  private started = false;
  /** 音频帧来源：frontend=前端 getDisplayMedia 上行；backend=后端 WASAPI Loopback */
  private source: 'backend' | 'frontend' = 'frontend';

  constructor(private url: string, private h: AsrSocketHandlers) {}

  get connected(): boolean {
    return this.opened && this.ws?.readyState === WebSocket.OPEN;
  }

  /** 建立连接并发送 start。source=backend 时由后端直接采集系统音频，前端不上行帧。
   * 失败抛错（调用方友好提示）。 */
  async open(source: 'backend' | 'frontend' = 'frontend'): Promise<void> {
    this.source = source;
    this.closedByUser = false;
    await this.connect();
    this.started = true;
    this.sendControl('start', { source });
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.onclose = null; this.ws.onerror = null; this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.opened = false;
    this.buffer = [];
  }

  /** 发送音频帧；连接未就绪时进入缓冲（需求第十二条：短时缓冲音频）。 */
  sendAudio(pcm: Int16Array): void {
    if (this.connected && this.ws) {
      try {
        this.ws.send(pcm);
        return;
      } catch { /* 落入缓冲 */ }
    }
    this.buffer.push(pcm);
    if (this.buffer.length > MAX_BUFFER_FRAMES) this.buffer.shift();
  }

  sendControl(type: 'start' | 'pause' | 'resume' | 'stop', extra?: Record<string, unknown>): void {
    if (this.connected && this.ws) {
      try { this.ws.send(JSON.stringify({ type, ...(extra ?? {}) })); } catch { /* ignore */ }
    }
  }

  // ── 内部 ──

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        reject(e instanceof Error ? e : new Error('Couldn’t create the WebSocket'));
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      const timer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch { /* ignore */ }
          reject(new Error('Recognition service connection timed out'));
        }
      }, 6000);

      ws.onopen = () => {
        window.clearTimeout(timer);
        if (settled) return;
        settled = true;
        this.opened = true;
        this.reconnectAttempt = 0;
        this.h.onConnChange(true);
        if (this.started) this.sendControl('start', { source: this.source });
        this.flushBuffer();
        resolve();
      };

      ws.onmessage = e => this.dispatch(e.data);

      ws.onerror = () => { /* onclose 统一处理 */ };

      ws.onclose = () => {
        window.clearTimeout(timer);
        this.opened = false;
        if (this.closedByUser) return;
        this.h.onConnChange(false);
        if (!settled) {
          settled = true;
          reject(new Error('Couldn’t connect to the recognition service'));
          return;
        }
        this.scheduleReconnect();
      };
    });
  }

  private flushBuffer(): void {
    if (!this.connected || !this.ws) return;
    const pending = this.buffer;
    this.buffer = [];
    for (const frame of pending) {
      try { this.ws.send(frame); } catch { this.buffer.push(frame); break; }
    }
    if (pending.length) console.log(`[ASR-WS] resent buffered audio after reconnect: ${pending.length} frames`);
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    if (this.reconnectAttempt >= RECONNECT_DELAYS.length) {
      this.h.onFatal('Recognition service disconnected and couldn’t reconnect. Please restart listening.');
      return;
    }
    const delay = RECONNECT_DELAYS[this.reconnectAttempt];
    this.reconnectAttempt += 1;
    console.warn(`[ASR-WS] disconnected, ${delay}ms until reconnect attempt ${this.reconnectAttempt}…`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private dispatch(data: unknown): void {
    if (typeof data !== 'string') return;
    let ev: { type: string; [k: string]: unknown };
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    switch (ev.type) {
      case 'ready':
        this.h.onReady(String(ev.engine ?? ''), String(ev.vad ?? ''));
        break;
      case 'partial':
        this.h.onPartial(String(ev.text ?? ''), Number(ev.sentence_id ?? 0), Number(ev.engine_ms ?? 0));
        break;
      case 'final':
        this.h.onFinal(String(ev.text ?? ''), Number(ev.sentence_id ?? 0), Number(ev.engine_ms ?? 0));
        break;
      case 'vad':
        this.h.onVad(Boolean(ev.speech));
        break;
      case 'fallback':
        this.h.onFallback(String(ev.reason ?? ''));
        break;
      case 'question_ready':
        this.h.onQuestionReady?.(Number(ev.sentence_id ?? 0));
        break;
      case 'capture':
        this.h.onCaptureInfo?.(String(ev.source ?? ''), String(ev.device ?? ''));
        break;
      case 'capture_error':
        this.h.onCaptureError?.(String(ev.message ?? 'Backend audio capture unavailable'));
        break;
      case 'error':
        this.h.onError(String(ev.message ?? 'Recognition service error'), Boolean(ev.recoverable));
        break;
      case 'paused':
      case 'stopped':
        break;   // 控制回执（UI 状态由调用方本地管理）
      default:
        break;
    }
  }
}
