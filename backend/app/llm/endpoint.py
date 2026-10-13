"""Endpoint Detection + 问题会话管理 + 语义完整性判断。

管线位置（本模块是"ASR 结果 → LLM 回答"之间的闸门）：

    前端 VAD 分段 → /api/audio/segment 转写 → 【本模块决策】→ 放行最终问题 → RAG/LLM

核心机制（对应需求第一/四/七/八/九/十条）：
  1. QuestionSession —— 一次客户提问一个 session_id，
     状态 LISTENING → PROCESSING → ANSWERED；PROCESSING 期间禁止重复触发 LLM。
  2. 语义完整性分类器 classify_completeness —— 轻量规则分类器（<1ms），输出
     {"status": COMPLETE_QUESTION|INCOMPLETE|CONTINUE_EXPECTED|NOT_QUESTION,
      "confidence": 0-1, "type": technical_question|project_question|general}
     只有 COMPLETE_QUESTION（或 hold 超时兜底）才允许进入回答。
  3. 多因素结束判定 —— 前端按 静音时长/能量衰减/语音概率 判定"语句结束"，
     后端按 语义完整度 + 自适应延迟 判定"问题结束"，两层合成 EndScore 决策。
  4. 上下文拼接 —— 停顿切开的多段自动合并为一个问题（"你介绍一下RAG项目" +
     "里面为什么使用Reranker？" → 合并为一个问题）。
  5. 自适应延迟 —— 按问题长度动态调整等待续说的时间：
     短(<10字) 1.0s / 普通(10~50字) 1.5s / 长(>50字) 2.5s，CONTINUE_EXPECTED 追加等待。
  6. 防重复触发 —— 相同/高度相似问题 30s 内去重；会话状态闸门防并发重复调用。

设计说明：分类器为纯规则实现，满足"问题判断 <300ms"的性能要求；
接口与 JSON 输出格式与轻量 LLM 分类器兼容，后续可在 decide() 中无缝替换。
"""

from __future__ import annotations

import difflib
import re
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum

from loguru import logger

from app.config import settings


# ═══════════════════════════════════════════════════════════════════
# 语义完整性分类器
# ═══════════════════════════════════════════════════════════════════

class QStatus(str, Enum):
    COMPLETE = "COMPLETE_QUESTION"       # 完整问题，可进入回答
    INCOMPLETE = "INCOMPLETE"            # 明显未说完（半句话）
    CONTINUE = "CONTINUE_EXPECTED"       # 预期还有下文（列举/铺垫）
    NOT_QUESTION = "NOT_QUESTION"        # 填充词/非问题


# ── 规则表（按优先级使用） ──────────────────────────────────────────

# 纯填充词：整段只有这些 → NOT_QUESTION
_FILLER_SET = {
    "嗯", "嗯嗯", "恩", "啊", "哦", "呃", "诶", "哎",
    "对", "对对", "对的", "好", "好的", "行", "行的", "可以",
    "ok", "OK", "Ok", "okay", "嗯好", "嗯对", "嗯好的", "嗯 ok",
    "明白", "明白了", "了解", "了解了", "知道", "知道了", "我知道",
    "我看一下", "我看看", "让我想想", "我想一下", "稍等", "等一下", "等等",
    "没事", "没事的", "没有关系", "没关系", "没有", "不用", "不用了",
    "继续", "好继续", "嗯继续", "okok", "哦哦", "啊啊",
}

