"""API route definitions."""

import json
import time

from fastapi import APIRouter, Form, HTTPException, UploadFile, File, WebSocket
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict
from loguru import logger

from app.config import settings

router = APIRouter(prefix="/api")


# ─── Request / Response Models ───────────────────────────────────────────────

class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str


class ChatResponse(BaseModel):
    answer: str
    source: str          # "kb" | "llm_refine" | "llm" | "llm_cache"
    score: float | None  # similarity score (None if pure LLM)
    file: str | None     # source file (None if pure LLM)
    matched_question: str | None = None


class RebuildResponse(BaseModel):
    status: str
    chunk_count: int
    files_processed: int


class HealthResponse(BaseModel):
    status: str
    embedding_model: str
    index_size: int
    llm_base_url: str
    auto_answer: bool = False   # false=手动发送模式（默认），true=ASR放行后自动回答
    backend_capture: bool = True  # 后端 WASAPI Loopback 采集可用（前端默认采集源）


class RefineRequest(BaseModel):
    question: str


class RefineResponse(BaseModel):
    original: str
    refined: str


# ─── Routes ──────────────────────────────────────────────────────────────────

@router.get("/health", response_model=HealthResponse)
async def health():
    """Check system health: model loaded, index size, LLM reachable."""
    from app.rag.index import get_index_size

    return HealthResponse(
        status="ok",
        embedding_model=settings.embedding_model,
        index_size=get_index_size(),
        llm_base_url=settings.llm_base_url,
        auto_answer=settings.auto_answer,
        backend_capture=settings.backend_capture_enabled,
    )


@router.post("/question/refine", response_model=RefineResponse)
async def refine(request: RefineRequest):
    """问题优化：把口语化问题改写为规范化技术问题（用户点"优化问题"按钮触发）。"""
    from app.llm.client import refine_question

    q = request.question.strip()
    if not q:
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    refined = await refine_question(q)
    return RefineResponse(original=q, refined=refined)


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """Core Q&A endpoint: retrieve from KB or generate via LLM."""
    from app.rag.retriever import retrieve_answer

    if not request.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    # 聊天历史术语记录：本句出现的术语用于下一句 ASR 纠错提权
    from app.asr.kb_terms import note_chat_terms
    note_chat_terms(request.question)

    logger.info(f"📝 Question: {request.question[:80]}...")

    result = await retrieve_answer(request.question)

    logger.info(f"💡 Answer source={result['source']}, score={result.get('score')}")
    return ChatResponse(**result)


# ─── Streaming Q&A (SSE) ────────────────────────────────────────

def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@router.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    """流式问答：SSE 推送。

    事件序列：
      meta  → {source, score, file, matched_question}
      delta → {text} 答案增量（kb 命中时一次性整段推送）
      done  → {answer} 完整答案
    """
    from app.rag.retriever import retrieve_decision
    from app.llm.answer_cache import cache_lookup
    from app.llm.client import ask_llm_stream
    from app.llm.errors import LLMServiceError

    if not request.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    question = request.question

    # 聊天历史术语记录：本句出现的术语用于下一句 ASR 纠错提权
    from app.asr.kb_terms import note_chat_terms
    note_chat_terms(question)

    logger.info(f"📝 Stream question: {question[:80]}...")

    async def answer_events():
        decision = await retrieve_decision(question)

        if decision["kb_hit"]:
            resp = decision["response"]
            logger.info(f"💡 Stream kb hit, score={resp['score']}")
            yield _sse({"type": "meta", "source": resp["source"],
                        "score": resp["score"], "file": resp["file"],
                        "matched_question": resp["matched_question"]})
            yield _sse({"type": "delta", "text": resp["answer"]})
            yield _sse({"type": "done", "answer": resp["answer"]})
            return

        cached = cache_lookup(question)
        if cached:
            logger.info("💡 Stream answer cache hit")
            yield _sse({"type": "meta", "source": "llm_cache",
                        "score": None, "file": None, "matched_question": None})
            yield _sse({"type": "delta", "text": cached})
            yield _sse({"type": "done", "answer": cached})
            return

        source = decision["source"]
        logger.info(f"💡 Stream {source}, score={decision['score']}")
        yield _sse({"type": "meta", "source": source,
                    "score": decision["score"], "file": decision["file"],
                    "matched_question": decision["matched_question"]})

        parts = []
        async for chunk in ask_llm_stream(question, decision["context"]):
            parts.append(chunk)
            yield _sse({"type": "delta", "text": chunk})

        yield _sse({"type": "done", "answer": "".join(parts)})

    async def event_gen():
        try:
            async for event in answer_events():
                yield event
        except LLMServiceError as error:
            yield _sse({
                "type": "error",
                "code": error.code,
                "message": error.user_message,
            })
            return
        except Exception:
            logger.error("Stream answer pipeline failed")
            yield _sse({
                "type": "error",
                "code": "local_service_error",
                "message": "The local service couldn’t finish the answer. Please try again shortly.",
            })
            return

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # 禁用 nginx 缓冲
            "Connection": "keep-alive",
        },
    )


