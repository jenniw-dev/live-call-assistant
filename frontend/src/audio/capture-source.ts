export interface SystemAudioSource {
  stream: MediaStream;
  audioTrack: MediaStreamTrack;
  stop: () => void;
  readonly ended: boolean;
  onEnded: (callback: () => void) => () => void;
}

type DisplayMediaDevices = Pick<MediaDevices, 'getDisplayMedia'>;

const NOT_ALLOWED_MESSAGE = 'Couldn’t start system audio sharing. You may have cancelled, or permission isn’t granted yet. Click 🔊 to try again. If it keeps failing, allow it in System Settings → Privacy & Security, then restart the app.';
const CANCEL_MESSAGE = 'System audio sharing was cancelled. Click 🔊 to choose again.';
const GENERIC_CAPTURE_MESSAGE = 'Couldn’t start system audio sharing. Stop any other sharing and try again.';
const NO_AUDIO_MESSAGE = 'No system audio was received. Choose again and make sure audio sharing is ticked.';
export const TRACK_ENDED_MESSAGE = 'System audio sharing stopped. Click 🔊 to start listening again.';

function captureErrorName(error: unknown): string {
  if (!error || typeof error !== 'object' || !('name' in error)) return '';
  return typeof error.name === 'string' ? error.name : '';
}

function safeCaptureError(error: unknown): Error {
  const name = captureErrorName(error);
  if (name === 'NotAllowedError') return new Error(NOT_ALLOWED_MESSAGE);
  if (name === 'AbortError') return new Error(CANCEL_MESSAGE);
  return new Error(GENERIC_CAPTURE_MESSAGE);
}

export async function requestSystemAudio(
  mediaDevices: DisplayMediaDevices,
): Promise<SystemAudioSource> {
  let stream: MediaStream;
  try {
    stream = await mediaDevices.getDisplayMedia({ audio: true, video: true });
  } catch (error) {
    throw safeCaptureError(error);
  }

  const stoppedTracks = new Set<MediaStreamTrack>();
  let stopped = false;
  let ended = false;
  const endedCallbacks = new Set<() => void>();
  const stopTracks = (tracks: MediaStreamTrack[]) => {
    for (const track of tracks) {
      if (stoppedTracks.has(track)) continue;
      stoppedTracks.add(track);
      try { track.stop(); } catch { /* Native teardown races are harmless. */ }
    }
  };
  let audioTrack: MediaStreamTrack | undefined;
  const handleEnded = () => {
    if (ended) return;
    ended = true;
    stop();
    for (const callback of [...endedCallbacks]) callback();
    endedCallbacks.clear();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    audioTrack?.removeEventListener('ended', handleEnded);
    stopTracks(stream.getTracks());
  };

  stopTracks(stream.getVideoTracks());

  const audioTracks = stream.getAudioTracks();
  audioTrack = audioTracks[0];
  if (!audioTrack) {
    stop();
    throw new Error(NO_AUDIO_MESSAGE);
  }

  stopTracks(audioTracks.slice(1));
  audioTrack.addEventListener('ended', handleEnded);
  if (audioTrack.readyState === 'ended') {
    handleEnded();
    throw new Error(TRACK_ENDED_MESSAGE);
  }

  return {
    stream,
    audioTrack,
    stop,
    get ended() { return ended; },
    onEnded(callback) {
      if (ended) {
        callback();
        return () => {};
      }
      if (stopped) return () => {};
      endedCallbacks.add(callback);
      return () => endedCallbacks.delete(callback);
    },
  };
}

export function selectCaptureSource({
  platform,
  preferBackend,
}: {
  platform: string;
  preferBackend: boolean;
}): 'backend' | 'frontend' {
  if (platform === 'darwin') return 'frontend';
  return preferBackend ? 'backend' : 'frontend';
}
