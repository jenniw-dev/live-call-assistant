import { useEffect } from 'react';
import type { ChatItem } from '../types';
import { fmtClock } from '../utils/derive';

interface Props {
  open: boolean;
  items: ChatItem[];
  activeId: string | null;
  onSelect: (id: string) => void;   // 回看某条问答（主区聚焦）
  onClear: () => void;
  onClose: () => void;
}

/**
 * 隐藏式历史记录抽屉（替代旧底部横向 chips 列表）：
 *   默认不展示，点左下角「🕘 History」按钮展开；左侧滑入，不占主要通话区域。
 */
export default function HistoryDrawer({ open, items, activeId, onSelect, onClear, onClose }: Props) {
  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={`hd-mask ${open ? 'show' : ''}`} onClick={onClose} />
      <aside className={`history-drawer ${open ? 'open' : ''}`} aria-hidden={!open}>
        <div className="hd-head">
          <span className="hd-title">🕘 Call history</span>
          <button className="hd-close" onClick={onClose} title="Close (ESC)">✕</button>
        </div>

        {items.length === 0 ? (
          <div className="hd-empty">No history yet</div>
        ) : (
          <div className="hd-list">
            {/* 倒序：最新在上 */}
            {[...items].reverse().map((it, idx) => (
              <button
                key={it.id}
                className={`hd-item ${activeId === it.id ? 'active' : ''}`}
                onClick={() => { onSelect(it.id); onClose(); }}
                title={it.question}
              >
                <span className="hd-q">
                  Q{items.length - idx} · {it.question.slice(0, 34)}{it.question.length > 34 ? '…' : ''}
                </span>
                <span className="hd-meta">
                  <span className={`hd-src ${it.response.source === 'kb' ? 'kb' : 'llm'}`}>
                    {it.response.source === 'kb' ? '📚 Docs' : '🤖 LLM'}
                  </span>
                  <span className="hd-time">{fmtClock(it.timestamp)}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {items.length > 0 && (
          <div className="hd-foot">
            <button className="dock-btn ghost" onClick={onClear}>🗑️ Clear history</button>
          </div>
        )}
      </aside>
    </>
  );
}