@router.post("/rebuild", response_model=RebuildResponse)
async def rebuild():
    """Rebuild FAISS index from knowledge base markdown files."""
    from app.rag.parser import parse_all_kb_files
    from app.rag.embedder import embed_texts
    from app.rag.index import build_and_save_index

    kb_dir = settings.kb_path
    if not kb_dir.exists():
        raise HTTPException(status_code=400, detail=f"KB directory not found: {kb_dir}")

    logger.info(f"📂 Parsing knowledge base from {kb_dir}...")
    chunks = parse_all_kb_files(kb_dir)

    if not chunks:
        raise HTTPException(status_code=400, detail="No Q&A chunks found in KB files")

    logger.info(f"📦 Embedding {len(chunks)} chunks...")
    texts_to_embed = [f"{c['question']} {c['answer'][:200]}" for c in chunks]
    vectors = embed_texts(texts_to_embed)

    logger.info(f"🔨 Building FAISS index...")
    build_and_save_index(vectors, chunks, settings.index_path)

    logger.info(f"✅ Index rebuilt: {len(chunks)} chunks from {len(set(c['file'] for c in chunks))} files")
    return RebuildResponse(
        status="ok",
        chunk_count=len(chunks),
        files_processed=len(set(c["file"] for c in chunks)),
    )


# ─── Audio Transcription ─────────────────────────────────────────────────────

class TranscribeResponse(BaseModel):
    text: str
    duration_ms: int | None = None


class PartialResponse(BaseModel):
    text: str
    busy: bool = False            # ASR 正在处理更重要的请求时直接返回空，不排队


@router.post("/audio/partial", response_model=PartialResponse)
async def audio_partial(audio: UploadFile = File(...)):
    """滚动增量转写（豆包式逐段显示）：讲话进行中定期提交累积音频取 partial。

    只做转写+纠错，不做端点决策。若 ASR 锁被占用（有最终段在转写），
    立即返回 busy=True —— partial 是体验增强，绝不能拖延问题放行链路。
    """
    from app.llm.audio import transcribe_audio, is_asr_busy
    from app.asr.term_correct import correct_terms
    from app.asr.kb_terms import kb_assisted_terms

    audio_data = await audio.read()
    mime_type = audio.content_type or "audio/webm"

    if len(audio_data) < 200:
        return PartialResponse(text="")
    if is_asr_busy():
        return PartialResponse(text="", busy=True)

    result = await transcribe_audio(audio_data, mime_type)
    raw = result.get("text", "")
    text = correct_terms(raw, extra_terms=kb_assisted_terms(raw))
    return PartialResponse(text=text)


@router.post("/audio/transcribe", response_model=TranscribeResponse)
async def transcribe(audio: UploadFile = File(...)):
    """语音转写：接收前端 VAD 判定结束后提交的完整语句片段（约 1~15s）。

    空/无效音频不抛错，返回空文本让前端静默恢复监听，不打断通话。
    """
    from datetime import datetime

    from app.llm.audio import transcribe_audio
    import time

    audio_data = await audio.read()
    start_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    mime_type = audio.content_type or "audio/webm"
    logger.info(
        f"🎙️ [ASR] Audio Start Time: {start_time} | "
        f"ASR Input Size: {len(audio_data)} bytes | type={mime_type}"
    )

    # 空音频/极小音频：不调 ASR，直接返回空（前端会跳过）
    if len(audio_data) < 200:
        logger.warning("[ASR] 空音频/极小音频，跳过转写")
        return TranscribeResponse(text="", duration_ms=0)

    from app.asr.term_correct import correct_terms

    t0 = time.time()
    result = await transcribe_audio(audio_data, mime_type)
    elapsed = int((time.time() - t0) * 1000)
    text = correct_terms(result.get("text", ""))   # 技术词纠错

    logger.info(
        f"🎙️ [ASR] Audio Duration: {result.get('duration_s', 0.0)}s | "
        f"VAD Result: voiced={result.get('voiced_ratio', 0.0):.1%} "
        f"({result.get('voiced_ms', 0.0):.0f}ms) rms={result.get('rms', 0.0):.4f} "
        f"peak={result.get('peak', 0.0):.4f} | "
        f"ASR Output: {text[:80] if text else '(empty)'} | elapsed={elapsed}ms"
    )
    return TranscribeResponse(text=text, duration_ms=elapsed)


# ─── 智能端点检测（Endpoint Detection + Question Session）───────────────────
# 管线：前端 VAD 分段 → 本端点转写 → 语义完整性/会话决策 → 只有完整问题才放行给 RAG/LLM
# ASR partial / 半句话 / 填充词一律不触发回答（需求第一条）。

class SegmentDecision(BaseModel):
    action: str                    # pending | answer | ignore
    question: str | None = None    # action=answer 时的最终问题（已合并上下文+纠错）
    interim_text: str = ""         # 当前会话累积文本（已纠错，供前端展示）
    stable_text: str = ""          # 稳定器输出：连续一致才固化的文本（防跳动，优先展示）
    corrected: bool = False        # 本段是否发生技术词纠错
    status: str = ""               # 语义完整性状态
    confidence: float = 0.0
    hold_ms: int = 0               # action=pending 时前端等待续说的时长
    session_id: str = ""
    reason: str = ""               # 决策原因（日志/调试）
    transcript: str = ""           # 本段 ASR 转写结果（纠错后）


