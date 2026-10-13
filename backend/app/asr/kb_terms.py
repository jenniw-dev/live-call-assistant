"""知识库辅助纠错（需求第十条）—— 纠错不只靠词典，还结合个人知识库与聊天历史。

场景示例：
    ASR: "为什么选择lang chain graph"
    知识库含: "LangGraph State设计" 相关文档
    → 生成变体映射 "lang chain graph"→LangGraph 并修正

机制：
  1. 启动后首次调用时解析知识库 chunks（复用 rag.parser，不重建索引、不动向量库），
     抽取技术术语（CamelCase / 全大写缩写 / 含连字符型号，如 LangGraph、BGE-M3）；
  2. 为每个术语生成 ASR 典型错误变体（小写连写 / CamelCase 拆空格 / 拆词重组）；
  3. 聊天历史中的术语（最近 10 轮问题）同样入表，且优先级更高——
     客户刚提到的词，下一句大概率还会提到；
  4. correct_terms(text, extra_terms=kb_assisted_terms(text)) 注入动态映射。

性能：术语表与变体表构建一次后缓存（KB 内容会话期间不变），查询 <1ms。
"""

from __future__ import annotations

import re
from collections import deque

from loguru import logger

from app.config import settings

# ── 术语抽取 ────────────────────────────────────────────────────

# 候选 token：英文词，可含连字符/点/数字（LangGraph、BGE-M3、faster-whisper）
_TOKEN_RE = re.compile(r"\b[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*\b")

# 常见英文虚词/通话口语词：即使大写开头也不是术语（Markdown 句首大写会误报）
_STOPWORDS = {
    "The", "This", "That", "What", "Why", "How", "When", "Where", "Which",
    "Yes", "No", "Not", "And", "But", "For", "With", "From", "Into", "Over",
    "My", "Our", "Your", "You", "We", "It", "Is", "Are", "Was", "Were",
    "Can", "Could", "Should", "Would", "Will", "Do", "Does", "Did",
    "If", "Then", "Than", "So", "As", "At", "By", "On", "In", "Of", "To",
    "Q", "A", "Q1", "A1", "Q2", "A2", "Top", "Note", "Answer", "Question",
    "Step", "Case", "Example", "Table", "Figure", "Markdown", "Html", "Http",
    "True", "False", "None", "Ok", "Okay",
}

# 变体最小长度（太短的变体做子串替换会误伤）
_MIN_VARIANT_LEN = 5


def _is_term(tok: str) -> bool:
    """是否像技术术语：CamelCase / 全大写缩写 / 含内部大写 / 带型号后缀。"""
    if tok in _STOPWORDS:
        return False
    if len(tok) < 2:
        return False
    if tok.isupper():                       # RAG, BGE, LLM
        return True
    if any(c.isupper() for c in tok[1:]):   # LangGraph, ColBERT, QLoRA
        return True
    if re.search(r"[a-z]\d|\d[a-z]", tok, re.IGNORECASE):  # bm25, gpt4
        return True
    return False


def _variants(term: str) -> list[str]:
    """术语 → ASR 典型错误变体列表（全部小写，供子串匹配）。

    LangGraph  → ["langgraph", "lang graph", "lang-graph"]
    BGE-M3     → ["bge m3", "bge-m3"]（"bgem3"）
    ColBERT    → ["colbert", "col bert"]
    """
    out: set[str] = set()
    low = term.lower()

    # CamelCase 拆词
    parts = re.findall(r"[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+", term)
    parts = [p.lower() for p in parts if p]
    # 连字符型号（BGE-M3 → ["bge", "m3"]）
    if len(parts) == 1 and "-" in low:
        parts = low.split("-")

    if len(parts) >= 2:
        out.add("".join(parts))           # langgraph
        out.add(" ".join(parts))          # lang graph
        out.add("-".join(parts))          # lang-graph
    out.add(low)                          # 原形小写（大小写丢失型错误）
    # 过滤：太短的变体不做子串替换（防误伤）；与规范写法完全相同的无需替换
    return [v for v in out if len(v) >= _MIN_VARIANT_LEN and v != term]


# ── 术语表缓存 ──────────────────────────────────────────────────

_kb_terms: set[str] | None = None
_variant_map: dict[str, str] | None = None     # 变体(小写) → 规范术语
_recent_chat_terms: deque[str] = deque(maxlen=40)


def _load_kb_terms() -> set[str]:
    """从知识库 chunks 抽取术语（复用现有 parser，不改动 RAG 流程）。"""
    from app.rag.parser import parse_all_kb_files

    terms: set[str] = set()
    try:
        kb_dir = settings.kb_path
        if not kb_dir.exists():
            return terms
        chunks = parse_all_kb_files(kb_dir)
        for c in chunks:
            for field in ("question", "answer"):
                txt = c.get(field, "")
                for m in _TOKEN_RE.finditer(txt):
                    tok = m.group()
                    # 源文本截断标记（"LangGra..."）后的 token 是不完整词，丢弃；
                    # 单个句号（英文句尾 "LangGraph."）不过滤
                    tail = txt[m.end():m.end() + 2]
                    if tail.startswith("..") or tail.startswith("…"):
                        continue
                    if _is_term(tok):
                        terms.add(tok)
        logger.info(f"📚 [KBTerms] 从知识库抽取 {len(terms)} 个术语")
    except Exception as e:
        logger.warning(f"[KBTerms] 术语抽取失败: {e}")
    return terms


def _rebuild_variant_map() -> dict[str, str]:
    """KB 术语 + 聊天历史术语 → 变体映射表（聊天历史术语后写入，同变体时覆盖 KB）。"""
    global _kb_terms
    if _kb_terms is None:
        _kb_terms = _load_kb_terms()

    vmap: dict[str, str] = {}
    for term in _kb_terms:
        for v in _variants(term):
            vmap.setdefault(v, term)
    for term in list(_recent_chat_terms):
        for v in _variants(term):
            vmap[v] = term      # 会话术语优先（可能是 KB 没收录的新词）
    return vmap


def get_variant_map() -> dict[str, str]:
    """变体表（缓存，聊天历史变化时惰性重建）。"""
    global _variant_map
    if _variant_map is None:
        _variant_map = _rebuild_variant_map()
    return _variant_map


def note_chat_terms(question: str) -> None:
    """记录聊天历史中的术语（每轮问答调用一次，供下一句 ASR 纠错提权）。"""
    global _variant_map
    if not question:
        return
    added = False
    for tok in _TOKEN_RE.findall(question):
        if _is_term(tok) and tok not in _recent_chat_terms:
            _recent_chat_terms.append(tok)
            added = True
    if added:
        _variant_map = _rebuild_variant_map()   # 惰性重建成本极低（几十个术语）
        logger.debug(f"📚 [KBTerms] 会话术语更新: {list(_recent_chat_terms)[-5:]}")


def kb_assisted_terms(text: str) -> dict[str, str]:
    """扫描文本，返回其中出现的"变体→规范术语"映射（供 correct_terms 注入）。

    只在文本里真实出现变体时才返回对应条目，保持映射最小化。
    """
    if not text:
        return {}
    low = text.lower()
    found: dict[str, str] = {}
    for variant, term in get_variant_map().items():
        if variant and variant in low and variant != term:
            found[variant] = term
    return found
