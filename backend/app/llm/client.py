"""LLM client — works with Anthropic-style and OpenAI-compatible endpoints.

- URL containing "anthropic" -> Anthropic Messages API (x-api-key, anthropic-version,
  text blocks only; thinking blocks are skipped).
- Any other URL (DeepSeek / vLLM / DashScope compatible mode) -> OpenAI Chat Completions.

Answer-quality layer:
  1. SYSTEM_PROMPT — live-call assistant: short, speakable answers grounded in the
     product docs; says so plainly when the docs don't cover something.
  2. classify_answer_tier — quick fact / normal / troubleshooting, drives length & max_tokens.
  3. Knowledge-base context is injected as "product documentation" and takes priority.
  4. Follow-up handling — the last two Q&A rounds are passed as context.
  5. Answer cache — similarity > 0.9 returns a stored answer without calling the LLM.
"""

import json
import re
import time
from collections import deque

import httpx
from loguru import logger

from app.config import settings
from app.llm.errors import (
    LLMServiceError,
    from_http_error,
    from_network_error,
    provider_unavailable_error,
    timeout_error,
)

SYSTEM_PROMPT = """You are a live-call assistant sitting next to a customer support or sales agent.
The customer is talking right now. Your job is to give the agent an answer they can say out loud in a few seconds.

Rules:
1. Ground every answer in the product documentation provided. Product docs come first; general knowledge
   is only for wording, never for prices, limits, policies or feature claims.
2. If the docs don't cover the question, say so in one line ("Not in the docs: check with billing before
   promising anything") and suggest what the agent can safely say instead. Never invent numbers or policies.
3. Write the way a helpful agent talks: plain words, second person to the customer, no marketing fluff,
   no headings. Put the direct answer in the first sentence.
4. Only for troubleshooting or setup questions, give numbered steps (max 5) the agent can walk the customer
   through. Everything else is 1-4 sentences of plain speech.
5. Don't promise timelines, follow-ups or outcomes the docs don't back up ("I'll check" is fine, "today" is not).
6. If the customer sounds upset or mentions cancelling, start with one short line of acknowledgement.
7. Answer in the same language the customer used."""


# --- Answer tiers: control length and max_tokens ---------------------------

_TIER_MAX_TOKENS = {"simple": 200, "normal": 400, "project": 700}

_TIER_HINT = {
    "simple": "Quick fact. Answer in 1-2 sentences.",
    "normal": "Answer in 3-5 sentences.",
    "project": "Troubleshooting or multi-part question. Give a one-line answer, then up to 5 numbered steps.",
}

_PROJECT_SIGNAL = re.compile(
    r"(not working|doesn't work|does not work|isn't working|error|fail|can't|cannot|"
    r"won't|broken|stuck|how do i set up|how to set up|step by step|troubleshoot|"
    r"无法|不能用|报错|失败|怎么设置)", re.IGNORECASE
)
_PROJECT_INTRO = re.compile(r"(walk me through|step by step|how do i set up|how do we set up|how do i migrate)", re.IGNORECASE)
_PROJECT_DEEP = re.compile(r"(sso|saml|api|webhook|import|export|integration).{0,20}(set ?up|configure|connect|work)", re.IGNORECASE)
_MEMO_SIGNAL = re.compile(r"(how much|price|cost|do you have|do you support|do you offer|is there|does it|can i|what is|when|which plan|多少钱|有没有|是否)", re.IGNORECASE)
_ANALYSIS_SIGNAL = re.compile(r"(why|how do|how does|how can|how to|how come|difference|compare|vs\.?|versus|为什么|怎么|区别)", re.IGNORECASE)


def classify_answer_tier(question: str) -> str:
    """Rule-based tier (<1ms): simple = quick fact / normal / project = troubleshooting."""
    q = (question or "").strip()
    n = len(q)
    if _PROJECT_SIGNAL.search(q) or _PROJECT_INTRO.search(q) or _PROJECT_DEEP.search(q):
        return "project"
    if _MEMO_SIGNAL.search(q) and n <= 80 and not _ANALYSIS_SIGNAL.search(q):
        return "simple"
    if n <= 12 and not _ANALYSIS_SIGNAL.search(q):
        return "simple"
    return "normal"


# --- Follow-ups: recent rounds + likely next questions ----------------------

_recent_rounds: deque[dict] = deque(maxlen=2)  # [{question, answer}]

_FOLLOWUP_HINTS = {
    "refund": ["How long does the refund take?", "Do I get a partial refund?"],
    "price": ["Is there a discount for annual billing?", "What happens if I add more seats?"],
    "plan": ["Can I downgrade later?", "What's the difference between Team and Business?"],
    "sso": ["Do you support Okta?", "Can we enforce SSO for everyone?"],
    "export": ["What format is the export?", "Is there an API instead?"],
    "trial": ["Do I need a credit card for the trial?", "What happens when the trial ends?"],
    "data": ["Where is our data stored?", "Can you delete our data?"],
    "cancel": ["Will I lose my data if I cancel?", "Can I pause instead?"],
}


