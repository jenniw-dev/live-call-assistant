import { useState, useCallback, useEffect, useRef, memo } from 'react';
import type { WheelEvent as ReactWheelEvent } from 'react';
import ChatInput from './components/ChatInput';
import QuestionPanelBase from './components/QuestionPanel';
import AnswerPanelBase from './components/AnswerPanel';
import AudioRecorder from './components/AudioRecorder';
import FloatingToolbar from './components/FloatingToolbar';
import HistoryDrawer from './components/HistoryDrawer';
import ApiKeySetup from './components/ApiKeySetup';
import DeepSeekSettings from './components/DeepSeekSettings';
import { askQuestionStream, refineQuestion, API_BASE } from './api/client';
import { useElectronRuntime } from './runtime/electron';
import { fmtElapsed, oneSentence } from './utils/derive';
import type { AsrMetrics, AsrState, ChatItem, ChatResponse, HealthResponse, TranscriptKind } from './types';
import './App.css';

// memo 隔离：ASR 实时文本高频更新 draft 时仅输入区重渲染，面板 props 稳定则跳过
const QuestionPanel = memo(QuestionPanelBase);
const AnswerPanel = memo(AnswerPanelBase);

// Electron 环境检测：preload 注入了 electronAPI
const IS_ELECTRON = typeof window !== 'undefined' && !!window.electronAPI;

// 迷你/展开双态浮窗仅供浏览器 ?float=1 预览；
// Electron 桌面浮窗 = 全布局（半透明、可拖拽、置顶），与网页版同结构
const FLOAT_PREVIEW = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('float');
const FLOAT_MODE = FLOAT_PREVIEW;

// 聊天历史 localStorage 持久化 key
const HISTORY_KEY = 'aic_chat_history_v1';
const MAX_HISTORY = 100;
// 收藏答案持久化 key
const FAV_KEY = 'aic_favorites_v1';

// 顶部状态徽章：绿=正在监听 / 黄=检测到讲话 / 蓝=问题整理完成
const ASR_BADGE: Record<AsrState, { cls: string; text: string }> = {
  IDLE: { cls: 'off', text: '⚪ Not listening' },
  LISTENING: { cls: 'on', text: '🟢 Listening' },
  RECOGNIZING: { cls: 'busy', text: '🟡 Speech detected' },
  DONE: { cls: 'on', text: '🟢 Listening' },
  READY: { cls: 'ready', text: '🔵 Question ready' },
  PAUSED: { cls: 'paused', text: '⏸ Listening paused' },
  ERROR: { cls: 'error', text: '⚠️ Recognition error' },
};

