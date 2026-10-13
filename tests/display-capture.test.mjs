import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');

test('uses the native picker on macOS without asking for a loopback source', async () => {
  const { configureDisplayCapture } = await import('../electron/display-capture.js');
  const registrations = [];
  const defaultSession = {
    setDisplayMediaRequestHandler: (handler, options) => registrations.push({ handler, options }),
  };
  const desktopCapturer = {
    getSources: () => { throw new Error('macOS must not ask Electron for Windows loopback sources'); },
  };

  configureDisplayCapture({
    session: { defaultSession },
    desktopCapturer,
    platform: 'darwin',
  });

  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0].options, { useSystemPicker: true });

  const grants = [];
  registrations[0].handler({}, streams => grants.push(streams));
  assert.deepEqual(grants, [{}]);
});

test('uses Electron loopback only on non-macOS platforms', async () => {
  const { configureDisplayCapture } = await import('../electron/display-capture.js');
  const source = { id: 'screen:1', name: 'Primary screen' };
  const sourceRequests = [];
  let handler;
  const defaultSession = {
    setDisplayMediaRequestHandler: registered => { handler = registered; },
  };

  configureDisplayCapture({
    session: { defaultSession },
    desktopCapturer: {
      getSources: async options => {
        sourceRequests.push(options);
        return [source];
      },
    },
    platform: 'win32',
  });

  const grants = [];
  await handler({}, streams => grants.push(streams));
  assert.deepEqual(sourceRequests, [{ types: ['screen'] }]);
  assert.deepEqual(grants, [{ video: source, audio: 'loopback' }]);
});

test('denies a failed non-macOS source lookup exactly once without exposing its error', async () => {
  const { configureDisplayCapture } = await import('../electron/display-capture.js');
  let handler;
  const defaultSession = {
    setDisplayMediaRequestHandler: registered => { handler = registered; },
  };

  configureDisplayCapture({
    session: { defaultSession },
    desktopCapturer: {
      getSources: async () => { throw new Error('native-source-secret-detail'); },
    },
    platform: 'win32',
  });

  const grants = [];
  await handler({}, streams => grants.push(streams));
  assert.deepEqual(grants, [{}]);
});

test('registers only once for the same Electron session', async () => {
  const { configureDisplayCapture } = await import('../electron/display-capture.js');
  let registrations = 0;
  const defaultSession = {
    setDisplayMediaRequestHandler: () => { registrations += 1; },
  };
  const dependencies = {
    session: { defaultSession },
    desktopCapturer: { getSources: async () => [] },
    platform: 'darwin',
  };

  configureDisplayCapture(dependencies);
  configureDisplayCapture(dependencies);

  assert.equal(registrations, 1);
});

test('a native registration failure does not poison a later retry', async () => {
  const { configureDisplayCapture } = await import('../electron/display-capture.js');
  let attempts = 0;
  const defaultSession = {
    setDisplayMediaRequestHandler: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('native registration detail');
    },
  };
  const dependencies = {
    session: { defaultSession },
    desktopCapturer: {},
    platform: 'darwin',
  };

  assert.throws(() => configureDisplayCapture(dependencies), /native registration detail/);
  assert.doesNotThrow(() => configureDisplayCapture(dependencies));
  assert.equal(attempts, 2);
});

test('main process waits for Electron readiness before registering the macOS picker', async () => {
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const registrations = [];
  const appListeners = new Map();
  const fakeApp = {
    whenReady: () => ready,
    on: (event, listener) => appListeners.set(event, listener),
    getPath: () => '/private/tmp/aic-display-test',
    quit: () => {},
  };
  class FakeWindow {
    static getAllWindows() { return []; }
    webContents = {
      send: () => {},
      setWindowOpenHandler: () => {},
      on: () => {},
    };
    on() {}
    setAlwaysOnTop() {}
    loadFile() {}
    isDestroyed() { return false; }
  }
  const originalLoad = Module._load;
  const mainPath = require.resolve('../electron/main.js');
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = '/private/tmp/aic-display-resources';

  Module._load = (request, parent, isMain) => {
    if (request === 'electron') {
      return {
        app: fakeApp,
        BrowserWindow: FakeWindow,
        desktopCapturer: { getSources: async () => [] },
        globalShortcut: { register: () => {}, unregisterAll: () => {} },
        ipcMain: { on: () => {} },
        safeStorage: {},
        shell: { openExternal: async () => {} },
        session: {
          defaultSession: {
            setDisplayMediaRequestHandler: (handler, options) => registrations.push({ handler, options }),
          },
        },
      };
    }
    if (request === './backend-manager') {
      return { BackendManager: class {} };
    }
    if (request === './key-store') {
      return { KeyStore: class {} };
    }
    if (request === './quit-coordinator') {
      return { createQuitCoordinator: () => () => {} };
    }
    if (request === './runtime-ipc') {
      return { registerRuntimeIpc: () => ({ startIfConfigured: async () => {}, dispose: () => {} }) };
    }
    if (request === './runtime-settings') {
      return { RuntimeSettings: class {} };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[mainPath];
    require(mainPath);
    assert.equal(registrations.length, 0);
    resolveReady();
    await ready;
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    Module._load = originalLoad;
    delete require.cache[mainPath];
    if (originalResourcesPath === undefined) delete process.resourcesPath;
    else process.resourcesPath = originalResourcesPath;
  }

  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0].options, { useSystemPicker: true });
});

test('preload exposes the immutable runtime platform for frontend capture routing', () => {
  let rendererApi;
  const originalLoad = Module._load;
  const preloadPath = require.resolve('../electron/preload.js');

  Module._load = (request, parent, isMain) => {
    if (request === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (_name, value) => { rendererApi = value; } },
        ipcRenderer: {
          invoke: () => Promise.resolve(),
          on: () => {},
          removeListener: () => {},
          send: () => {},
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
  }

  assert.equal(rendererApi.platform, process.platform);
});

test('package declares exact macOS audio permissions and arm64 directory packaging', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(pkg.devDependencies.electron, '44.2.0');
  assert.equal(pkg.devDependencies['electron-builder'], '26.15.3');
  assert.equal(pkg.build.mac.identity, null);
  assert.deepEqual(pkg.build.mac.target, [{ target: 'dir', arch: ['arm64'] }]);
  assert.match(pkg.build.mac.extendInfo.NSAudioCaptureUsageDescription, /system audio/);
  assert.match(pkg.build.mac.extendInfo.NSScreenCaptureUsageDescription, /video track is stopped immediately/);
  assert.equal(pkg.scripts.electron, 'electron .');
  assert.equal(pkg.scripts['electron-dev'], 'VITE_DEV_SERVER_URL=http://localhost:5173 electron .');
  assert.equal(pkg.scripts['build-frontend'], 'npm run build --prefix frontend');
  assert.equal(pkg.scripts['dist:mac'], 'bash scripts/build-mac-app.sh');
  assert.equal(Object.hasOwn(pkg.scripts, 'dist'), false);
  assert.equal(Object.hasOwn(pkg.scripts, 'postinstall'), false);
  assert.equal('win' in pkg.build, false);
  assert.equal('nsis' in pkg.build, false);
});
