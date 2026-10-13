import test from 'node:test';
import assert from 'node:assert/strict';

class FakeTrack {
  constructor(kind, label = '') {
    this.kind = kind;
    this.label = label;
    this.readyState = 'live';
    this.stopCalls = 0;
    this.listeners = new Set();
  }

  stop() {
    this.stopCalls += 1;
    this.readyState = 'ended';
  }

  addEventListener(type, listener) {
    if (type === 'ended') this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === 'ended') this.listeners.delete(listener);
  }

  end() {
    this.readyState = 'ended';
    for (const listener of [...this.listeners]) listener();
  }
}

function makeStream({ audio = [], video = [] } = {}) {
  return {
    getVideoTracks: () => video,
    getAudioTracks: () => audio,
    getTracks: () => [...video, ...audio],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('requests display audio and video, then immediately releases video', async () => {
  const { requestSystemAudio } = await import('../src/audio/capture-source.ts');
  const requests = [];
  const videoTrack = new FakeTrack('video');
  const audioTrack = new FakeTrack('audio', 'System Audio');
  const stream = {
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [audioTrack],
    getTracks: () => [videoTrack, audioTrack],
  };

  const result = await requestSystemAudio({
    getDisplayMedia: async constraints => {
      requests.push(constraints);
      return stream;
    },
  });

  assert.deepEqual(requests, [{ audio: true, video: true }]);
  assert.equal(videoTrack.stopCalls, 1);
  assert.equal(audioTrack.stopCalls, 0);
  assert.equal(result.stream, stream);
  assert.equal(result.audioTrack, audioTrack);

  result.stop();
  result.stop();
  assert.equal(videoTrack.stopCalls, 1);
  assert.equal(audioTrack.stopCalls, 1);
});

test('maps NotAllowedError to cancellation-or-permission guidance without guessing which occurred', async () => {
  const { requestSystemAudio } = await import('../src/audio/capture-source.ts');
  const mediaDevices = {
    getDisplayMedia: async () => {
      throw new DOMException('native permission detail', 'NotAllowedError');
    },
  };

  await assert.rejects(
    requestSystemAudio(mediaDevices),
    error => error instanceof Error
      && error.message === 'Couldn't start system audio sharing. You may have cancelled, or permission isn't granted yet. Click 🔊 to try again. If it keeps failing, allow it in System Settings → Privacy & Security, then restart the app.'
      && !error.message.includes('native permission detail'),
  );
});

test('maps picker cancellation without exposing native details', async () => {
  const { requestSystemAudio } = await import('../src/audio/capture-source.ts');
  const mediaDevices = {
    getDisplayMedia: async () => {
      throw new DOMException('native cancel detail', 'AbortError');
    },
  };

  await assert.rejects(
    requestSystemAudio(mediaDevices),
    error => error instanceof Error
      && error.message === 'System audio sharing was cancelled. Click 🔊 to choose again.'
      && !error.message.includes('native cancel detail'),
  );
});

test('maps unexpected capture failures to a safe actionable message', async () => {
  const { requestSystemAudio } = await import('../src/audio/capture-source.ts');

  await assert.rejects(
    requestSystemAudio({
      getDisplayMedia: async () => { throw new Error('native-device-secret-detail'); },
    }),
    error => error instanceof Error
      && error.message === 'Couldn't start system audio sharing. Stop any other sharing and try again.'
      && !error.message.includes('native-device-secret-detail'),
  );
});

test('releases the selected stream when it contains no system audio track', async () => {
  const { requestSystemAudio } = await import('../src/audio/capture-source.ts');
  const videoTrack = new FakeTrack('video');
  const stream = makeStream({ video: [videoTrack] });

  await assert.rejects(
    requestSystemAudio({ getDisplayMedia: async () => stream }),
    { message: 'No system audio was received. Choose again and make sure audio sharing is ticked.' },
  );
  assert.ok(videoTrack.stopCalls >= 1);
});

test('trusts picker provenance, retains one audio track, and stops every additional track', async () => {
  const { requestSystemAudio } = await import('../src/audio/capture-source.ts');
  const selectedTrack = new FakeTrack('audio', 'Localized or arbitrary label');
  const extraTrack = new FakeTrack('audio', 'MacBook Microphone');
  const anotherExtraTrack = new FakeTrack('audio', '其他音訊');
  const stream = makeStream({ audio: [selectedTrack, extraTrack, anotherExtraTrack] });

  const source = await requestSystemAudio({ getDisplayMedia: async () => stream });

  assert.equal(source.audioTrack, selectedTrack);
  assert.equal(selectedTrack.stopCalls, 0);
  assert.equal(extraTrack.stopCalls, 1);
  assert.equal(anotherExtraTrack.stopCalls, 1);
  source.stop();
  assert.equal(selectedTrack.stopCalls, 1);
});

test('captures an ended event immediately even when the consumer subscribes later', async () => {
  const { requestSystemAudio } = await import('../src/audio/capture-source.ts');
  const audioTrack = new FakeTrack('audio', 'System Audio');
  const stream = makeStream({ audio: [audioTrack] });
  const source = await requestSystemAudio({ getDisplayMedia: async () => stream });
  const events = [];

  audioTrack.end();
  const detach = source.onEnded(() => events.push('ended'));
  detach();

  assert.deepEqual(events, ['ended']);
  assert.equal(audioTrack.stopCalls, 1);
});

test('rejects a track that is already ended before acquisition can commit', async () => {
  const { requestSystemAudio } = await import('../src/audio/capture-source.ts');
  const audioTrack = new FakeTrack('audio', 'System Audio');
  audioTrack.readyState = 'ended';
  const stream = makeStream({ audio: [audioTrack] });

  await assert.rejects(
    requestSystemAudio({ getDisplayMedia: async () => stream }),
    { message: 'System audio sharing stopped. Click 🔊 to start listening again.' },
  );
  assert.equal(audioTrack.stopCalls, 1);
});

test('macOS always selects frontend WebSocket audio even when backend capture is preferred', async () => {
  const { selectCaptureSource } = await import('../src/audio/capture-source.ts');

  assert.equal(selectCaptureSource({ platform: 'darwin', preferBackend: true }), 'frontend');
  assert.equal(selectCaptureSource({ platform: 'darwin', preferBackend: false }), 'frontend');
  assert.equal(selectCaptureSource({ platform: 'win32', preferBackend: true }), 'backend');
  assert.equal(selectCaptureSource({ platform: 'win32', preferBackend: false }), 'frontend');
});

test('a processing-pipeline startup failure releases the selected system audio', async () => {
  const { startSystemCapture } = await import('../src/audio/capture.ts');
  const audioTrack = new FakeTrack('audio', 'System Audio');
  audioTrack.applyConstraints = async () => { throw new Error('constraint detail'); };
  const videoTrack = new FakeTrack('video');
  const stream = makeStream({ audio: [audioTrack], video: [videoTrack] });
  const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'mediaDevices');
  const originalWindow = globalThis.window;
  const originalMediaStream = globalThis.MediaStream;
  const originalWarn = console.warn;

  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia: async () => stream },
  });
  globalThis.window = {};
  globalThis.MediaStream = class {
    constructor(tracks) { this.tracks = tracks; }
    getAudioTracks() { return this.tracks; }
  };
  console.warn = () => {};

  try {
    await assert.rejects(
      startSystemCapture({ onFrame: () => {}, onError: () => {} }),
      { message: 'Couldn't start system audio processing. Stop sharing and try again.' },
    );
  } finally {
    if (mediaDevicesDescriptor) {
      Object.defineProperty(globalThis.navigator, 'mediaDevices', mediaDevicesDescriptor);
    } else {
      delete globalThis.navigator.mediaDevices;
    }
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalMediaStream === undefined) delete globalThis.MediaStream;
    else globalThis.MediaStream = originalMediaStream;
    console.warn = originalWarn;
  }

  assert.equal(videoTrack.stopCalls, 1);
  assert.equal(audioTrack.stopCalls, 1);
});

