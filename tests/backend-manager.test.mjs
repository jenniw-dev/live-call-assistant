import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BackendManager, buildBackendEnv } from '../electron/backend-manager.js';
import { createQuitCoordinator } from '../electron/quit-coordinator.js';
import { registerRuntimeIpc } from '../electron/runtime-ipc.js';
import { RuntimeSettings } from '../electron/runtime-settings.js';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const realFs = require('node:fs');
const HEALTH_URL = 'http://127.0.0.1:8001/api/health';

function healthyResponse() {
  return {
    ok: true,
    redirected: false,
    status: 200,
    url: HEALTH_URL,
  };
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'aic-backend-'));
  const resourcesPath = join(root, 'App', 'Contents', 'Resources');
  const userDataPath = join(root, 'Library', 'Application Support', 'AIC');
  mkdirSync(join(resourcesPath, 'data', 'faiss_index'), { recursive: true });
  mkdirSync(userDataPath, { recursive: true });
  writeFileSync(join(resourcesPath, 'data', 'faiss_index', 'index.faiss'), 'bundled-v1');
  return {
    resourcesPath,
    root,
    userDataPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function makeChild({ exitOnKill = true } = {}) {
  const child = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    if (exitOnKill) queueMicrotask(() => child.emit('exit', 0, signal));
    return true;
  };
  return child;
}

function makeManager(fixture, overrides = {}) {
  const child = overrides.child || makeChild();
  return {
    child,
    manager: new BackendManager({
      spawn: () => child,
      fetch: async () => healthyResponse(),
      isPortAvailable: async () => true,
      resourcesPath: fixture.resourcesPath,
      userDataPath: fixture.userDataPath,
      healthTimeoutMs: 30,
      healthPollIntervalMs: 1,
      stopTimeoutMs: 10,
      ...overrides,
    }),
  };
}

async function waitUntil(predicate, timeoutMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('test condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('builds a fixed local-only backend environment with absolute packaged paths', () => {
  const env = buildBackendEnv({
    apiKey: 'private-runtime-value',
    thinking: false,
    resourcesPath: '/App/Contents/Resources',
    userDataPath: '/Users/test/Library/Application Support/AIC',
    parentEnv: { PATH: '/usr/bin', LLM_BASE_URL: 'https://untrusted.example' },
  });

  assert.deepEqual(env, {
    PATH: '/usr/bin',
    LLM_BASE_URL: 'https://api.deepseek.com',
    LLM_MODEL: 'deepseek-v4-flash',
    LLM_API_KEY: 'private-runtime-value',
    LLM_ENABLE_THINKING: 'false',
    PREWARM_ENABLED: 'false',
    AUTO_ANSWER: 'false',
    STREAMING_ENGINE: 'local',
    DASHSCOPE_API_KEY: '',
    BACKEND_CAPTURE_ENABLED: 'false',
    BACKEND_HOST: '127.0.0.1',
    BACKEND_PORT: '8001',
    KB_DIR: '/App/Contents/Resources/data/knowledge',
    FAISS_INDEX_PATH: '/Users/test/Library/Application Support/AIC/faiss_index',
    EMBEDDING_MODEL: '/App/Contents/Resources/models/bge-small-en-v1.5',
    ASR_MODEL: '/App/Contents/Resources/models/faster-whisper-small',
  });
});

test('rejects relative resource or user-data paths before constructing the child environment', () => {
  const options = {
    apiKey: 'private-runtime-value',
    thinking: false,
    resourcesPath: 'relative/resources',
    userDataPath: '/absolute/user-data',
  };
  assert.throws(() => buildBackendEnv(options), /absolute/i);
  assert.throws(
    () => buildBackendEnv({ ...options, resourcesPath: '/absolute/resources', userDataPath: 'relative/user-data' }),
    /absolute/i,
  );
});

test('spawns only the packaged backend with empty arguments and puts the key only in its environment', async () => {
  const fixture = makeFixture();
  try {
    const child = makeChild();
    const spawnCalls = [];
    const { manager } = makeManager(fixture, {
      child,
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return child;
      },
    });

    await manager.start({ apiKey: 'private-runtime-value', thinking: true });

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, join(fixture.resourcesPath, 'backend', 'call-assistant-backend'));
    assert.deepEqual(spawnCalls[0].args, []);
    assert.deepEqual(spawnCalls[0].options.stdio, ['ignore', 'ignore', 'ignore']);
    assert.equal(spawnCalls[0].options.env.LLM_API_KEY, 'private-runtime-value');
    assert.equal(spawnCalls[0].options.env.LLM_ENABLE_THINKING, 'true');
    assert.equal(JSON.stringify({ command: spawnCalls[0].command, args: spawnCalls[0].args }),
      JSON.stringify({ command: spawnCalls[0].command, args: [] }));
    await manager.stop();
  } finally {
    fixture.cleanup();
  }
});

