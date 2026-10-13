import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

test('backend build synchronizes and verifies the committed lock before any model or PyInstaller work', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'aic-python-lock-build-'));
  const callLog = join(fixture, 'python-calls.log');
  try {
    const buildScript = join(fixture, 'scripts', 'build-mac-backend.sh');
    const fakePython = join(fixture, '.venv', 'bin', 'python');
    mkdirSync(dirname(buildScript), { recursive: true });
    mkdirSync(dirname(fakePython), { recursive: true });
    mkdirSync(join(fixture, 'backend'), { recursive: true });
    copyFileSync(join(root, 'scripts', 'build-mac-backend.sh'), buildScript);
    writeFileSync(join(fixture, 'backend', 'requirements-macos-arm64.lock'), 'example==1.0\n');
    writeFileSync(fakePython, `#!/bin/sh
printf '%s\\n' "$*" >> "$AIC_TEST_CALL_LOG"
case "$*" in
  *download-models.py*) exit 73 ;;
  *) exit 0 ;;
esac
`);
    chmodSync(fakePython, 0o755);

    const result = spawnSync('bash', [buildScript], {
      encoding: 'utf8',
      env: { ...process.env, AIC_TEST_CALL_LOG: callLog },
    });
    const calls = readFileSync(callLog, 'utf8').trim().split('\n');

    assert.equal(result.status, 73);
    assert.match(
      calls[0],
      /-m pip install --disable-pip-version-check --no-deps --require-hashes --requirement .*requirements-macos-arm64\.lock$/,
    );
    assert.match(calls[1], /verify_python_lock\.py .*requirements-macos-arm64\.lock$/);
    assert.match(calls[2], /download-models\.py$/);
    assert.equal(calls.some((call) => call.includes('requirements.txt')), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('committed arm64 Python 3.11 lock exactly matches the checked build environment', () => {
  const lockLines = readFileSync(
    join(root, 'backend', 'requirements-macos-arm64.lock'),
    'utf8',
  )
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.ok(lockLines.length >= 60);
  assert.equal(
    lockLines.every((line) => /^[A-Za-z0-9._-]+==\S+ --hash=sha256:[a-f0-9]{64}$/.test(line)),
    true,
  );

  const result = spawnSync(
    join(root, '.venv', 'bin', 'python'),
    [
      join(root, 'scripts', 'verify_python_lock.py'),
      '--lock',
      join(root, 'backend', 'requirements-macos-arm64.lock'),
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Python lock verified: \d+ exact packages; pip check passed/);
});
