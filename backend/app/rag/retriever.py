"""Retriever — orchestrates embed → search → judge → answer."""

from loguru import logger

from app.config import settings
from app.rag.embedder import embed_query
from app.rag.index import search, is_loaded
from app.llm.client import ask_llm


async def retrieve_decision(question: str) -> dict:
    """只做检索和阈值判断，不调用 LLM。供流式端点使用。

    返回:
      kb_hit=True  → {"kb_hit": True, "response": {...完整 ChatResponse 结构}}
      kb_hit=False → {"kb_hit": False, "source": "llm"|"llm_refine",
                      "score":..., "file":..., "matched_question":...,
                      "context": str|None}  （context 供 LLM 参考）
    """
    if not is_loaded():
        return {"kb_hit": False, "source": "llm", "score": None,
                "file": None, "matched_question": None, "context": None}

    query_vector = embed_query(question)
    results = search(query_vector, top_k=settings.faiss_top_k)

    if not results:
        return {"kb_hit": False, "source": "llm", "score": None,
                "file": None, "matched_question": None, "context": None}

    top_result = results[0]
    top_score = top_result["score"]
    logger.info(f"FAISS top-1: score={top_score:.3f}, "
                f"question='{top_result['question'][:50]}...'")

    if top_score >= settings.similarity_hit_threshold:
        return {
            "kb_hit": True,
            "response": {
                # FAQ-style KB: a hit returns the matched entry itself, never a
                # longer neighbour, so prices and policies stay exact.
                "answer": _extract_concise_answer(top_result["answer"]),
                "source": "kb",
                "score": round(top_score, 3),
                "file": top_result["file"],
                "matched_question": top_result["question"],
            },
        }

    if top_score >= settings.similarity_partial_threshold:
        return {"kb_hit": False, "source": "llm_refine",
                "score": round(top_score, 3), "file": top_result["file"],
                "matched_question": top_result["question"],
                "context": _build_context(results[:3])}

    return {"kb_hit": False, "source": "llm", "score": round(top_score, 3),
            "file": None, "matched_question": None, "context": None}


async def retrieve_answer(question: str) -> dict:
    """Full retrieval pipeline: embed → FAISS search → threshold judge → return.

    Returns dict with keys: answer, source, score, file, matched_question
    """
    # Step 1: Check if index is loaded
    if not is_loaded():
        logger.warning("FAISS index not loaded, falling back to pure LLM")
        answer = await ask_llm(question)
        return {
            "answer": answer,
            "source": "llm",
            "score": None,
            "file": None,
            "matched_question": None,
        }

    # Step 2: Embed the query
    query_vector = embed_query(question)

    # Step 3: FAISS search
    results = search(query_vector, top_k=settings.faiss_top_k)

    if not results:
        answer = await ask_llm(question)
        return {
            "answer": answer,
            "source": "llm",
            "score": None,
            "file": None,
            "matched_question": None,
        }

    top_result = results[0]
    top_score = top_result["score"]
    logger.info(f"FAISS top-1: score={top_score:.3f}, "
                f"question='{top_result['question'][:50]}...'")

    # Step 4: Threshold judgment
    if top_score >= settings.similarity_hit_threshold:
        # ── KB HIT: return stored answer directly ──
        # Return the matched entry itself (not the longest neighbour)
        best_answer = _extract_concise_answer(top_result["answer"])
        return {
            "answer": best_answer,
            "source": "kb",
            "score": round(top_score, 3),
            "file": top_result["file"],
            "matched_question": top_result["question"],
        }

    elif top_score >= settings.similarity_partial_threshold:
        # ── PARTIAL HIT: LLM refine with KB context ──
        # Gather top-3 contexts
        context = _build_context(results[:3])
        answer = await ask_llm(question, context=context)
        return {
            "answer": answer,
            "source": "llm_refine",
            "score": round(top_score, 3),
            "file": top_result["file"],
            "matched_question": top_result["question"],
        }

    else:
        # ── KB MISS: pure LLM generation ──
        answer = await ask_llm(question)
        return {
            "answer": answer,
            "source": "llm",
            "score": round(top_score, 3),
            "file": None,
            "matched_question": None,
        }


def _extract_concise_answer(answer: str) -> str:
    """Extract the most concise part of a KB answer for quick display."""
    if len(answer) <= 400:
        return answer

    # Try to find a natural break point
    for sep in ["。", "\n\n", "！", "？", ". "]:
        idx = answer.find(sep, 150)
        if 150 < idx < 400:
            return answer[: idx + 1]

    # Hard truncate
    return answer[:300] + "..."


def _pick_best_answer(results: list[dict]) -> str:
    """Pick the best answer from top-K results.

    Prefer longer, more substantive answers. Skip chunks that are mostly
    question lists or very short (code-only chunks stripped to nothing).
    """
    def _is_good_answer(r: dict) -> bool:
        """Filter out low-quality answers."""
        a = r.get("answer", "")
        if len(a) < 30:
            return False
        # Skip chunks that are mostly numbered question lists (追问TOP30 sections)
        question_lines = sum(1 for l in a.split("\n") if l.strip().startswith(("1.", "2.", "3.", "4.", "5.", "6.", "7.", "8.", "9.")) and "？" in l)
        total_lines = len([l for l in a.split("\n") if l.strip()])
        if total_lines > 0 and question_lines / total_lines > 0.5:
            return False
        return True

    good = [r for r in results if _is_good_answer(r)]

    if good:
        best = max(good, key=lambda r: len(r["answer"]))
        return _extract_concise_answer(best["answer"])

    # Fallback: use top-1 result
    return _extract_concise_answer(results[0].get("answer", "No matching answer"))


def _build_context(results: list[dict]) -> str:
    """Build a context string from top-K search results for LLM refinement.

    截断放宽（80/300 → 100/600）：让 LLM 拿到更完整的知识库内容，
    支撑 200-500 字的深度回答（知识库利用优化，检索流程本身不变）。
    """
    parts = []
    for i, r in enumerate(results, 1):
        q = r["question"][:100]
        a = r["answer"][:600]
        parts.append(f"[Doc {i}] Q: {q}\nA: {a}")
    return "\n\n".join(parts)
