"""后端系统音频采集 —— Windows WASAPI Loopback（需求第三条）。

捕获电脑正在播放的声音（腾讯会议/飞书/浏览器/Zoom/Teams 里客户的声音），
绝不采集麦克风（防录入候选人自己的声音 → 系统回答自己）。

架构（性能要求：音频 buffer 异步处理 / ASR 独立线程 / UI 与识别线程分离）：

    独立 daemon 线程：soundcard recorder 阻塞循环
      → float32 (n, ch) → mono 均值 → PCM16 bytes（32ms/帧 @16kHz）
      → asyncio.run_coroutine_threadsafe → StreamingSession._on_audio
        （复用现有 VAD + ASR 引擎管线，帧来源对管线透明）

线程安全约束：
  - soundcard/COM 对象只在采集线程内创建与使用（COM 线程亲和），绝不跨线程传递；
  - 线程侧只做一件事：run_coroutine_threadsafe 投递帧字节，不触碰任何 asyncio 对象；
  - 背压保护：事件循环忙时未消费 future 超过上限 → 丢帧（宁丢延迟不堆积）。

失败路径（import soundcard 失败 / 无默认播放设备 / 运行期设备异常）统一抛
CaptureError 或经 on_error 回调上报，由 StreamingSession 下发 capture_error
事件 → 前端自动降级浏览器 getDisplayMedia 采集。
"""

from __future__ import annotations

import asyncio
import threading

import numpy as np
from loguru import logger

from app.config import settings


class CaptureError(RuntimeError):
    """采集不可用（依赖缺失/无设备/启动失败），调用方应降级前端采集。"""


