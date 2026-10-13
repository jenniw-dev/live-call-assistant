/**
 * 系统音频内录（需求第五条）：
 *
 *   getDisplayMedia(loopback 系统音频，禁止麦克风)
 *     → WebRTC Noise Suppression（RTCPeerConnection 本地环回走 WebRTC 音频
 *       处理管线降噪；失败回退 applyConstraints；再失败原样直通）
 *     → AudioWorklet 重采样 → PCM16 / 16kHz / mono / 32ms(512采样点) frames
 *
 * 仅采集：不做 VAD 截断、不做分段 —— 音频持续流动，VAD 由后端 Silero
 * 统一做状态展示（需求第六条），分片/断句由流式 ASR 引擎完成。
 */

import { requestSystemAudio, TRACK_ENDED_MESSAGE } from './capture-source.ts';

export const TARGET_RATE = 16000;      // 目标采样率（需求固定 16kHz）
export const FRAME_SAMPLES = 512;      // 32ms @ 16kHz（需求 20~40ms chunk）

export const silenceTimeoutMessage = () =>
  'No system audio received. Allow audio recording in System Settings → Privacy & Security, then restart the app.';

export function createSilenceWatchdog(
  onSilent: (message: string) => void,
  timeoutMs = 10_000,
) {
  let timer = window.setTimeout(() => {
    timer = 0;
    onSilent(silenceTimeoutMessage());
  }, timeoutMs);

  return {
    observe(pcm: Int16Array) {
      if (timer && pcm.some(sample => Math.abs(sample) >= 64)) {
        window.clearTimeout(timer);
        timer = 0;
      }
    },
    cancel() {
      if (timer) window.clearTimeout(timer);
      timer = 0;
    },
  };
}

export interface CaptureCallbacks {
  /** 每帧 32ms PCM16 数据（Int16Array[512]），capturedAt=performance.now() 采集时刻 */
  onFrame: (pcm: Int16Array, capturedAt: number) => void;
  /** 捕获层异常（共享被用户停止 / 无声卡等），调用方友好提示并停止 */
  onError: (msg: string) => void;
  /** 連續無聲提示；只警告，不停止擷取或提交已辨識文字。 */
  onSilence?: (msg: string) => void;
  /** 元件停止或卸載時，立即取消還在啟動中的擷取管線。 */
  signal?: AbortSignal;
}

export interface CaptureHandle {
  stop: () => void;
  sourceLabel: string;      // 音频轨标签（调试）
  webrtcNs: boolean;        // WebRTC 降噪管线是否生效
  sampleRate: number;       // AudioContext 采样率（调试）
}

// ── AudioWorklet 处理器（Blob 注入，避免构建配置改动）──────────────
// 功能：累积输入采样 → 每凑满 512 个 16kHz 采样点输出一帧 Int16Array。
// 整数倍降采样用均值抽取（盒式抗混叠），非整数倍线性内插。
const WORKLET_SRC = `
class Pcm16Chunker extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const targetRate = (options.processorOptions || {}).targetRate || 16000;
    this.srcRate = sampleRate;
    this.ratio = this.srcRate / targetRate;
    this.frameSize = 512;
    this.need = Math.max(1, Math.round(this.ratio * this.frameSize));
    this.buf = [];
    this.bufLen = 0;
    this.stopped = false;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.stopped = true; };
  }
  process(inputs) {
    if (this.stopped) return false;
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this.buf.push(ch);
      this.bufLen += ch.length;
      while (this.bufLen >= this.need) this.emitFrame();
    }
    return true;
  }
  takeSamples(n) {
    const out = new Float32Array(n);
    let off = 0;
    while (off < n) {
      const head = this.buf[0];
      const take = Math.min(head.length, n - off);
      out.set(take === head.length ? head : head.subarray(0, take), off);
      off += take;
      if (take === head.length) this.buf.shift();
      else this.buf[0] = head.subarray(take);
    }
    this.bufLen -= n;
    return out;
  }
  emitFrame() {
    const src = this.takeSamples(this.need);
    const out = new Int16Array(this.frameSize);
    const r = Math.round(this.ratio);
    if (Math.abs(this.ratio - r) < 0.01 && r > 1 && src.length >= r * this.frameSize) {
      for (let i = 0; i < this.frameSize; i++) {
        let s = 0;
        for (let j = 0; j < r; j++) s += src[i * r + j];
        s /= r;
        out[i] = s <= -1 ? -32768 : (s >= 1 ? 32767 : Math.round(s * 32767));
      }
    } else {
      for (let i = 0; i < this.frameSize; i++) {
        const pos = i * this.ratio;
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const a = src[idx] || 0;
        const b = src[Math.min(idx + 1, src.length - 1)] || a;
        const s = a + (b - a) * frac;
        out[i] = s <= -1 ? -32768 : (s >= 1 ? 32767 : Math.round(s * 32767));
      }
    }
    this.port.postMessage(out, [out.buffer]);
  }
}
registerProcessor('pcm16-chunker', Pcm16Chunker);
`;

