import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const verifier = new URL('../scripts/verify-mac-bundle.sh', import.meta.url);
const fixtureSkipOptions = ['--skip-architecture-check', '--fixture-skip-runtime-check'];

function writeFixtureFile(path, content = 'fixture') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function makeBundle() {
  const root = mkdtempSync(join(tmpdir(), 'call-assistant-bundle-'));
  const app = join(root, 'Live Call Assistant.app');
  const contents = join(app, 'Contents');
  const resources = join(contents, 'Resources');
  const files = {
    electron: join(contents, 'MacOS', 'Live Call Assistant'),
    backend: join(resources, 'backend', 'call-assistant-backend'),
    bgeWeight: join(resources, 'models', 'bge-small-en-v1.5', 'model.safetensors'),
    bgeConfig: join(resources, 'models', 'bge-small-en-v1.5', 'config.json'),
    bgeTokenizer: join(resources, 'models', 'bge-small-en-v1.5', 'tokenizer.json'),
    whisperWeight: join(resources, 'models', 'faster-whisper-small', 'model.bin'),
    whisperConfig: join(resources, 'models', 'faster-whisper-small', 'config.json'),
    whisperTokenizer: join(resources, 'models', 'faster-whisper-small', 'tokenizer.json'),
    knowledge: join(resources, 'data', 'knowledge', 'faq.md'),
    index: join(resources, 'data', 'faiss_index', 'index.faiss'),
    metadata: join(resources, 'data', 'faiss_index', 'metadata.json'),
    renderer: join(resources, 'app.asar'),
  };

  for (const path of Object.values(files)) writeFixtureFile(path);
  chmodSync(files.backend, 0o755);
  chmodSync(files.electron, 0o755);
  writeFixtureFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0"><dict>
    <key>NSAudioCaptureUsageDescription</key><string>Audio fixture</string>
    <key>NSScreenCaptureUsageDescription</key><string>Screen fixture</string>
  </dict></plist>`);
  return { root, app, files };
}

function runVerifier(app, options = fixtureSkipOptions) {
  try {
    return {
      status: 0,
      output: execFileSync(
        'bash',
        [fileURLToPath(verifier), '--app', app, ...options],
        { encoding: 'utf8', stderr: 'pipe' },
      ),
    };
  } catch (error) {
    return { status: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function withBundle(assertion) {
  const fixture = makeBundle();
  try {
    assertion(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('bundle verifier accepts a complete controlled fixture without running its fake executable', () => {
  withBundle((fixture) => {
    const result = runVerifier(fixture.app);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Mac bundle verification passed/);
  });
});

for (const [name, target, expected] of [
  ['BGE weight', 'bgeWeight', /model\.safetensors/],
  ['BGE config', 'bgeConfig', /bge-small-en-v1\.5.*config\.json/],
  ['BGE tokenizer', 'bgeTokenizer', /bge-small-en-v1\.5.*tokenizer\.json/],
  ['Whisper weight', 'whisperWeight', /faster-whisper-small.*model\.bin/],
  ['Whisper config', 'whisperConfig', /faster-whisper-small.*config\.json/],
  ['Whisper tokenizer', 'whisperTokenizer', /faster-whisper-small.*tokenizer\.json/],
  ['knowledge content', 'knowledge', /knowledge/],
  ['FAISS index', 'index', /index\.faiss/],
  ['FAISS metadata', 'metadata', /metadata\.json/],
  ['renderer archive', 'renderer', /app\.asar/],
]) {
  test(`bundle verifier rejects an empty ${name}`, () => {
    withBundle((fixture) => {
      truncateSync(fixture.files[target], 0);
      const result = runVerifier(fixture.app);
      assert.notEqual(result.status, 0);
      assert.match(result.output, expected);
    });
  });
}

test('bundle verifier rejects a non-arm64 backend executable', () => {
  withBundle((fixture) => {
    copyFileSync('/usr/bin/true', fixture.files.electron);
    const result = runVerifier(fixture.app, ['--fixture-skip-runtime-check']);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /backend executable is not arm64/);
  });
});

test('bundle verifier rejects a non-arm64 Electron executable', () => {
  withBundle((fixture) => {
    copyFileSync('/usr/bin/true', fixture.files.backend);
    const result = runVerifier(fixture.app, ['--fixture-skip-runtime-check']);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Electron executable is not arm64/);
  });
});
