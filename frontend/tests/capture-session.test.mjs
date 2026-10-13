import test from 'node:test';
import assert from 'node:assert/strict';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

function fakeSocket(openPromise = Promise.resolve()) {
  return {
    openCalls: [],
    controls: [],
    closeCalls: 0,
    open(source) {
      this.openCalls.push(source);
      return openPromise;
    },
    sendControl(type) { this.controls.push(type); },
    close() { this.closeCalls += 1; },
  };
}

function fakeCapture(id = 'capture') {
  return { id, stopCalls: 0, stop() { this.stopCalls += 1; } };
}

test('starting is synchronous and rejects a second concurrent start', async () => {
  const { CaptureSessionCoordinator } = await import('../src/audio/capture-session.ts');
  const opened = deferred();
  const socket = fakeSocket(opened.promise);
  let socketCreations = 0;
  let readyCalls = 0;
  const coordinator = new CaptureSessionCoordinator();
  const request = {
    source: 'frontend',
    createSocket: () => { socketCreations += 1; return socket; },
    createCapture: async () => fakeCapture(),
    onReady: () => { readyCalls += 1; },
    onError: error => { throw error; },
  };

  assert.equal(coordinator.start(request), true);
  assert.equal(coordinator.start(request), false);
  assert.equal(socketCreations, 1);

  opened.resolve();
  await nextTurn();
  assert.equal(readyCalls, 1);
});

test('stop owns and closes a socket whose open is still pending', async () => {
  const { CaptureSessionCoordinator } = await import('../src/audio/capture-session.ts');
  const opened = deferred();
  const socket = fakeSocket(opened.promise);
  let readyCalls = 0;
  let errorCalls = 0;
  const coordinator = new CaptureSessionCoordinator();

  coordinator.start({
    source: 'frontend',
    createSocket: () => socket,
    createCapture: async () => fakeCapture(),
    onReady: () => { readyCalls += 1; },
    onError: () => { errorCalls += 1; },
  });
  coordinator.stop();
  opened.resolve();
  await nextTurn();

  assert.equal(socket.closeCalls, 1);
  assert.deepEqual(socket.controls, ['stop']);
  assert.equal(readyCalls, 0);
  assert.equal(errorCalls, 0);
  assert.equal(coordinator.phase, 'idle');
});

test('stop aborts a pending capture attempt before its promise resolves', async () => {
  const { CaptureSessionCoordinator } = await import('../src/audio/capture-session.ts');
  const captureResult = deferred();
  const captureStarted = deferred();
  let attemptSignal;
  const coordinator = new CaptureSessionCoordinator();

  coordinator.start({
    source: 'frontend',
    createSocket: () => fakeSocket(),
    createCapture: guard => {
      attemptSignal = guard.signal;
      captureStarted.resolve();
      return captureResult.promise;
    },
    onReady: () => {},
    onError: error => { throw error; },
  });
  await captureStarted.promise;
  assert.equal(attemptSignal.aborted, false);

  coordinator.stop();

  assert.equal(attemptSignal.aborted, true);
  captureResult.resolve(fakeCapture('late-aborted'));
  await nextTurn();
});

test('a capture that resolves after stop is immediately released and never published', async () => {
  const { CaptureSessionCoordinator } = await import('../src/audio/capture-session.ts');
  const captureResult = deferred();
  const captureStarted = deferred();
  const socket = fakeSocket();
  const lateCapture = fakeCapture('late');
  let readyCalls = 0;
  const coordinator = new CaptureSessionCoordinator();

  coordinator.start({
    source: 'frontend',
    createSocket: () => socket,
    createCapture: () => {
      captureStarted.resolve();
      return captureResult.promise;
    },
    onReady: () => { readyCalls += 1; },
    onError: error => { throw error; },
  });
  await captureStarted.promise;
  coordinator.stop();
  captureResult.resolve(lateCapture);
  await nextTurn();

  assert.equal(lateCapture.stopCalls, 1);
  assert.equal(socket.closeCalls, 1);
  assert.equal(readyCalls, 0);
});

