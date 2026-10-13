"""Streaming ASR Hub —— 实时流式语音识别核心（需求第一~六、十~十二条）。

数据流（补充约束1 固化顺序，降噪不可省略 —— 前端 WebRTC NS 为第一级，
本地引擎在分片转写前再过 Audio Enhancement 频谱减法降噪）：

    前端系统音频内录（PCM16 / 16kHz / mono / 32ms 帧）
      → WebRTC Noise Suppression（前端前置链路）
      → 本模块 WebSocket：/api/audio/stream
      → Silero VAD（仅状态展示；不截断音频流/不自动结束识别/不自动提交文本）
      → ASR 引擎：
          A. DashScope Paraformer-realtime（真流式，需 DASHSCOPE_API_KEY）
          B. 本地 faster-whisper 短分片（默认/降级：1.2s 人声分片滚动转写）
      → 热词/上下文纠错（hotwords.streaming_correct）
      → partial/final 事件回推前端 → 实时字幕输入框（仅局部更新，<100ms）

关键约束：
  - 识别结果只写入输入框，绝不自动发送、绝不触发 RAG/LLM（需求第九条）；
  - partial 持续追加/微调；final 整句热词二次修正（补充约束2）；
  - 云端 WebSocket 中断自动重连 + 短时音频缓冲；彻底失败降级本地短分片（第十二条）。
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections import deque

import numpy as np
from loguru import logger

from app.config import settings

# ── 帧参数（需求第五条：PCM16 / 16kHz / mono / 20~40ms chunk，取 32ms）──
FRAME_SAMPLES = 512              # 32ms @ 16kHz
FRAME_BYTES = FRAME_SAMPLES * 2  # int16
FRAME_MS = 32

_END_PUNCT = "。？！?!…"          # 句尾标点 → 本地引擎断句信号


def _pcm_to_float(pcm: bytes) -> np.ndarray:
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0


# ═══════════════════════════════════════════════════════════════════
# VAD（需求第六条：Silero 优先，仅状态展示，绝不截断/提交）
# ═══════════════════════════════════════════════════════════════════

class SileroStreamVAD:
    """有状态 Silero VAD（复用 faster-whisper 自带 onnx 模型），逐 32ms 帧推理。"""

    name = "silero"

    def __init__(self):
        from faster_whisper.vad import get_vad_model

        self._session = get_vad_model().session
        self.reset()

    def reset(self) -> None:
        self._h = np.zeros((1, 1, 128), dtype=np.float32)
        self._c = np.zeros((1, 1, 128), dtype=np.float32)
        self._ctx = np.zeros((1, 64), dtype=np.float32)

    def feed(self, frame: np.ndarray) -> float:
        """输入 512 采样点 float32 帧，返回语音概率 0~1（状态在实例内延续）。"""
        if frame.shape[0] != FRAME_SAMPLES:
            # 异常帧长：退化为能量估计，不更新 RNN 状态
            return min(1.0, float(np.sqrt(np.mean(frame ** 2))) / 0.05)
        x = np.concatenate([self._ctx, frame.reshape(1, -1)], axis=1)
        out, self._h, self._c = self._session.run(
            None, {"input": x, "h": self._h, "c": self._c}
        )
        self._ctx = frame.reshape(1, -1)[:, -64:]
        return float(np.asarray(out).reshape(-1)[-1])


class EnergyStreamVAD:
    """能量 VAD 兜底（Silero 不可用时）：自适应噪声底 → 0~1 语音概率。"""

    name = "energy"

    def __init__(self):
        self._floor = 0.0

    def reset(self) -> None:
        self._floor = 0.0

    def feed(self, frame: np.ndarray) -> float:
        rms = float(np.sqrt(np.mean(frame.astype(np.float64) ** 2)))
        floor = self._floor
        if floor == 0:
            self._floor = rms
            return 0.0
        threshold = max(0.0035, floor * 3.0)
        if rms < threshold:
            self._floor = floor * 0.95 + rms * 0.05
        span = max(threshold * 1.2 - self._floor, 1e-4)
        return float(min(1.0, max(0.0, (rms - self._floor) / span)))


def create_stream_vad():
    """Silero 优先，异常自动降级能量 VAD（需求第六条例外兜底）。"""
    try:
        vad = SileroStreamVAD()
        logger.info("🎙️ [Stream] VAD: Silero (状态展示专用，不截断音频流)")
        return vad
    except Exception as e:
        logger.warning(f"[Stream] Silero VAD 不可用，降级能量 VAD: {e}")
        return EnergyStreamVAD()


class VadStatusTracker:
    """语音概率 → 防抖状态切换（连续 2 帧有声起始 / 连续 300ms 静音结束）。

    仅产出状态变化事件供前端展示；不做任何音频截断/识别控制。
    """

    def __init__(self):
        self._speech = False
        self._above = 0
        self._sil_ms = 0

    def feed(self, prob: float) -> bool | None:
        on, off = settings.stream_vad_speech, settings.stream_vad_silence
        if not self._speech:
            if prob >= on:
                self._above += 1
                if self._above >= 2:
                    self._speech = True
                    self._above = 0
                    self._sil_ms = 0
                    return True
            else:
                self._above = 0
            return None
        # 已处于人声状态
        if prob < off:
            self._sil_ms += FRAME_MS
            if self._sil_ms >= settings.stream_vad_end_ms:
                self._speech = False
                self._sil_ms = 0
                return False
        else:
            self._sil_ms = 0
        return None

    def reset(self) -> None:
        self._speech = False
        self._above = 0
        self._sil_ms = 0


# ═══════════════════════════════════════════════════════════════════
# ASR 引擎
# ═══════════════════════════════════════════════════════════════════

class DashScopeStreamEngine:
    """DashScope Paraformer-realtime 双工流式 ASR（真流式，300~500ms 出字）。

    协议：run-task → 二进制 PCM 帧 → result-generated(sentence) → finish-task。
    """

    def __init__(self, api_key: str, on_partial, on_final, on_error):
        self._api_key = api_key
        self._on_partial = on_partial     # async (text, engine_ms)
        self._on_final = on_final         # async (text, engine_ms)
        self._on_error = on_error         # async (exception)
        self._ws = None
        self._recv_task: asyncio.Task | None = None
        self._started = asyncio.Event()
        self._send_buf = bytearray()
        self._task_id = uuid.uuid4().hex
        self._sentence_t0: float | None = None   # 当前句首帧推送时刻（延迟统计）
        self._closed = False
        self._error_raised = False
        # start() 阶段收到的首个异常（如 task-failed/无效 key/连接被服务端拒绝）。
        # 记录后由 start() 检查并抛出 —— 否则 _started.set() 会让 start() 正常返回，
        # 引擎被误判为就绪，实际已僵死（不出结果也不降级）。
        self._start_error: Exception | None = None

    async def start(self) -> None:
        import websockets

        headers = {"Authorization": f"bearer {self._api_key}"}
        url = settings.dashscope_ws_url
        # open_timeout 覆盖 DNS+TCP+TLS+WS 握手全程；热点/多网卡环境冷解析
        # 可能耗时 3~10s，取值见 settings.dashscope_open_timeout（默认 15s）
        timeout = settings.dashscope_open_timeout
        try:
            self._ws = await websockets.connect(
                url, additional_headers=headers, max_size=None, open_timeout=timeout,
            )
        except TypeError:  # 旧版 websockets 参数名兼容
            self._ws = await websockets.connect(
                url, extra_headers=headers, max_size=None, open_timeout=timeout,
            )

        run_task = {
            "header": {
                "action": "run-task",
                "task_id": self._task_id,
                "streaming": "duplex",
            },
            "payload": {
                "task_group": "audio",
                "task": "asr",
                "function": "recognition",
                "model": settings.dashscope_asr_model,
                "parameters": {
                    "format": "pcm",
                    "sample_rate": 16000,
                    # 中英混合（需求第七条：中英文混合语句精准识别）
                    "language_hints": ["en", "zh"],
                },
                "input": {},
            },
        }
        await self._ws.send(json.dumps(run_task))
        self._recv_task = asyncio.create_task(self._recv_loop())
        await asyncio.wait_for(self._started.wait(), timeout=timeout)
        # task-started 之前就收到 task-failed（无效 key/模型不可用等）时，_recv_loop
        # 会置位 _started 并记录 _start_error —— 这里必须抛出，让 _boot_engine
        # 走重试/降级，而不是把僵死连接当成"云端就绪"。
        if self._start_error is not None:
            raise RuntimeError(
                f"DashScope 流式任务建立失败: {self._start_error}"
            ) from self._start_error

    async def push(self, frame: bytes, prob: float = 0.0) -> None:
        """累积到 100ms（3200B）发送一次（DashScope 推荐 ≤200ms/帧）。"""
        if self._closed or self._ws is None:
            return
        if self._sentence_t0 is None:
            self._sentence_t0 = time.monotonic()
        self._send_buf.extend(frame)
        if len(self._send_buf) >= 3200:
            payload = bytes(self._send_buf)
            self._send_buf.clear()
            try:
                await self._ws.send(payload)
            except Exception as e:
                # 连接已断：绝不把异常抛回 _on_audio（会炸掉整个会话），
                # 交给 _on_error 走既有的重连/降级链路；本段音频丢弃，
                # 重连期间后续帧由会话层 _pending 缓冲。
                logger.warning(f"[Stream] DashScope 音频推送失败，触发重连: {e}")
                if not self._error_raised:
                    self._error_raised = True
                    await self._on_error(e)

    async def finish(self) -> None:
        """finish-task：冲刷尾部音频，等待最后的 sentence_end（≤2.5s）。"""
        if self._closed or self._ws is None:
            return
        try:
            if self._send_buf:
                await self._ws.send(bytes(self._send_buf))
                self._send_buf.clear()
            await self._ws.send(json.dumps({
                "header": {"action": "finish-task", "task_id": self._task_id,
                           "streaming": "duplex"},
                "payload": {"input": {}},
            }))
            if self._recv_task:
                await asyncio.wait_for(asyncio.shield(self._recv_task), timeout=2.5)
        except Exception:
            pass

    async def close(self) -> None:
        self._closed = True
        if self._recv_task:
            self._recv_task.cancel()
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass

    async def _recv_loop(self) -> None:
        try:
            async for msg in self._ws:
                if not isinstance(msg, str):
                    continue
                data = json.loads(msg)
                header = data.get("header", {})
                # DashScope 双工协议：请求用 header.action，响应事件用 header.event
                action = header.get("event") or header.get("action")
                if action == "task-started":
                    self._started.set()
                elif action == "result-generated":
                    sentence = (data.get("payload", {}).get("output", {})
                                .get("sentence", {}))
                    text = (sentence.get("text") or "").strip()
                    if not text:
                        continue
                    lat = int((time.monotonic() - (self._sentence_t0 or time.monotonic())) * 1000)
                    if sentence.get("sentence_end"):
                        self._sentence_t0 = None
                        await self._on_final(text, lat)
                    else:
                        await self._on_partial(text, lat)
                elif action == "task-finished":
                    break
                elif action == "task-failed":
                    raise RuntimeError(
                        f"DashScope task-failed: {header.get('error_code')} "
                        f"{header.get('error_message')}"
                    )
        except asyncio.CancelledError:
            return
        except Exception as e:
            self._started.set()   # 防止 start() 永久等待
            if self._start_error is None:
                self._start_error = e   # start() 检查后抛出 → 触发重试/降级
            if not self._error_raised:
                self._error_raised = True
                await self._on_error(e)


class LocalStreamEngine:
    """本地 faster-whisper 短分片流式引擎（默认 / 降级方案，需求第十二条）。

    连续音频流 → 按人声累积 1.2s 短分片 → 逐片转写 → partial 增量上屏；
    句尾标点 / 文本停滞 → 该句固化为 final（仅文本展示层提交：音频流不截断、
    识别不自动结束、绝不触发发送）。
    """

    def __init__(self, on_partial, on_final):
        self._on_partial = on_partial     # async (text, engine_ms)
        self._on_final = on_final         # async (text, engine_ms)
        self._q: asyncio.Queue = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._stopped = False

    async def start(self) -> None:
        self._stopped = False
        self._worker = asyncio.create_task(self._run())

    async def push(self, frame: bytes, prob: float = 0.0) -> None:
        if not self._stopped:
            self._q.put_nowait((frame, prob))

    async def finish(self) -> None:
        """冲刷尾部分片并把未定稿句固化为 final（≤3s）。"""
        if self._stopped:
            return
        self._stopped = True
        self._q.put_nowait(None)          # sentinel
        if self._worker:
            try:
                await asyncio.wait_for(self._worker, timeout=5)
            except Exception:
                self._worker.cancel()

    async def close(self) -> None:
        await self.finish()

    # ── worker：音频流 → 分片 → 转写 → partial/final ──

    async def _run(self) -> None:
        from app.llm.audio import is_asr_busy

        chunk_ms = settings.stream_local_chunk_ms
        tail_ms = settings.stream_local_tail_ms
        stall_ms = settings.stream_local_commit_stall_ms

        sentence = ""                     # 当前未定稿句（partial 累积展示）
        voiced: list[bytes] = []          # 待转写分片帧
        voiced_ms = 0
        silence_ms = 0
        last_text_at = time.monotonic()

        async def flush_chunk(force: bool = False):
            """转写已累积人声分片 → partial；句尾信号 → final。"""
            nonlocal sentence, voiced, voiced_ms, silence_ms, last_text_at
            if not voiced:
                return
            pcm = b"".join(voiced)
            voiced, voiced_ms, silence_ms = [], 0, 0
            text, ms = await self._transcribe(pcm)
            if not text:
                return
            sentence = sentence + text
            await self._on_partial(sentence, ms)
            last_text_at = time.monotonic()
            if text.rstrip()[-1:] in _END_PUNCT or len(sentence) >= 120 or force:
                await self._on_final(sentence, ms)
                sentence = ""

        while True:
            try:
                item = await asyncio.wait_for(self._q.get(), timeout=0.4)
            except asyncio.TimeoutError:
                item = "tick"

            if item is None:                       # finish sentinel：冲刷收尾
                await flush_chunk(force=True)
                if sentence.strip():
                    await self._on_final(sentence, 0)
                return
            if item != "tick":
                frame, prob = item
                if prob >= settings.stream_vad_speech:
                    voiced.append(frame)
                    voiced_ms += FRAME_MS
                    silence_ms = 0
                elif voiced_ms > 0:
                    silence_ms += FRAME_MS

            # 分片触发：① 累积满 chunk_ms；② 讲话停顿且有尾片；
            # ③ ASR 空闲时放宽到 chunk_ms，繁忙时继续累积（上限 4s 防延迟堆积）
            busy = is_asr_busy()
            full = voiced_ms >= (chunk_ms * 2 if busy else chunk_ms)
            tail = voiced_ms >= 400 and silence_ms >= tail_ms
            capped = voiced_ms >= settings.stream_local_chunk_ms * 3
            if voiced and (full or tail or capped):
                await flush_chunk()

            # 文本停滞固化：无新识别文本超过 stall_ms 且无待转写音频
            if sentence and not voiced and \
                    time.monotonic() - last_text_at > stall_ms / 1000:
                await self._on_final(sentence, 0)
                sentence = ""
                last_text_at = time.monotonic()

    async def _transcribe(self, pcm: bytes) -> tuple[str, int]:
        from app.llm.audio import transcribe_waveform

        t0 = time.monotonic()
        try:
            result = await transcribe_waveform(_pcm_to_float(pcm), fast=True)
        except asyncio.TimeoutError:
            logger.warning("[StreamLocal] 分片转写超时，丢弃该分片")
            return "", 0
        except Exception as e:
            logger.warning(f"[StreamLocal] 分片转写失败: {e}")
            return "", 0
        ms = int((time.monotonic() - t0) * 1000)
        return (result.get("text") or "").strip(), ms


# ═══════════════════════════════════════════════════════════════════
# 流式会话（WebSocket 端点驱动）
# ═══════════════════════════════════════════════════════════════════

class StreamingSession:
    """单条前端 WebSocket 连接的流式识别会话。

    职责：帧接收 → VAD 状态事件 → 引擎调度（重连/降级/缓冲）→ 纠错 → 事件回推。
    """

    def __init__(self, ws):
        self._ws = ws
        self._send_lock = asyncio.Lock()
        self._vad = create_stream_vad()
        self._tracker = VadStatusTracker()
        self._engine = None
        self._engine_kind = ""            # "dashscope" | "local"
        # 曾因云端启动失败/重连耗尽降级到本地；resume 重建引擎时据此重试云端
        self._fell_back = False
        self._paused = False
        self._closed = False
        self._sentence_id = 0
        self._reconnects = 0
        # 引擎不可用/重连期间的音频缓冲（需求第十二条：短时缓冲）
        self._pending: deque = deque(
            maxlen=max(32, settings.stream_reconnect_buffer_ms // FRAME_MS)
        )
        self._reconnecting = False
        # ── 后端 WASAPI Loopback 采集（start source=backend 时启用）──
        self._capture = None
        self._loop: asyncio.AbstractEventLoop | None = None
        # ── 问题整理信号：语音结束后累计静音计时（仅 UI 提示，绝不触发提交）──
        self._in_speech = False
        self._sil_ms = 0
        self._ready_sentence_id = 0
        self._partial_since_ready = False

    # ── 发送 ──

    async def emit(self, obj: dict) -> None:
        if self._closed:
            return
        try:
            async with self._send_lock:
                await self._ws.send_json(obj)
        except Exception:
            self._closed = True

    # ── 引擎生命周期 ──

    def _use_dashscope(self) -> bool:
        mode = settings.streaming_engine
        return bool(settings.dashscope_api_key) and mode in ("auto", "dashscope")

    async def _boot_engine(self, kind: str | None = None, attempts: int = 1) -> None:
        """创建并启动引擎。kind=None 时按配置自动选择。

        attempts>1 时云端引擎启动失败会原地重试（含退避），耗尽后才降级本地 ——
        本网络环境 DNS 冷解析间歇性超时，单次尝试会把可用的云端连接误判死刑。
        """
        if kind is None:
            kind = "dashscope" if self._use_dashscope() else "local"

        if kind == "dashscope":
            last_err: Exception | None = None
            for attempt in range(1, attempts + 1):
                eng = DashScopeStreamEngine(
                    settings.dashscope_api_key,
                    self._emit_partial, self._emit_final, self._on_engine_error,
                )
                try:
                    await eng.start()
                except Exception as e:
                    last_err = e
                    try:
                        await eng.close()      # 半开的连接不留泄漏
                    except Exception:
                        pass
                    logger.warning(
                        f"[Stream] DashScope 启动失败 ({attempt}/{attempts}): {e}")
                    if attempt < attempts:
                        await asyncio.sleep(min(0.5 * attempt, 2.0))
                    continue
                self._engine, self._engine_kind = eng, "dashscope"
                self._reconnects = 0
                self._fell_back = False
                logger.info("🎙️ [Stream] 引擎: DashScope Paraformer-realtime (真流式)")
                await self.emit({"type": "ready", "engine": "paraformer",
                                 "vad": self._vad.name})
                await self._flush_pending()
                return
            logger.warning(f"[Stream] DashScope 重试耗尽，降级本地短分片: {last_err}")
            await self.emit({"type": "fallback",
                             "reason": f"dashscope_unavailable: {last_err}"})
            self._fell_back = True
            kind = "local"

        self._engine = LocalStreamEngine(self._emit_partial, self._emit_final)
        self._engine_kind = "local"
        await self._engine.start()
        logger.info("🎙️ [Stream] 引擎: 本地 faster-whisper 短分片 (1.2s 滚动)")
        await self.emit({"type": "ready", "engine": "local", "vad": self._vad.name})
        await self._flush_pending()

    async def _flush_pending(self) -> None:
        """重连成功后把缓冲音频补推进引擎。"""
        eng = self._engine
        if eng is None:
            return
        while self._pending and self._engine is eng:
            frame = self._pending.popleft()
            await eng.push(frame)

    async def _on_engine_error(self, err: Exception) -> None:
        """云端流中断（需求第十二条）：自动重连 + 缓冲音频，耗尽后降级本地。"""
        logger.warning(f"[Stream] DashScope 连接异常: {err}")
        if self._closed or self._engine_kind != "dashscope":
            return
        await self.emit({"type": "error", "message": "Streaming connection dropped. Reconnecting…",
                         "recoverable": True})
        if self._reconnecting:
            return
        self._reconnecting = True
        old = self._engine
        self._engine = None                       # 期间帧进入 _pending 缓冲
        if old:
            await old.close()

        backoff = [0.5, 1.0, 2.0]
        while self._reconnects < settings.stream_reconnect_max and not self._closed:
            delay = backoff[min(self._reconnects, len(backoff) - 1)]
            await asyncio.sleep(delay)
            self._reconnects += 1
            try:
                await self._boot_engine("dashscope")
                logger.info(f"[Stream] DashScope 重连成功 (第{self._reconnects}次)")
                self._reconnecting = False
                return
            except Exception as e:
                logger.warning(f"[Stream] 重连失败 ({self._reconnects}): {e}")

        if not self._closed:
            logger.warning("[Stream] 重连耗尽，降级本地短分片引擎")
            await self.emit({"type": "fallback", "reason": "dashscope_reconnect_exhausted"})
            self._fell_back = True
            await self._boot_engine("local")
        self._reconnecting = False

    async def _restart_engine(self) -> None:
        """暂停/恢复后重建引擎（DashScope task 为一次性会话）。

        若之前因云端失败降级到本地（_fell_back），趁恢复重建的机会重试云端 ——
        启动时的网络抖动（DNS 冷解析超时）往往已经过去；重试失败会由
        _boot_engine 内部再次降级本地，不影响本次恢复。
        """
        if self._engine:
            await self._engine.close()
            self._engine = None
        if self._fell_back and self._use_dashscope():
            logger.info("[Stream] resume 重建：重试云端流式引擎")
            await self._boot_engine("dashscope", attempts=settings.stream_boot_retries)
            return
        await self._boot_engine(self._engine_kind or None)

    # ── 纠错 + 事件 ──

    async def _emit_partial(self, text: str, engine_ms: int) -> None:
        from app.asr.hotwords import streaming_correct

        corrected = streaming_correct(text)
        if not corrected.strip():
            return
        self._partial_since_ready = True     # 有待展示文本 → 静音后可触发整理信号
        await self.emit({"type": "partial", "text": corrected,
                         "sentence_id": self._sentence_id, "engine_ms": engine_ms})

    async def _emit_final(self, text: str, engine_ms: int) -> None:
        from app.asr.hotwords import streaming_correct, get_asr_context
        from app.asr.kb_terms import note_chat_terms

        corrected = streaming_correct(text).strip()
        if not corrected:
            return
        self._sentence_id += 1
        self._partial_since_ready = False    # 定稿后由 sentence_id 比较触发整理信号
        # 上下文积累：本句术语提权供下一句消歧（需求第八条，无 LLM）
        get_asr_context().note(corrected)
        try:
            note_chat_terms(corrected)
        except Exception:
            pass
        logger.info(f"🎙️ [Stream] final #{self._sentence_id}: '{corrected[:60]}'")
        await self.emit({"type": "final", "text": corrected,
                         "sentence_id": self._sentence_id, "engine_ms": engine_ms})

    # ── 主循环 ──

    async def run(self) -> None:
        if not settings.streaming_asr_enabled:
            await self.emit({"type": "error", "message": "Streaming recognition is disabled",
                             "recoverable": False})
            return

        self._loop = asyncio.get_running_loop()   # 后端采集线程投递帧的目标
        await self._boot_engine(attempts=settings.stream_boot_retries)

        while not self._closed:
            try:
                msg = await self._ws.receive()
            except Exception:
                break
            mtype = msg.get("type", "")
            if mtype == "websocket.disconnect":
                break
            if mtype == "websocket.receive":
                if msg.get("bytes"):
                    await self._on_audio(msg["bytes"])
                elif msg.get("text"):
                    try:
                        data = json.loads(msg["text"])
                    except Exception:
                        continue
                    await self._on_control(data)

        await self.aclose()

    async def _on_audio(self, payload: bytes) -> None:
        """二进制帧：逐 32ms 帧过 VAD（状态）+ 推引擎（识别）。"""
        n = len(payload) // FRAME_BYTES
        for i in range(n):
            frame = payload[i * FRAME_BYTES:(i + 1) * FRAME_BYTES]
            prob = self._vad.feed(_pcm_to_float(frame))
            change = self._tracker.feed(prob)
            if change is True:
                self._in_speech = True
                self._sil_ms = 0
            elif change is False:
                # tracker 已确认连续静音 stream_vad_end_ms，从该基数继续累计
                self._in_speech = False
                self._sil_ms = settings.stream_vad_end_ms
            if change is not None:
                await self.emit({"type": "vad", "speech": change,
                                 "prob": round(prob, 3)})

            # ── 问题整理信号（VAD 智能断句）：语音结束后累计静音 ≥ 1.5s
            #    且已有识别文本 → 通知前端"问题已完整、可发送"。
            #    仅 UI 状态信号：绝不截断音频、绝不触发任何自动提交。──
            if not self._in_speech and self._sil_ms > 0:
                self._sil_ms += FRAME_MS
                if (self._sil_ms >= settings.stream_question_ready_ms
                        and not self._paused
                        and (self._sentence_id > self._ready_sentence_id
                             or self._partial_since_ready)):
                    self._ready_sentence_id = self._sentence_id
                    self._partial_since_ready = False
                    await self.emit({"type": "question_ready",
                                     "sentence_id": self._sentence_id})

            if self._paused:
                continue
            if self._engine is not None:
                await self._engine.push(frame, prob)
            else:                       # 重连/切换期间缓冲（丢弃最旧）
                self._pending.append(frame)

    async def _on_control(self, data: dict) -> None:
        t = data.get("type")
        if t == "start":
            # source=backend → 后端 WASAPI Loopback 直接采集系统播放声音
            # （通话中客户的声音）；source=frontend（默认）→ 前端上行二进制帧
            src = str(data.get("source", "frontend"))
            if src == "backend":
                await self._start_backend_capture()
        elif t == "pause":
            self._paused = True
            if self._capture:
                self._capture.pause()           # 丢帧但保持设备流
            if self._engine:
                await self._engine.finish()     # 冲刷未定稿文本为 final
            await self.emit({"type": "paused"})
        elif t == "resume":
            self._paused = False
            self._vad.reset()
            self._tracker.reset()
            self._in_speech = False
            self._sil_ms = 0
            if self._capture:
                self._capture.resume()
            await self._restart_engine()
        elif t == "stop":
            if self._capture:
                self._capture.stop()
                self._capture = None
            if self._engine:
                await self._engine.finish()
            await self.emit({"type": "stopped"})

    # ── 后端 WASAPI Loopback 采集 ──

    async def _start_backend_capture(self) -> None:
        """启动后端系统音频采集；失败下发 capture_error（前端降级浏览器采集，
        WS 会话保持不动，前端直接开始上行二进制帧即可）。"""
        from app.asr.capture import CaptureError, WasapiCapture

        if self._capture is not None:
            return                              # 已在采集
        if not settings.backend_capture_enabled:
            await self.emit({"type": "capture_error",
                             "message": "Backend capture is disabled (BACKEND_CAPTURE_ENABLED=false)"})
            return
        if self._loop is None:
            self._loop = asyncio.get_running_loop()
        cap = WasapiCapture(self._loop, self._on_audio, self._on_capture_error)
        try:
            cap.start()
        except CaptureError as e:
            logger.warning(f"[Stream] 后端采集启动失败，前端可降级浏览器采集: {e}")
            await self.emit({"type": "capture_error", "message": str(e)})
            return
        self._capture = cap
        await self.emit({"type": "capture", "source": "backend",
                         "device": cap.device_name})

    async def _on_capture_error(self, msg: str) -> None:
        """采集线程运行期异常 → 停止采集并通知前端降级。"""
        if self._capture:
            self._capture.stop()
            self._capture = None
        await self.emit({"type": "capture_error", "message": msg})

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._capture:                     # 防采集线程泄漏
            self._capture.stop()
            self._capture = None
        try:
            if self._engine and not self._paused:
                await asyncio.wait_for(self._engine.finish(), timeout=3)
        except Exception:
            pass
        try:
            if self._engine:
                await self._engine.close()
        except Exception:
            pass
        logger.info("[Stream] 会话已关闭")
