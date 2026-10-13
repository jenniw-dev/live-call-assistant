"""Audio transcription — 本地 faster-whisper 优先，DashScope 云端可选兜底。

主方案：faster-whisper（CPU int8），无需 API key，离线可用。
  - 用 PyAV 解码任意音频格式（前端 VAD 提交的 16kHz WAV、webm/opus 等）→ 16kHz 单声道
  - 能量 VAD 预检：有效人声占比过低时直接跳过 whisper（不让 ASR 收到无效音频）
  - vad_filter 过滤段内静音，防止 whisper 在静音上产生幻觉文本
  - language 固定为 zh + 中文 initial_prompt，避免噪音误判/繁体/乱码
兜底方案：配置 DASHSCOPE_API_KEY 后，本地失败时回退到 DashScope SenseVoice。
"""

import asyncio
import io
import os

import httpx
import numpy as np
from loguru import logger

from app.config import settings

# DashScope OpenAI-compatible audio transcription endpoint（仅兜底用）
DASHSCOPE_AUDIO_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/audio/transcriptions"

# ── ASR 输入校验 / VAD 预检参数 ──────────────────────────────
ASR_SAMPLE_RATE = 16000
MIN_AUDIO_S = 0.3             # 短于 0.3s 的片段不调 ASR（过短音频识别必失败）
VAD_FRAME_MS = 30             # 能量 VAD 帧长
VAD_RMS_THRESHOLD = 0.010     # 有声帧 RMS 阈值（16k 归一化波形）
VAD_MIN_VOICED_RATIO = 0.05   # 有声帧占比 < 5% → 视为无人声
VAD_MIN_VOICED_MS = 300       # 有声时长 < 300ms → 视为无人声
ASR_TIMEOUT_S = 25            # 单次本地转写超时（15s 音频 small int8 通常 2~6s）
# ── 音量归一化：系统回环采集音量常常偏低，whisper 的内部 VAD / no_speech
#    判定会把低音量语音整段丢弃 → 识别为空。统一放大到目标 RMS。
TARGET_RMS = 0.15             # 归一化目标 RMS（语音典型值 0.1~0.2）
MAX_GAIN = 40.0               # 最大放大倍数，防止把纯底噪放大成幻觉源


# ===== 本地 ASR（faster-whisper） =============================================

_whisper_model = None
_asr_lock = asyncio.Lock()   # 串行化转写：whisper 是 CPU 密集型，并发会互相拖慢


def is_asr_busy() -> bool:
    """ASR 是否正在转写（滚动 partial 请求用它做非阻塞退避，不拖延最终段）。"""
    return _asr_lock.locked()


def load_asr_model():
    """加载 faster-whisper 模型（启动时预热，避免首次请求卡顿）。"""
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model

    from faster_whisper import WhisperModel

    # 如需从 HuggingFace 下载，走国内镜像
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

    model_id = settings.asr_model
    logger.info(f"🎙️ Loading local ASR model: {model_id} ...")
    _whisper_model = WhisperModel(model_id, device="cpu", compute_type="int8")
    logger.info("✅ ASR model loaded (faster-whisper, CPU int8)")
    return _whisper_model


def _decode_audio(audio_data: bytes) -> np.ndarray | None:
    """解码音频字节为 16kHz 单声道 float32 波形（支持 wav/webm/opus 等）。"""
    import av

    try:
        container = av.open(io.BytesIO(audio_data))
        resampler = av.AudioResampler(format="s16", layout="mono", rate=ASR_SAMPLE_RATE)
        chunks = []
        for frame in container.decode(audio=0):
            for resampled in resampler.resample(frame):
                chunks.append(resampled.to_ndarray().flatten())
        container.close()

        if not chunks:
            return None
        pcm = np.concatenate(chunks)
        return pcm.astype(np.float32) / 32768.0
    except Exception as e:
        logger.warning(f"Audio decode failed: {e}")
        return None


def _energy_vad(waveform: np.ndarray) -> tuple[float, float]:
    """粗粒度能量 VAD：返回 (有声帧占比, 有声时长ms)。

    前端已做过精确 VAD（静音切句），这里做第二道防线：
    整段都是静音/底噪时直接跳过 whisper，避免幻觉文本和无效计算。
    """
    frame = max(1, int(ASR_SAMPLE_RATE * VAD_FRAME_MS / 1000))
    n = len(waveform) // frame
    if n == 0:
        return 0.0, 0.0
    frames = waveform[: n * frame].reshape(n, frame)
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    voiced = int(np.count_nonzero(rms > VAD_RMS_THRESHOLD))
    return voiced / n, float(voiced * VAD_FRAME_MS)


# Domain prompt for whisper: biases decoding toward product terms the customer is likely to say.
TECH_TERMS_PROMPT = (
    "A customer support call about a project management software product. "
    "Common terms: Pebblework, workspace, seats, Free plan, Team plan, Business plan, Enterprise, "
    "SSO, SAML, Okta, two-factor authentication, API key, webhook, CSV export, invoice, "
    "refund, prorated, annual billing, admin, Slack integration, Google Calendar."
)