# 疑问信号（出现任一 → 倾向完整问题）
_QUESTION_WORDS = re.compile(
    r"(什么|为什么|为啥|怎么|怎样|咋|如何|哪里|哪个|哪些|哪种|多少|几个|几条|"
    r"是否|是不是|能不能|能否|可不可以|可以吗|有没有|会不会|要不要|需不需要|"
    r"吗|呢|嘛|么$|吗$|呢$)"
)
# 句尾问号
_Q_MARK = re.compile(r"[?？]\s*$")
# 请求类动词（祈使式提问，本身可构成完整问题）
_REQUEST_VERBS = re.compile(
    r"(介绍一下|介绍下|讲讲|讲一下|讲下|说说|说一下|说下|谈谈|聊聊|聊一下|"
    r"描述一下|描述下|解释一下|解释下|分析一下|分析下|对比一下|对比下|比较一下|"
    r"举例|举个例子|展开讲讲|展开说说|详细说说|详细介绍|深入讲讲|说说看)"
)
# 未说完的句尾词（半句话标记）
_INCOMPLETE_TAILS = re.compile(
    r"(的|了|在|是|和|与|及|或|或者|然后|就是|因为|所以|如果|虽说|比如|比如说|"
    r"包括|还有|另外|其次|再者|的话|这个|那个|一种|一个|进行|来|去|把|被|让|给|"
    r"第一|第二|第三|首先)$"
)
# 列举铺垫（说完这句必然有下文）
_ENUM_LEAD = re.compile(
    r"(几个方面|几个方面[啊吧呢]?|以下几点|以下?几[点个方面]|分几[步个点部分]|"
    r"有两[点个]|有三[点个]|第一个是|第二个是|第三个是|首先是|第一点是|一方面)"
)
# 列举进行中的条目（可能还有下一条）
_ENUM_ITEM_TAIL = re.compile(
    r"(第一个|第二个|第三个|第四个|第一点|第二点|首先|其次|然后|最后|一方面|另一方面|"
    r"第[一二三四五六]个是|第[一二三四五六]点)$"
)
# 及物动词结尾（缺宾语 → 大概率没说完："为什么选择" "怎么使用"）
_TRANSITIVE_TAILS = re.compile(
    r"(选择|选用|使用|采用|考虑|设计|实现|解决|处理|优化|改进|提升|降低|"
    r"保证|确保|支持|接入|部署|区分|评估)$"
)


# 笑声 / 非语言声音（"哈哈哈哈" "呵呵"）→ 视为填充，不触发回答
_LAUGH_RE = re.compile(r"^[哈呵嘻嘿嘎]+[哈呵嘻嘿嘎!！~～。，, ]*$")


def _is_all_filler(t: str) -> bool:
    """整段（或其全部组成）都是填充词："嗯" / "ok明白" / "嗯，好的" / "哈哈哈哈"。"""
    s = t.rstrip(",.!?~、 ")
    if not s:
        return True
    if _LAUGH_RE.match(s):
        return True
    if s in _FILLER_SET:
        return True
    for fl in sorted(_FILLER_SET, key=len, reverse=True):
        if fl and s.startswith(fl):
            rest = s[len(fl):].lstrip(",、 ")
            if rest == "" or _is_all_filler(rest):
                return True
    return False


def _norm(text: str) -> str:
    """规范化 ASR 文本：去空白、统一标点。"""
    t = re.sub(r"\s+", "", text or "")
    t = t.replace("，", ",").replace("。", ".").replace("？", "?")
    return t


def classify_completeness(text: str) -> dict:
    """语义完整性分类（轻量规则版，<1ms）。

    返回 {"status", "confidence", "type"}，格式与轻量 LLM 分类器一致。
    """
    raw = (text or "").strip()
    t = _norm(raw)
    n = len(t)

    # 0) 空文本 / 纯填充词 → NOT_QUESTION
    if n == 0:
        return {"status": QStatus.NOT_QUESTION.value, "confidence": 0.99, "type": "filler"}
    if _is_all_filler(t) or (n <= 3 and not _QUESTION_WORDS.search(t)):
        return {"status": QStatus.NOT_QUESTION.value, "confidence": 0.9, "type": "filler"}

    has_qmark = bool(_Q_MARK.search(t))
    has_qword = bool(_QUESTION_WORDS.search(t))
    has_request = bool(_REQUEST_VERBS.search(t))
    enum_lead = bool(_ENUM_LEAD.search(t))
    incomplete_tail = bool(_INCOMPLETE_TAILS.search(t))
    enum_item_tail = bool(_ENUM_ITEM_TAIL.search(t))

    qtype = _question_type(t)

    # 1) 问号结尾 → 完整问题（最强信号）
    if has_qmark:
        conf = 0.95 if (has_qword or has_request) else 0.85
        return {"status": QStatus.COMPLETE.value, "confidence": conf, "type": qtype}

    # 2) 列举铺垫（"考虑几个方面..."）→ 必有下文
    if enum_lead:
        return {"status": QStatus.CONTINUE.value, "confidence": 0.8, "type": qtype}

    # 3) 疑问词（无问号）→ 完整问题；但句尾是半句标记时降级
    if has_qword:
        if (incomplete_tail and n < 15) or (_TRANSITIVE_TAILS.search(t) and n <= 12):
            # "为什么选择...的" / "为什么选择"（缺宾语）这类半截 → 等下文
            return {"status": QStatus.INCOMPLETE.value, "confidence": 0.6, "type": qtype}
        conf = 0.88 if n >= 6 else 0.7
        return {"status": QStatus.COMPLETE.value, "confidence": conf, "type": qtype}

    # 4) 祈使式请求（介绍一下/讲讲...）→ 完整问题
    if has_request:
        if incomplete_tail:
            return {"status": QStatus.CONTINUE.value, "confidence": 0.65, "type": qtype}
        return {"status": QStatus.COMPLETE.value, "confidence": 0.82, "type": qtype}

    # 5) 列举条目结尾（"第一个是数据安全"）→ 可能还有下一条
    if enum_item_tail:
        return {"status": QStatus.CONTINUE.value, "confidence": 0.65, "type": qtype}

    # 6) 半句话尾 → INCOMPLETE
    if incomplete_tail:
        return {"status": QStatus.INCOMPLETE.value, "confidence": 0.7, "type": qtype}

    # 7) 兜底：较长陈述句（可能是提问铺垫）→ 保守放行；太短 → 等下文
    if n >= 10:
        return {"status": QStatus.COMPLETE.value, "confidence": 0.55, "type": qtype}
    return {"status": QStatus.INCOMPLETE.value, "confidence": 0.5, "type": qtype}


