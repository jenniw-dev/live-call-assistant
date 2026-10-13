"""内置专业词表 + 短时上下文纠错（需求第七/八条，流式识别文本统一纠错入口）。

第七条例外规避（硬性）：
    RAG → 拉格   ❌ 必须纠正回 RAG
    GPT → GTP    ❌ 必须纠正回 GPT
    BGE-M3 → BGM3 ❌ 必须纠正回 BGE-M3

第八条上下文消歧（不引入 LLM，纯规则 <1ms）：
    上一句: "项目里面使用BGE-M3作为embedding模型"
    下一句: "为什么选择它"
    —— 最近 final 句中的术语进入高优先级变体映射，下一句的模糊变体
       （bge m3 / lang graph / 拉格 等）优先向上下文术语对齐，降低歧义。

统一入口 streaming_correct(text)：
    同音误识别修正 → 上下文术语提权 → 知识库辅助 → 静态词典纠错（幂等）。
"""

from __future__ import annotations

import re
from collections import deque

from loguru import logger

from app.asr.kb_terms import _TOKEN_RE, _is_term, _variants

# ── Built-in hotwords (product + support vocabulary) ──────────────────
BUILTIN_HOTWORDS: list[str] = [
    "Pebblework", "workspace", "SSO", "SAML", "Okta", "Azure AD", "2FA",
    "API", "API key", "webhook", "CSV", "Slack", "Google Calendar", "Zapier",
    "Free plan", "Team plan", "Business plan", "Enterprise", "invoice", "refund", "prorated", "GDPR", "SOC 2",
]


# ── 中文同音/形近误识别修正（高置信度，带边界保护）──────────────────

def fix_homophones(text: str) -> str:
    """修正 ASR 高频同音误识别。幂等，保护合法词（如"拉格朗日"不受影响）。"""
    if not text:
        return text
    out = text
    # 拉格 → RAG（负向前瞻保护 拉格朗日/拉格勒 等数学名词）
    out = re.sub(r"拉格(?![朗勒])", "RAG", out)
    # GTP → GPT（词边界保护，大小写不敏感）
    out = re.sub(r"(?<![A-Za-z0-9])[Gg][Tt][Pp](?![A-Za-z0-9])", "GPT", out)
    # BGM3 / BGM-3 / BGM 3 → BGE-M3
    out = re.sub(r"(?<![A-Za-z0-9])[Bb][Gg][Mm][\s\-]*3(?![A-Za-z0-9])", "BGE-M3", out)
    if out != text:
        logger.debug(f"🔤 [HotFix] '{text[:50]}' → '{out[:50]}'")
    return out


# ── 短时 ASR 上下文（需求第八条）────────────────────────────────────

class AsrContext:
    """最近 N 条 final 句的术语提权表。

    客户刚提到的术语，下一句大概率还会提到；其 ASR 变体拼写
    优先纠正为上下文中的规范写法（优先级高于知识库静态表）。
    """

    def __init__(self, maxlen: int = 3):
        self._recent: deque[str] = deque(maxlen=maxlen)

    def note(self, final_text: str) -> None:
        t = (final_text or "").strip()
        if t:
            self._recent.append(t)

    def term_map(self) -> dict[str, str]:
        """上下文术语 → 变体映射（变体→规范写法）。"""
        terms: set[str] = set()
        for sent in self._recent:
            for tok in _TOKEN_RE.findall(sent):
                if _is_term(tok):
                    terms.add(tok)
        vmap: dict[str, str] = {}
        for term in terms:
            for v in _variants(term):
                vmap[v] = term
        return vmap

    def reset(self) -> None:
        self._recent.clear()


_asr_context = AsrContext()


def get_asr_context() -> AsrContext:
    return _asr_context


# ── 统一纠错入口 ────────────────────────────────────────────────────

def streaming_correct(text: str) -> str:
    """流式识别文本统一纠错（partial/final 共用；纯规则 <1ms，幂等）。

    顺序：同音误识别 → 上下文术语提权 → 知识库辅助变体 → 静态词典。
    """
    from app.asr.term_correct import correct_terms
    from app.asr.kb_terms import kb_assisted_terms

    if not text:
        return text
    out = fix_homophones(text)
    # 上下文术语优先于 KB 静态表（同变体冲突时上下文覆盖）
    extra = {**kb_assisted_terms(out), **_asr_context.term_map()}
    out = correct_terms(out, extra_terms=extra)
    return out