def _transcribe_local_sync(audio_data: bytes, fast: bool = False) -> dict:
    """本地 faster-whisper 转写（同步，供线程池调用）。

    fast=True（滚动 partial）：beam_size=1，牺牲少量精度换 2~3 倍速度；
    fast=False（最终段）：beam_size=2，精度/速度平衡。

    返回 {"text", "duration_s", "voiced_ratio", "voiced_ms", "has_speech", "rms", "peak"}。
    """
    waveform = _decode_audio(audio_data)
    if waveform is None:
        logger.warning("VAD Result: 音频解码失败，跳过 ASR")
        return {"text": "", "duration_s": 0.0, "voiced_ratio": 0.0,
                "voiced_ms": 0.0, "has_speech": False, "rms": 0.0, "peak": 0.0}
    return _transcribe_waveform_sync(waveform, fast)


def _transcribe_waveform_sync(waveform: np.ndarray, fast: bool = False,
                              stream_chunk: bool = False) -> dict:
    """16kHz float32 单声道波形 → faster-whisper 转写（同步，供线程池调用）。

    供 HTTP 分段端点（解码后）与流式短分片引擎（已是 PCM 波形）共用。
    stream_chunk=True（流式短分片）：跳过 whisper 内部 silero-VAD 通道
    （分片本身已由流式 VAD 按人声切出），每片省约 0.3~0.5s。
    """
    result = {"text": "", "duration_s": 0.0, "voiced_ratio": 0.0,
              "voiced_ms": 0.0, "has_speech": False, "rms": 0.0, "peak": 0.0}

    result["duration_s"] = round(len(waveform) / ASR_SAMPLE_RATE, 2)
    if result["duration_s"] < MIN_AUDIO_S:
        logger.info(f"VAD Result: 音频过短 ({result['duration_s']}s < {MIN_AUDIO_S}s)，跳过 ASR")
        return result

    # ── Audio Enhancement Layer：高通 + 频谱减法降噪 + 动态 AGC ──
    # 位置：解码之后、VAD/ASR 之前（降噪也能提升能量 VAD 与 silero-VAD 判定质量）；
    # 开关 settings.audio_enhance_enabled，异常安全（失败原样返回）。
    if settings.audio_enhance_enabled:
        from app.asr.enhance import enhance_waveform
        waveform = enhance_waveform(waveform, ASR_SAMPLE_RATE)

    # ── 能量 VAD 预检：无人声不送 whisper ──
    voiced_ratio, voiced_ms = _energy_vad(waveform)
    result["voiced_ratio"], result["voiced_ms"] = round(voiced_ratio, 3), round(voiced_ms, 1)
    if voiced_ratio < VAD_MIN_VOICED_RATIO or voiced_ms < VAD_MIN_VOICED_MS:
        logger.info(f"VAD Result: 无有效人声 (voiced={voiced_ratio:.1%}, {voiced_ms:.0f}ms)，跳过 ASR")
        return result
    result["has_speech"] = True

    # ── 音量归一化：回环采集音量偏低时放大到目标 RMS，
    #    否则 whisper 内部 silero-VAD / no_speech 判定会把整段语音丢弃 → 识别为空 ──
    rms = float(np.sqrt(np.mean(waveform.astype(np.float64) ** 2)))
    peak = float(np.max(np.abs(waveform))) if len(waveform) else 0.0
    result["rms"], result["peak"] = round(rms, 4), round(peak, 4)
    if rms > 1e-4:
        gain = min(TARGET_RMS / rms, MAX_GAIN)
        gain = min(gain, 0.95 / max(peak, 1e-6))   # 峰值限幅，防止削波
        if gain > 1.05:
            waveform = np.clip(waveform * gain, -1.0, 1.0).astype(np.float32)
            logger.info(f"Gain normalize: rms={rms:.4f} peak={peak:.4f} → ×{gain:.1f}")

    logger.info(
        f"VAD Result: voiced={voiced_ratio:.1%} "
        f"({voiced_ms:.0f}ms / {result['duration_s'] * 1000:.0f}ms) rms={rms:.4f} peak={peak:.4f}"
    )

    model = load_asr_model()
    segments, _info = model.transcribe(
        waveform,
        language=settings.asr_language or None,   # 固定语言，避免自动检测在噪声上跑偏
        task="transcribe",
        initial_prompt=TECH_TERMS_PROMPT,         # 术语先验：引导简体中文+技术词正确拼写
        # 过滤段内静音，防幻觉；流式短分片已由流式 VAD 切出纯人声段，跳过以省延迟
        vad_filter=not stream_chunk,
        # 回环采集场景音量波动大：silero 阈值降到 0.3 防漏检人声
        vad_parameters={
            "threshold": 0.30,
            "min_silence_duration_ms": 500,
            "min_speech_duration_ms": 250,
        },
        no_speech_threshold=0.75,                 # 放宽 no_speech 过滤，防低音量语音被整段丢弃
        beam_size=1 if fast else 2,               # partial 求快 / 最终段求稳
        best_of=1,                                # 关闭 best_of 采样，CPU 上近半耗时
    )
    parts = []
    for seg in segments:
        logger.info(
            f"ASR seg [{seg.start:.2f}-{seg.end:.2f}s] "
            f"no_speech={seg.no_speech_prob:.2f} logprob={seg.avg_logprob:.2f} '{seg.text}'"
        )
        parts.append(seg.text)
    result["text"] = "".join(parts).strip()
    return result