test('emits starting and ready states without process or environment details', async () => {
  const fixture = makeFixture();
  try {
    const { manager } = makeManager(fixture);
    const states = [];
    manager.on('status', (state) => states.push(state));

    await manager.start({ apiKey: 'private-runtime-value', thinking: false });

    assert.deepEqual(states, [
      { backendState: 'starting', message: 'Starting the local service…' },
      { backendState: 'ready', message: '' },
    ]);
    assert.deepEqual(manager.getStatus(), { backendState: 'ready', message: '' });
    assert.equal(JSON.stringify(states).includes('private-runtime-value'), false);
    await manager.stop();
  } finally {
    fixture.cleanup();
  }
});

test('refuses an occupied loopback port without spawning, copying, or killing another process', async () => {
  const fixture = makeFixture();
  try {
    let spawnCount = 0;
    const manager = new BackendManager({
      spawn: () => { spawnCount += 1; },
      fetch: async () => ({ ok: false }),
      isPortAvailable: async (port, host) => {
        assert.equal(port, 8001);
        assert.equal(host, '127.0.0.1');
        return false;
      },
      resourcesPath: fixture.resourcesPath,
      userDataPath: fixture.userDataPath,
      healthTimeoutMs: 10,
      healthPollIntervalMs: 1,
      stopTimeoutMs: 5,
    });
    const states = [];
    manager.on('status', (state) => states.push(state));

    await assert.rejects(
      manager.start({ apiKey: 'private-runtime-value', thinking: false }),
      /8001 is used by another program/,
    );

    assert.equal(spawnCount, 0);
    assert.equal(existsSync(join(fixture.userDataPath, 'faiss_index')), false);
    assert.deepEqual(states, [{
      backendState: 'error',
      message: 'Local port 8001 is used by another program. Close it and try again.',
    }]);
  } finally {
    fixture.cleanup();
  }
});

test('copies the bundled FAISS index only when the writable copy is absent', async () => {
  const fixture = makeFixture();
  try {
    const spawnedChildren = [];
    const { manager } = makeManager(fixture, {
      spawn: () => {
        const child = makeChild();
        spawnedChildren.push(child);
        return child;
      },
    });
    const target = join(fixture.userDataPath, 'faiss_index', 'index.faiss');

    await manager.start({ apiKey: 'private-runtime-value', thinking: false });
    assert.equal(readFileSync(target, 'utf8'), 'bundled-v1');
    const publishedTarget = join(fixture.userDataPath, 'faiss_index');
    const relativeVersion = realFs.readlinkSync(publishedTarget);
    assert.equal(realFs.lstatSync(publishedTarget).isSymbolicLink(), true);
    assert.equal(relativeVersion.startsWith('.faiss-index-copy-'), true);
    assert.equal(existsSync(join(fixture.userDataPath, relativeVersion, 'index.faiss')), true);
    await manager.stop();
    writeFileSync(join(fixture.resourcesPath, 'data', 'faiss_index', 'index.faiss'), 'bundled-v2');
    await manager.start({ apiKey: 'private-runtime-value', thinking: false });

    assert.equal(readFileSync(target, 'utf8'), 'bundled-v1');
    await manager.stop();
    assert.deepEqual(spawnedChildren.map((child) => child.killSignals), [['SIGTERM'], ['SIGTERM']]);
  } finally {
    fixture.cleanup();
  }
});

