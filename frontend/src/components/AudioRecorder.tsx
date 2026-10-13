import { useState, useRef, useCallback, useEffect } from 'react';
import { startSystemCapture } from '../audio/capture';
import type { CaptureHandle } from '../audio/capture';
import { selectCaptureSource } from '../audio/capture-source';
import { CaptureSessionCoordinator } from '../audio/capture-session';
import type { CaptureAttemptGuard } from '../audio/capture-session';
import { AsrSocket, asrWsUrl } from '../audio/asrSocket';
import type { AsrMetrics, AsrState, TranscriptKind } from '../types';
import { fmtElapsed } from '../utils/derive';

interface Props {
  /** partial=实时增量文本（持续追加/微调）；final=整句定稿（热词二次修正后） */
  onTranscript: (text: string, kind: TranscriptKind) => void;
  disabled: boolean;
  /** 监听状态上报（Header 徽章/浮窗状态指示用），running=非 IDLE */
  onStatusChange?: (running: boolean, state: string, elapsedMs: number) => void;
  /** 紧凑形态：单个小圆麦按钮（浮窗模式用） */
  compact?: boolean;
  /** 流式状态/耗时上报（输入框顶部状态提示 + 开发调试面板，需求第三/十一条） */
  onAsrStatus?: (state: AsrState, label: string, metrics: AsrMetrics | null, eventAt: number) => void;
  /** true 优先用后端 WASAPI Loopback 采集（失败自动降级浏览器 getDisplayMedia） */
  preferBackend?: boolean;
  /** 后端采集启动失败降级时的用户提示（可选，默认 toast 由组件内 showError） */
  onToast?: (msg: string) => void;
}

/**
 * 流式语音输入（对齐豆包/飞书实时字幕体验）：
 *
 *   系统音频内录(禁麦克风) → WebRTC 降噪 → PCM16/16kHz/mono/32ms frames
 *     → WebSocket /api/audio/stream
 *     → 后端 Silero VAD(仅状态) + 流式 ASR(Paraformer/本地短分片降级)
 *     → partial 实时追加 / final 整句定稿 → 输入框（用户手动点发送才调 AI）
 *
 * 铁律（需求核心约束）：
 *   ❌ 识别完成绝不自动发送、绝不自动触发 AI 回答；
 *   ✅ 文本只写入输入框，人工确认发送；
 *   VAD 仅切换状态展示，不截断音频流、不自动结束识别、不自动提交文本。
 */

// 状态文案（需求第三条枚举；READY=静音 1.5s 后问题整理完成、可发送）
const STATE_LABEL: Record<AsrState, string> = {
  IDLE: '⚪ Not listening',
  LISTENING: '🎙 Listening...',
  RECOGNIZING: '✍️ Transcribing...',
  DONE: '✅ Transcribed',
  READY: '🔵 Question ready to send',
  PAUSED: '⏸ Paused',
  ERROR: '⚠️ Recognition error',
};

// 映射到旧版状态契约（Header 徽章/浮窗仅识别 PROCESSING=识别中，其余=监听中）
const COMPAT_STATE: Record<AsrState, string> = {
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  RECOGNIZING: 'PROCESSING',
  DONE: 'WAITING',
  READY: 'READY',
  PAUSED: 'WAITING',
  ERROR: 'ERROR',
};

const DONE_RESET_MS = 1600;      // ✅识别完成 → 回到监听的展示时长
const SPEECH_GRACE_MS = 1200;    // VAD 停顿后保留"识别中"的宽限（等 final 落地）

