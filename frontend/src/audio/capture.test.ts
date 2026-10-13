import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSilenceWatchdog, silenceTimeoutMessage, startSystemCapture } from './capture';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function installCaptureBrowser(displayPromise: Promise<MediaStream>) {
  const audioTrack = {
    label: 'System audio',
    readyState: 'live',
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
  } as unknown as MediaStreamTrack;
  const videoTrack = {
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
  const displayStream = {
    getTracks: () => [audioTrack, videoTrack],
    getAudioTracks: () => [audioTrack],
    getVideoTracks: () => [videoTrack],
  } as unknown as MediaStream;

  class FakeMediaStream {
    private tracks: MediaStreamTrack[];
    constructor(tracks: MediaStreamTrack[] = []) { this.tracks = tracks; }
    getAudioTracks() { return this.tracks; }
  }

  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const mute = {
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const close = vi.fn().mockResolvedValue(undefined);
  class FakeAudioContext {
    state = 'running';
    sampleRate = 48_000;
    destination = {};
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    createMediaStreamSource() { return source; }
    createGain() { return mute; }
    close = close;
  }

  const port = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn() };
  class FakeAudioWorkletNode {
    port = port;
    connect = vi.fn();
    disconnect = vi.fn();
  }

  vi.stubGlobal('navigator', {
    mediaDevices: { getDisplayMedia: vi.fn(() => displayPromise) },
  });
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.stubGlobal('RTCPeerConnection', class { constructor() { throw new Error('unavailable'); } });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:test'),
    revokeObjectURL: vi.fn(),
  });

  return { audioTrack, close, displayStream, port };
}

describe('macOS silence watchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports a stream that remains silent for ten seconds exactly once', () => {
    vi.useFakeTimers();
    const onSilent = vi.fn();
    const watchdog = createSilenceWatchdog(onSilent, 10_000);
    watchdog.observe(new Int16Array(512));

    vi.advanceTimersByTime(30_000);

    expect(onSilent).toHaveBeenCalledTimes(1);
    expect(onSilent).toHaveBeenCalledWith(silenceTimeoutMessage());
  });

  it('cancels the warning after an audible PCM frame', () => {
    vi.useFakeTimers();
    const onSilent = vi.fn();
    const watchdog = createSilenceWatchdog(onSilent, 10_000);
    const audible = new Int16Array(512);
    audible[0] = 64;

    watchdog.observe(audible);
    vi.advanceTimersByTime(10_000);

    expect(onSilent).not.toHaveBeenCalled();
  });

  it('treats samples below the audible threshold as silence', () => {
    vi.useFakeTimers();
    const onSilent = vi.fn();
    const watchdog = createSilenceWatchdog(onSilent, 10_000);
    const quiet = new Int16Array(512);
    quiet[0] = 63;

    watchdog.observe(quiet);
    vi.advanceTimersByTime(9_999);
    expect(onSilent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  it('cancels pending warnings during capture cleanup', () => {
    vi.useFakeTimers();
    const onSilent = vi.fn();
    const watchdog = createSilenceWatchdog(onSilent, 10_000);

    watchdog.cancel();
    watchdog.cancel();
    vi.advanceTimersByTime(10_000);

    expect(onSilent).not.toHaveBeenCalled();
  });

  it('starts only after capture is ready and observes PCM before forwarding it', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const display = deferred<MediaStream>();
    const browser = installCaptureBrowser(display.promise);
    const events: string[] = [];
    const onSilent = vi.fn();
    const capturePromise = startSystemCapture({
      onFrame: () => { events.push('forward'); },
      onError: vi.fn(),
      onSilence: onSilent,
    });

    vi.advanceTimersByTime(20_000);
    expect(onSilent).not.toHaveBeenCalled();
    display.resolve(browser.displayStream);
    const handle = await capturePromise;
    const audible = new Int16Array(512);
    audible[0] = 64;
    const some = audible.some.bind(audible);
    Object.defineProperty(audible, 'some', {
      value: (predicate: (value: number, index: number, array: Int16Array) => unknown) => {
        events.push('observe');
        return some(predicate);
      },
    });

    browser.port.onmessage?.({ data: audible } as MessageEvent);
    vi.advanceTimersByTime(10_000);

    expect(events).toEqual(['observe', 'forward']);
    expect(onSilent).not.toHaveBeenCalled();
    handle.stop();
  });

  it('cancels a pending silence warning on stop and abort', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const stopBrowser = installCaptureBrowser(Promise.resolve({} as MediaStream));
    // The resolved value must be the same complete fake stream used by the browser fixture.
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(stopBrowser.displayStream) },
    });
    const onStopSilence = vi.fn();
    const stopped = await startSystemCapture({
      onFrame: vi.fn(),
      onError: vi.fn(),
      onSilence: onStopSilence,
    });
    stopped.stop();
    vi.advanceTimersByTime(10_000);
    expect(onStopSilence).not.toHaveBeenCalled();

    const abortBrowser = installCaptureBrowser(Promise.resolve({} as MediaStream));
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(abortBrowser.displayStream) },
    });
    const controller = new AbortController();
    const onAbortSilence = vi.fn();
    await startSystemCapture({
      onFrame: vi.fn(),
      onError: vi.fn(),
      onSilence: onAbortSilence,
      signal: controller.signal,
    });
    controller.abort();
    vi.advanceTimersByTime(10_000);

    expect(onAbortSilence).not.toHaveBeenCalled();
  });
});