test('cleans an interrupted temporary FAISS copy and retries without poisoning the final target', async () => {
  const fixture = makeFixture();
  try {
    let failCopy = true;
    let spawnCount = 0;
    const fileSystem = {
      ...realFs,
      cpSync: (source, target, options) => {
        if (!failCopy) return realFs.cpSync(source, target, options);
        realFs.mkdirSync(target, { recursive: true });
        realFs.writeFileSync(join(target, 'partial.tmp'), 'incomplete');
        throw new Error('simulated interrupted copy');
      },
    };
    const { manager } = makeManager(fixture, {
      fileSystem,
      spawn: () => {
        spawnCount += 1;
        return makeChild();
      },
    });
    const finalTarget = join(fixture.userDataPath, 'faiss_index');

    await assert.rejects(
      manager.start({ apiKey: 'private-runtime-value', thinking: false }),
      /prepare the local service/,
    );
    assert.equal(existsSync(finalTarget), false);
    assert.deepEqual(
      realFs.readdirSync(fixture.userDataPath).filter((name) => name.startsWith('.faiss-index-copy-')),
      [],
    );
    assert.equal(spawnCount, 0);

    failCopy = false;
    await manager.start({ apiKey: 'private-runtime-value', thinking: false });
    assert.equal(readFileSync(join(finalTarget, 'index.faiss'), 'utf8'), 'bundled-v1');
    assert.equal(spawnCount, 1);
    await manager.stop();
  } finally {
    fixture.cleanup();
  }
});

test('exclusive FAISS publication never replaces a target created at the publication boundary', async () => {
  const fixture = makeFixture();
  try {
    let publicationCalls = 0;
    const createRacingTarget = (target) => {
      publicationCalls += 1;
      realFs.mkdirSync(target);
      realFs.writeFileSync(join(target, 'owner.sentinel'), 'other-process');
    };
    const fileSystem = {
      ...realFs,
      renameSync: (source, target) => {
        createRacingTarget(target);
        return realFs.renameSync(source, target);
      },
      symlinkSync: (source, target, type) => {
        createRacingTarget(target);
        return realFs.symlinkSync(source, target, type);
      },
    };
    const { manager } = makeManager(fixture, { fileSystem });
    const finalTarget = join(fixture.userDataPath, 'faiss_index');

    await manager.start({ apiKey: 'private-runtime-value', thinking: false });

    assert.equal(publicationCalls, 1);
    assert.equal(realFs.lstatSync(finalTarget).isDirectory(), true);
    assert.equal(readFileSync(join(finalTarget, 'owner.sentinel'), 'utf8'), 'other-process');
    assert.equal(existsSync(join(finalTarget, 'index.faiss')), false);
    assert.deepEqual(
      realFs.readdirSync(fixture.userDataPath).filter((name) => name.startsWith('.faiss-index-copy-')),
      [],
    );
    await manager.stop();
  } finally {
    fixture.cleanup();
  }
});

test('existing broken FAISS symlink is never followed, deleted, or replaced', async () => {
  const fixture = makeFixture();
  try {
    const finalTarget = join(fixture.userDataPath, 'faiss_index');
    realFs.symlinkSync('missing-owned-elsewhere', finalTarget, 'dir');
    const { manager } = makeManager(fixture);

    await manager.start({ apiKey: 'private-runtime-value', thinking: false });

    assert.equal(realFs.lstatSync(finalTarget).isSymbolicLink(), true);
    assert.equal(realFs.readlinkSync(finalTarget), 'missing-owned-elsewhere');
    assert.deepEqual(
      realFs.readdirSync(fixture.userDataPath).filter((name) => name.startsWith('.faiss-index-copy-')),
      [],
    );
    await manager.stop();
  } finally {
    fixture.cleanup();
  }
});

test('reports a safe spawn failure and does not retain a child', async () => {
  const fixture = makeFixture();
  try {
    const { manager } = makeManager(fixture, {
      spawn: () => { throw new Error('native spawn detail private-runtime-value'); },
    });
    const states = [];
    manager.on('status', (state) => states.push(state));

    await assert.rejects(
      manager.start({ apiKey: 'private-runtime-value', thinking: false }),
      (error) => /start the local service/.test(error.message)
        && !error.message.includes('native spawn detail'),
    );

    assert.deepEqual(manager.getStatus(), {
      backendState: 'error',
      message: 'Couldn’t start the local service. Please restart the app.',
    });
    assert.equal(JSON.stringify(states).includes('private-runtime-value'), false);
    await manager.stop();
  } finally {
    fixture.cleanup();
  }
});

test('reports a safe error when the child exits before health readiness', async () => {
  const fixture = makeFixture();
  try {
    const child = makeChild();
    const { manager } = makeManager(fixture, {
      child,
      spawn: () => {
        queueMicrotask(() => child.emit('exit', 23, null));
        return child;
      },
      fetch: async () => ({ ok: false }),
    });
    const states = [];
    manager.on('status', (state) => states.push(state));

    await assert.rejects(
      manager.start({ apiKey: 'private-runtime-value', thinking: false }),
      /stopped before it finished starting/,
    );

    assert.equal(states.some(({ backendState }) => backendState === 'ready'), false);
    assert.equal(JSON.stringify(states).includes('23'), false);
    assert.equal(JSON.stringify(states).includes('private-runtime-value'), false);
  } finally {
    fixture.cleanup();
  }
});

