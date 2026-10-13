"""探测测试录音：音量/噪声统计 + 抽样转写，了解录音内容与质量。

用法: python scripts/probe_audio.py
"""
import io
import sys

import av
import numpy as np

FILES = [
    r"D:/xwechat_files/wxid_3y1ppqcmpj6t22_6ee8/temp/RWTemp/2026-08/9e20f478899dc29eb19741386f9343c8/新录音(1).m4a",
    r"D:/xwechat_files/wxid_3y1ppqcmpj6t22_6ee8/temp/RWTemp/2026-08/9e20f478899dc29eb19741386f9343c8/新录音 2.m4a",
    r"D:/xwechat_files/wxid_3y1ppqcmpj6t22_6ee8/temp/RWTemp/2026-08/9e20f478899dc29eb19741386f9343c8/新录音 3.m4a",
]
SR = 16000


def decode_range(path, start_s=0.0, end_s=None):
    """解码 [start_s, end_s) 为 16kHz mono float32。"""
    container = av.open(path)
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SR)
    chunks = []
    for frame in container.decode(audio=0):
        ts = float(frame.pts * frame.time_base) if frame.pts is not None else 0.0
        if ts + float(frame.samples / frame.rate) < start_s:
            continue
        if end_s is not None and ts > end_s:
            break
        for r in resampler.resample(frame):
            chunks.append(r.to_ndarray().flatten())
    container.close()
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    pcm = np.concatenate(chunks).astype(np.float32) / 32768.0
    # 裁剪到范围
    a = int(start_s * SR)
    b = len(pcm) if end_s is None else min(len(pcm), int(end_s * SR))
    return pcm[a:b]


def stats(pcm):
    if len(pcm) == 0:
        return None
    frame = int(SR * 0.03)
    n = len(pcm) // frame
    frames = pcm[: n * frame].reshape(n, frame)
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    return {
        "rms_mean": float(rms.mean()),
        "rms_p50": float(np.percentile(rms, 50)),
        "rms_p90": float(np.percentile(rms, 90)),
        "rms_p99": float(np.percentile(rms, 99)),
        "peak": float(np.abs(pcm).max()),
        "voiced_ratio_0010": float((rms > 0.010).mean()),
        "voiced_ratio_0035": float((rms > 0.0035).mean()),
    }


def main():
    for path in FILES:
        name = path.split("/")[-1]
        print(f"\n{'='*70}\n📼 {name}\n{'='*70}")
        # 全片音量统计（抽样：取前 120s 足够看音量特征）
        pcm = decode_range(path, 0, 120)
        s = stats(pcm)
        if s:
            print(f"  前120s 音量: rms_mean={s['rms_mean']:.4f} p50={s['rms_p50']:.4f} "
                  f"p90={s['rms_p90']:.4f} p99={s['rms_p99']:.4f} peak={s['peak']:.3f}")
            print(f"  有声占比: >0.010: {s['voiced_ratio_0010']:.1%} | >0.0035: {s['voiced_ratio_0035']:.1%}")

        # 抽样转写：前60s
        from faster_whisper import WhisperModel
        global _model
        try:
            _model
        except NameError:
            _model = WhisperModel(
                "small",
                device="cpu", compute_type="int8")
        for (a, b) in [(0, 60)]:
            seg_pcm = decode_range(path, a, b)
            if len(seg_pcm) < SR:
                continue
            rms = float(np.sqrt(np.mean(seg_pcm.astype(np.float64) ** 2)))
            if rms > 1e-4:
                gain = min(0.15 / rms, 40.0)
                gain = min(gain, 0.95 / max(float(np.abs(seg_pcm).max()), 1e-6))
                if gain > 1.05:
                    seg_pcm = np.clip(seg_pcm * gain, -1, 1).astype(np.float32)
            segments, _ = _model.transcribe(
                seg_pcm, language="en", task="transcribe",
                initial_prompt="A customer support call.",
                vad_filter=True,
                vad_parameters={"threshold": 0.30, "min_silence_duration_ms": 500},
            )
            print(f"  --- 转写 [{a}-{b}s] ---")
            for seg in segments:
                print(f"  [{seg.start:6.1f}-{seg.end:6.1f}s] {seg.text}")


if __name__ == "__main__":
    main()