// ── WebRTC Noise Suppression（补充约束1：前置降噪不可省略）────────
// 把音频轨塞进 RTCPeerConnection 本地环回，强制走 WebRTC 音频处理
// 管线（NS/AEC/AGC）；2.5s 内未就绪则回退 applyConstraints。
function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('capture cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('capture cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function applyWebRtcNs(
  stream: MediaStream,
  signal?: AbortSignal,
): Promise<{ stream: MediaStream; cleanup: () => void } | null> {
  let pc1: RTCPeerConnection | null = null;
  let pc2: RTCPeerConnection | null = null;
  let trackTimer: number | null = null;
  try {
    pc1 = new RTCPeerConnection();
    pc2 = new RTCPeerConnection();
    stream.getAudioTracks().forEach(t => pc1!.addTrack(t, stream));

    const gotTrack = new Promise<MediaStream>((resolve, reject) => {
      trackTimer = window.setTimeout(() => reject(new Error('webrtc-ns timeout')), 2500);
      pc2!.ontrack = e => {
        if (trackTimer !== null) window.clearTimeout(trackTimer);
        trackTimer = null;
        resolve(e.streams[0] ?? new MediaStream([e.track]));
      };
    });
    void gotTrack.catch(() => {});
    pc1.onicecandidate = e => { if (e.candidate) pc2!.addIceCandidate(e.candidate).catch(() => {}); };
    pc2.onicecandidate = e => { if (e.candidate) pc1!.addIceCandidate(e.candidate).catch(() => {}); };

    const offer = await awaitWithAbort(pc1.createOffer(), signal);
    await awaitWithAbort(pc1.setLocalDescription(offer), signal);
    await awaitWithAbort(pc2.setRemoteDescription(offer), signal);
    const answer = await awaitWithAbort(pc2.createAnswer(), signal);
    await awaitWithAbort(pc2.setLocalDescription(answer), signal);
    await awaitWithAbort(pc1.setRemoteDescription(answer), signal);

    const processed = await awaitWithAbort(gotTrack, signal);
    const p1 = pc1, p2 = pc2;
    return { stream: processed, cleanup: () => { try { p1.close(); p2.close(); } catch { /* ignore */ } } };
  } catch {
    console.warn('[Audio] WebRTC noise suppression unavailable; using track-level noise reduction.');
    try { pc1?.close(); pc2?.close(); } catch { /* ignore */ }
    return null;
  } finally {
    if (trackTimer !== null) window.clearTimeout(trackTimer);
  }
}

async function applyTrackConstraints(stream: MediaStream, signal?: AbortSignal): Promise<boolean> {
  try {
    await awaitWithAbort(stream.getAudioTracks()[0].applyConstraints({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    } as MediaTrackConstraints), signal);
    return true;
  } catch {
    return false;
  }
}

// ── 主入口 ────────────────────────────────────────────────────────

export async function startSystemCapture(cb: CaptureCallbacks): Promise<CaptureHandle> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('System audio capture isn’t supported here.');
  }

  // 1) 系统音频回环（绝不使用麦克风 getUserMedia —— 防采集候选人声音/回声）
  const sourceCapture = await requestSystemAudio(navigator.mediaDevices);
  if (cb.signal?.aborted) {
    sourceCapture.stop();
    throw new Error('Couldn’t start system audio processing. Stop sharing and try again.');
  }
  const { audioTrack } = sourceCapture;
  const audioTracks = [audioTrack];
  let nsCleanup: (() => void) | null = null;
  let ctx: AudioContext | null = null;
  let silenceWatchdog: ReturnType<typeof createSilenceWatchdog> | null = null;
  let cleanupCurrent = () => sourceCapture.stop();
  let endedReported = false;
  const abortSource = () => cleanupCurrent();
  cb.signal?.addEventListener('abort', abortSource, { once: true });
  const detachAbort = () => cb.signal?.removeEventListener('abort', abortSource);
  const detachSourceEnd = sourceCapture.onEnded(() => {
    cleanupCurrent();
    if (endedReported) return;
    endedReported = true;
    cb.onError(TRACK_ENDED_MESSAGE);
  });

  try {
    // 2) WebRTC 降噪前置链路（NS 不可省略；逐级降级不阻塞）
    let workStream = new MediaStream(audioTracks);
    let webrtcNs = false;
    const rtc = await applyWebRtcNs(workStream, cb.signal);
    if (cb.signal?.aborted) throw new Error('capture cancelled');
    if (sourceCapture.ended) throw new Error(TRACK_ENDED_MESSAGE);
    if (rtc) {
      workStream = rtc.stream;
      nsCleanup = rtc.cleanup;
      webrtcNs = true;
    } else {
      await applyTrackConstraints(workStream, cb.signal);   // 尽力而为，失败也继续
      if (cb.signal?.aborted) throw new Error('capture cancelled');
      if (sourceCapture.ended) throw new Error(TRACK_ENDED_MESSAGE);
    }

    // 3) AudioWorklet：重采样 → 16kHz PCM16 32ms frames
    const Ctx = window.AudioContext
      ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctx();
    if (ctx.state === 'suspended') await awaitWithAbort(ctx.resume().catch(() => {}), cb.signal);

    const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    try {
      await awaitWithAbort(ctx.audioWorklet.addModule(blobUrl), cb.signal);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }

    const src = ctx.createMediaStreamSource(workStream);
    const node = new AudioWorkletNode(ctx, 'pcm16-chunker', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetRate: TARGET_RATE },
    });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);   // 静音输出，驱动 worklet 持续渲染

    silenceWatchdog = createSilenceWatchdog(cb.onSilence ?? cb.onError);

    node.port.onmessage = (e: MessageEvent) => {
      const pcm = e.data as Int16Array;
      silenceWatchdog?.observe(pcm);
      cb.onFrame(pcm, performance.now());
    };

    let stopped = false;
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      silenceWatchdog?.cancel();
      detachAbort();
      detachSourceEnd();
      try { node.port.postMessage('stop'); } catch { /* ignore */ }
      node.port.onmessage = null;
      try { src.disconnect(); node.disconnect(); mute.disconnect(); } catch { /* ignore */ }
      ctx?.close().catch(() => {});
      sourceCapture.stop();
      if (nsCleanup) nsCleanup();
    };
    cleanupCurrent = cleanup;
    if (cb.signal?.aborted) {
      cleanup();
      throw new Error('capture cancelled');
    }
    if (sourceCapture.ended) {
      cleanup();
      throw new Error(TRACK_ENDED_MESSAGE);
    }

    console.log(
      `[Audio] capture started | ctx=${ctx.sampleRate}Hz → 16kHz/mono/PCM16/32ms | ` +
      `source=system track="${audioTrack.label}" | WebRTC NS=${webrtcNs ? 'on' : 'off'}`,
    );

    return {
      stop: cleanup,
      sourceLabel: audioTrack.label,
      webrtcNs,
      sampleRate: ctx.sampleRate,
    };
  } catch (error) {
    silenceWatchdog?.cancel();
    detachAbort();
    detachSourceEnd();
    try { nsCleanup?.(); } catch { /* ignore */ }
    try { await ctx?.close(); } catch { /* ignore */ }
    sourceCapture.stop();
    if (error instanceof Error && error.message === TRACK_ENDED_MESSAGE) throw error;
    throw new Error('Couldn’t start system audio processing. Stop sharing and try again.');
  }
}