test('translates a post-readiness child error without losing shutdown ownership', async () => {
  const fixture = makeFixture();
  try {
    const child = makeChild();
    const { manager } = makeManager(fixture, { child });
    await manager.start({ apiKey: 'private-runtime-value', thinking: false });

    child.emit('error', new Error('native child detail private-runtime-value'));

    assert.deepEqual(manager.getStatus(), {
      backendState: 'error',
      message: 'The local service stopped unexpectedly. Please restart the app.',
    });
    assert.equal(JSON.stringify(manager.getStatus()).includes('private-runtime-value'), false);
    await manager.stop();
    assert.deepEqual(child.killSignals, ['SIGTERM']);
    assert.equal(child.listenerCount('error'), 0);
  } finally {
    fixture.cleanup();
  }
});

test('times out health polling, terminates its child, and exposes only a safe error', async () => {
  const fixture = makeFixture();
  try {
    const child = makeChild();
    const { manager } = makeManager(fixture, {
      child,
      fetch: async () => { throw new Error('health detail private-runtime-value'); },
      healthTimeoutMs: 8,
    });
    const states = [];
    manager.on('status', (state) => states.push(state));

    await assert.rejects(
      manager.start({ apiKey: 'private-runtime-value', thinking: false }),
      (error) => /took too long to start/.test(error.message) && !error.message.includes('health detail'),
    );

    assert.deepEqual(child.killSignals, ['SIGTERM']);
    assert.equal(JSON.stringify(states).includes('private-runtime-value'), false);
    assert.deepEqual(manager.getStatus(), {
      backendState: 'error',
      message: 'The local service took too long to start. Please restart the app.',
    });
  } finally {
    fixture.cleanup();
  }
});

test('health timeout still applies when an individual health request never settles', async () => {
  const fixture = makeFixture();
  try {
    const child = makeChild();
    const { manager } = makeManager(fixture, {
      child,
      fetch: async () => new Promise(() => {}),
      healthTimeoutMs: 8,
    });

    await assert.rejects(
      manager.start({ apiKey: 'private-runtime-value', thinking: false }),
      /took too long to start/,
    );
    assert.deepEqual(child.killSignals, ['SIGTERM']);
  } finally {
    fixture.cleanup();
  }
});

test('health readiness denies redirects away from the intended loopback URL', async () => {
  const fixture = makeFixture();
  try {
    const child = makeChild();
    const fetchCalls = [];
    const { manager } = makeManager(fixture, {
      child,
      fetch: async (url, options) => {
        fetchCalls.push({ url, options });
        return {
          ok: true,
          redirected: true,
          status: 200,
          url: 'https://redirected.example/api/health',
        };
      },
      healthTimeoutMs: 8,
    });

    await assert.rejects(
      manager.start({ apiKey: 'private-runtime-value', thinking: false }),
      /took too long to start/,
    );

    assert.ok(fetchCalls.length > 0);
    assert.equal(fetchCalls.every(({ url }) => url === HEALTH_URL), true);
    assert.equal(fetchCalls.every(({ options }) => options.redirect === 'manual'), true);
    assert.deepEqual(child.killSignals, ['SIGTERM']);
    assert.equal(manager.getStatus().backendState, 'error');
  } finally {
    fixture.cleanup();
  }
});

test('stop cancels a pending port check without spawning or emitting a late ready state', async () => {
  const fixture = makeFixture();
  try {
    let spawnCount = 0;
    const { manager } = makeManager(fixture, {
      spawn: () => { spawnCount += 1; },
      isPortAvailable: async () => new Promise(() => {}),
    });
    const states = [];
    manager.on('status', (state) => states.push(state));
    const starting = manager.start({ apiKey: 'private-runtime-value', thinking: false });
    await new Promise((resolve) => setImmediate(resolve));

    await manager.stop();

    await assert.rejects(
      Promise.race([
        starting,
        new Promise((_, reject) => setTimeout(() => reject(new Error('test deadline')), 20)),
      ]),
      (error) => /startup was cancelled/.test(error.message) && !error.message.includes('test deadline'),
    );
    assert.equal(spawnCount, 0);
    assert.equal(states.some(({ backendState }) => backendState === 'ready'), false);
  } finally {
    fixture.cleanup();
  }
});

