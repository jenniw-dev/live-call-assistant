"""端到端测试：3段真实录音 → 前端VAD模拟 → /api/audio/segment → 端点决策 → 验收。

模拟前端 AudioRecorder 的完整行为：
  1. 能量VAD状态机分段（LISTENING→SPEAKING→SPEECH_PAUSE→END_CANDIDATE→FINALIZED）
  2. 逐段串行提交 /api/audio/segment（带 session_id + silence_before_ms）
  3. pending 时按 hold_ms + ASR耗时 + 宽限期 判断是否 flush（模拟前端 flush 定时器）
  4. 统计：放行问题数 / 填充词忽略数 / 合并段数 / 重复抑制数

用法: python scripts/test_endpoint_e2e.py [录音文件...]（默认跑全部3段）
"""
import io
import struct
import sys
import time

import av
import httpx
import numpy as np

BASE = "http://127.0.0.1:8001"
FILES = [
    r"D:/xwechat_files/wxid_3y1ppqcmpj6t22_6ee8/temp/RWTemp/2026-08/9e20f478899dc29eb19741386f9343c8/新录音(1).m4a",
    r"D:/xwechat_files/wxid_3y1ppqcmpj6t22_6ee8/temp/RWTemp/2026-08/9e20f478899dc29eb19741386f9343c8/新录音 2.m4a",
    r"D:/xwechat_files/wxid_3y1ppqcmpj6t22_6ee8/temp/RWTemp/2026-08/9e20f478899dc29eb19741386f9343c8/新录音 3.m4a",
]

# ── 与前端 AudioRecorder.tsx 完全一致的参数 ──
TARGET = 16000
FRAME_MS = 30
PRE_ROLL_MS = 400
MIN_UTT_MS = 800
MAX_UTT_MS = 30000
PAUSE_OBS_MS = 800
SIL_END_MS = 1500
SIL_HARD_MS = 3000
CONFIRM_MS = 250
ABS_FLOOR = 0.0035
DYN_RATIO = 3.0
NOISE_ALPHA = 0.05
PROB_ALPHA = 0.35
PROB_SPEECH = 0.55
PROB_SILENCE = 0.35
START_FRAMES = 2


def decode_all(path: str) -> np.ndarray:
    c = av.open(path)
    rs = av.AudioResampler(format="s16", layout="mono", rate=TARGET)
    parts = []
    for frame in c.decode(audio=0):
        for r in rs.resample(frame):
            parts.append(r.to_ndarray().flatten())
    c.close()
    return (np.concatenate(parts).astype(np.float32) / 32768.0) if parts else np.zeros(0, np.float32)


def encode_wav(pcm: np.ndarray) -> bytes:
    n = len(pcm)
    buf = io.BytesIO()
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + n * 2))
    buf.write(b"WAVEfmt ")
    buf.write(struct.pack("<IHHIIHH", 16, 1, 1, TARGET, TARGET * 2, 2, 16))
    buf.write(b"data")
    buf.write(struct.pack("<I", n * 2))
    s16 = (np.clip(pcm, -1, 1) * 32767).astype("<i2")
    buf.write(s16.tobytes())
    return buf.getvalue()


class Seg:
    __slots__ = ("pcm", "dur_ms", "silence_ms", "start_s", "end_s")

    def __init__(self, pcm, dur_ms, silence_ms, start_s, end_s):
        self.pcm, self.dur_ms, self.silence_ms = pcm, dur_ms, silence_ms
        self.start_s, self.end_s = start_s, end_s