test('track end during WebRTC setup aborts startup with one safe idle message', async () => {
  const { startSystemCapture } = await import('../src/audio/capture.ts');
  const negotiation = deferred();
  const audioTrack = new FakeTrack('audio', 'System Audio');
  audioTrack.applyConstraints = async () => {};
  const stream = makeStream({ audio: [audioTrack] });
  const peerConnections = [];
  class FakePeerConnection {
    constructor() { peerConnections.push(this); }
    addTrack() {}
    createOffer() { return negotiation.promise; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async createAnswer() { return {}; }
    async addIceCandidate() {}
    close() {}
  }
  const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'mediaDevices');
  const originalWindow = globalThis.window;
  const originalMediaStream = globalThis.MediaStream;
  const originalPeerConnection = globalThis.RTCPeerConnection;
  const originalWarn = console.warn;
  const errors = [];

  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia: async () => stream },
  });
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.MediaStream = class {
    constructor(tracks) { this.tracks = tracks; }
    getAudioTracks() { return this.tracks; }
  };
  globalThis.RTCPeerConnection = FakePeerConnection;
  console.warn = () => {};

  try {
    const starting = startSystemCapture({ onFrame: () => {}, onError: message => errors.push(message) });
    await new Promise(resolve => setImmediate(resolve));
    audioTrack.end();
    negotiation.resolve({});
    peerConnections[1].ontrack({
      streams: [new globalThis.MediaStream([audioTrack])],
      track: audioTrack,
    });

    await assert.rejects(starting, {
      message: 'System audio sharing stopped. Click 🔊 to start listening again.',
    });
  } finally {
    if (mediaDevicesDescriptor) Object.defineProperty(globalThis.navigator, 'mediaDevices', mediaDevicesDescriptor);
    else delete globalThis.navigator.mediaDevices;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalMediaStream === undefined) delete globalThis.MediaStream;
    else globalThis.MediaStream = originalMediaStream;
    if (originalPeerConnection === undefined) delete globalThis.RTCPeerConnection;
    else globalThis.RTCPeerConnection = originalPeerConnection;
    console.warn = originalWarn;
  }

  assert.deepEqual(errors, [
    'System audio sharing stopped. Click 🔊 to start listening again.',
  ]);
  assert.equal(audioTrack.stopCalls, 1);
});