test('stop is idempotent, sends SIGTERM only to the stored child, and removes wait listeners', async () => {
  const fixture = makeFixture();
  try {
    const child = makeChild();
    const unrelated = makeChild();
    const { manager } = makeManager(fixture, { child });
    await manager.start({ apiKey: 'private-runtime-value', thinking: false });

    await Promise.all([manager.stop(), manager.stop()]);

    assert.deepEqual(child.killSignals, ['SIGTERM']);
    assert.deepEqual(unrelated.killSignals, []);
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('error'), 0);
    assert.deepEqual(manager.getStatus(), { backendState: 'stopped', message: '' });
  } finally {
    fixture.cleanup();
  }
});

test('concurrent stops wait for the same owned child exit and signal it only once', async () => {
  const fixture = makeFixture();
  try {
    const child = makeChild({ exitOnKill: false });
    const { manager } = makeManager(fixture, { child, stopTimeoutMs: 30 });
    await manager.start({ apiKey: 'private-runtime-value', thinking: false });

    let firstSettled = false;
    let secondSettled = false;
    const first = manager.stop().then(() => { firstSettled = true; });
    const second = manager.stop().then(() => { secondSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(child.killSignals, ['SIGTERM']);
    assert.equal(firstSettled, false);
    assert.equal(secondSettled, false);

    child.emit('exit', 0, 'SIGTERM');
    await Promise.all([first, second]);
    assert.deepEqual(manager.getStatus(), { backendState: 'stopped', message: '' });
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('error'), 0);
  } finally {
    fixture.cleanup();
  }
});

test('stop timeout retains live-child ownership and blocks replacement spawn', async () => {
  const fixture = makeFixture();
  const child = makeChild({ exitOnKill: false });
  try {
    let spawnCount = 0;
    const { manager } = makeManager(fixture, {
      child,
      spawn: () => {
        spawnCount += 1;
        return spawnCount === 1 ? child : makeChild();
      },
      stopTimeoutMs: 5,
    });
    await manager.start({ apiKey: 'private-runtime-value', thinking: false });

    await assert.rejects(manager.stop(), /confirm the local service stopped/);
    assert.deepEqual(child.killSignals, ['SIGTERM']);
    assert.deepEqual(manager.getStatus(), {
      backendState: 'error',
      message: 'Couldn’t confirm the local service stopped. Please restart the app.',
    });

    await assert.rejects(
      manager.start({ apiKey: 'private-runtime-value', thinking: true }),
      /confirm the local service stopped/,
    );
    assert.equal(spawnCount, 1);
    assert.deepEqual(child.killSignals, ['SIGTERM']);
  } finally {
    child.emit('exit', 0, 'SIGTERM');
    fixture.cleanup();
  }
});

test('quit-only shutdown escalates an owned hung child from SIGTERM to SIGKILL and waits for exit', async () => {
  const fixture = makeFixture();
  const child = makeChild({ exitOnKill: false });
  try {
    const { manager } = makeManager(fixture, {
      child,
      stopTimeoutMs: 5,
      forceStopTimeoutMs: 50,
    });
    await manager.start({ apiKey: 'private-runtime-value', thinking: false });

    let settled = false;
    const quitting = manager.stopForQuit().then(() => { settled = true; });
    await waitUntil(() => child.killSignals.includes('SIGKILL'));

    assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
    assert.equal(settled, false);
    assert.equal(manager.child, child);

    child.emit('exit', null, 'SIGKILL');
    await quitting;

    assert.equal(settled, true);
    assert.equal(manager.child, null);
    assert.deepEqual(manager.getStatus(), { backendState: 'stopped', message: '' });
  } finally {
    child.emit('exit', null, 'SIGKILL');
    fixture.cleanup();
  }
});

test('concurrent quit-only shutdown calls share one escalation and signal sequence', async () => {
  const fixture = makeFixture();
  const child = makeChild({ exitOnKill: false });
  try {
    const { manager } = makeManager(fixture, {
      child,
      stopTimeoutMs: 5,
      forceStopTimeoutMs: 50,
    });
    await manager.start({ apiKey: 'private-runtime-value', thinking: false });

    const first = manager.stopForQuit();
    const second = manager.stopForQuit();
    await waitUntil(() => child.killSignals.includes('SIGKILL'));

    assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
    child.emit('exit', null, 'SIGKILL');
    await Promise.all([first, second]);
    assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
  } finally {
    child.emit('exit', null, 'SIGKILL');
    fixture.cleanup();
  }
});

test('quit-only force-kill failure keeps ownership and reports only a safe error', async () => {
  const fixture = makeFixture();
  const child = makeChild({ exitOnKill: false });
  child.kill = (signal) => {
    child.killSignals.push(signal);
    return signal !== 'SIGKILL';
  };
  try {
    const { manager } = makeManager(fixture, {
      child,
      stopTimeoutMs: 5,
      forceStopTimeoutMs: 20,
    });
    await manager.start({ apiKey: 'private-runtime-value', thinking: false });

    await assert.rejects(
      manager.stopForQuit(),
      (error) => error.code === 'force-stop-failed'
        && error.message === 'Couldn’t stop the local service safely. The app stays open; please try again shortly.',
    );

    assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
    assert.equal(manager.child, child);
    assert.deepEqual(manager.getStatus(), {
      backendState: 'error',
      message: 'Couldn’t stop the local service safely. The app stays open; please try again shortly.',
    });
  } finally {
    child.emit('exit', null, 'SIGKILL');
    fixture.cleanup();
  }
});

test('shutdown keeps an error listener until an asynchronous kill error and exit settle', async () => {
  const fixture = makeFixture();
  try {
    const child = makeChild({ exitOnKill: false });
    child.kill = (signal) => {
      child.killSignals.push(signal);
      queueMicrotask(() => {
        child.emit('error', new Error('asynchronous native kill detail private-runtime-value'));
        child.emit('exit', 0, signal);
      });
      return true;
    };
    const { manager } = makeManager(fixture, { child });
    await manager.start({ apiKey: 'private-runtime-value', thinking: false });

    await manager.stop();

    assert.deepEqual(child.killSignals, ['SIGTERM']);
    assert.deepEqual(manager.getStatus(), { backendState: 'stopped', message: '' });
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('exit'), 0);
  } finally {
    fixture.cleanup();
  }
});