def vad_segment(pcm: np.ndarray) -> list:
    """复刻前端 VAD 状态机，返回语句段列表。"""
    frame = int(TARGET * FRAME_MS / 1000)
    n = len(pcm) // frame
    segs = []

    state = "LISTENING"
    noise = 0.0
    speech_level = 0.0
    prob = 0.0
    above = 0
    silence = 0.0
    confirm = 0.0
    preroll = []          # (frame_pcm,)
    preroll_ms = 0.0
    seg_frames = []
    seg_ms = 0.0
    speech_start_frame = 0

    def finalize(trailing_silence, keep_speaking, idx):
        nonlocal seg_frames, seg_ms, silence, confirm, above, state
        dur = seg_ms
        frames = seg_frames
        seg_frames, seg_ms = [], 0.0
        silence, confirm, above = 0.0, 0.0, 0
        if dur < MIN_UTT_MS:
            state = "SPEAKING" if keep_speaking else "LISTENING"
            return
        start_s = (idx * frame - int(dur / FRAME_MS) * frame) / TARGET
        segs.append(Seg(np.concatenate(frames), dur, trailing_silence,
                        max(0.0, start_s), idx * frame / TARGET))
        state = "SPEAKING" if keep_speaking else "LISTENING"

    for i in range(n):
        f = pcm[i * frame:(i + 1) * frame]
        rms = float(np.sqrt(np.mean(f.astype(np.float64) ** 2)))
        thr = max(ABS_FLOOR, noise * DYN_RATIO)
        span = max(thr * 1.2 - noise, 1e-4)
        inst = min(1.0, max(0.0, (rms - noise) / span))
        prob = prob * (1 - PROB_ALPHA) + inst * PROB_ALPHA

        # 噪声底持续跟踪：讲话期间用低能量帧收敛噪声底（与前端一致）
        if rms > thr:
            speech_level = rms if speech_level == 0 else speech_level * 0.9 + rms * 0.1
        elif rms < max(thr, speech_level * 0.15):
            noise = rms if noise == 0 else noise * (1 - NOISE_ALPHA) + rms * NOISE_ALPHA

        if state in ("LISTENING",):
            noise = rms if noise == 0 else noise * (1 - NOISE_ALPHA) + rms * NOISE_ALPHA
            preroll.append(f)
            preroll_ms += FRAME_MS
            while preroll_ms > PRE_ROLL_MS and len(preroll) > 1:
                preroll.pop(0)
                preroll_ms -= FRAME_MS
            if prob > PROB_SPEECH:
                above += 1
                if above >= START_FRAMES:
                    speech_start_frame = i
                    seg_frames = list(preroll)
                    seg_ms = preroll_ms
                    preroll, preroll_ms = [], 0.0
                    above, silence, confirm = 0, 0.0, 0.0
                    state = "SPEAKING"
            else:
                above = 0
            continue

        # SPEAKING / SPEECH_PAUSE / END_CANDIDATE 都缓存音频
        seg_frames.append(f)
        seg_ms += FRAME_MS

        if state == "SPEAKING":
            silence = 0.0 if prob >= PROB_SILENCE else silence + FRAME_MS
            if silence >= PAUSE_OBS_MS:
                state = "SPEECH_PAUSE"
            elif seg_ms >= MAX_UTT_MS:
                finalize(silence, True, i)
        elif state == "SPEECH_PAUSE":
            if prob > PROB_SPEECH:
                silence = 0.0
                state = "SPEAKING"
            else:
                silence += FRAME_MS
                if silence >= SIL_END_MS or seg_ms >= MAX_UTT_MS:
                    confirm = 0.0
                    state = "END_CANDIDATE"
        elif state == "END_CANDIDATE":
            if prob > PROB_SPEECH:
                silence, confirm = 0.0, 0.0
                state = "SPEAKING"
            else:
                silence += FRAME_MS
                confirm += FRAME_MS
                if confirm >= CONFIRM_MS or silence >= SIL_HARD_MS:
                    finalize(silence, False, i)

    # 录音结尾残留语句
    if seg_frames and seg_ms >= MIN_UTT_MS:
        segs.append(Seg(np.concatenate(seg_frames), seg_ms, 0.0,
                        max(0.0, (n * frame - int(seg_ms / FRAME_MS) * frame) / TARGET),
                        n * frame / TARGET))
    return segs