def _question_type(t: str) -> str:
    """问题类型粗分（供观测/后续路由扩展，不影响放行决策）。"""
    if re.search(r"(项目|你们|我做|简历|实习|经历|工作中)", t):
        return "project_question"
    if re.search(r"(为什么|原理|区别|如何实现|底层|架构|优缺点|对比)", t):
        return "technical_question"
    return "general"


# ═══════════════════════════════════════════════════════════════════
# 问题会话（Question Session）
# ═══════════════════════════════════════════════════════════════════

class SessionState(str, Enum):
    LISTENING = "LISTENING"      # 累积语音段中
    PROCESSING = "PROCESSING"    # 已决策，等待 hold 结束/放行（禁止重复触发）
    ANSWERED = "ANSWERED"        # 已放行给 RAG/LLM


@dataclass
class QuestionSession:
    session_id: str
    state: SessionState = SessionState.LISTENING
    segments: list[dict] = field(default_factory=list)   # [{text, ts, silence_before_ms}]
    created_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)

    @property
    def merged_text(self) -> str:
        """上下文拼接：多段合并为一个问题（需求第十条）。"""
        parts = [s["text"] for s in self.segments if s.get("text")]
        if not parts:
            return ""
        out = parts[0].rstrip("，,。 ")
        for p in parts[1:]:
            p = p.strip("，,。 ")
            if not p:
                continue
            # 上一段以问号结尾 → 视为两个问题并列，仍合并（客户补充追问同主题）
            out = out + "，" + p
        return out

    @property
    def text_len(self) -> int:
        return len(_norm(self.merged_text))


class QuestionSessionManager:
    """会话管理器：单例。负责会话生命周期、去重、TTL 清理。"""

    def __init__(self) -> None:
        self._sessions: dict[str, QuestionSession] = {}
        self._answered_recently: list[tuple[float, str]] = []  # (ts, norm_text)

    # ── 会话生命周期 ──

    def get_or_create(self, session_id: str | None) -> QuestionSession:
        self._cleanup_ttl()
        if session_id and session_id in self._sessions:
            s = self._sessions[session_id]
            s.last_active = time.time()
            return s
        s = QuestionSession(session_id=session_id or uuid.uuid4().hex[:12])
        self._sessions[s.session_id] = s
        return s

    def _cleanup_ttl(self) -> None:
        now = time.time()
        ttl = settings.session_ttl_s
        stale = [k for k, s in self._sessions.items() if now - s.last_active > ttl]
        for k in stale:
            logger.debug(f"[Session] TTL 清理过期会话 {k}")
            del self._sessions[k]
        self._answered_recently = [
            (ts, t) for ts, t in self._answered_recently if now - ts < 60
        ]

    # ── 去重（需求第九条：防止多次重复调用模型）──

    def is_duplicate(self, text: str) -> bool:
        """30s 内相同/高度相似（>0.9）的问题视为重复触发。"""
        now = time.time()
        nt = _norm(text)
        if not nt:
            return True
        for ts, prev in self._answered_recently:
            if now - ts > 30:
                continue
            if prev == nt:
                return True
            if len(prev) >= 8 and difflib.SequenceMatcher(None, prev, nt).ratio() > 0.9:
                return True
        return False

    def mark_answered(self, text: str) -> None:
        self._answered_recently.append((time.time(), _norm(text)))

    # ── 自适应 hold 时长（需求第八条）──

    @staticmethod
    def adaptive_hold_ms(sess: QuestionSession, status: str) -> int:
        """按问题长度与状态动态计算"等待续说"时长。

        短问题快放行，长问题多等等，避免长问题被提前截断。
        """
        if not settings.endpoint_adaptive_delay:
            base = settings.session_hold_normal_ms
        else:
            n = sess.text_len
            if n < 10:
                base = settings.session_hold_short_ms     # 1000ms
            elif n <= 50:
                base = settings.session_hold_normal_ms    # 1500ms
            else:
                base = settings.session_hold_long_ms      # 2500ms
        if status == QStatus.CONTINUE.value:
            base += 1200     # 明确预期有下文，多等
        elif status == QStatus.INCOMPLETE.value:
            base += 800      # 半句话，多等等续说
        return min(base, 5000)


