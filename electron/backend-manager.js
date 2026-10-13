const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = 8001;
const HEALTH_URL = `http://${HOST}:${PORT}/api/health`;

const MESSAGES = {
  cancelled: 'Local service startup was cancelled.',
  earlyExit: 'The local service stopped before it finished starting. Please restart the app.',
  portInUse: 'Local port 8001 is used by another program. Close it and try again.',
  spawn: 'Couldn’t start the local service. Please restart the app.',
  stopped: 'The local service stopped unexpectedly. Please restart the app.',
  forceStopFailed: 'Couldn’t stop the local service safely. The app stays open; please try again shortly.',
  stopTimeout: 'Couldn’t confirm the local service stopped. Please restart the app.',
  timeout: 'The local service took too long to start. Please restart the app.',
  unavailable: 'Couldn’t prepare the local service. Please restart the app.',
};

class LifecycleError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function assertAbsolutePath(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
}

function buildBackendEnv({
  apiKey,
  thinking,
  resourcesPath,
  userDataPath,
  parentEnv = process.env,
}) {
  assertAbsolutePath(resourcesPath, 'resourcesPath');
  assertAbsolutePath(userDataPath, 'userDataPath');
  const dataRoot = path.join(resourcesPath, 'data');
  const modelRoot = path.join(resourcesPath, 'models');
  return {
    ...parentEnv,
    LLM_BASE_URL: 'https://api.deepseek.com',
    LLM_MODEL: 'deepseek-v4-flash',
    LLM_API_KEY: apiKey,
    LLM_ENABLE_THINKING: String(Boolean(thinking)),
    PREWARM_ENABLED: 'false',
    AUTO_ANSWER: 'false',
    STREAMING_ENGINE: 'local',
    DASHSCOPE_API_KEY: '',
    BACKEND_CAPTURE_ENABLED: 'false',
    BACKEND_HOST: HOST,
    BACKEND_PORT: String(PORT),
    KB_DIR: path.join(dataRoot, 'knowledge'),
    FAISS_INDEX_PATH: path.join(userDataPath, 'faiss_index'),
    EMBEDDING_MODEL: path.join(modelRoot, 'bge-small-en-v1.5'),
    ASR_MODEL: path.join(modelRoot, 'faster-whisper-small'),
  };
}

function defaultIsPortAvailable(port = PORT, host = HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (available) => {
      server.removeAllListeners();
      resolve(available);
    };
    server.once('error', () => finish(false));
    server.once('listening', () => server.close(() => finish(true)));
    server.listen(port, host);
  });
}