test('cancelling startup immediately releases media and settles without waiting for negotiation', async () => {
  const { startSystemCapture } = await import('../src/audio/capture.ts');
  const negotiation = deferred();
  const audioTrack = new FakeTrack('audio', 'System Audio');
  const stream = makeStream({ audio: [audioTrack] });
  class PendingPeerConnection {
    addTrack() {}
    createOffer() { return negotiation.promise; }
    async addIceCandidate() {}
    close() {}
  }
  const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'mediaDevices');
  const originalWindow = globalThis.window;
  const originalMediaStream = globalThis.MediaStream;
  const originalPeerConnection = globalThis.RTCPeerConnection;
  const originalWarn = console.warn;
  const controller = new AbortController();

  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia: async () => stream },
  });
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.MediaStream = class {
    constructor(tracks) { this.tracks = tracks; }
    getAudioTracks() { return this.tracks; }
  };
  globalThis.RTCPeerConnection = PendingPeerConnection;
  console.warn = () => {};

  try {
    const starting = startSystemCapture({
      onFrame: () => {},
      onError: () => {},
      signal: controller.signal,
    });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();

    await Promise.race([
      assert.rejects(starting),
      new Promise((_, reject) => setTimeout(() => reject(new Error('capture cancellation timeout')), 30)),
    ]);
  } finally {
    negotiation.resolve({});
    if (mediaDevicesDescriptor) Object.defineProperty(globalThis.navigator, 'mediaDevices', mediaDevicesDescriptor);
    else delete globalThis.navigator.mediaDevices;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalMediaStream === undefined) delete globalThis.MediaStream;
    else globalThis.MediaStream = originalMediaStream;
    if (originalPeerConnection === undefined) delete globalThis.RTCPeerConnection;
    else globalThis.RTCPeerConnection = originalPeerConnection;
    console.warn = originalWarn;
  }

  assert.equal(audioTrack.stopCalls, 1);
});

test('early WebRTC negotiation failure cannot reject its track wait later', async () => {
  const { startSystemCapture } = await import('../src/audio/capture.ts');
  const audioTrack = new FakeTrack('audio', 'System Audio');
  audioTrack.applyConstraints = async () => {};
  const stream = makeStream({ audio: [audioTrack] });
  class FailingPeerConnection {
    addTrack() {}
    async createOffer() { throw new Error('early negotiation failure'); }
    async addIceCandidate() {}
    close() {}
  }
  const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'mediaDevices');
  const originalWindow = globalThis.window;
  const originalMediaStream = globalThis.MediaStream;
  const originalPeerConnection = globalThis.RTCPeerConnection;
  const originalWarn = console.warn;
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);

  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia: async () => stream },
  });
  globalThis.window = {
    setTimeout: callback => setTimeout(callback, 10),
    clearTimeout,
  };
  globalThis.MediaStream = class {
    constructor(tracks) { this.tracks = tracks; }
    getAudioTracks() { return this.tracks; }
  };
  globalThis.RTCPeerConnection = FailingPeerConnection;
  console.warn = () => {};
  process.on('unhandledRejection', onUnhandled);

  try {
    await assert.rejects(
      startSystemCapture({ onFrame: () => {}, onError: () => {} }),
      { message: 'Couldn't start system audio processing. Stop sharing and try again.' },
    );
    await new Promise(resolve => setTimeout(resolve, 30));
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    if (mediaDevicesDescriptor) Object.defineProperty(globalThis.navigator, 'mediaDevices', mediaDevicesDescriptor);
    else delete globalThis.navigator.mediaDevices;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalMediaStream === undefined) delete globalThis.MediaStream;
    else globalThis.MediaStream = originalMediaStream;
    if (originalPeerConnection === undefined) delete globalThis.RTCPeerConnection;
    else globalThis.RTCPeerConnection = originalPeerConnection;
    console.warn = originalWarn;
  }

  assert.deepEqual(unhandled, []);
});