@router.post("/audio/segment", response_model=SegmentDecision)
async def audio_segment(
    audio: UploadFile = File(...),
    session_id: str = Form(""),
    silence_before_ms: int = Form(0),
):
    """语音段 → 转写 → 端点决策。

    前端每提交一个 VAD 分段，后端转写并判断"问题是否完整"：
      - pending：问题未完整/可能有下文 → 前端继续监听，hold_ms 后无续说则调 /audio/flush
      - answer：完整问题放行（question 为合并后的最终问题）
      - ignore：填充词/噪声/重复 → 前端什么都不做
    """
    from app.llm.audio import transcribe_audio
    from app.llm.endpoint import decide_on_segment
    from app.asr.term_correct import correct_terms
    from app.asr.stabilizer import get_stabilizer_manager

    audio_data = await audio.read()
    mime_type = audio.content_type or "audio/webm"

    if len(audio_data) < 200:
        return SegmentDecision(action="ignore", reason="empty_audio",
                               session_id=session_id)

    t0 = time.time()
    result = await transcribe_audio(audio_data, mime_type)
    asr_ms = int((time.time() - t0) * 1000)
    raw_text = result.get("text", "")

    # ── 技术词纠错（ASR 后处理，不改转写接口本身）──
    # 词典 + 知识库/聊天历史辅助：kb_assisted_terms 扫描文本中出现的术语变体
    from app.asr.kb_terms import kb_assisted_terms
    text = correct_terms(raw_text, extra_terms=kb_assisted_terms(raw_text))
    corrected = text != raw_text

    logger.info(
        f"🎙️ [Segment] session={session_id[:12]} | "
        f"audio={result.get('duration_s', 0.0)}s asr={asr_ms}ms "
        f"silence_before={silence_before_ms}ms corrected={corrected} | "
        f"'{text[:60] if text else '(empty)'}'"
    )

    decision = decide_on_segment(session_id or None, text, silence_before_ms)

    # ── 文本稳定器：interim/question 过一遍，防前端实时文字跳动 ──
    stab = get_stabilizer_manager().get(decision.get("session_id") or session_id)
    stable = ""
    if decision["action"] == "pending":
        stable = stab.feed(decision.get("interim_text") or "")
    elif decision["action"] == "answer" and decision.get("question"):
        stable = stab.finalize(decision["question"])
        get_stabilizer_manager().drop(decision.get("session_id") or session_id)

    return SegmentDecision(transcript=text, corrected=corrected,
                           stable_text=stable, **decision)


@router.post("/audio/flush", response_model=SegmentDecision)
async def audio_flush(session_id: str = Form("")):
    """hold 超时且客户未续说 → 放行当前累积的问题（兜底，防问题被无限挂起）。"""
    from app.llm.endpoint import decide_on_flush
    from app.asr.stabilizer import get_stabilizer_manager

    decision = decide_on_flush(session_id or None)

    # 放行的最终问题整段固化（完整语句无需稳定窗口）
    stable = ""
    if decision["action"] == "answer" and decision.get("question"):
        stab = get_stabilizer_manager().get(decision.get("session_id") or session_id)
        stable = stab.finalize(decision["question"])
        get_stabilizer_manager().drop(decision.get("session_id") or session_id)

    return SegmentDecision(stable_text=stable, **decision)


# ─── Streaming ASR（实时流式识别，需求第一~六/十~十二条）──────────────────
# 数据流：系统音频内录(前端 WebRTC 降噪) → 32ms PCM16 帧 → 本 WebSocket
#         → Silero VAD(仅状态) → 流式 ASR 引擎 → 热词纠错 → partial/final 回推
# 铁律：识别结果只写入前端输入框；绝不自动发送、绝不触发 RAG/LLM（需求第九条）。

@router.websocket("/audio/stream")
async def audio_stream(ws: WebSocket):
    """流式识别通道：持续音频帧进，partial/final 文本实时出。

    上行：二进制 = PCM16 16kHz mono 32ms 帧（可一次多发）；
          JSON 控制 = {"type":"pause"|"resume"|"stop"}。
    下行（JSON）：
      ready    {engine, vad}                    引擎就绪（paraformer/local）
      vad      {speech, prob}                   人声起止（仅状态展示）
      partial  {text, sentence_id, engine_ms}   实时增量文本（持续追加/微调）
      final    {text, sentence_id, engine_ms}   整句定稿（热词二次修正后）
      fallback {reason}                         云端异常降级本地短分片
      error    {message, recoverable}           异常提示（前端友好展示）
      paused / stopped                          控制回执
    """
    from fastapi import WebSocketDisconnect

    from app.asr.streaming import StreamingSession

    await ws.accept()
    session = StreamingSession(ws)
    try:
        await session.run()
    except WebSocketDisconnect:
        pass
    finally:
        await session.aclose()