test('runtime settings persist only a boolean with restrictive directory and file permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'aic-runtime-'));
  const userDataPath = join(root, 'user-data');
  try {
    mkdirSync(userDataPath, { mode: 0o777 });
    chmodSync(userDataPath, 0o777);
    const settings = new RuntimeSettings({ userDataPath });
    assert.equal(settings.getThinking(), false);

    writeFileSync(join(userDataPath, 'runtime-settings.json'), JSON.stringify({
      thinkingEnabled: false,
      apiKey: 'must-be-removed',
      endpoint: 'https://must-be-removed.example',
    }), { mode: 0o666 });
    chmodSync(join(userDataPath, 'runtime-settings.json'), 0o666);
    settings.setThinking(true);

    const file = join(userDataPath, 'runtime-settings.json');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { thinkingEnabled: true });
    assert.equal(settings.getThinking(), true);
    assert.equal(statSync(userDataPath).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quit coordinator prevents early quit, shares shutdown, and permits exactly one final exit', async () => {
  let finishStop;
  const stopGate = new Promise((resolve) => { finishStop = resolve; });
  const backend = {
    quitStopCount: 0,
    stopForQuit() {
      this.quitStopCount += 1;
      return stopGate;
    },
  };
  const app = {
    exitCodes: [],
    exit(code) { this.exitCodes.push(code); },
  };
  let disposeCount = 0;
  const onWillQuit = createQuitCoordinator({
    app,
    backend,
    dispose: () => { disposeCount += 1; },
  });
  const firstEvent = { prevented: 0, preventDefault() { this.prevented += 1; } };
  const secondEvent = { prevented: 0, preventDefault() { this.prevented += 1; } };

  const firstQuit = onWillQuit(firstEvent);
  const secondQuit = onWillQuit(secondEvent);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(firstEvent.prevented, 1);
  assert.equal(secondEvent.prevented, 1);
  assert.equal(backend.quitStopCount, 1);
  assert.deepEqual(app.exitCodes, []);

  finishStop();
  await Promise.all([firstQuit, secondQuit]);
  assert.equal(disposeCount, 1);
  assert.deepEqual(app.exitCodes, [0]);

  const finalEvent = { prevented: 0, preventDefault() { this.prevented += 1; } };
  await onWillQuit(finalEvent);
  assert.equal(finalEvent.prevented, 0);
  assert.deepEqual(app.exitCodes, [0]);
});

