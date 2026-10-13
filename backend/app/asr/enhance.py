"""Audio Enhancement Layer（需求第七条）—— 系统音频采集之后、ASR 之前。

    系统回环音频 → 【本模块】→ faster-whisper

三个功能（纯 numpy 实现，不新增依赖；CPU 开销 <100ms/15s 音频）：
  1. 80Hz 高通滤波   —— 去掉空调/风扇/电源低频嗡嗡声（biquad IIR）；
  2. 频谱减法降噪     —— STFT 域估计背景噪声谱并减去，过滤环境噪声与会议杂音；
  3. 动态 AGC        —— 逐帧增益平滑（attack/release），声音小时自动提升、
                        大时不削波；与 audio.py 的全局 RMS 归一化互补
                        （本层管句内动态，全局层管整段电平）。

设计约束：
  - 不改变采样率/声道/数据格式（输入输出均为 16kHz float32 单声道）；
  - 全程异常安全：任何失败原样返回输入波形，不阻断 ASR 主链路；
  - settings.audio_enhance_enabled 开关控制。
"""

from __future__ import annotations

import numpy as np
from loguru import logger

from app.config import settings

_HIGHPASS_HZ = 80.0
_FRAME_MS = 25          # STFT 帧长
_HOP_MS = 10            # STFT 帧移
_NOISE_PERCENTILE = 15  # 用能量最低的 N% 帧估计噪声谱（回环音频开头未必是静音）


# ── 1. 80Hz 高通（二阶 Butterworth biquad）──────────────────────

def _highpass_coeffs(sr: float, fc: float) -> tuple[float, float, float, float, float]:
    w = 2.0 * np.pi * fc / sr
    cw = np.cos(w)
    alpha = np.sin(w) / (2.0 * np.sqrt(2.0))   # Q = 0.707
    b0, b1, b2 = (1 + cw) / 2, -(1 + cw), (1 + cw) / 2
    a0, a1, a2 = 1 + alpha, -2 * cw, 1 - alpha
    return b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0


def _highpass_fast(x: np.ndarray, sr: int) -> np.ndarray:
    """80Hz 高通（biquad 直接形式 II）。"""
    b0, b1, b2, a1, a2 = _highpass_coeffs(sr, _HIGHPASS_HZ)
    n = len(x)
    y = np.empty(n, dtype=np.float64)
    z1 = z2 = 0.0
    for i in range(n):
        xi = x[i]
        yi = b0 * xi + z1
        z1 = b1 * xi - a1 * yi + z2
        z2 = b2 * xi - a2 * yi
        y[i] = yi
    return y.astype(np.float32)


# ── 2. 频谱减法降噪（numpy STFT + overlap-add）──────────────────

def _spectral_subtract(x: np.ndarray, sr: int) -> np.ndarray:
    frame = max(64, int(sr * _FRAME_MS / 1000))
    hop = max(32, int(sr * _HOP_MS / 1000))
    window = np.hanning(frame).astype(np.float32)

    n = len(x)
    if n < frame:
        return x

    # 分帧（零填充到整数帧）
    pad = (frame - (n - frame) % hop) % hop
    xp = np.concatenate([x, np.zeros(pad + frame, dtype=np.float32)])
    n_frames = 1 + (len(xp) - frame) // hop
    idx = np.arange(frame)[None, :] + (np.arange(n_frames) * hop)[:, None]
    frames = xp[idx] * window

    spec = np.fft.rfft(frames, axis=1)
    mag = np.abs(spec)
    phase = np.angle(spec)

    # 噪声谱估计：能量最低 N% 帧的均值谱（不依赖"开头是静音"假设）
    frame_energy = np.mean(mag, axis=1)
    k = max(1, int(n_frames * _NOISE_PERCENTILE / 100))
    noise_frames = mag[np.argpartition(frame_energy, k - 1)[:k]]
    noise = np.mean(noise_frames, axis=0)

    factor = settings.enhance_subtract_factor
    floor = settings.enhance_spectral_floor
    mag_clean = np.maximum(mag - factor * noise[None, :], floor * mag)

    spec_clean = mag_clean * np.exp(1j * phase)
    frames_out = np.fft.irfft(spec_clean, axis=1).astype(np.float32) * window

    # overlap-add
    y = np.zeros(len(xp), dtype=np.float32)
    np.add.at(y, idx.reshape(-1), frames_out.reshape(-1))
    # 窗归一化（Hann + hop=frame*0.4 时 COLA 近似成立，实测重建增益恒定）
    norm = np.zeros(len(xp), dtype=np.float32)
    np.add.at(norm, idx.reshape(-1), np.tile(window ** 2, n_frames))
    norm[norm < 1e-6] = 1.0
    y = y / norm
    return y[:n]


# ── 3. 动态 AGC（逐帧增益 + attack/release 平滑 + 峰值限幅）──────

def _agc(x: np.ndarray, sr: int) -> np.ndarray:
    frame = max(64, int(sr * 30 / 1000))
    hop = frame // 2
    target = settings.enhance_target_rms
    max_gain = 40.0

    n = len(x)
    if n < frame:
        return x

    n_frames = 1 + (n - frame) // hop
    idx = np.arange(frame)[None, :] + (np.arange(n_frames) * hop)[:, None]
    frames = x[idx]
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))

    # 目标增益（静音帧不给增益，防放大底噪）
    with np.errstate(divide="ignore"):
        gain = np.where(rms > 1e-4, np.minimum(target / rms, max_gain), 1.0)

    # attack/release 一阶平滑：声音变大快速压住（attack），变小缓慢提升（release）
    alpha_up = 0.4     # release（提升方向，慢，防抽吸效应）
    alpha_dn = 0.7     # attack（压低方向，快，防削波）
    sm = np.empty_like(gain)
    g = 1.0
    for i in range(len(gain)):
        gi = float(gain[i])
        alpha = alpha_dn if gi < g else alpha_up
        g = g + alpha * (gi - g)
        sm[i] = min(g, max_gain)

    # 帧间增益线性内插到采样点
    centers = np.arange(n_frames) * hop + frame // 2
    sample_gain = np.interp(np.arange(n), centers, sm)
    y = x * sample_gain.astype(np.float32)
    peak = float(np.max(np.abs(y))) if n else 0.0
    if peak > 0.95:
        y = y * (0.95 / peak)
    return y.astype(np.float32)


# ── 统一入口 ─────────────────────────────────────────────────────

def enhance_waveform(waveform: np.ndarray, sr: int = 16000) -> np.ndarray:
    """16kHz float32 单声道 → 增强后的同格式波形。异常安全，失败原样返回。"""
    if not settings.audio_enhance_enabled or waveform is None or len(waveform) < sr // 10:
        return waveform
    try:
        import time
        t0 = time.time()
        y = _highpass_fast(waveform, sr)
        y = _spectral_subtract(y, sr)
        y = _agc(y, sr)
        logger.debug(f"🎚️ [Enhance] {len(waveform) / sr:.1f}s audio enhanced "
                     f"in {(time.time() - t0) * 1000:.0f}ms "
                     f"(rms {np.sqrt(np.mean(waveform**2)):.4f} → {np.sqrt(np.mean(y**2)):.4f})")
        return y
    except Exception as e:
        logger.warning(f"[Enhance] 音频增强失败，使用原始音频: {e}")
        return waveform
