import { useRef, useEffect, useLayoutEffect, useState, KeyboardEvent } from 'react';
import type { AsrMetrics, AsrState } from '../types';

interface Props {
  value: string;                    // 输入框内容（ASR 实时文本 + 用户可编辑）
  onChange: (v: string) => void;    // 用户手动编辑
  onSend: () => void;               // 发送 → 调用 AI 回答（唯一入口，用户控制）
  /** 已定稿(final)前缀长度：白色渲染；其后为实时 partial 灰色。用户编辑过时传 value.length */
  finalLen?: number;
  /** 流式识别状态（输入框顶部展示，需求第三条） */
  asrState?: AsrState;
  asrLabel?: string;
  /** 链路耗时（需求第十一条）：audio/asr 由录音侧测，ui 在本组件渲染后测 */
  asrMetrics?: AsrMetrics | null;
  /** 最近一次 ASR 事件到达时刻（performance.now），用于测 UI update latency */
  asrEventAt?: number;
}

const MAX_LEN = 500;

// 开发调试面板（需求第十一条）：DEV 构建或 URL ?asrdebug=1 时展示
const SHOW_DEBUG = import.meta.env.DEV
  || (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('asrdebug'));

/**
 * 底部大尺寸实时字幕编辑框：
 *   ASR partial 实时增量写入 / final 整句追加；
 *   用户手动编辑时 ASR 只追加不覆盖（补充约束3），光标平滑不跳动；
 *   只有 Enter / Ctrl+Enter / 点击「发送」才调用 AI 回答（绝不自动发送）；
 *   识别文本双色渲染：已定稿 final 白色、实时 partial 灰色
 *   （透明文字 textarea + 背后同步渲染层，字体度量完全一致）。
 */
export default function ChatInput({
  value, onChange, onSend, finalLen, asrState, asrLabel, asrMetrics, asrEventAt,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // ── 光标平滑（补充约束3）：ASR 程序化更新 value 后恢复/顺延光标 ──
  const selRef = useRef<{ s: number; e: number; len: number } | null>(null);

  const captureSelection = () => {
    const el = inputRef.current;
    if (el) selRef.current = { s: el.selectionStart ?? 0, e: el.selectionEnd ?? 0, len: el.value.length };
  };

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || document.activeElement !== el) {
      selRef.current = null;
      return;
    }
    const prev = selRef.current;
    const wasAtEnd = !prev || prev.e >= prev.len;
    if (wasAtEnd) {
      el.setSelectionRange(value.length, value.length);   // 跟随最新识别（平滑打字感）
    } else if (prev) {
      el.setSelectionRange(Math.min(prev.s, value.length), Math.min(prev.e, value.length));
    }
    selRef.current = { s: el.selectionStart ?? 0, e: el.selectionEnd ?? 0, len: value.length };
  }, [value]);

  // ASR 写入且未聚焦时保持滚动到底部；同步背景渲染层滚动位置
  useEffect(() => {
    const el = inputRef.current;
    if (el && document.activeElement !== el) el.scrollTop = el.scrollHeight;
    if (el && backdropRef.current) {
      backdropRef.current.scrollTop = el.scrollTop;
      backdropRef.current.scrollLeft = el.scrollLeft;
    }
  }, [value]);

  const syncScroll = () => {
    const el = inputRef.current;
    if (el && backdropRef.current) {
      backdropRef.current.scrollTop = el.scrollTop;
      backdropRef.current.scrollLeft = el.scrollLeft;
    }
  };

  // ── 中文输入法组词期间：textarea 恢复可见文字，隐藏背景层（防重影） ──
  const [composing, setComposing] = useState(false);

  // ── UI update latency：事件到达 → 本次渲染提交 ──
  const lastMarkRef = useRef(0);
  const [uiMs, setUiMs] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (asrEventAt && asrEventAt !== lastMarkRef.current) {
      lastMarkRef.current = asrEventAt;
      const dt = performance.now() - asrEventAt;
      if (dt >= 0 && dt < 5000) setUiMs(Math.round(dt));
    }
  }, [value, asrEventAt]);

  // Enter / Ctrl+Enter 发送；Shift+Enter 换行（绝不自动发送）
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !composing) {
      e.preventDefault();
      onSend();
    }
  };

  const metrics = asrMetrics ?? null;
  const totalMs = metrics && uiMs !== null
    ? Math.round(metrics.audioMs + metrics.asrMs + uiMs)
    : null;

  const splitAt = Math.min(Math.max(finalLen ?? value.length, 0), value.length);
  const finalPart = value.slice(0, splitAt);
  const partialPart = value.slice(splitAt);

  return (
    <div className="dock-editor">
      <div className="editor-head">
        <span className="editor-title">🎙 Live transcript</span>
        {asrState && asrLabel && (
          <span className={`asr-chip st-${asrState.toLowerCase()}`} data-state={asrState}>{asrLabel}</span>
        )}
        {SHOW_DEBUG && metrics && (metrics.audioMs > 0 || metrics.asrMs > 0) && (
          <span className="asr-metrics" title="Debug: audio pipeline timing">
            Audio {Math.round(metrics.audioMs)}ms · ASR {Math.round(metrics.asrMs)}ms ·
            UI {uiMs ?? '–'}ms · Total {totalMs ?? '–'}ms
          </span>
        )}
        <span className="editor-hint">The caller’s words appear here · edit if needed · then click Send</span>
      </div>

      <div className={`chat-input-wrap ${composing ? 'composing' : ''}`}>
        {/* 背景同步渲染层：白色=已定稿文本，灰色=实时识别中 */}
        <div className="chat-input-backdrop" ref={backdropRef} aria-hidden>
          <span className="seg-final">{finalPart}</span>
          <span className="seg-partial">{partialPart}</span>
          {'​'}
        </div>
        <textarea
          ref={inputRef}
          className="chat-input chat-input-lg overlay-input"
          placeholder="The caller’s question is transcribed here. Edit it if needed, then click Send to get a suggested answer."
          value={value}
          maxLength={MAX_LEN}
          onChange={e => { captureSelection(); onChange(e.target.value); }}
          onKeyUp={captureSelection}
          onClick={captureSelection}
          onSelect={captureSelection}
          onScroll={syncScroll}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={handleKeyDown}
          rows={3}
        />
      </div>
      <span className="char-count">{value.length}/{MAX_LEN}</span>
    </div>
  );
}
