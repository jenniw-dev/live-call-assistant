"""FastAPI application entry point with lifespan management."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

from app.config import settings
from app.api.routes import router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load embedding model and FAISS index on startup."""
    logger.info("🚀 Starting Live Call Assistant...")

    # ── 音频源安全检查：只允许监听系统音频（客户声音），禁止麦克风 ──
    # 麦克风会采集候选人自己的声音与环境噪声，导致系统回答自己 → 必须拒绝启动
    if settings.audio_microphone or settings.audio_source.lower() != "system":
        logger.error(
            f"❌ 音频源配置违规: source={settings.audio_source}, "
            f"microphone={settings.audio_microphone}。只允许 system（系统音频回环），"
            f"拒绝启动以防监听候选人麦克风。"
        )
        raise RuntimeError(
            "Audio source must be 'system' with microphone disabled "
            "(call system-audio only). Check AUDIO_SOURCE / AUDIO_MICROPHONE in .env"
        )
    logger.info("🔒 Audio source check passed: system-audio only (microphone disabled)")

    # Load embedding model
    from app.rag.embedder import load_embedder
    load_embedder()
    logger.info(f"✅ Embedding model loaded: {settings.embedding_model}")

    # Load FAISS index if exists
    from app.rag.index import load_index
    index_path = settings.index_path
    if (index_path / "index.faiss").exists():
        load_index(index_path)
        logger.info(f"✅ FAISS index loaded from {index_path}")
    else:
        logger.warning(f"⚠️  No FAISS index found at {index_path}. Call POST /api/rebuild to build.")

    # Preload local ASR model (in worker thread; failure doesn't block startup)
    import asyncio
    from app.llm.audio import load_asr_model
    try:
        await asyncio.to_thread(load_asr_model)
    except Exception as e:
        logger.warning(f"⚠️  ASR model preload failed (audio transcription unavailable): {e}")

    # 缓存预热：后台预生成高频题答案（延迟优化；异步任务，不阻塞启动）
    from app.llm.prewarm import prewarm_cache
    asyncio.create_task(prewarm_cache())

    yield

    logger.info("👋 Shutting down Live Call Assistant...")
    from app.llm.client import close_http_client
    await close_http_client()


app = FastAPI(
    title="Live Call Assistant",
    description="Real-time call assistant with RAG-powered answers",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS - allow frontend dev server + Electron 桌面壳
# Electron 以 file:// 加载页面时 Origin 为字符串 "null"，需加入白名单
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        settings.frontend_url,
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "null",      # Electron file:// 页面的 Origin
        "file://",
        "app://-",   # 预留：自定义协议
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.get("/")
async def root():
    return {"message": "Live Call Assistant is running", "docs": "/docs"}
