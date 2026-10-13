import type { ChatResponse } from '../types';

// ─── Known product terms (shown as question tags / key points) ─────────────
const KNOWN_TERMS: { term: string; desc: string }[] = [
  { term: 'Refund', desc: 'Annual: full refund within 30 days' },
  { term: 'Invoice', desc: 'Settings → Billing → Invoices' },
  { term: 'Prorated', desc: 'New seats charged for the time left' },
  { term: 'Seats', desc: 'Per-user billing; guests are free' },
  { term: 'Trial', desc: '14-day Business trial, no card' },
  { term: 'Team', desc: '$9/user/mo annual · $11 monthly' },
  { term: 'Business', desc: '$19/user/mo annual · SSO, audit log' },
  { term: 'Enterprise', desc: 'Custom quote · SCIM, EU hosting' },
  { term: 'SSO', desc: 'SAML on Business and Enterprise' },
  { term: 'SCIM', desc: 'Enterprise only' },
  { term: '2FA', desc: 'Available on every plan' },
  { term: 'Two-factor', desc: 'Available on every plan' },
  { term: 'Export', desc: 'CSV or JSON, every plan' },
  { term: 'API', desc: 'Team and up · 100 requests/min' },
  { term: 'Webhook', desc: 'Team and up' },
  { term: 'Slack', desc: 'Paid plans · Settings → Integrations' },
  { term: 'Cancel', desc: 'Read-only for 90 days after' },
  { term: 'GDPR', desc: 'DPA in Settings → Legal' },
  { term: 'SOC 2', desc: 'Type II report via trust portal' },
  { term: 'Data residency', desc: 'EU hosting is Enterprise only' },
];

// Common words excluded from token extraction
const EN_STOP = new Set([
  'the', 'and', 'is', 'are', 'was', 'were', 'of', 'in', 'on', 'to', 'for',
  'a', 'an', 'it', 'this', 'that', 'with', 'as', 'by', 'or', 'be', 'can',
  'how', 'what', 'why', 'when', 'where', 'you', 'your', 'we', 'our', 'my',
]);

/** Extract keywords from question + answer: known product terms first, then capitalised tokens */
export function extractKeywords(question: string, answer: string, max = 6): string[] {
  const text = `${question}\n${answer}`.toLowerCase();
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const k = t.toLowerCase();
    if (seen.has(k) || found.length >= max) return;
    seen.add(k);
    found.push(t);
  };

  for (const { term } of KNOWN_TERMS) {
    if (text.includes(term.toLowerCase())) push(term);
  }

  // 问题中的英文技术词（如 Query / Embedding / Vector Search 首字母大写 token）
  const enRe = /[A-Z][A-Za-z0-9+#-]{1,15}/g;
  let m: RegExpExecArray | null;
  while ((m = enRe.exec(question)) !== null && found.length < max) {
    const w = m[0];
    if (!EN_STOP.has(w.toLowerCase())) push(w);
  }
  return found;
}

/** Short description for a keyword chip */
export function keywordDesc(keyword: string): string {
  const hit = KNOWN_TERMS.find(t => t.term.toLowerCase() === keyword.toLowerCase());
  return hit ? hit.desc : 'Mentioned in the question or answer';
}

/** ~30-second spoken version: cut at sentence boundaries */
export function summarize30s(answer: string, maxLen = 140): string {
  const clean = answer.replace(/[#>*`|-]/g, '').trim();
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  const sentences = clean.split(/(?<=[。！？!?\n])/);
  let out = '';
  for (const s of sentences) {
    if (!s.trim()) continue;
    if (out && out.length + s.length > maxLen) break;
    out += s;
  }
  return (out || clean.slice(0, maxLen)).trim() + '…';
}

/** 一句话版（快速操作：一句话回答） */
export function oneSentence(answer: string): string {
  const clean = answer.replace(/[#>*`|-]/g, '').trim();
  const m = clean.split(/(?<=[。！？!?])/)[0];
  return (m || clean.slice(0, 60)).trim();
}

/** Likely next questions from the customer: keyword templates + generic pool; seed rotates the list. */
export function genFollowUps(keywords: string[], seed = 0): string[] {
  const pool: string[] = [];
  for (const k of keywords.slice(0, 3)) {
    pool.push(`Is ${k} included in my current plan?`);
    pool.push(`How long does ${k} take to set up?`);
    pool.push(`Does ${k} cost extra?`);
  }
  pool.push(
    'Can I get that in writing by email?',
    'What happens to my data if I cancel?',
    'Is there a discount if we pay yearly?',
    'Can I talk to someone in sales about this?',
    'How long does a refund take?',
  );
  const off = pool.length ? seed % pool.length : 0;
  const rotated = [...pool.slice(off), ...pool.slice(0, off)];
  return [...new Set(rotated)].slice(0, 5);
}

/** Confidence星级：score → 1~5 星；无 score（纯 LLM）给 3 星中性 */
export function scoreStars(score: number | null): number {
  if (score === null) return 3;
  return Math.max(1, Math.min(5, Math.round(score * 5)));
}

// ─── 回答来源映射（后端 source 字段 → 来源占比/命中展示）──────────────
export interface SourceMeta {
  kbPct: number;      // 项目知识库占比
  llmPct: number;     // 通用大模型占比
  matched: boolean;   // 是否命中个人项目经验
  label: string;
  icon: string;
  color: string;
}

export function sourceMeta(r: ChatResponse): SourceMeta {
  switch (r.source) {
    case 'kb':
      return { kbPct: 100, llmPct: 0, matched: true, label: 'From docs', icon: '📚', color: '#22c55e' };
    case 'llm_refine':
      return { kbPct: 70, llmPct: 30, matched: true, label: 'Docs + AI', icon: '🔍', color: '#f59e0b' };
    default:
      return { kbPct: 0, llmPct: 100, matched: false, label: 'AI only', icon: '🤖', color: '#6366f1' };
  }
}

// ─── 时间格式化 ───────────────────────────────────────────────────────
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