def run_file(path: str, client: httpx.Client) -> dict:
    name = path.split("/")[-1]
    print(f"\n{'='*76}\n▶ 测试录音: {name}\n{'='*76}", flush=True)
    pcm = decode_all(path)
    print(f"  解码完成: {len(pcm)/TARGET:.1f}s", flush=True)

    t0 = time.time()
    segs = vad_segment(pcm)
    print(f"  VAD 分段: {len(segs)} 段 (耗时 {time.time()-t0:.1f}s)", flush=True)
    for s in segs:
        print(f"    [{s.start_s:7.1f}-{s.end_s:7.1f}s] dur={s.dur_ms:6.0f}ms "
              f"silence_before={s.silence_ms:5.0f}ms", flush=True)

    session_id = None
    stats = {"segments": len(segs), "answers": [], "ignored": [], "merged_sessions": 0,
             "asr_ms_total": 0, "errors": 0}
    segs_in_session = 0

    for i, s in enumerate(segs):
        wav = encode_wav(s.pcm)
        t1 = time.time()
        try:
            r = client.post(
                f"{BASE}/api/audio/segment",
                files={"audio": ("a.wav", wav, "audio/wav")},
                data={"session_id": session_id or "",
                      "silence_before_ms": str(int(s.silence_ms))},
            )
            d = r.json()
        except Exception as e:
            print(f"  !! 段{i} 请求失败: {e}", flush=True)
            stats["errors"] += 1
            continue
        asr_ms = (time.time() - t1) * 1000
        stats["asr_ms_total"] += asr_ms

        new_sid = d.get("session_id") or session_id
        if new_sid != session_id:
            segs_in_session = 0
        session_id = new_sid
        segs_in_session += 1

        tr = (d.get("transcript") or "").replace("\n", " ")
        print(f"  段{i:02d} [{s.start_s:6.1f}s] asr={asr_ms:6.0f}ms | "
              f"{d['action']:7} | {d.get('reason',''):18} | '{tr[:45]}'", flush=True)

        if d["action"] == "answer":
            stats["answers"].append({"q": d["question"], "at": s.end_s,
                                     "merged": segs_in_session > 1})
            if segs_in_session > 1:
                stats["merged_sessions"] += 1
            session_id, segs_in_session = None, 0
        elif d["action"] == "ignore":
            stats["ignored"].append({"text": tr, "reason": d.get("reason")})
        else:  # pending → 模拟前端 flush 定时器
            hold_s = d.get("hold_ms", 1500) / 1000
            deadline = s.end_s + asr_ms / 1000 + hold_s + 0.4
            next_start = segs[i + 1].start_s if i + 1 < len(segs) else float("inf")
            if next_start > deadline:
                # hold 窗口内无续说 → flush 放行
                rf = client.post(f"{BASE}/api/audio/flush",
                                 data={"session_id": session_id or ""})
                df = rf.json()
                fq = (df.get("question") or "").replace("\n", " ")
                print(f"        ↳ flush({df['action']:6} {df.get('reason',''):14}) "
                      f"'{fq[:50]}'", flush=True)
                if df["action"] == "answer":
                    stats["answers"].append({"q": df["question"], "at": s.end_s,
                                             "merged": segs_in_session > 1})
                    if segs_in_session > 1:
                        stats["merged_sessions"] += 1
                    session_id, segs_in_session = None, 0
                elif df["action"] == "ignore":
                    stats["ignored"].append({"text": fq, "reason": df.get("reason")})
                    session_id, segs_in_session = None, 0

    # 收尾 flush
    if session_id:
        rf = client.post(f"{BASE}/api/audio/flush", data={"session_id": session_id})
        df = rf.json()
        if df["action"] == "answer":
            stats["answers"].append({"q": df["question"], "at": -1, "merged": False})

    print(f"\n  ── {name} 结果汇总 ──", flush=True)
    print(f"  语音段: {stats['segments']} | 放行问题: {len(stats['answers'])} | "
          f"忽略(填充/重复): {len(stats['ignored'])} | 多段合并会话: {stats['merged_sessions']} | "
          f"ASR总耗时: {stats['asr_ms_total']/1000:.0f}s", flush=True)
    print("  放行的问题:", flush=True)
    for a in stats["answers"]:
        tag = " [合并]" if a["merged"] else ""
        print(f"    @{a['at']:6.1f}s{tag} {a['q'][:90]}", flush=True)
    if stats["ignored"]:
        ig_texts = {}
        for g in stats["ignored"]:
            ig_texts[g["reason"]] = ig_texts.get(g["reason"], 0) + 1
        print(f"  忽略明细: {ig_texts}", flush=True)
    return stats


def main():
    files = sys.argv[1:] or FILES
    all_stats = {}
    with httpx.Client(timeout=180) as client:
        # 预热健康检查
        h = client.get(f"{BASE}/api/health")
        print(f"backend health: {h.json()['status']} | index={h.json()['index_size']}", flush=True)
        for f in files:
            all_stats[f.split("/")[-1]] = run_file(f, client)

    # ── 验收检查 ──
    print(f"\n{'='*76}\n验收检查\n{'='*76}", flush=True)
    filler_releases = 0
    truncated = 0
    for name, st in all_stats.items():
        for a in st["answers"]:
            q = a["q"].strip()
            if len(q) <= 4:
                filler_releases += 1
                print(f"  ❌ [{name}] 放行了疑似填充词: '{q}'")
            if q.endswith(("选择", "使用", "采用", "的话", "因为", "然后", "就是")):
                truncated += 1
                print(f"  ⚠️ [{name}] 疑似截断问题: '{q[:60]}'")
    total_q = sum(len(s["answers"]) for s in all_stats.values())
    total_ig = sum(len(s["ignored"]) for s in all_stats.values())
    total_merged = sum(s["merged_sessions"] for s in all_stats.values())
    print(f"\n  总放行问题: {total_q} | 总忽略: {total_ig} | 多段合并: {total_merged}")
    print(f"  填充词误放行: {filler_releases} | 疑似截断: {truncated}")
    print(f"  结论: {'✅ 通过' if filler_releases == 0 else '❌ 存在填充词误放行'}")


if __name__ == "__main__":
    main()
