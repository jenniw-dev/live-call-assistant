import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { KeyStore } from '../electron/key-store.js';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const encryptedValues = new Map();
const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => {
    const ciphertext = randomBytes(48);
    encryptedValues.set(ciphertext.toString('hex'), value);
    return ciphertext;
  },
  decryptString: (value) => encryptedValues.get(value.toString('hex')),
};

function withTempDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'aic-key-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('stores ciphertext without persisting the submitted key', () => {
  withTempDirectory((directory) => {
    const submittedKey = randomBytes(32).toString('base64url');
    const store = new KeyStore({ safeStorage: crypto, userDataPath: directory });

    store.save(submittedKey);

    const file = join(directory, 'credentials', 'deepseek-key.bin');
    assert.equal(store.has(), true);
    assert.equal(store.readForBackend(), submittedKey);
    assert.equal(readFileSync(file, 'utf8').includes(submittedKey), false);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

test('tightens an existing credential directory before storing the ciphertext', () => {
  withTempDirectory((directory) => {
    const credentialDirectory = join(directory, 'credentials');
    mkdirSync(credentialDirectory, { mode: 0o777 });
    chmodSync(credentialDirectory, 0o777);
    const store = new KeyStore({ safeStorage: crypto, userDataPath: directory });

    store.save(randomBytes(32).toString('base64url'));

    assert.equal(statSync(credentialDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(join(credentialDirectory, 'deepseek-key.bin')).mode & 0o777, 0o600);
  });
});

test('rejects blank keys', () => {
  withTempDirectory((directory) => {
    const store = new KeyStore({ safeStorage: crypto, userDataPath: directory });

    assert.throws(() => store.save('   '), /can’t be empty/);
    assert.equal(store.has(), false);
  });
});

test('rejects saving when encryption is unavailable', () => {
  withTempDirectory((directory) => {
    const store = new KeyStore({
      safeStorage: { ...crypto, isEncryptionAvailable: () => false },
      userDataPath: directory,
    });

    assert.throws(() => store.save(randomBytes(32).toString('base64url')), /can’t store the key securely/);
    assert.equal(store.has(), false);
  });
});

test('clear removes the encrypted key file', () => {
  withTempDirectory((directory) => {
    const store = new KeyStore({ safeStorage: crypto, userDataPath: directory });
    store.save(randomBytes(32).toString('base64url'));

    store.clear();
    store.clear();

    assert.equal(store.has(), false);
    assert.equal(existsSync(join(directory, 'credentials', 'deepseek-key.bin')), false);
  });
});

test('rejects reading when encryption is unavailable', () => {
  withTempDirectory((directory) => {
    let encryptionAvailable = true;
    const store = new KeyStore({
      safeStorage: { ...crypto, isEncryptionAvailable: () => encryptionAvailable },
      userDataPath: directory,
    });
    store.save(randomBytes(32).toString('base64url'));
    encryptionAvailable = false;

    assert.throws(() => store.readForBackend(), /Couldn’t read the key securely/);
  });
});

test('translates corrupt ciphertext decrypt failures into a safe error', () => {
  withTempDirectory((directory) => {
    const store = new KeyStore({
      safeStorage: {
        ...crypto,
        decryptString: () => { throw new Error('native decrypt details'); },
      },
      userDataPath: directory,
    });
    store.save(randomBytes(32).toString('base64url'));

    assert.throws(
      () => store.readForBackend(),
      (error) => /Couldn’t read the key securely/.test(error.message) && !error.message.includes('native decrypt details'),
    );
  });
});

test('renderer bridge exposes only credential presence, save, and clear operations', async () => {
  const calls = [];
  let rendererApi;
  const originalLoad = Module._load;
  const preloadPath = require.resolve('../electron/preload.js');

  Module._load = (request, parent, isMain) => {
    if (request === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (_name, value) => { rendererApi = value; } },
        ipcRenderer: {
          invoke: (...args) => { calls.push(args); return Promise.resolve(); },
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

  assert.deepEqual(Object.keys(rendererApi.credentials).sort(), ['clear', 'has', 'save']);
  const submittedKey = randomBytes(32).toString('base64url');
  await rendererApi.credentials.has();
  await rendererApi.credentials.save(submittedKey);
  await rendererApi.credentials.clear();
  assert.deepEqual(calls, [
    ['credentials:has'],
    ['credentials:save', submittedKey],
    ['credentials:clear'],
  ]);
});