_session_manager: QuestionSessionManager | None = None


def get_session_manager() -> QuestionSessionManager:
    global _session_manager
    if _session_manager is None:
        _session_manager = QuestionSessionManager()
    return _session_manager


# ═══════════════════════════════════════════════════════════════════
# 端点决策（核心入口）
# ═══════════════════════════════════════════════════════════════════

def decide_on_segment(
    session_id: str | None,
    text: str,
    silence_before_ms: int = 0,
) -> dict:
    """新语音段转写结果进入会话后的决策。

    返回（前端据此行动）：
      action:
        "pending" → 问题未定，继续监听；hold_ms 后若无续说则调 flush 放行
        "answer"  → 立即放行 question 给 RAG/LLM（极少用：强信号+长静音）
        "ignore"  → 填充词/重复，忽略
      question / interim_text / status / confidence / hold_ms / session_id / reason
    """
    mgr = get_session_manager()
    text = (text or "").strip()

    cls = classify_completeness(text)
    status, conf = cls["status"], cls["confidence"]

    # ── 填充词处理（需求第十一条 情况1：客户说"嗯……"→ 忽略）──
    if status == QStatus.NOT_QUESTION.value:
        # 会话里有未决问题 → 保持 pending（填充词不打断问题累积）
        if session_id and session_id in mgr._sessions:
            sess = mgr._sessions[session_id]
            if sess.segments:
                logger.info(f"[Endpoint] 填充词 '{text[:20]}'（会话 {session_id} 保持 pending）")
                return {
                    "action": "pending", "question": None,
                    "interim_text": sess.merged_text,
                    "status": status, "confidence": conf,
                    "hold_ms": mgr.adaptive_hold_ms(sess, QStatus.CONTINUE.value),
                    "session_id": sess.session_id, "reason": "filler_hold",
                }
        logger.info(f"[Endpoint] 填充词忽略: '{text[:20]}'")
        return {"action": "ignore", "question": None, "interim_text": "",
                "status": status, "confidence": conf, "hold_ms": 0,
                "session_id": session_id or "", "reason": "filler"}

    # ── 空转写（噪声段）→ 不打断 ──
    if not text:
        return {"action": "ignore", "question": None, "interim_text": "",
                "status": "EMPTY", "confidence": 0.0, "hold_ms": 0,
                "session_id": session_id or "", "reason": "empty_asr"}

    # ── 语义判断关闭：退回"每段即问题"（保留去重闸门）──
    if not settings.semantic_enabled:
        if mgr.is_duplicate(text):
            return {"action": "ignore", "question": None, "interim_text": text,
                    "status": "DUPLICATE", "confidence": 0.0, "hold_ms": 0,
                    "session_id": session_id or "", "reason": "duplicate"}
        mgr.mark_answered(text)
        return {"action": "answer", "question": text, "interim_text": text,
                "status": QStatus.COMPLETE.value, "confidence": 0.5, "hold_ms": 0,
                "session_id": session_id or "", "reason": "semantic_disabled"}

    sess = mgr.get_or_create(session_id)
    if sess.state == SessionState.ANSWERED:
        # 已放行的旧会话收到新段 → 开新会话（前端通常已换 session_id，这是兜底）
        sess = mgr.get_or_create(None)

    sess.segments.append({
        "text": text, "ts": time.time(), "silence_before_ms": silence_before_ms,
    })
    sess.state = SessionState.LISTENING
    merged = sess.merged_text

    # ── 会话上限保护（连续讲话/无停顿场景的安全闸）──
    # 合并文本超长或会话超时 → 立即放行当前累积内容，防止无限 accumulation
    # （500 字 ≈ 2 分钟语速，覆盖 90s 长问题；超出必是多问题连读）
    over_chars = len(_norm(merged)) > settings.session_max_question_chars
    over_time = (time.time() - sess.created_at) > settings.session_max_question_s
    if over_chars or (over_time and sess.text_len >= 10):
        logger.warning(
            f"[Endpoint] 会话达到上限 (chars={len(_norm(merged))}, "
            f"age={time.time()-sess.created_at:.0f}s)，强制放行"
        )
        if not mgr.is_duplicate(merged):
            return _finalize(mgr, sess, merged, "session_cap")
        mgr._sessions.pop(sess.session_id, None)
        return {"action": "ignore", "question": None, "interim_text": merged,
                "status": "SESSION_CAP", "confidence": 0.0, "hold_ms": 0,
                "session_id": sess.session_id, "reason": "session_cap_duplicate"}

    # 合并后重新分类（拼接可能改变完整性）
    cls_m = classify_completeness(merged)
    m_status, m_conf = cls_m["status"], cls_m["confidence"]
    logger.info(
        f"[Endpoint] 会话 {sess.session_id} 累积段: '{text[:40]}' | "
        f"合并后: '{merged[:60]}' | status={m_status} conf={m_conf:.2f} "
        f"silence_before={silence_before_ms}ms"
    )

    hold_ms = mgr.adaptive_hold_ms(sess, m_status)

    # ── 统一走 hold 等待续说，前端 hold_ms 后 flush ──
    # 不做"立即放行"：即使当前文本已是完整问题，客户仍可能在短停顿后补充
    # （验收场景：介绍RAG项目 + 停顿2s + 为什么选Reranker → 必须合并），
    # 自适应 hold（短问题 1s / 普通 1.5s / 长 2.5s）在"防截断"与"响应速度"间取平衡。
    return {
        "action": "pending", "question": None,
        "interim_text": merged, "status": m_status, "confidence": round(m_conf, 2),
        "hold_ms": hold_ms, "session_id": sess.session_id,
        "reason": f"hold_{m_status.lower()}",
    }