def _history_block() -> str:
    """Last rounds of the call, so follow-ups ("and on the yearly plan?") make sense."""
    if not _recent_rounds:
        return ""
    lines = []
    for r in _recent_rounds:
        lines.append(f"Customer: {r['question'][:120]}\nSuggested answer: {r['answer'][:200]}")
    return ("[Earlier in this call — if this is a follow-up, continue from it]\n"
            + "\n".join(lines) + "\n\n")


def _is_error_answer(answer: str) -> bool:
    return bool(answer) and (
        answer.startswith("Sorry") or answer.startswith("LLM")
        or "LLM request failed" in answer or "LLM service error" in answer or "LLM timeout" in answer
    )


def _record_round(question: str, answer: str) -> None:
    """Store this round for follow-ups and log likely next questions."""
    if not answer or _is_error_answer(answer):
        return
    _recent_rounds.append({"question": question, "answer": answer[:200]})
    low = answer.lower()
    followups = []
    for term, hints in _FOLLOWUP_HINTS.items():
        if term in low:
            followups.extend(hints)
    if followups:
        logger.info(f"🔮 [FollowUp] likely next: {' | '.join(followups[:4])}")


# ─── 持久 HTTP 连接（延迟优化：复用 TCP/TLS，每请求省 200-800ms 握手）───

_HTTP_CLIENT: httpx.AsyncClient | None = None


def _get_http_client() -> httpx.AsyncClient:
    global _HTTP_CLIENT
    if _HTTP_CLIENT is None or _HTTP_CLIENT.is_closed:
        _HTTP_CLIENT = httpx.AsyncClient(timeout=settings.llm_timeout, trust_env=False)
    return _HTTP_CLIENT


async def close_http_client() -> None:
    """关闭持久 HTTP 连接（lifespan 退出时调用）。"""
    global _HTTP_CLIENT
    if _HTTP_CLIENT is not None and not _HTTP_CLIENT.is_closed:
        await _HTTP_CLIENT.aclose()
    _HTTP_CLIENT = None


async def warmup_llm() -> None:
    """预热 LLM 连接与服务端前缀缓存（延迟优化）。

    实测发现：携带完整 SYSTEM_PROMPT 的首个请求会触发服务端前缀缓存构建，
    TTFT 约 11s；同前缀的后续请求仅 ~300ms。启动时先发一个最小请求
    （max_tokens=8）吸收该成本，避免通话中第一个问题撞上冷启动。
    """
    try:
        t0 = time.perf_counter()
        if _is_anthropic_endpoint():
            await _call_anthropic("warmup", max_tokens=8)
        else:
            await _call_openai("warmup", max_tokens=8)
        logger.info(f"🔥 [Warmup] LLM 前缀缓存预热完成: {(time.perf_counter()-t0)*1000:.0f}ms")
    except Exception:
        logger.warning("⚠️  [Warmup] LLM 预熱失敗（不影響使用）")


# ─── 主调用 ────────────────────────────────────────────────────────

def _is_anthropic_endpoint() -> bool:
    return "anthropic" in settings.llm_base_url.lower()


def _build_user_content(question: str, context: str | None, tier: str) -> str:
    """User message: earlier rounds + product docs (KB) + customer question + length hint."""
    parts = []
    hist = _history_block()
    if hist:
        parts.append(hist)
    if context:
        parts.append(f"[Product documentation — use this first]\n{context}\n")
    else:
        parts.append("[Product documentation]\nNo matching section was found in the docs.\n")
    parts.append(f"[What the customer just asked]\n{question}\n")
    parts.append(_TIER_HINT[tier])
    return "\n".join(parts)

def _dynamic_max_tokens(tier: str) -> int:
    """按问题级别动态 max_tokens，且不超过全局上限（需求第三/五条）。"""
    return min(_TIER_MAX_TOKENS[tier], settings.llm_max_tokens)