function App() {
  const runtime = useElectronRuntime();
  const [items, setItems] = useState<ChatItem[]>(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as ChatItem[];
        // 恢复时所有流式状态视为已结束
        return parsed.map(it => ({ ...it, streaming: false, modeStreaming: null }));
      }
    } catch { /* 损坏的历史直接丢弃 */ }
    return [];
  });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);

  // ── Copilot 视图状态 ──
  const [activeId, setActiveId] = useState<string | null>(null);  // 主区聚焦的问题
  const [historyOpen, setHistoryOpen] = useState(false);          // 历史抽屉（默认隐藏）
  const [recStatus, setRecStatus] = useState<{ running: boolean; state: string; elapsed: number }>({ running: false, state: 'IDLE', elapsed: 0 });
  const [toast, setToast] = useState<string | null>(null);

  // ── 浮窗模式状态 ──
  const [floatExpanded, setFloatExpanded] = useState(false);   // false=迷你浮窗（默认）
  const [widgetOpacity, setWidgetOpacity] = useState(0.68);    // 浮窗Opacity 60~70%（默认 68%）
  const [showSettings, setShowSettings] = useState(false);    // 设置弹层（右键/⚙）
  const [keyClearPending, setKeyClearPending] = useState(false);
  const keyClearPendingRef = useRef(false);
  const [autoHide, setAutoHide] = useState(false);            // 鼠标移出自动收起+变暗
  const [dimmed, setDimmed] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  // ── 输入坞草稿状态（流式字幕编辑框）──
  // draft: 输入框文本（ASR 实时写入 + 用户可编辑）
  // committed/committedRef: 已定稿(final)的 ASR 句子累积 —— draft 的"识别基准前缀"
  // dirty/dirtyRef: 用户手动编辑过 → ASR 切换为纯追加策略，禁止覆盖用户修改
  const [draft, setDraft] = useState('');
  const [refining, setRefining] = useState(false);
  const [committed, setCommitted] = useState('');
  const [dirty, setDirty] = useState(false);
  const committedRef = useRef('');
  const dirtyRef = useRef(false);
  const pendingFinalRef = useRef(false);
  const programmaticRef = useRef(false);   // 区分程序写入与用户键入

  // ── 流式识别状态/耗时（输入框状态提示 + 顶部徽章）──
  const [asrState, setAsrState] = useState<AsrState>('IDLE');
  const [asrLabel, setAsrLabel] = useState('');
  const [asrMetrics, setAsrMetrics] = useState<AsrMetrics | null>(null);
  const [asrEventAt, setAsrEventAt] = useState(0);

  const mainScrollRef = useRef<HTMLDivElement>(null);

  // Fetch health on mount（含 backend_capture 开关 → 决定默认采集源）
  useEffect(() => {
    fetch(`${API_BASE}/api/health`)
      .then(r => r.json())
      .then(setHealth)
      .catch(() => {});
  }, []);

  // 聊天历史持久化（保留上下文，重启不丢）
  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(-MAX_HISTORY)));
    } catch { /* 存储满时静默失败 */ }
  }, [items]);

  // 主区内容增高时自动滚到底（流式生成期间保持可见最新内容）
  useEffect(() => {
    const el = mainScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  // Electron：body 透明（浮窗外观）
  useEffect(() => {
    if (!IS_ELECTRON) return;
    document.body.classList.add('overlay-body');
    return () => {
      document.body.classList.remove('overlay-body');
    };
  }, []);

  // 监听状态上报（浮窗模式状态指示用）
  const handleRecStatus = useCallback((running: boolean, state: string, elapsed: number) => {
    setRecStatus({ running, state, elapsed });
  }, []);

  // 流式识别状态上报（顶部徽章 + 输入框状态提示）
  const handleAsrStatus = useCallback((s: AsrState, label: string, metrics: AsrMetrics | null, eventAt: number) => {
    setAsrState(s);
    setAsrLabel(label);
    setAsrMetrics(metrics);
    setAsrEventAt(eventAt);
  }, []);

  // 浮窗预览：body 模拟桌面壁纸，突出"悬浮"观感
  useEffect(() => {
    if (!FLOAT_PREVIEW) return;
    document.body.classList.add('preview-body');
    return () => document.body.classList.remove('preview-body');
  }, []);

  // ESC：关设置 → 收起展开态 → 隐藏浮窗（Electron）
  useEffect(() => {
    if (!FLOAT_MODE) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showSettings) setShowSettings(false);
      else if (floatExpanded) setFloatExpanded(false);
      else if (IS_ELECTRON) window.electronAPI?.hide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSettings, floatExpanded]);

  // 滚轮调透明度（30%~100%）
  const handleWheel = useCallback((e: ReactWheelEvent) => {
    setWidgetOpacity(o => Math.min(1, Math.max(0.3, o + (e.deltaY < 0 ? 0.05 : -0.05))));
  }, []);

  // 自动隐藏：鼠标移出 1.5s 后收起+变暗，移入恢复
  const onWidgetEnter = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    setDimmed(false);
  }, []);

  const onWidgetLeave = useCallback(() => {
    if (!autoHide) return;
    hideTimerRef.current = window.setTimeout(() => {
      setDimmed(true);
      setFloatExpanded(false);
    }, 1500);
  }, [autoHide]);

  const activeItem = items.find(i => i.id === activeId) ?? items[items.length - 1] ?? null;

  // 后端 WASAPI 采集优先（health 未返回时默认开启；后端不可用会自动降级浏览器采集）
  const preferBackend = health ? health.backend_capture !== false : true;

  // ── 流式问答：插入占位卡片 → SSE 流式填充 + 首字延迟测量 ──
  const runStream = useCallback(async (question: string) => {
    const id = crypto.randomUUID();
    const emptyResponse: ChatResponse = {
      answer: '', source: 'llm', score: null, file: null, matched_question: null,
    };
    setItems(prev => [...prev, { id, question, response: emptyResponse, timestamp: Date.now(), streaming: true }]);
    setActiveId(id);      // 新问题成为主区焦点

    const patchItem = (patch: (it: ChatItem) => ChatItem) =>
      setItems(prev => prev.map(it => (it.id === id ? patch(it) : it)));

    const t0 = performance.now();
    let firstTokenAt: number | null = null;

    try {
      await askQuestionStream(question, {
        onMeta: meta => patchItem(it => ({
          ...it,
          response: { ...it.response, source: meta.source, score: meta.score, file: meta.file, matched_question: meta.matched_question },
        })),
        onDelta: text => {
          if (firstTokenAt === null) {
            firstTokenAt = performance.now();
            const latency = Math.round(firstTokenAt - t0);
            console.log(`[Perf] First-token latency: ${latency}ms`);
            patchItem(it => ({ ...it, latency_ms: latency }));
          }
          patchItem(it => ({
            ...it,
            response: { ...it.response, answer: it.response.answer + text },
          }));
        },
        onDone: () => patchItem(it => ({ ...it, streaming: false })),
      });
      // 兜底：流正常结束但未收到 done 事件
      patchItem(it => ({ ...it, streaming: false }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      patchItem(it => ({ ...it, streaming: false }));
    }
  }, []);

  // ── 发送：唯一调用 AI 回答的入口（用户控制，核心原则，绝不自动发送） ──
  // 完整链路：识别文本填充输入框 → 用户编辑 → 用户点击发送 → RAG检索 → LLM生成
  const handleSend = useCallback(async () => {
    const question = draft.trim();
    if (!question || sending) return;

    // 清空输入坞（含识别基准前缀）
    setDraft('');
    committedRef.current = '';
    dirtyRef.current = false;
    pendingFinalRef.current = false;
    setCommitted('');
    setDirty(false);
    setSending(true);
    setError(null);

    try {
      await runStream(question);
    } finally {
      setSending(false);
    }
  }, [draft, sending, runStream]);

  // ── 流式 ASR 文本写入输入框（实时字幕：可查看/修改/确认，绝不自动回答） ──
  // partial：当前句实时增量文本——未编辑时就地更新"已定稿前缀+当前句"；
  //          用户编辑中则完全不动输入框（防覆盖/防光标跳动）。
  // final：整句定稿（热词二次修正已在后端完成）——追加进已定稿前缀；
  //        用户编辑中 → 纯追加策略，禁止覆盖用户修改内容。
  // 全程禁止Clear the input、禁止自动发送。
  const handleTranscript = useCallback((text: string, kind: TranscriptKind) => {
    const cleaned = text.trim();
    if (!cleaned) return;

    programmaticRef.current = true;
    if (kind === 'partial') {
      if (!dirtyRef.current) {
        const base = committedRef.current;
        setDraft(base ? base + cleaned : cleaned);
      }
    } else {
      committedRef.current = committedRef.current ? committedRef.current + cleaned : cleaned;
      setCommitted(committedRef.current);
      if (dirtyRef.current) {
        // 用户手动编辑期间：识别文本只追加到末尾，绝不覆盖/清空
        setDraft(prev => (prev.trim() ? `${prev.replace(/\s+$/, '')}${cleaned}` : cleaned));
      } else {
        setDraft(committedRef.current);
        pendingFinalRef.current = true;
      }
    }
    window.setTimeout(() => { programmaticRef.current = false; }, 0);
  }, []);

  // ── 用户手动编辑输入框 → 标记 dirty（ASR 不再覆盖，整段按已确认白色渲染） ──
  const handleDraftChange = useCallback((v: string) => {
    if (!programmaticRef.current) {
      dirtyRef.current = true;
      setDirty(true);
    }
    setDraft(v);
  }, []);

  // ── 优化问题：口语 → 技术问题 ──
  const handleRefine = useCallback(async () => {
    const q = draft.trim();
    if (!q || refining) return;
    setRefining(true);
    setError(null);
    try {
      const res = await refineQuestion(q);
      programmaticRef.current = true;
      setDraft(res.refined.trim() || q);
      committedRef.current = '';     // 草稿已被改写，脱离 ASR 识别基准
      dirtyRef.current = false;
      pendingFinalRef.current = true;
      setCommitted('');
      setDirty(false);
      window.setTimeout(() => { programmaticRef.current = false; }, 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t clean up the question');
    } finally {
      setRefining(false);
    }
  }, [draft, refining]);

  // ── 追问写入输入框（由用户确认后发送，保持手动控制原则） ──
  const handleAskFollowUp = useCallback((q: string) => {
    programmaticRef.current = true;
    setDraft(q);
    committedRef.current = '';
    dirtyRef.current = false;
    pendingFinalRef.current = true;
    setCommitted('');
    setDirty(false);
    window.setTimeout(() => { programmaticRef.current = false; }, 0);
  }, []);

  // ── Clear the input（识别基准一并清零，ASR 从空白重新累积） ──
  const handleClearDraft = useCallback(() => {
    setDraft('');
    committedRef.current = '';
    dirtyRef.current = false;
    pendingFinalRef.current = false;
    setCommitted('');
    setDirty(false);
  }, []);

  // ── 收藏当前答案 ──
  const handleFavorite = useCallback(() => {
    if (!activeItem?.response.answer) return;
    try {
      const raw = localStorage.getItem(FAV_KEY);
      const favs = raw ? (JSON.parse(raw) as unknown[]) : [];
      favs.push({ question: activeItem.question, answer: activeItem.response.answer, timestamp: Date.now() });
      localStorage.setItem(FAV_KEY, JSON.stringify(favs));
      setToast('🔖 Answer saved');
      window.setTimeout(() => setToast(null), 2000);
    } catch { /* 存储满时静默失败 */ }
  }, [activeItem]);

  // ── 清空聊天历史 ──
  const handleClearHistory = useCallback(() => {
    setItems([]);
    setActiveId(null);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(t => (t === msg ? null : t)), 3000);
  }, []);

  const canSend = !sending && draft.trim().length > 0;
  const modelLabel = health
    ? (import.meta.env.VITE_LLM_LABEL || (/qwen|dashscope/i.test(health.llm_base_url) ? 'Qwen-Max' : 'LLM online'))
    : '—';
  const badge = ASR_BADGE[asrState];

  const saveKey = useCallback(async (key: string) => {
    const api = window.electronAPI;
    if (!api || keyClearPendingRef.current) return;
    await api.credentials.save(key);
    await runtime.refresh();
  }, [runtime.refresh]);

  const clearKey = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    keyClearPendingRef.current = true;
    setKeyClearPending(true);
    try {
      await api.credentials.clear();
      await runtime.refresh();
    } finally {
      keyClearPendingRef.current = false;
      setKeyClearPending(false);
    }
  }, [runtime.refresh]);

  const setThinking = useCallback(async (enabled: boolean) => {
    const api = window.electronAPI;
    if (!api) return;
    await api.runtime.setThinking(enabled);
    await runtime.refresh();
  }, [runtime.refresh]);

  const settingsPanel = IS_ELECTRON && showSettings ? (
    <DeepSeekSettings
      backendState={runtime.backendState}
      message={runtime.message}
      thinkingEnabled={runtime.thinkingEnabled}
      saveKey={saveKey}
      clearKey={clearKey}
      setThinking={setThinking}
      onClose={() => setShowSettings(false)}
    />
  ) : null;

  if (IS_ELECTRON && runtime.loading) {
    return <div className="startup-screen">Starting Live Call Assistant…</div>;
  }
  if (IS_ELECTRON && !runtime.keyConfigured) {
    return <ApiKeySetup save={saveKey} clearingPreviousKey={keyClearPending} />;
  }
  if (IS_ELECTRON && runtime.backendState !== 'ready') {
    const usefulRelaunch = runtime.message.includes('restart');
    return (
      <main className="startup-screen runtime-gate">
        <section className="setup-card" aria-labelledby="runtime-gate-title">
          <div className="setup-logo" aria-hidden="true">🎯</div>
          <h1 id="runtime-gate-title">
            {runtime.backendState === 'error' ? 'The local service needs attention' : 'Starting the local service…'}
          </h1>
          <p role={runtime.backendState === 'error' ? 'alert' : 'status'}>
            {runtime.message || 'Starting the local service…'}
          </p>
          <div className="startup-actions">
            <button className="setup-primary" type="button" onClick={() => setShowSettings(true)}>
              Open DeepSeek settings
            </button>
            {usefulRelaunch && (
              <button type="button" onClick={() => window.electronAPI?.runtime.relaunch()}>
                Restart app
              </button>
            )}
          </div>
        </section>
        {settingsPanel}
      </main>
    );
  }

  // ═══ 浮窗模式（浏览器 ?float=1 预览）：迷你/展开双态 ═══
  if (FLOAT_MODE) {
    const oneLinerQ = draft.trim() || activeItem?.question || '';
    const oneLinerA = activeItem?.response.answer ? oneSentence(activeItem.response.answer) : '';
    const fStateClass = recStatus.running ? (recStatus.state === 'PROCESSING' ? 'busy' : 'on') : 'off';
    const fStateText = recStatus.running ? (recStatus.state === 'PROCESSING' ? 'Transcribing' : 'Listening') : 'Not listening';
    const effOpacity = dimmed ? Math.min(widgetOpacity, 0.45) : widgetOpacity;

    return (
      <div className="float-root" style={{ opacity: effOpacity }} onWheel={handleWheel}>
        {floatExpanded ? (
          <div
            className="float-expanded glass-card"
            onMouseEnter={onWidgetEnter}
            onMouseLeave={onWidgetLeave}
            onContextMenu={e => { e.preventDefault(); setShowSettings(true); }}
          >
            <div className="fw-head" onDoubleClick={() => setFloatExpanded(false)}>
              <AudioRecorder compact onTranscript={handleTranscript} disabled={false} onStatusChange={handleRecStatus} preferBackend={preferBackend} />
              <span className="fw-title">Live Call Assistant</span>
              <span className={`fm-status st-${fStateClass}`}>{fStateText} {fmtElapsed(recStatus.elapsed)}</span>
              <span className="fw-btns">
                <button className="fw-btn" title="Collapse to mini widget" onClick={() => setFloatExpanded(false)}>─</button>
                <button className="fw-btn" title="Settings" onClick={() => setShowSettings(v => !v)}>⚙</button>
                <button
                  className="fw-btn danger"
                  title="Close"
                  onClick={() => (IS_ELECTRON ? window.electronAPI?.close() : setFloatExpanded(false))}
                >
                  ✕
                </button>
              </span>
            </div>

            {activeItem ? (
              <div className="fw-body">
                <QuestionPanel
                  question={activeItem.question}
                  timestamp={activeItem.timestamp}
                  answer={activeItem.response.answer}
                />
                <AnswerPanel key={activeItem.id} item={activeItem} />
              </div>
            ) : (
              <div className="fw-empty">No questions yet. Type below or wait for the caller to speak, then press Enter</div>
            )}

            <div className="float-inputrow">
              <input
                className="float-input"
                value={draft}
                placeholder="Type or edit the caller’s question, Enter to send"
                onChange={e => handleDraftChange(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleSend(); } }}
              />
              <button
                className="dock-btn primary"
                disabled={!canSend}
                onClick={() => void handleSend()}
                title="Send (Enter)"
              >
                {sending ? '⏳' : '➤'}
              </button>
            </div>
          </div>
        ) : (
          <div
            className="float-mini glass-card"
            onMouseEnter={onWidgetEnter}
            onMouseLeave={onWidgetLeave}
            onDoubleClick={() => setFloatExpanded(true)}
            onContextMenu={e => { e.preventDefault(); setShowSettings(true); }}
            title="Double-click to expand / right-click for settings"
          >
            <div className="fm-head">
              <AudioRecorder compact onTranscript={handleTranscript} disabled={false} onStatusChange={handleRecStatus} preferBackend={preferBackend} />
              <span className="fm-title">AI Copilot</span>
              <span className={`fm-status st-${fStateClass}`}>
                {fStateClass === 'on' ? '🟢' : fStateClass === 'busy' ? '🟡' : '⚪'} {fStateText} {fmtElapsed(recStatus.elapsed)}
              </span>
              <span className="fw-btns">
                <button className="fw-btn" title="Expand" onClick={() => setFloatExpanded(true)}>⤢</button>
                <button className="fw-btn" title="Settings" onClick={() => setShowSettings(v => !v)}>⚙</button>
                <button
                  className="fw-btn danger"
                  title="Close"
                  onClick={() => (IS_ELECTRON ? window.electronAPI?.close() : setDimmed(true))}
                >
                  ✕
                </button>
              </span>
            </div>
            <div className="fm-q">Q: {oneLinerQ || 'Waiting for the caller…'}</div>
            <div className="fm-a">A: {oneLinerA || 'Suggested answers show up here'}</div>
          </div>
        )}

        {showSettings && (
          <div className="float-settings glass-card" onContextMenu={e => e.preventDefault()}>
            <div className="fs-title">Settings</div>
            <label className="fs-row fs-slider">
              Opacity {Math.round(widgetOpacity * 100)}%
              <input
                type="range"
                min={30}
                max={100}
                value={Math.round(widgetOpacity * 100)}
                onChange={e => setWidgetOpacity(Number(e.target.value) / 100)}
              />
            </label>
            <label className="fs-row">
              <input type="checkbox" checked={autoHide} onChange={e => setAutoHide(e.target.checked)} />
              Auto-collapse (shrink and dim when the mouse leaves)
            </label>
            <div className="fs-row dim">Scroll to change opacity · right-click for settings · double-click to expand/collapse · ESC to collapse</div>
            {IS_ELECTRON && (
              <button className="fs-exit" onClick={() => window.electronAPI?.close()}>Quit app</button>
            )}
          </div>
        )}
      </div>
    );
  }

  // ═══ 主布局（Electron 桌面浮窗 = 通话实时辅助型）═══
  // 顶部状态栏 / 中部 左20%问题 + 右80%回答 / 底部 实时语音输入坞
  return (
    <div className={`app ${IS_ELECTRON ? 'overlay-mode' : ''}`}>
      {/* 顶部状态栏：品牌 + 监听状态徽章（绿/黄/蓝）+ 窗口控制（Electron 拖拽区） */}
      <header className="app-header top-bar">
        <div className="brand">
          <span className="brand-logo">🎯</span>
          <h1>Live Call Assistant</h1>
        </div>
        <div className="header-right">
          <span className={`listen-badge ${badge.cls}`} title={asrLabel || badge.text}>
            {badge.text}{recStatus.running ? ` · ${fmtElapsed(recStatus.elapsed)}` : ''}
          </span>
          {health && (
            <span className="hdr-chip" title={`Embedding: ${health.embedding_model}`}>
              📚 {health.index_size} chunks
            </span>
          )}
          <span className="hdr-chip" title="Answer model">🤖 {modelLabel}</span>
          {IS_ELECTRON && (
            <FloatingToolbar
              onOpenSettings={() => setShowSettings(true)}
            />
          )}
        </div>
      </header>

      {/* 主区：左 20% 客户问题 / 右 80% AI 回答（最大化回答区域） */}
      <main className="copilot-main" ref={mainScrollRef}>
        {activeItem ? (
          <>
            <QuestionPanel
              question={activeItem.question}
              timestamp={activeItem.timestamp}
              answer={activeItem.response.answer}
              showFollowUps={!activeItem.streaming && !!activeItem.response.answer}
              onAskFollowUp={handleAskFollowUp}
            />
            <AnswerPanel
              key={activeItem.id}
              item={activeItem}
            />
          </>
        ) : (
          <div className="empty-state">
            <p className="empty-icon">💡</p>
            <p>Click 🎤 below to listen to the call (system audio)</p>
            <p className="empty-hint">
              Live transcript → auto-tidied on pause → check it in the box → click Send for a suggested answer · or type ⌨️
            </p>
            <button
              className="demo-btn"
              onClick={() => { void runStream('We added three people halfway through our annual plan. How will that be billed?'); }}
              title="Send a sample customer question to preview the answer card"
            >
              ⚡ Try a sample question
            </button>
          </div>
        )}
      </main>

      {/* 底部输入坞：row1 麦克风+实时输入框+发送；row2 历史/清空/优化/收藏 */}
      <div className="input-dock">
        <div className="dock-row">
          <AudioRecorder
            onTranscript={handleTranscript}
            disabled={false}
            onStatusChange={handleRecStatus}
            onAsrStatus={handleAsrStatus}
            preferBackend={preferBackend}
            onToast={showToast}
          />
          <ChatInput
            value={draft}
            onChange={handleDraftChange}
            onSend={handleSend}
            finalLen={dirty ? draft.length : committed.length}
            asrState={asrState}
            asrLabel={asrLabel}
            asrMetrics={asrMetrics}
            asrEventAt={asrEventAt}
          />
          <button className="dock-btn primary send-btn" onClick={handleSend} disabled={!canSend} title="Send (Enter / Ctrl+Enter): search the docs, then generate an answer">
            {sending ? '⏳ Answering…' : '➤ Send'}
          </button>
        </div>
        <div className="dock-footer">
          <button className="dock-btn" onClick={() => setHistoryOpen(true)} title="Show earlier questions in this call">
            🕘 History{items.length > 0 ? ` ${items.length}` : ''}
          </button>
          <button className="dock-btn" onClick={handleClearDraft} disabled={!draft} title="Clear the input">
            🗑️ Clear
          </button>
          <button
            className="dock-btn"
            onClick={handleRefine}
            disabled={!draft.trim() || refining || sending}
            title="Rewrite the spoken question into a clear one for better search results"
          >
            {refining ? '⏳ Cleaning up…' : '✨ Clean up question'}
          </button>
          <button
            className="dock-btn"
            onClick={handleFavorite}
            disabled={!activeItem?.response.answer}
            title="Save this answer on this Mac"
          >
            🔖 Save answer
          </button>
          <span className="dock-spacer" />
          <span className="dock-kbd">Enter / Ctrl+Enter to send · Shift+Enter for a new line</span>
        </div>
        {error && <div className="error-msg">⚠️ {error}</div>}
        {toast && <div className="toast">{toast}</div>}
      </div>

      {/* 隐藏式历史记录抽屉（左下角「历史」按钮展开） */}
      <HistoryDrawer
        open={historyOpen}
        items={items}
        activeId={activeItem?.id ?? null}
        onSelect={setActiveId}
        onClear={handleClearHistory}
        onClose={() => setHistoryOpen(false)}
      />
      {settingsPanel}
    </div>
  );
}

export default App;
