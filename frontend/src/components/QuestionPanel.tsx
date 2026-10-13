import { useState } from 'react';
import { extractKeywords, fmtClock, genFollowUps } from '../utils/derive';

interface Props {
  question: string;
  timestamp: number;
  answer: string;   // 用于关键词提取（问题+回答），流式期间渐进丰富
  showFollowUps?: boolean;              // 回答生成完成 → 在问题下方空白区展示可能追问
  onAskFollowUp?: (q: string) => void;  // 追问写入输入坞，由用户确认发送
}

/**
 * 左侧「客户问题」卡片：
 *   问题原文（大字号，3 秒可读）+ 时间戳 + 问题分析标签（技术关键词 chips）
 *   问题下方空白区：「可能追问」（默认收起，点击写入输入框由用户确认发送）
 * 绝不自动发送：追问也需用户确认后发送。
 */
export default function QuestionPanel({ question, timestamp, answer, showFollowUps, onAskFollowUp }: Props) {
  const keywords = extractKeywords(question, answer);
  const [followUpOpen, setFollowUpOpen] = useState(false); // 可能追问折叠（默认收起）
  const [seed, setSeed] = useState(0);

  const followUps = genFollowUps(keywords, seed);

  return (
    <section className="glass-card question-panel">
      <div className="panel-head">
        <span className="panel-title">👤 Customer question</span>
        <span className="panel-time">{fmtClock(timestamp)}</span>
      </div>

      <div className="caller-label">Customer</div>
      <div className="question-text">{question}</div>

      <div className="question-tags">
        <div className="sub-title">🧩 Key points</div>
        {keywords.length > 0 ? (
          <div className="tag-row">
            {keywords.map(k => (
              <span key={k} className="qtag">{k}</span>
            ))}
          </div>
        ) : (
          <div className="tags-empty">No product terms detected</div>
        )}
      </div>

      {/* 可能追问：移至问题卡片下方空白区（默认收起，点击写入输入框由用户确认发送） */}
      {showFollowUps && onAskFollowUp && (
        <div className="collapse-block">
          <button className="collapse-toggle" onClick={() => setFollowUpOpen(v => !v)}>
            ❓ Likely next questions {followUpOpen ? '▲' : '▼'}
          </button>
          {followUpOpen && (
            <div className="followup-body">
              <button className="shuffle-btn" onClick={() => setSeed(s => s + 1)} title="Show other likely questions">
                🔄 Show others
              </button>
              <ol className="followup-list">
                {followUps.map((f, i) => (
                  <li key={f}>
                    <button className="followup-item" onClick={() => onAskFollowUp(f)} title="Put in the input box; send after checking">
                      <span className="fu-idx">{i + 1}.</span> {f}
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