async def ask_llm(question: str, context: str | None = None) -> str:
    """Send a question to the LLM and return the generated answer.

    Args:
        question: The customer's question
        context: Optional KB context to ground the answer

    Returns:
        Generated answer string
    """
    from app.llm.answer_cache import cache_lookup, cache_store

    # 高频问题缓存：相似度>0.9 直接返回历史优质答案（需求第九条）
    cached = cache_lookup(question)
    if cached:
        _record_round(question, cached)
        return cached

    tier = classify_answer_tier(question)
    user_content = _build_user_content(question, context, tier)
    max_tokens = _dynamic_max_tokens(tier)

    try:
        if _is_anthropic_endpoint():
            data = await _call_anthropic(user_content, max_tokens)
            answer = _extract_anthropic_text(data)
        else:
            data = await _call_openai(user_content, max_tokens)
            answer = data["choices"][0]["message"]["content"].strip()

        if not answer:
            logger.error(f"LLM returned empty answer, stop_reason={data.get('stop_reason', '?')}")
            return "Sorry, the model returned an empty answer. Please try again."

        tokens = (data.get("usage", {}).get("output_tokens")
                  or data.get("usage", {}).get("total_tokens") or "?")
        logger.debug(f"LLM response [{tier}, max_tokens={max_tokens}]: "
                     f"{len(answer)} chars, tokens: {tokens}")
        _record_round(question, answer)
        cache_store(question, answer)
        return answer

    except httpx.TimeoutException:
        error = timeout_error()
        logger.error(f"LLM request failed: {error.code}")
        return error.user_message
    except httpx.HTTPStatusError as e:
        error = from_http_error(e)
        logger.error(f"LLM request failed: {error.code}")
        return error.user_message
    except httpx.RequestError as e:
        error = from_network_error(e)
        logger.error(f"LLM request failed: {error.code}")
        return error.user_message
    except Exception:
        error = provider_unavailable_error()
        logger.error(f"LLM request failed: {error.code}")
        return error.user_message


def _anthropic_payload(user_content: str, stream: bool = False,
                       max_tokens: int | None = None,
                       system: str | None = None) -> dict:
    """构造 Anthropic Messages 请求体。"""
    payload = {
        "model": settings.llm_model,
        "max_tokens": max_tokens or settings.llm_max_tokens,
        "temperature": settings.llm_temperature,
        "system": system or SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_content}],
    }
    # 思考模型关 thinking：实测 15s+ → 3.7s（token-plan 网关认 Anthropic 原生参数，
    # 不认 DashScope 的 enable_thinking）
    if not settings.llm_enable_thinking:
        payload["thinking"] = {"type": "disabled"}
    if stream:
        payload["stream"] = True
    return payload


def _anthropic_headers() -> dict:
    return {
        "x-api-key": settings.llm_api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }


async def _call_anthropic(user_content: str, max_tokens: int | None = None,
                          system: str | None = None) -> dict:
    """Anthropic Messages 协议调用。"""
    url = f"{settings.llm_base_url.rstrip('/')}/v1/messages"
    payload = _anthropic_payload(user_content, max_tokens=max_tokens, system=system)
    resp = await _get_http_client().post(url, json=payload, headers=_anthropic_headers())
    resp.raise_for_status()
    return resp.json()


def _extract_anthropic_text(data: dict) -> str:
    """提取响应中的 text 块（跳过思考模型的 thinking 块）。"""
    blocks = data.get("content", [])
    text_parts = [b.get("text", "") for b in blocks if b.get("type") == "text"]
    return "".join(text_parts).strip()