export default function AudioRecorder({
  onTranscript, disabled, onStatusChange, compact, onAsrStatus, preferBackend, onToast,
}: Props) {
  const [state, setState] = useState<AsrState>('IDLE');
  const [error, setError] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [engine, setEngine] = useState('');
  // 采集来源展示：'backend'=后端 WASAPI / 'frontend'=浏览器共享音频
  const [captureMode, setCaptureMode] = useState<'backend' | 'frontend' | ''>('');
  const startAtRef = useRef<number | null>(null);

  // ── 运行时 refs ──
  const stateRef = useRef<AsrState>('IDLE');
  const activeRef = useRef(false);
  const pausedRef = useRef(false);
  const captureRef = useRef<CaptureHandle | null>(null);
  const socketRef = useRef<AsrSocket | null>(null);
  const sessionRef = useRef<CaptureSessionCoordinator<AsrSocket, CaptureHandle> | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = new CaptureSessionCoordinator<AsrSocket, CaptureHandle>();
  }
  const doneTimerRef = useRef<number | null>(null);
  const graceTimerRef = useRef<number | null>(null);
  const captureModeRef = useRef<'backend' | 'frontend'>('frontend');
  const fallbackTriedRef = useRef(false);   // 后端采集降级只允许一次，防循环

  // ── 延迟指标（需求第十一条）：Audio/ASR latency 在此测，UI latency 由输入框测 ──
  const metricsRef = useRef<AsrMetrics>({ audioMs: 0, asrMs: 0, uiMs: 0, totalMs: 0 });
  const lastEventAtRef = useRef(0);

  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  const onAsrStatusRef = useRef(onAsrStatus);
  useEffect(() => { onAsrStatusRef.current = onAsrStatus; }, [onAsrStatus]);

  const setStateMachine = useCallback((s: AsrState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const showError = useCallback((msg: string) => {
    setError(msg);
    window.setTimeout(() => setError(prev => (prev === msg ? '' : prev)), 6000);
  }, []);

  const clearTimers = useCallback(() => {
    if (doneTimerRef.current !== null) { window.clearTimeout(doneTimerRef.current); doneTimerRef.current = null; }
    if (graceTimerRef.current !== null) { window.clearTimeout(graceTimerRef.current); graceTimerRef.current = null; }
  }, []);

  /** 上报流式状态 + 指标（输入框顶部提示/调试面板数据源） */
  const reportStatus = useCallback((s: AsrState) => {
    onAsrStatusRef.current?.(s, STATE_LABEL[s], { ...metricsRef.current }, lastEventAtRef.current);
  }, []);

  const enterState = useCallback((s: AsrState) => {
    clearTimers();
    setStateMachine(s);
    reportStatus(s);
    if (s === 'DONE') {
      doneTimerRef.current = window.setTimeout(() => {
        doneTimerRef.current = null;
        if (activeRef.current && !pausedRef.current) {
          setStateMachine('LISTENING');
          reportStatus('LISTENING');
        }
      }, DONE_RESET_MS);
    }
  }, [clearTimers, setStateMachine, reportStatus]);

  // 监听计时：非 IDLE 计时，IDLE 清零
  useEffect(() => {
    if (state === 'IDLE') {
      startAtRef.current = null;
      setElapsedMs(0);
      return;
    }
    if (startAtRef.current === null) startAtRef.current = Date.now();
    const t = window.setInterval(() => {
      if (startAtRef.current !== null) setElapsedMs(Date.now() - startAtRef.current);
    }, 1000);
    return () => window.clearInterval(t);
  }, [state]);

  // 旧契约状态上报（Header/浮窗）
  useEffect(() => {
    onStatusChange?.(state !== 'IDLE', COMPAT_STATE[state], elapsedMs);
  }, [state, elapsedMs, onStatusChange]);

  // ── 音频帧：采集 → 发送（暂停时丢弃；延迟指标 EMA）──
  const handleFrame = useCallback((pcm: Int16Array, capturedAt: number) => {
    if (!activeRef.current || pausedRef.current) return;
    const lat = performance.now() - capturedAt;
    const m = metricsRef.current;
    m.audioMs = m.audioMs === 0 ? lat : m.audioMs * 0.8 + lat * 0.2;
    socketRef.current?.sendAudio(pcm);
  }, []);

  // ── Socket 事件 ──
  const handleVad = useCallback((speech: boolean) => {
    if (!activeRef.current || pausedRef.current) return;
    if (speech) {
      // 新一轮讲话：从监听/完成/整理完成态统一切回识别中（黄色）
      if (stateRef.current === 'LISTENING' || stateRef.current === 'DONE' || stateRef.current === 'READY') {
        enterState('RECOGNIZING');
      }
    } else if (stateRef.current === 'RECOGNIZING') {
      // 停顿宽限：等 final 落地；无 final 则回到监听
      if (graceTimerRef.current !== null) window.clearTimeout(graceTimerRef.current);
      graceTimerRef.current = window.setTimeout(() => {
        graceTimerRef.current = null;
        if (stateRef.current === 'RECOGNIZING') {
          setStateMachine('LISTENING');
          reportStatus('LISTENING');
        }
      }, SPEECH_GRACE_MS);
    }
  }, [enterState, setStateMachine, reportStatus]);

  const handlePartial = useCallback((text: string, _sentenceId: number, engineMs: number) => {
    if (!activeRef.current || pausedRef.current) return;
    metricsRef.current.asrMs = engineMs;
    lastEventAtRef.current = performance.now();
    if (stateRef.current !== 'RECOGNIZING') {
      clearTimers();
      setStateMachine('RECOGNIZING');
    }
    onTranscriptRef.current(text, 'partial');
    reportStatus('RECOGNIZING');
  }, [clearTimers, setStateMachine, reportStatus]);

  const handleFinal = useCallback((text: string, _sentenceId: number, engineMs: number) => {
    if (!activeRef.current) return;
    metricsRef.current.asrMs = engineMs;
    lastEventAtRef.current = performance.now();
    onTranscriptRef.current(text, 'final');
    // READY（问题已整理待发送）是更强的终态，不被 DONE 覆盖
    if (pausedRef.current) reportStatus('PAUSED');
    else if (stateRef.current !== 'READY') enterState('DONE');
  }, [enterState, reportStatus]);

  // ── 问题整理完成（VAD 智能断句）：静音 1.5s 后端通知 → 蓝色 READY 态 ──
  // 仅状态展示：识别文本已在输入框，等待用户确认发送（绝不自动发送）。
  const handleQuestionReady = useCallback((_sentenceId: number) => {
    if (!activeRef.current || pausedRef.current) return;
    enterState('READY');
  }, [enterState]);

  // ── 启动 / 停止 / 暂停 ──

  const stopCapture = useCallback((msg?: string) => {
    sessionRef.current?.stop();
    activeRef.current = false;
    pausedRef.current = false;
    clearTimers();
    socketRef.current = null;
    captureRef.current = null;
    captureModeRef.current = 'frontend';
    setCaptureMode('');
    setEngine('');
    setStateMachine('IDLE');
    reportStatus('IDLE');
    if (msg) setError(msg);
  }, [clearTimers, setStateMachine, reportStatus]);

  const createFrontendCapture = useCallback((guard: CaptureAttemptGuard) => {
    return startSystemCapture({
      onFrame: handleFrame,
      onSilence: showError,
      signal: guard.signal,
      onError: msg => {
        if (!guard.isCurrent()) return;
        showError(msg);
        stopCapture();
      },
    });
  }, [handleFrame, showError, stopCapture]);

  // 非 macOS 後端採集降級時，只將仍屬於目前世代的擷取器換入會話。
  const bootFrontendCapture = useCallback(async (guard: CaptureAttemptGuard) => {
    const capture = await createFrontendCapture(guard);
    if (!guard.isCurrent()) {
      capture.stop();
      return;
    }
    if (!sessionRef.current?.replaceCapture(capture)) return;
    captureRef.current = capture;
    captureModeRef.current = 'frontend';
    setCaptureMode('frontend');
    if (!capture.webrtcNs) console.warn('[Audio] WebRTC noise suppression unavailable; using backend noise reduction');
  }, [createFrontendCapture]);

  // Backend capture unavailable → 降级浏览器共享音频（WS 会话保持，只补起本地采集）
  const fallbackToFrontend = useCallback(async (reason: string, guard: CaptureAttemptGuard) => {
    if (!guard.isCurrent() || !activeRef.current || captureModeRef.current !== 'backend' || fallbackTriedRef.current) return;
    fallbackTriedRef.current = true;
    console.warn(`[Audio] Backend capture unavailable（${reason}），falling back to browser audio sharing`);
    (onToast ?? showError)('Backend audio capture unavailable. Switched to browser audio sharing.');
    try {
      await bootFrontendCapture(guard);
    } catch (e) {
      if (!guard.isCurrent()) return;
      const msg = e instanceof Error ? e.message : 'Couldn’t capture system audio';
      showError(msg);
      stopCapture();
    }
  }, [bootFrontendCapture, onToast, showError, stopCapture]);

  const startCapture = useCallback(() => {
    const source = selectCaptureSource({
      platform: window.electronAPI?.platform ?? 'darwin',
      preferBackend: !!preferBackend,
    });
    const coordinator = sessionRef.current;
    if (!coordinator) return;

    const accepted = coordinator.start({
      source,
      createSocket: guard => new AsrSocket(asrWsUrl(), {
        onReady: eng => {
          if (!guard.isCurrent()) return;
          setEngine(eng);
          console.log(`[ASR] Streaming engine ready: ${eng}`);
        },
        onPartial: (...args) => { if (guard.isCurrent()) handlePartial(...args); },
        onFinal: (...args) => { if (guard.isCurrent()) handleFinal(...args); },
        onVad: speech => { if (guard.isCurrent()) handleVad(speech); },
        onQuestionReady: sentenceId => { if (guard.isCurrent()) handleQuestionReady(sentenceId); },
        onCaptureInfo: (_src, device) => {
          if (!guard.isCurrent()) return;
          captureModeRef.current = 'backend';
          setCaptureMode('backend');
          console.log(`[Audio] Backend WASAPI loopback capture started: ${device}`);
        },
        onCaptureError: msg => {
          if (guard.isCurrent()) void fallbackToFrontend(msg, guard);
        },
        onFallback: reason => {
          if (!guard.isCurrent()) return;
          console.warn('[ASR] falling back to local chunked recognition:', reason);
          showError('Cloud streaming unavailable. Switched to local recognition (slightly slower).');
          setEngine('local');
        },
        onError: (msg, recoverable) => {
          if (!guard.isCurrent()) return;
          if (!recoverable) { showError(msg); stopCapture(); }
          else console.warn('[ASR] service notice:', msg);
        },
        onConnChange: connected => {
          if (!guard.isCurrent()) return;
          if (!connected && activeRef.current) showError('Recognition connection dropped. Reconnecting…');
        },
        onFatal: msg => {
          if (!guard.isCurrent()) return;
          showError(msg);
          stopCapture();
        },
      }),
      createCapture: source === 'frontend' ? guard => createFrontendCapture(guard) : undefined,
      onReady: ({ socket, capture, guard }) => {
        if (!guard.isCurrent()) return;
        socketRef.current = socket;
        captureRef.current = capture;
        captureModeRef.current = source;
        setCaptureMode(source);
        activeRef.current = true;
        pausedRef.current = false;
        metricsRef.current = { audioMs: 0, asrMs: 0, uiMs: 0, totalMs: 0 };
        lastEventAtRef.current = 0;
        enterState('LISTENING');
      },
      onError: error => {
        const msg = error instanceof Error ? error.message : 'Couldn’t capture system audio. Please try again.';
        stopCapture(msg);
      },
    });
    if (!accepted) return;
    setError('');
    fallbackTriedRef.current = false;
  }, [preferBackend, handleFinal, handlePartial, handleVad, handleQuestionReady,
      fallbackToFrontend, createFrontendCapture, enterState, showError, stopCapture]);

  const togglePause = useCallback(() => {
    if (!activeRef.current) return;
    const sock = socketRef.current;
    if (!pausedRef.current) {
      pausedRef.current = true;
      sock?.sendControl('pause');
      enterState('PAUSED');
    } else {
      pausedRef.current = false;
      sock?.sendControl('resume');
      enterState('LISTENING');
    }
  }, [enterState]);

  const toggleCapture = useCallback(() => {
    if (sessionRef.current?.phase === 'idle') startCapture();
    else stopCapture();
  }, [startCapture, stopCapture]);

  useEffect(() => () => {
    activeRef.current = false;
    sessionRef.current?.stop();
    socketRef.current = null;
    captureRef.current = null;
  }, []);

  const busy = state === 'RECOGNIZING';
  const ready = state === 'READY';
  // 状态色：绿=监听 / 黄=检测到讲话 / 蓝=问题整理完成 / 琥珀=暂停 / 红=异常
  const stateClass = error
    ? 'error'
    : state === 'IDLE'
      ? 'idle'
      : state === 'PAUSED'
        ? 'busy'
        : ready
          ? 'ready'
          : busy
            ? 'speaking'
            : 'listening';

  const micIcon = state === 'IDLE' ? '🎤' : busy ? '✍️' : state === 'PAUSED' ? '⏸' : ready ? '📝' : '🎙️';
  const modeLabel = captureMode === 'backend' ? 'backend capture' : captureMode === 'frontend' ? 'browser sharing' : '';
  const metaText = `${fmtElapsed(elapsedMs)}${engine ? ` · ${engine === 'paraformer' ? 'streaming' : 'local'}` : ''}${modeLabel ? ` · ${modeLabel}` : ''}`;
  const micTitle = state === 'IDLE'
    ? 'Click to start capturing system audio (the caller’s voice)'
    : `Listening (${STATE_LABEL[state]}${modeLabel ? ` · ${modeLabel}` : ''}), click to stop`;
  const needsRelaunch = Boolean(
    window.electronAPI
    && error
    && (error.includes('restart') || error.includes('Privacy & Security')),
  );

  // 紧凑形态（浮窗）：单个小圆麦按钮
  if (compact) {
    return (
      <button
        className={`mic-mini st-${stateClass}`}
        onClick={toggleCapture}
        disabled={disabled && state === 'IDLE'}
        title={micTitle}
        aria-label={micTitle}
      >
        {micIcon}
      </button>
    );
  }

  // Dock 形态：小圆麦 + 状态文字 + 暂停，随输入框同行排布
  return (
    <div className="recorder-dock">
      <button
        className={`mic-circle mic-sm st-${stateClass}`}
        onClick={toggleCapture}
        disabled={disabled && state === 'IDLE'}
        title={micTitle}
        aria-label={micTitle}
      >
        <span className="ripple r1" />
        <span className="ripple r2" />
        <span className="mic-icon">{micIcon}</span>
      </button>

      <div className="recorder-meta">
        <span className={`rec-status st-${stateClass}`} title={STATE_LABEL[state]}>
          {error ? `⚠️ ${error}` : STATE_LABEL[state]}
        </span>
        <span className="rec-timer">{metaText}</span>
      </div>

      {needsRelaunch && (
        <button className="restart-app-btn" type="button" onClick={() => window.electronAPI?.runtime.relaunch()}>
          Restart app
        </button>
      )}

      {state !== 'IDLE' && (
        <button className="pause-listen-btn" onClick={togglePause} title={pausedRef.current ? 'Resume recognition' : 'Pause recognition (keep capturing)'}>
          {state === 'PAUSED' ? '▶ Resume' : '⏸ Pause'}
        </button>
      )}
    </div>
  );
}