test('quit coordinator keeps the app alive when owned-child force shutdown cannot settle', async () => {
  const backend = {
    stopForQuit: async () => {
      const error = new Error('private native process detail');
      error.code = 'force-stop-failed';
      throw error;
    },
  };
  const app = {
    exitCodes: [],
    exit(code) { this.exitCodes.push(code); },
  };
  let disposeCount = 0;
  const onWillQuit = createQuitCoordinator({
    app,
    backend,
    dispose: () => { disposeCount += 1; },
  });
  const event = { prevented: 0, preventDefault() { this.prevented += 1; } };

  await onWillQuit(event);

  assert.equal(event.prevented, 1);
  assert.equal(disposeCount, 0);
  assert.deepEqual(app.exitCodes, []);
});

function makeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    listeners,
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, listener) => listeners.set(channel, listener),
    removeHandler: (channel) => handlers.delete(channel),
    removeListener: (channel) => listeners.delete(channel),
  };
}

test('runtime IPC owns credential-driven lifecycle and returns only renderer-safe state', async () => {
  const ipcMain = makeIpcMain();
  const secret = randomBytes(24).toString('base64url');
  let storedKey = '';
  let thinking = false;
  const keyStore = {
    has: () => storedKey !== '',
    save: (value) => { storedKey = value; },
    clear: () => { storedKey = ''; },
    readForBackend: () => storedKey,
  };
  const runtimeSettings = {
    getThinking: () => thinking,
    setThinking: (enabled) => { thinking = Boolean(enabled); },
  };
  const backend = new EventEmitter();
  backend.starts = [];
  backend.stopCount = 0;
  backend.status = { backendState: 'stopped', message: '' };
  backend.getStatus = () => ({ ...backend.status });
  backend.start = async (options) => {
    backend.starts.push(options);
    backend.status = { backendState: 'ready', message: '' };
    backend.emit('status', backend.status);
  };
  backend.stop = async () => {
    backend.stopCount += 1;
    backend.status = { backendState: 'stopped', message: '' };
    backend.emit('status', backend.status);
  };
  const broadcasts = [];
  const app = {
    relaunchCount: 0,
    exits: [],
    relaunch() { this.relaunchCount += 1; },
    exit(code) { this.exits.push(code); },
  };
  const controller = registerRuntimeIpc({
    ipcMain,
    app,
    keyStore,
    runtimeSettings,
    backend,
    broadcastStatus: (state) => broadcasts.push(state),
  });

  assert.deepEqual([...ipcMain.handlers.keys()].sort(), [
    'credentials:clear',
    'credentials:has',
    'credentials:save',
    'runtime:set-thinking',
    'runtime:status',
  ]);
  assert.deepEqual([...ipcMain.listeners.keys()], ['runtime:relaunch']);
  assert.deepEqual(await ipcMain.handlers.get('runtime:status')(), {
    hasCredential: false,
    thinkingEnabled: false,
    backendState: 'stopped',
    message: '',
  });
  assert.equal(await controller.startIfConfigured(), false);

  await ipcMain.handlers.get('credentials:save')(null, secret);
  assert.deepEqual(backend.starts, [{ apiKey: secret, thinking: false }]);
  assert.equal(JSON.stringify(await ipcMain.handlers.get('runtime:status')()).includes(secret), false);

  const changed = await ipcMain.handlers.get('runtime:set-thinking')(null, 1);
  assert.equal(thinking, true);
  assert.deepEqual(backend.starts.at(-1), { apiKey: secret, thinking: true });
  assert.equal(JSON.stringify(changed).includes(secret), false);

  backend.emit('status', {
    backendState: 'error',
    message: '可安全顯示的錯誤',
    child: { pid: 123 },
    env: { LLM_API_KEY: secret },
  });
  assert.deepEqual(broadcasts.at(-1), {
    hasCredential: true,
    thinkingEnabled: true,
    backendState: 'error',
    message: '可安全顯示的錯誤',
  });
  assert.equal(JSON.stringify(broadcasts).includes(secret), false);

  await ipcMain.handlers.get('credentials:clear')();
  assert.equal(storedKey, '');
  assert.equal(backend.stopCount, 1);

  storedKey = secret;
  const relaunch = ipcMain.listeners.get('runtime:relaunch');
  await relaunch();
  assert.equal(backend.stopCount, 2);
  assert.equal(app.relaunchCount, 1);
  assert.deepEqual(app.exits, [0]);
  controller.dispose();
  assert.equal(backend.listenerCount('status'), 0);
});

