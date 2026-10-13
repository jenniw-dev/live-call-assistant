export interface ChatResponse {
  answer: string;
  source: 'kb' | 'llm_refine' | 'llm' | 'llm_cache';
  score: number | null;
  file: string | null;
  matched_question: string | null;
}

// 回答展示模式（纯前端 UI 状态，不改后端接口）：
//   quick=30秒口述版 / deep=全文技术深入 / project=结合知识库项目经验 / star=STAR 结构（经已有流式接口二次生成）
export type AnswerMode = 'quick' | 'deep' | 'project' | 'star';

export interface ChatItem {
  id: string;
  question: string;
  response: ChatResponse;
  timestamp: number;
  streaming?: boolean;    // true = 答案正在流式生成中
  latency_ms?: number;    // 首字延迟（发送 → 首个 delta 到达），实时性能观测
  modeAnswers?: Partial<Record<AnswerMode, ChatResponse>>; // 模式二次生成缓存（如 STAR）
  modeStreaming?: AnswerMode | null; // 某模式正在流式生成
}

export interface HealthResponse {
  status: string;
  embedding_model: string;
  index_size: number;
  llm_base_url: string;
  auto_answer: boolean;   // false=手动发送模式（默认）；true=ASR放行后自动回答
  backend_capture?: boolean;  // 后端 WASAPI Loopback 采集可用 → 前端默认采集源
}

// ASR 转写结果类型：partial=实时中间文本（持续追加/微调输入框），final=整句定稿
export type TranscriptKind = 'partial' | 'final';

// ── 流式识别状态（输入框顶部展示，需求第三条）──
// LISTENING=🎙正在监听 / RECOGNIZING=✍️正在识别 / DONE=✅识别完成 /
// READY=🔵问题整理完成可发送（静音1.5s后由后端 question_ready 触发） / PAUSED=⏸已暂停
export type AsrState = 'IDLE' | 'LISTENING' | 'RECOGNIZING' | 'DONE' | 'READY' | 'PAUSED' | 'ERROR';

export interface AsrStatusInfo {
  state: AsrState;
  label: string;      // 带 emoji 的展示文案
  engine?: string;    // paraformer | local（调试）
}

// ── 链路耗时（需求第十一条，仅开发模式展示）──
export interface AsrMetrics {
  audioMs: number;    // Audio latency：采集 → 发送（缓冲/分帧）
  asrMs: number;      // ASR latency：后端引擎产出该文本的耗时
  uiMs: number;       // UI update latency：事件到达 → 输入框渲染完成
  totalMs: number;    // Total latency ≈ audio + asr + ui
}