def _openai_payload(user_content: str, stream: bool = False,
                    max_tokens: int | None = None,
                    system: str | None = None) -> dict:
    """构造 OpenAI 兼容协议请求体。"""
    payload = {
        "model": settings.llm_model,
        "messages": [
            {"role": "system", "content": system or SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "max_tokens": max_tokens or settings.llm_max_tokens,
        "temperature": settings.llm_temperature,
    }
    _apply_reasoning_mode(payload)
    if stream:
        payload["stream"] = True
    return payload


def _is_deepseek_endpoint() -> bool:
    """Return whether the configured OpenAI-compatible endpoint is DeepSeek."""
    return settings.llm_base_url.rstrip("/") == "https://api.deepseek.com"


def _apply_reasoning_mode(payload: dict) -> None:
    """Add the configured provider's reasoning-mode request parameter."""
    if _is_deepseek_endpoint():
        payload["thinking"] = {
            "type": "enabled" if settings.llm_enable_thinking else "disabled"
        }
        return

    if not settings.llm_enable_thinking and (
        "qwen" in settings.llm_model.lower() or "dashscope" in settings.llm_base_url.lower()
    ):
        payload["enable_thinking"] = False


def _openai_headers() -> dict:
    return {
        "Authorization": f"Bearer {settings.llm_api_key}",
        "Content-Type": "application/json",
    }


async def _call_openai(user_content: str, max_tokens: int | None = None,
                       system: str | None = None) -> dict:
    """OpenAI 兼容协议调用（vLLM / DashScope 等）。"""
    url = f"{settings.llm_base_url.rstrip('/')}/chat/completions"
    resp = await _get_http_client().post(url, json=_openai_payload(user_content, max_tokens=max_tokens,
                                                                   system=system),
                                         headers=_openai_headers())
    resp.raise_for_status()
    return resp.json()


# ─── 问题优化（口语问题 → 技术问题改写）─────────────────────────

REFINE_PROMPT = """You clean up questions transcribed from a live customer call.
Rewrite the customer's spoken question into one clear, complete question that can be used to search the product docs.

Rules:
1. Keep the customer's intent. Fill in obvious missing objects ("why's it double?" -> "Why was I charged twice this month?").
2. Fix obvious speech-recognition mistakes in product terms (e.g. "single sign on" -> "SSO", "web hook" -> "webhook").
3. Output only the rewritten question. No explanation, no answer, no quotes.
4. If the question is already clear, return it unchanged."""

async def refine_question(question: str) -> str:
    """口语问题 → 规范化技术问题（非流式，短输出，超时宽容）。"""
    q = (question or "").strip()
    if not q:
        return ""
    try:
        if _is_anthropic_endpoint():
            data = await _call_anthropic(q, max_tokens=256, system=REFINE_PROMPT)
            refined = _extract_anthropic_text(data)
        else:
            data = await _call_openai(q, max_tokens=256, system=REFINE_PROMPT)
            refined = data["choices"][0]["message"]["content"].strip()
        refined = refined.strip().strip('"“”')
        logger.info(f"✨ [Refine] '{q[:50]}' → '{refined[:60]}'")
        return refined or q
    except Exception:
        logger.warning("[Refine] 問題優化失敗，返回原文")
        return q


# ─── 流式输出（SSE）────────────────────────────────────────────

async def ask_llm_stream(
    question: str,
    context: str | None = None,
):
    """流式调用 LLM，yield 文本增量；安全错误由调用方转为 SSE 事件。

    首字即出即推给前端（需求第六条：首字响应 <2s，完整回答后台继续生成）。
    Anthropic 协议：跳过 thinking 块（delta.type=thinking_delta），只取 text_delta。
    OpenAI 协议：取 choices[0].delta.content。
    """
    from app.llm.answer_cache import cache_store

    tier = classify_answer_tier(question)
    user_content = _build_user_content(question, context, tier)
    max_tokens = _dynamic_max_tokens(tier)
    logger.info(f"🤖 [LLM] tier={tier}, max_tokens={max_tokens}, "
                f"kb_context={'yes' if context else 'no'}")

    parts: list[str] = []
    try:
        if _is_anthropic_endpoint():
            async for chunk in _stream_anthropic(user_content, max_tokens):
                parts.append(chunk)
                yield chunk
        else:
            async for chunk in _stream_openai(user_content, max_tokens):
                parts.append(chunk)
                yield chunk
    except httpx.TimeoutException:
        error = timeout_error()
        logger.error(f"LLM stream failed: {error.code}")
        raise error
    except httpx.HTTPStatusError as e:
        error = from_http_error(e)
        logger.error(f"LLM stream failed: {error.code}")
        raise error
    except httpx.RequestError as e:
        error = from_network_error(e)
        logger.error(f"LLM stream failed: {error.code}")
        raise error
    except Exception:
        error = provider_unavailable_error()
        logger.error(f"LLM stream failed: {error.code}")
        raise error

    # 流结束：记录本轮问答（追问衔接）+ 写入高频缓存
    answer = "".join(parts)
    _record_round(question, answer)
    cache_store(question, answer)


async def _stream_anthropic(user_content: str, max_tokens: int | None = None):
    url = f"{settings.llm_base_url.rstrip('/')}/v1/messages"
    payload = _anthropic_payload(user_content, stream=True, max_tokens=max_tokens)
    got_text = False
    async with _get_http_client().stream("POST", url, json=payload,
                                         headers=_anthropic_headers()) as resp:
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                ev = json.loads(data)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "content_block_delta":
                delta = ev.get("delta", {})
                if delta.get("type") == "text_delta":
                    text = delta.get("text", "")
                    if text:
                        got_text = True
                        yield text
    if not got_text:
        yield "Sorry, the model returned an empty answer. Please try again."


async def _stream_openai(user_content: str, max_tokens: int | None = None):
    url = f"{settings.llm_base_url.rstrip('/')}/chat/completions"
    payload = _openai_payload(user_content, stream=True, max_tokens=max_tokens)
    got_text = False
    async with _get_http_client().stream("POST", url, json=payload,
                                         headers=_openai_headers()) as resp:
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                ev = json.loads(data)
            except json.JSONDecodeError:
                continue
            choices = ev.get("choices") or []
            if choices:
                text = (choices[0].get("delta") or {}).get("content") or ""
                if text:
                    got_text = True
                    yield text
    if not got_text:
        yield "Sorry, the model returned an empty answer. Please try again."
