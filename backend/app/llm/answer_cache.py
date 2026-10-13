"""高频问题答案缓存（需求第九条，最小改动版）。

不修改现有 RAG 检索流程：缓存层位于 LLM 生成层（client.ask_llm / ask_llm_stream）。
命中场景：Transformer / Attention / RAG / LoRA / Agent 等高频八股问题被反复问到时，
若与某个已生成的"优质答案"对应的问题 Embedding 相似度 > 0.9，直接返回历史答案。
非流式调用在 client 层读取；流式调用由 API route 读取一次，确保其 source 标记可信。

只缓存：
  - 长度 ≥ 80 字的回答（过滤错误提示与过短回答）；
  - 非错误类回答。
内存缓存，FIFO 上限 128 条，TTL 1 小时，进程重启即清空（无需持久化）。
"""

import time
from collections import OrderedDict

import numpy as np
from loguru import logger

from app.config import settings

_MAX_ENTRIES = 128
_TTL_S = 3600
_MIN_ANSWER_LEN = 80

# key=规范化问题文本 → {question, answer, vec, ts}
_cache: OrderedDict[str, dict] = OrderedDict()


def _embed(text: str) -> np.ndarray:
    from app.rag.embedder import embed_query
    return embed_query(text)


def _norm_key(question: str) -> str:
    return "".join((question or "").split()).lower()


def cache_lookup(question: str) -> str | None:
    """相似度 > settings.answer_cache_similarity 时返回历史优质答案，否则 None。"""
    if not settings.answer_cache_enabled or not _cache:
        return None
    try:
        qv = _embed(question)
    except Exception as e:
        logger.warning(f"[AnswerCache] embed 失败，跳过缓存: {e}")
        return None

    now = time.time()
    for key, ent in list(_cache.items()):
        if now - ent["ts"] > _TTL_S:
            _cache.pop(key, None)
            continue
        sim = float(np.dot(qv, ent["vec"]))
        if sim >= settings.answer_cache_similarity:
            logger.info(f"⚡ [AnswerCache] 命中 sim={sim:.3f} "
                        f"('{question[:30]}' ≈ '{ent['question'][:30]}')")
            return ent["answer"]
    return None


def cache_store(question: str, answer: str) -> None:
    """写入优质答案（长度达标且非错误回答）。"""
    if not settings.answer_cache_enabled:
        return
    if not answer or len(answer) < _MIN_ANSWER_LEN:
        return
    if answer.startswith("Sorry") or "LLM" in answer[:6]:
        return
    try:
        _cache[_norm_key(question)] = {
            "question": question,
            "answer": answer,
            "vec": _embed(question),
            "ts": time.time(),
        }
        while len(_cache) > _MAX_ENTRIES:
            _cache.popitem(last=False)
        logger.debug(f"[AnswerCache] 已缓存 '{question[:40]}' ({len(answer)}字, 共{len(_cache)}条)")
    except Exception as e:
        logger.warning(f"[AnswerCache] 缓存写入失败: {e}")