class WasapiCapture:
    """WASAPI Loopback 采集器：线程内阻塞录音 → 事件循环投递 PCM 帧。

    参数:
      loop:        StreamingSession 所在事件循环（run_coroutine_threadsafe 目标）
      on_frame:    async (pcm: bytes) —— 直接传 session._on_audio（32ms PCM16 帧）
      on_error:    async (msg: str) —— 运行期异常上报（触发前端降级）
      samplerate:  目标采样率（默认 16000，与流式 ASR 一致）
      blocksize:   每帧采样点（默认 512 = 32ms @16kHz）
      device_hint: 播放设备名称子串（空 = 系统默认播放设备）
    """

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        on_frame,
        on_error,
        samplerate: int | None = None,
        blocksize: int | None = None,
        device_hint: str | None = None,
    ):
        self._loop = loop
        self._on_frame = on_frame
        self._on_error = on_error
        self._sr = samplerate or settings.backend_capture_samplerate
        self._bs = blocksize or settings.backend_capture_blocksize
        self._hint = device_hint if device_hint is not None else settings.backend_capture_device
        self._native_fallback = settings.backend_capture_native_fallback

        self._stop = threading.Event()
        self._paused = threading.Event()
        self._thread: threading.Thread | None = None
        self._inflight = 0                      # 未消费 future 数（背压）
        self._inflight_lock = threading.Lock()
        self.device_name = ""                   # 实际采集设备（ready 事件展示用）

    # ── 生命周期 ──

    def start(self) -> None:
        """探测设备并启动采集线程。失败抛 CaptureError。"""
        try:
            import soundcard as sc
        except Exception as e:
            raise CaptureError(f"soundcard 库不可用（pip install soundcard）: {e}") from e

        # 选播放设备：device_hint 按名称子串匹配，否则系统默认
        speaker = None
        if self._hint:
            for sp in sc.all_speakers():
                if self._hint.lower() in sp.name.lower():
                    speaker = sp
                    break
            if speaker is None:
                raise CaptureError(f"未找到名称含 '{self._hint}' 的播放设备")
        else:
            try:
                speaker = sc.default_speaker()
            except Exception as e:
                raise CaptureError(f"无系统默认播放设备，无法回环采集: {e}") from e
            if speaker is None:
                raise CaptureError("无系统默认播放设备，无法回环采集")

        self.device_name = speaker.name
        # loopback microphone 绑定到该播放设备的回环源
        # （这里只做探测；recorder 在采集线程内重新创建以满足 COM 线程亲和）
        try:
            probe = sc.get_microphone(id=speaker.id, include_loopback=True)
            if probe is None:
                raise CaptureError("该播放设备不支持回环采集")
        except CaptureError:
            raise
        except Exception as e:
            raise CaptureError(f"创建回环采集源失败: {e}") from e

        self._speaker_id = speaker.id
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, daemon=True, name="wasapi-loopback-capture"
        )
        self._thread.start()
        logger.info(f"🔊 [Capture] WASAPI Loopback 采集已启动: {speaker.name}")

    def stop(self) -> None:
        """停止采集线程（幂等）。record() 阻塞于设备数据，loopback 静音也有
        连续帧，循环每轮查 _stop 可退出；join 超时 + daemon 双保险。"""
        self._stop.set()
        t = self._thread
        if t is not None and t.is_alive() and threading.current_thread() is not t:
            t.join(timeout=1.5)
        self._thread = None

    def pause(self) -> None:
        """暂停：线程继续排空设备数据（保持流健康），但丢弃帧。"""
        self._paused.set()

    def resume(self) -> None:
        self._paused.clear()

    @property
    def paused(self) -> bool:
        return self._paused.is_set()

    # ── 采集线程 ──

    def _run(self) -> None:
        try:
            import soundcard as sc
        except Exception as e:
            self._submit_error(f"soundcard 库不可用: {e}")
            return

        try:
            # 线程内重建 loopback mic（COM 线程亲和，不跨线程传递对象）
            mic = sc.get_microphone(id=self._speaker_id, include_loopback=True)
            if mic is None:
                self._submit_error("播放设备在采集期间消失")
                return

            # 首选目标采样率（16kHz）；驱动拒绝且允许降级 → 原生采样率+本地抽取
            try:
                rec_cm = mic.recorder(samplerate=self._sr, blocksize=self._bs)
                src_rate = self._sr
            except Exception as e:
                if not self._native_fallback:
                    raise
                native = int(getattr(mic, "samplerate", 0) or 48000)
                logger.warning(
                    f"[Capture] 16kHz 共享模式打开失败({e})，降级原生 {native}Hz + 本地降采样"
                )
                rec_cm = mic.recorder(samplerate=native, blocksize=self._bs * max(1, native // self._sr))
                src_rate = native

            with rec_cm as rec:
                ratio = src_rate / self._sr
                while not self._stop.is_set():
                    data = rec.record(self._bs if src_rate == self._sr
                                      else int(self._bs * ratio))
                    if data is None or len(data) == 0 or self._stop.is_set():
                        continue
                    if self._paused.is_set():
                        continue                      # 排空但丢帧
                    mono = (data.mean(axis=1) if data.ndim > 1 else data[:, 0])
                    if src_rate != self._sr:
                        mono = self._downsample(mono, ratio)
                    pcm = (np.clip(mono, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
                    self._submit(pcm)
        except Exception as e:
            if not self._stop.is_set():
                self._submit_error(f"系统音频采集异常: {e}")

    @staticmethod
    def _downsample(mono: np.ndarray, ratio: float) -> np.ndarray:
        """整数倍盒式均值抽取（抗混叠），非整数倍线性内插（与前端 worklet 同思路）。"""
        r = round(ratio)
        if abs(ratio - r) < 0.01 and r > 1:
            n = len(mono) // r
            return mono[: n * r].reshape(n, r).mean(axis=1)
        n = int(len(mono) / ratio)
        pos = np.arange(n) * ratio
        idx = pos.astype(np.int64)
        frac = pos - idx
        a = mono[idx]
        b = mono[np.minimum(idx + 1, len(mono) - 1)]
        return a + (b - a) * frac

    # ── 线程 → 事件循环投递 ──

    def _submit(self, pcm: bytes) -> None:
        with self._inflight_lock:
            if self._inflight > 8:      # 背压：丢帧（≈256ms）优于延迟堆积
                return
            self._inflight += 1
        try:
            fut = asyncio.run_coroutine_threadsafe(self._on_frame(pcm), self._loop)
        except RuntimeError:            # 事件循环已关闭
            self._stop.set()
            with self._inflight_lock:
                self._inflight -= 1
            return
        fut.add_done_callback(self._on_frame_done)

    def _on_frame_done(self, fut) -> None:
        with self._inflight_lock:
            self._inflight -= 1
        exc = fut.exception()
        if exc is not None and not self._stop.is_set():
            logger.warning(f"[Capture] 帧处理异常: {exc}")

    def _submit_error(self, msg: str) -> None:
        logger.error(f"❌ [Capture] {msg}")
        try:
            asyncio.run_coroutine_threadsafe(self._on_error(msg), self._loop)
        except RuntimeError:
            pass
        self._stop.set()