def decide_on_flush(session_id: str | None) -> dict:
    """hold 超时且无续说 → 放行当前累积内容（兜底：宁可放行不丢问题）。"""
    mgr = get_session_manager()
    if not session_id or session_id not in mgr._sessions:
        return {"action": "ignore", "question": None, "interim_text": "",
                "status": "NO_SESSION", "confidence": 0.0, "hold_ms": 0,
                "session_id": session_id or "", "reason": "no_session"}

    sess = mgr._sessions[session_id]
    merged = sess.merged_text
    if not merged.strip():
        del mgr._sessions[session_id]
        return {"action": "ignore", "question": None, "interim_text": "",
                "status": "EMPTY", "confidence": 0.0, "hold_ms": 0,
                "session_id": session_id, "reason": "empty_flush"}

    cls = classify_completeness(merged)
    logger.info(
        f"[Endpoint] flush 会话 {session_id}: '{merged[:60]}' | "
        f"status={cls['status']} conf={cls['confidence']:.2f}"
    )

    # 纯填充词会话（"嗯""对对"）不放行
    if cls["status"] == QStatus.NOT_QUESTION.value:
        del mgr._sessions[session_id]
        logger.info(f"[Endpoint] flush 拦截纯填充词会话: '{merged[:30]}'")
        return {"action": "ignore", "question": None, "interim_text": merged,
                "status": cls["status"], "confidence": cls["confidence"],
                "hold_ms": 0, "session_id": session_id, "reason": "filler_flush"}

    if mgr.is_duplicate(merged):
        del mgr._sessions[session_id]
        logger.info(f"[Endpoint] 重复问题抑制: '{merged[:40]}'")
        return {"action": "ignore", "question": None, "interim_text": merged,
                "status": cls["status"], "confidence": cls["confidence"],
                "hold_ms": 0, "session_id": session_id, "reason": "duplicate"}

    return _finalize(mgr, sess, merged, "flush_timeout")


def _finalize(mgr: QuestionSessionManager, sess: QuestionSession,
              question: str, reason: str) -> dict:
    """放行问题：标记会话 ANSWERED + 去重登记，返回 answer 动作。"""
    sess.state = SessionState.ANSWERED
    mgr.mark_answered(question)
    # 会话使命结束，移除（后续同 session_id 会开新会话）
    mgr._sessions.pop(sess.session_id, None)
    logger.info(f"✅ [Endpoint] 放行问题 ({reason}): '{question[:80]}'")
    return {
        "action": "answer", "question": question,
        "interim_text": question,
        "status": QStatus.COMPLETE.value, "confidence": 0.9,
        "hold_ms": 0, "session_id": sess.session_id, "reason": reason,
    }