function pathEntryExists(fileSystem, entryPath) {
  try {
    fileSystem.lstatSync(entryPath);
    return true;
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

function copyInitialIndexIfMissing(resourcesPath, userDataPath, fileSystem = fs) {
  const source = path.join(resourcesPath, 'data', 'faiss_index');
  const target = path.join(userDataPath, 'faiss_index');
  if (pathEntryExists(fileSystem, target)) return;
  fileSystem.mkdirSync(userDataPath, { recursive: true });
  const temporaryRoot = fileSystem.mkdtempSync(path.join(userDataPath, '.faiss-index-copy-'));
  const stagedTarget = path.join(temporaryRoot, 'faiss_index');
  let published = false;
  try {
    fileSystem.cpSync(source, stagedTarget, { recursive: true });
    try {
      const relativeStagedTarget = path.relative(userDataPath, stagedTarget);
      fileSystem.symlinkSync(relativeStagedTarget, target, 'dir');
      published = true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
  } finally {
    if (!published) fileSystem.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createStartup() {
  let notifyCancelled;
  const cancelledSignal = new Promise((resolve) => { notifyCancelled = resolve; });
  return {
    isCancelled: false,
    cancelledSignal,
    cancel() {
      if (this.isCancelled) return;
      this.isCancelled = true;
      notifyCancelled();
    },
  };
}

function rejectWhenCancelled(startup) {
  return startup.cancelledSignal.then(() => {
    throw new LifecycleError(MESSAGES.cancelled, 'cancelled');
  });
}

async function waitForHealth(fetchImpl, timeoutMs, pollIntervalMs, startup) {
  const abortController = new AbortController();
  let timeout;
  const timedOut = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      abortController.abort();
      reject(new LifecycleError(MESSAGES.timeout, 'timeout'));
    }, timeoutMs);
  });
  const poll = async () => {
    while (!startup.isCancelled && !abortController.signal.aborted) {
      try {
        const response = await fetchImpl(HEALTH_URL, {
          redirect: 'manual',
          signal: abortController.signal,
        });
        if (
          response
          && response.ok
          && response.redirected === false
          && response.url === HEALTH_URL
        ) return;
      } catch {
        // The bundled models may still be loading. Provider details stay private.
      }
      if (!startup.isCancelled && !abortController.signal.aborted) await delay(pollIntervalMs);
    }
  };
  try {
    await Promise.race([poll(), timedOut, rejectWhenCancelled(startup)]);
  } finally {
    clearTimeout(timeout);
    abortController.abort();
  }
}

class BackendManager extends EventEmitter {
  constructor({
    spawn,
    fetch,
    isPortAvailable = defaultIsPortAvailable,
    resourcesPath,
    userDataPath,
    healthTimeoutMs = 120_000,
    healthPollIntervalMs = 250,
    stopTimeoutMs = 3_000,
    forceStopTimeoutMs = 3_000,
    fileSystem = fs,
  }) {
    super();
    assertAbsolutePath(resourcesPath, 'resourcesPath');
    assertAbsolutePath(userDataPath, 'userDataPath');
    this.spawn = spawn;
    this.fetch = fetch;
    this.isPortAvailable = isPortAvailable;
    this.resourcesPath = resourcesPath;
    this.userDataPath = userDataPath;
    this.healthTimeoutMs = healthTimeoutMs;
    this.healthPollIntervalMs = healthPollIntervalMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.forceStopTimeoutMs = forceStopTimeoutMs;
    this.fileSystem = fileSystem;
    this.child = null;
    this.childListeners = new Map();
    this.stopOperation = null;
    this.quitStopOperation = null;
    this.startup = null;
    this.status = { backendState: 'stopped', message: '' };
  }

  getStatus() {
    return { ...this.status };
  }

  emitStatus(backendState, message = '') {
    this.status = { backendState, message };
    this.emit('status', this.getStatus());
  }

  async start({ apiKey, thinking }) {
    if (this.startup) this.startup.cancel();
    const startup = createStartup();
    this.startup = startup;
    let startedChild = null;

    try {
      await this.stopOwnedChild();
      if (startup.isCancelled || this.startup !== startup) {
        throw new LifecycleError(MESSAGES.cancelled, 'cancelled');
      }
      const available = await Promise.race([
        Promise.resolve().then(() => this.isPortAvailable(PORT, HOST)),
        rejectWhenCancelled(startup),
      ]);
      if (startup.isCancelled || this.startup !== startup) {
        throw new LifecycleError(MESSAGES.cancelled, 'cancelled');
      }
      if (!available) throw new LifecycleError(MESSAGES.portInUse, 'port-in-use');
      copyInitialIndexIfMissing(this.resourcesPath, this.userDataPath, this.fileSystem);

      const command = path.join(this.resourcesPath, 'backend', 'call-assistant-backend');
      const env = buildBackendEnv({
        apiKey,
        thinking,
        resourcesPath: this.resourcesPath,
        userDataPath: this.userDataPath,
      });
      this.emitStatus('starting', 'Starting the local service…');

      let child;
      try {
        child = this.spawn(command, [], { env, stdio: ['ignore', 'ignore', 'ignore'] });
      } catch {
        throw new LifecycleError(MESSAGES.spawn, 'spawn');
      }
      if (!child || typeof child.once !== 'function' || typeof child.kill !== 'function') {
        throw new LifecycleError(MESSAGES.spawn, 'spawn');
      }
      startedChild = child;
      this.child = child;
      const onOwnedError = () => {
        const isStopping = this.stopOperation && this.stopOperation.child === child;
        if (this.child === child && !isStopping && this.status.backendState === 'ready') {
          this.emitStatus('error', MESSAGES.stopped);
        }
      };
      const onOwnedExit = () => {
        child.removeListener('error', onOwnedError);
        this.childListeners.delete(child);
        if (this.child !== child) return;
        this.child = null;
        const stopOperation = this.stopOperation && this.stopOperation.child === child
          ? this.stopOperation
          : null;
        if (stopOperation) {
          clearTimeout(stopOperation.timer);
          this.stopOperation = null;
          this.emitStatus('stopped');
          stopOperation.resolve(true);
        } else if (this.status.backendState === 'ready') {
          this.emitStatus('error', MESSAGES.stopped);
        }
      };
      this.childListeners.set(child, { onOwnedError, onOwnedExit });
      child.on('error', onOwnedError);
      child.once('exit', onOwnedExit);

      let rejectChildFailure;
      const childFailure = new Promise((_, reject) => { rejectChildFailure = reject; });
      const onEarlyExit = () => rejectChildFailure(new LifecycleError(MESSAGES.earlyExit, 'early-exit'));
      const onSpawnError = () => rejectChildFailure(new LifecycleError(MESSAGES.spawn, 'spawn'));
      child.once('exit', onEarlyExit);
      child.once('error', onSpawnError);
      try {
        await Promise.race([
          waitForHealth(this.fetch, this.healthTimeoutMs, this.healthPollIntervalMs, startup),
          childFailure,
        ]);
      } finally {
        child.removeListener('exit', onEarlyExit);
        child.removeListener('error', onSpawnError);
      }

      if (startup.isCancelled || this.startup !== startup || this.child !== child) {
        throw new LifecycleError(MESSAGES.cancelled, 'cancelled');
      }
      this.startup = null;
      this.emitStatus('ready');
      return this.getStatus();
    } catch (error) {
      if (this.startup === startup) this.startup = null;
      let shutdownError = null;
      if (startedChild && this.child === startedChild) {
        try {
          await this.stopOwnedChild();
        } catch (stopError) {
          shutdownError = stopError;
        }
      }
      if (error instanceof LifecycleError && error.code === 'cancelled') throw error;
      const safeError = shutdownError || (error instanceof LifecycleError
        ? error
        : new LifecycleError(MESSAGES.unavailable, 'unavailable'));
      this.emitStatus('error', safeError.message);
      throw safeError;
    }
  }

  stopOwnedChild() {
    const child = this.child;
    if (!child) return Promise.resolve(false);
    if (this.stopOperation && this.stopOperation.child === child) {
      return this.stopOperation.promise;
    }

    let resolveStop;
    let rejectStop;
    const promise = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    const operation = {
      child,
      promise,
      reject: rejectStop,
      resolve: resolveStop,
      timer: null,
    };
    this.stopOperation = operation;
    operation.timer = setTimeout(() => {
      if (this.stopOperation !== operation || this.child !== child) return;
      const error = new LifecycleError(MESSAGES.stopTimeout, 'stop-timeout');
      this.emitStatus('error', error.message);
      operation.reject(error);
    }, this.stopTimeoutMs);
    try {
      child.kill('SIGTERM');
    } catch {
      // Ownership and the safe error listener remain until exit or timeout.
    }
    return operation.promise;
  }

  async stop() {
    const hadStartup = Boolean(this.startup);
    if (this.startup) {
      this.startup.cancel();
      this.startup = null;
    }
    const stoppedChild = await this.stopOwnedChild();
    if (!stoppedChild && (hadStartup || this.status.backendState !== 'stopped')) {
      this.emitStatus('stopped');
    }
  }

  forceStopOwnedChildForQuit() {
    const child = this.child;
    if (!child) return Promise.resolve(false);

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        child.removeListener('exit', onExit);
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        const error = new LifecycleError(MESSAGES.forceStopFailed, 'force-stop-failed');
        this.emitStatus('error', error.message);
        reject(error);
      };
      const onExit = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(true);
      };

      child.once('exit', onExit);
      timer = setTimeout(fail, this.forceStopTimeoutMs);
      try {
        if (child.kill('SIGKILL') === false) fail();
      } catch {
        fail();
      }
    });
  }

  stopForQuit() {
    if (this.quitStopOperation) return this.quitStopOperation;

    const operation = (async () => {
      try {
        await this.stop();
      } catch (error) {
        if (!(error instanceof LifecycleError) || error.code !== 'stop-timeout') throw error;
        await this.forceStopOwnedChildForQuit();
      }
    })();
    this.quitStopOperation = operation;
    void operation.finally(() => {
      if (this.quitStopOperation === operation) this.quitStopOperation = null;
    }).catch(() => {
      // The returned operation carries the safe error to the quit coordinator.
    });
    return operation;
  }
}

module.exports = {
  BackendManager,
  buildBackendEnv,
  copyInitialIndexIfMissing,
  defaultIsPortAvailable,
};
