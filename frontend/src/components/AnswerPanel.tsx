import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';   // 浅色代码高亮主题（配合浅色玻璃风）
import type { ChatItem } from '../types';
import { scoreStars, sourceMeta } from '../utils/derive';

interface Props {
  item: ChatItem;
}

function isSafeExternalLink(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && Boolean(url.hostname)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

/**
 * 「AI 回答」主卡片 —— 界面最大区域（布局 80% 宽度）：
 *   完整 Markdown 回答（大字体、代码高亮、流式自动滚动）
 *   底部折叠：「查看回答依据」（来源/Confidence/Match，默认隐藏）
 *   「可能追问」已移至左侧客户问题卡片下方空白区（见 QuestionPanel）。
 * 绝不自动发送：回答仅供阅读，追问也需用户确认后发送。
 */
export default function AnswerPanel({ item }: Props) {
  const [basisOpen, setBasisOpen] = useState(false);     // 回答依据折叠（默认隐藏）
  const scrollRef = useRef<HTMLDivElement>(null);

  const r = item.response;
  const meta = sourceMeta(r);
  const streaming = !!item.streaming;
  const stars = scoreStars(r.score);

  // 流式生成期间自动滚动到底部（保持最新内容可见；用户向上翻看时不打扰：
  // 仅当滚动条接近底部时才跟随）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !streaming) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [r.answer, streaming]);

  const md = (text: string) => (
    <ReactMarkdown
      rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
      components={{
        img: ({ alt }) => (
          <span className="blocked-markdown-image">{alt || 'Image blocked'}</span>
        ),
        a: ({ href, children }) => {
          if (!isSafeExternalLink(href)) return <span>{children}</span>;
          return (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                window.electronAPI?.openExternal(href);
              }}
            >
              {children}
            </a>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );

  return (
    <section className="glass-card answer-panel">
      <div className="panel-head">
        <span className="panel-title">✨ Suggested answer</span>
        <span className="head-badges">
          {typeof item.latency_ms === 'number' && (
            <span
              className="latency-badge"
              style={{ color: item.latency_ms <= 2000 ? 'var(--green)' : 'var(--amber)' }}
              title="First-token latency: send → first character (target ≤ 1s)"
            >
              ⚡ First token {(item.latency_ms / 1000).toFixed(1)}s
            </span>
          )}
          {streaming && <span className="streaming-badge">⚡ Generating</span>}
        </span>
      </div>

      {/* 回答主体：最大化区域，流式逐字 + 光标 */}
      <div className="answer-scroll" ref={scrollRef}>
        {streaming && !r.answer ? (
          <div className="retrieving">
            <span className="spinner" />
            <span className="retrieving-text">🔍 Searching the product docs...</span>
            {r.score !== null && (
              <span className="retrieving-hit">✅ Found in docs · Match {(r.score * 100).toFixed(0)}%</span>
            )}
          </div>
        ) : (
          <div className="markdown-body answer-full">
            {r.answer
              ? md(r.answer)
              : <span className="streaming-placeholder">Thinking...</span>}
            {streaming && r.answer && <span className="streaming-cursor">▍</span>}
          </div>
        )}
      </div>

      {/* 生成完成后：折叠区（回答依据），默认收起不占回答空间 */}
      {!streaming && r.answer && (
        <div className="answer-collapses">
          <div className="collapse-block">
            <button className="collapse-toggle" onClick={() => setBasisOpen(v => !v)}>
              🔍 Show source {basisOpen ? '▲' : '▼'}
            </button>
            {basisOpen && (
              <div className="answer-basis">
                <div className="basis-row">
                  <span>📚 Product docs</span><b className="pct-kb">{meta.kbPct}%</b>
                  <span className="basis-gap">🧠 General model</span><b className="pct-llm">{meta.llmPct}%</b>
                </div>
                <div className="basis-row">
                  <span>Confidence</span>
                  <span className="stars" title={`Confidence ${stars}/5${r.score !== null ? `（Match ${(r.score * 100).toFixed(0)}%）` : ''}`}>
                    {'★'.repeat(stars)}<span className="star-dim">{'★'.repeat(5 - stars)}</span>
                  </span>
                  {r.score !== null && <span className="match-pct">Match <b>{(r.score * 100).toFixed(0)}%</b></span>}
                </div>
                {meta.matched ? (
                  <div className="matched-line ok">✅ Matched the product docs</div>
                ) : (
                  <div className="matched-line warn">⚠️ Not in the docs · check before promising anything</div>
                )}
                {r.file && <div className="src-file" title={r.file}>Source: {r.file}</div>}
                {r.matched_question && <div className="src-file">Matched question: {r.matched_question}</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