test('credential clear publishes missing-key state before backend shutdown settles', async () => {
  const ipcMain = makeIpcMain();
  let storedKey = 'sk-private';
  let finishStop;
  let stopStarted = false;
  const keyStore = {
    has: () => storedKey !== '',
    save: (value) => { storedKey = value; },
    clear: () => { storedKey = ''; },
    readForBackend: () => storedKey,
  };
  const runtimeSettings = {
    getThinking: () => false,
    setThinking() {},
  };
  const backend = new EventEmitter();
  backend.getStatus = () => ({ backendState: 'ready', message: '' });
  backend.start = async () => {};
  backend.stop = () => {
    stopStarted = true;
    return new Promise((resolve) => { finishStop = resolve; });
  };
  const broadcasts = [];
  const controller = registerRuntimeIpc({
    ipcMain,
    app: { relaunch() {}, exit() {} },
    keyStore,
    runtimeSettings,
    backend,
    broadcastStatus: (state) => broadcasts.push(state),
  });

  let clearSettled = false;
  const clearPromise = ipcMain.handlers.get('credentials:clear')()
    .then(() => { clearSettled = true; });
  await Promise.resolve();

  assert.equal(storedKey, '');
  assert.equal(stopStarted, true);
  assert.equal(clearSettled, false);
  assert.deepEqual(broadcasts.at(-1), {
    hasCredential: false,
    thinkingEnabled: false,
    backendState: 'ready',
    message: '',
  });

  finishStop();
  await clearPromise;
  controller.dispose();
});

test('credential clear failure keeps the configured-key state and does not stop backend', async () => {
  const ipcMain = makeIpcMain();
  let stopCount = 0;
  const backend = new EventEmitter();
  backend.getStatus = () => ({ backendState: 'ready', message: '' });
  backend.start = async () => {};
  backend.stop = async () => { stopCount += 1; };
  const broadcasts = [];
  const controller = registerRuntimeIpc({
    ipcMain,
    app: { relaunch() {}, exit() {} },
    keyStore: {
      has: () => true,
      save() {},
      clear() { throw new Error('keychain unavailable'); },
      readForBackend: () => 'sk-private',
    },
    runtimeSettings: {
      getThinking: () => false,
      setThinking() {},
    },
    backend,
    broadcastStatus: (state) => broadcasts.push(state),
  });

  await assert.rejects(
    ipcMain.handlers.get('credentials:clear')(),
    /keychain unavailable/,
  );
  assert.equal(stopCount, 0);
  assert.deepEqual(broadcasts, []);
  controller.dispose();
});

test('preload runtime bridge exposes status, thinking, relaunch, and removable status subscription only', async () => {
  const calls = [];
  const channelListeners = new Map();
  let rendererApi;
  const originalLoad = Module._load;
  const preloadPath = require.resolve('../electron/preload.js');

  Module._load = (request, parent, isMain) => {
    if (request === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (_name, value) => { rendererApi = value; } },
        ipcRenderer: {
          invoke: (...args) => { calls.push(['invoke', ...args]); return Promise.resolve({}); },
          on: (channel, listener) => channelListeners.set(channel, listener),
          removeListener: (channel, listener) => {
            if (channelListeners.get(channel) === listener) channelListeners.delete(channel);
          },
          send: (...args) => calls.push(['send', ...args]),
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

  assert.deepEqual(Object.keys(rendererApi.runtime).sort(), ['onStatus', 'relaunch', 'setThinking', 'status']);
  await rendererApi.runtime.status();
  await rendererApi.runtime.setThinking(true);
  rendererApi.runtime.relaunch();
  const received = [];
  const unsubscribe = rendererApi.runtime.onStatus((state) => received.push(state));
  channelListeners.get('runtime:status-changed')({}, { backendState: 'ready', message: '' });
  unsubscribe();

  assert.deepEqual(calls, [
    ['invoke', 'runtime:status'],
    ['invoke', 'runtime:set-thinking', true],
    ['send', 'runtime:relaunch'],
  ]);
  assert.deepEqual(received, [{ backendState: 'ready', message: '' }]);
  assert.equal(channelListeners.has('runtime:status-changed'), false);
});
