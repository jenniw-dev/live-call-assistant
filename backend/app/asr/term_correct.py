"""Product-term correction for ASR output.

ASR 对技术名词的识别错误模式：
  - 英文词被空格切碎：  "lang graph" → LangGraph、"bge rerank" → BGE Reranker
  - 大小写丢失：        "rag" → RAG、"qlora" → QLoRA
  - 中文同音错字：      "检所" → 检索

策略（纯规则，<1ms，不依赖 LLM）：
  1. 多词短语优先（最长匹配），词边界保护，防误伤已正确的写法；
  2. 单词术语按"长词优先"排序替换（reranker 先于 rerank）；
  3. 中文错字小表只收高置信度同音误识别；
  4. 预留 extra_terms 扩展口 —— Phase 3 知识库辅助纠错动态注入术语映射。
"""

from __future__ import annotations

import re

from loguru import logger

# ── Multi-word phrases (spacing / hyphen variants) → canonical form ──────
_PHRASES: list[tuple[str, str]] = [
    ("single sign on", "SSO"),
    ("single sign-on", "SSO"),
    ("two factor authentication", "two-factor authentication"),
    ("two factor", "two-factor"),
    ("web hook", "webhook"),
    ("web hooks", "webhooks"),
    ("api key", "API key"),
    ("azure ad", "Azure AD"),
    ("google calendar", "Google Calendar"),
    ("soc two", "SOC 2"),
    ("soc 2", "SOC 2"),
    ("pro rated", "prorated"),
    ("csv file", "CSV file"),
]

# ── Single product terms → canonical spelling (longest first) ─────────
_SINGLES: list[tuple[str, str]] = [
    ("pebblework", "Pebblework"),
    ("webhooks", "webhooks"),
    ("webhook", "webhook"),
    ("zapier", "Zapier"),
    ("okta", "Okta"),
    ("saml", "SAML"),
    ("sso", "SSO"),
    ("2fa", "2FA"),
    ("gdpr", "GDPR"),
    ("csv", "CSV"),
    ("api", "API"),
    ("sdk", "SDK"),
]

# ── Chinese homophone fixes (kept for bilingual calls; high confidence only) ──
_CN_TYPO: dict[str, str] = {
    "单点登路": "单点登录",
    "退宽": "退款",
}

# 预编译正则（词边界用 [A-Za-z0-9] 环视：中文相邻也能命中，英文粘连不误伤）
def _compile(parts: list[str]) -> re.Pattern:
    """term 列表 → (?<![A-Za-z0-9])t1[\s\-]*t2(?![A-Za-z0-9])，IGNORECASE。"""
    out = []
    for p in parts:
        words = p.split()
        inner = r"[\s\-]*".join(re.escape(w) for w in words)
        out.append(re.compile(rf"(?<![A-Za-z0-9]){inner}(?![A-Za-z0-9])", re.IGNORECASE))
    return out


_PHRASE_RES = _compile([p for p, _ in _PHRASES])
_SINGLE_RES = _compile([s for s, _ in _SINGLES])


def correct_terms(text: str, extra_terms: dict[str, str] | None = None) -> str:
    """ASR 文本 → 技术词规范文本。幂等：对已规范文本再跑一遍结果不变。

    extra_terms: Phase 3 知识库辅助纠错注入的动态映射（"lang chain graph"→LangGraph 等）。
    """
    if not text:
        return text
    out = text

    # 0) 动态注入的术语映射优先（知识库上下文相关，置信度更高）
    # 长变体先替换，防短前缀变体（langgra）抢先污染长词（langgraph）
    if extra_terms:
        for wrong, right in sorted(extra_terms.items(), key=lambda kv: len(kv[0]), reverse=True):
            if wrong and wrong in out and wrong != right:
                out = out.replace(wrong, right)

    # 1) 多词短语（最长优先，按表序）
    for rx, (_, canonical) in zip(_PHRASE_RES, _PHRASES):
        out = rx.sub(canonical, out)

    # 2) 单词术语（长词优先）
    for rx, (_, canonical) in zip(_SINGLE_RES, _SINGLES):
        out = rx.sub(canonical, out)

    # 3) 中文同音错字
    for wrong, right in _CN_TYPO.items():
        if wrong in out:
            out = out.replace(wrong, right)

    if out != text:
        logger.info(f"🔤 [TermFix] '{text[:60]}' → '{out[:60]}'")
    return out