async def transcribe_audio(audio_data: bytes, mime_type: str = "audio/webm") -> dict:
    """音频字节 → 文本。返回 {"text", "duration_s", "voiced_ratio", "voiced_ms"}。

    本地 faster-whisper 优先；配置了 DASHSCOPE_API_KEY 且本地确认有人声但识别为空时，
    回退云端。全程异常安全：任何失败都返回空文本而非抛出，前端可自动恢复监听。
    """
    result = {"text": "", "duration_s": 0.0, "voiced_ratio": 0.0, "voiced_ms": 0.0,
              "rms": 0.0, "peak": 0.0}

    # Method 1: 本地 faster-whisper（无需 API key，串行执行防 CPU 争抢）
    local_ok = False
    try:
        async with _asr_lock:
            local = await asyncio.wait_for(
                asyncio.to_thread(_transcribe_local_sync, audio_data),
                timeout=ASR_TIMEOUT_S,
            )
        # ⚠️ text 必须一并复制，否则识别结果会被丢弃
        result.update({k: local[k] for k in ("text", "duration_s", "voiced_ratio", "voiced_ms", "rms", "peak")})
        local_ok = True
        if local["text"]:
            return result
    except asyncio.TimeoutError:
        logger.error(f"Local ASR timeout (>{ASR_TIMEOUT_S}s)，尝试兜底")
    except Exception as e:
        logger.warning(f"Local ASR error: {e}")

    # Method 2: DashScope 云端兜底
    # 本地已正常运行且 VAD 判定无人声 → 直接返回空，不浪费云端请求
    if local_ok and result.get("voiced_ratio", 0.0) < VAD_MIN_VOICED_RATIO:
        logger.info("No speech detected locally; skip cloud fallback")
        logger.warning("Transcription finished with empty text")
        return result

    if settings.dashscope_api_key:
        text = await _transcribe_sensevoice(audio_data, mime_type)
        if text:
            result["text"] = text
            return result
        text = await _transcribe_whisper(audio_data, mime_type)
        if text:
            result["text"] = text
            return result
    else:
        logger.warning("Local ASR returned empty; set DASHSCOPE_API_KEY to enable cloud fallback")

    if not result["text"]:
        logger.warning("Transcription finished with empty text")
    return result


async def transcribe_waveform(waveform: np.ndarray, fast: bool = True,
                              stream_chunk: bool = True) -> dict:
    """16kHz float32 单声道波形 → 转写结果（异步，流式短分片引擎用）。

    与 transcribe_audio 相同的增强/VAD 预检/归一化/串行锁/超时保护，
    但输入已是解码后的波形（流式链路前端直接送 PCM，无需容器解码）。
    """
    async with _asr_lock:
        return await asyncio.wait_for(
            asyncio.to_thread(_transcribe_waveform_sync, waveform, fast, stream_chunk),
            timeout=ASR_TIMEOUT_S,
        )


# ===== DashScope 云端兜底 =====================================================

async def _transcribe_sensevoice(audio_data: bytes, mime_type: str) -> str | None:
    """DashScope OpenAI-compatible API with SenseVoice model (Chinese-optimized)."""
    try:
        headers = {"Authorization": f"Bearer {settings.dashscope_api_key}"}
        suffix = ".webm" if "webm" in mime_type else ".wav"

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                DASHSCOPE_AUDIO_URL,
                headers=headers,
                files={"file": (f"audio{suffix}", audio_data, mime_type)},
                data={"model": "sensevoice-v1", "language": settings.asr_language or "en"},
            )
            if resp.status_code == 200:
                text = resp.json().get("text", "")
                if text:
                    logger.info(f"SenseVoice transcription: {text[:60]}...")
                    return text
            logger.warning(f"SenseVoice ASR: HTTP {resp.status_code} - {resp.text[:200]}")
            return None
    except Exception as e:
        logger.warning(f"SenseVoice ASR error: {e}")
        return None


async def _transcribe_whisper(audio_data: bytes, mime_type: str) -> str | None:
    """Last resort: Whisper large-v3 via DashScope OpenAI-compatible API."""
    try:
        headers = {"Authorization": f"Bearer {settings.dashscope_api_key}"}
        suffix = ".webm" if "webm" in mime_type else ".wav"

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                DASHSCOPE_AUDIO_URL,
                headers=headers,
                files={"file": (f"audio{suffix}", audio_data, mime_type)},
                data={"model": "whisper-large-v3", "language": settings.asr_language or "en"},
            )
            if resp.status_code == 200:
                text = resp.json().get("text", "")
                if text:
                    logger.info(f"Whisper transcription: {text[:60]}...")
                    return text
            logger.warning(f"Whisper ASR: HTTP {resp.status_code}")
            return None
    except Exception as e:
        logger.warning(f"Whisper ASR error: {e}")
        return None