test('a stopped stale attempt cannot overwrite a newer active attempt', async () => {
  const { CaptureSessionCoordinator } = await import('../src/audio/capture-session.ts');
  const firstOpen = deferred();
  const firstSocket = fakeSocket(firstOpen.promise);
  const secondSocket = fakeSocket();
  const published = [];
  const coordinator = new CaptureSessionCoordinator();

  coordinator.start({
    source: 'frontend',
    createSocket: () => firstSocket,
    createCapture: async () => fakeCapture('first'),
    onReady: () => published.push('first'),
    onError: error => { throw error; },
  });
  coordinator.stop();

  assert.equal(coordinator.start({
    source: 'frontend',
    createSocket: () => secondSocket,
    createCapture: async () => fakeCapture('second'),
    onReady: ({ capture }) => published.push(capture.id),
    onError: error => { throw error; },
  }), true);
  await nextTurn();
  firstOpen.resolve();
  await nextTurn();

  assert.deepEqual(published, ['second']);
  assert.equal(firstSocket.closeCalls, 1);
  assert.equal(coordinator.phase, 'active');
});

test('stop releases the active socket and capture exactly once', async () => {
  const { CaptureSessionCoordinator } = await import('../src/audio/capture-session.ts');
  const socket = fakeSocket();
  const capture = fakeCapture();
  const ready = deferred();
  const coordinator = new CaptureSessionCoordinator();

  coordinator.start({
    source: 'frontend',
    createSocket: () => socket,
    createCapture: async () => capture,
    onReady: ready.resolve,
    onError: error => { throw error; },
  });
  await ready.promise;
  coordinator.stop();
  coordinator.stop();

  assert.deepEqual(socket.controls, ['stop']);
  assert.equal(socket.closeCalls, 1);
  assert.equal(capture.stopCalls, 1);
  assert.equal(coordinator.phase, 'idle');
});

test('stale callbacks can test their generation before publishing state', async () => {
  const { CaptureSessionCoordinator } = await import('../src/audio/capture-session.ts');
  const firstOpen = deferred();
  const guards = [];
  const coordinator = new CaptureSessionCoordinator();

  coordinator.start({
    source: 'frontend',
    createSocket: guard => { guards.push(guard); return fakeSocket(firstOpen.promise); },
    createCapture: async () => fakeCapture(),
    onReady: () => {},
    onError: error => { throw error; },
  });
  assert.equal(guards[0].isCurrent(), true);
  coordinator.stop();
  assert.equal(guards[0].isCurrent(), false);

  coordinator.start({
    source: 'backend',
    createSocket: guard => { guards.push(guard); return fakeSocket(); },
    onReady: () => {},
    onError: error => { throw error; },
  });
  assert.equal(guards[0].isCurrent(), false);
  assert.equal(guards[1].isCurrent(), true);
});

test('startup failure invalidates callbacks before closing its socket', async () => {
  const { CaptureSessionCoordinator } = await import('../src/audio/capture-session.ts');
  const callbackStates = [];
  let errorCalls = 0;
  const coordinator = new CaptureSessionCoordinator();

  coordinator.start({
    source: 'frontend',
    createSocket: guard => ({
      open: async () => { throw new Error('open failed'); },
      sendControl: () => {},
      close: () => callbackStates.push(guard.isCurrent()),
    }),
    createCapture: async () => fakeCapture(),
    onReady: () => {},
    onError: () => { errorCalls += 1; },
  });
  await nextTurn();

  assert.deepEqual(callbackStates, [false]);
  assert.equal(errorCalls, 1);
  assert.equal(coordinator.phase, 'idle');
});

test('replacement capture is owned only by an active current session', async () => {
  const { CaptureSessionCoordinator } = await import('../src/audio/capture-session.ts');
  const coordinator = new CaptureSessionCoordinator();
  const ready = deferred();
  const socket = fakeSocket();
  const activeCapture = fakeCapture('active');
  const staleCapture = fakeCapture('stale');

  coordinator.start({
    source: 'backend',
    createSocket: () => socket,
    onReady: ready.resolve,
    onError: error => { throw error; },
  });
  await ready.promise;

  assert.equal(coordinator.replaceCapture(activeCapture), true);
  coordinator.stop();
  assert.equal(activeCapture.stopCalls, 1);
  assert.equal(coordinator.replaceCapture(staleCapture), false);
  assert.equal(staleCapture.stopCalls, 1);
});
