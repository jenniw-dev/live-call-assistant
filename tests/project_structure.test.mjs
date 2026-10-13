import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, extname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const liveToken = /\b(?:sk|ds|rk)-[A-Za-z0-9_-]{16,}\b/;
const emitsCredential = /(?:print|console\.log|logger\.(?:debug|info|warning|error|exception))\s*\([^\n]*(?:\{[^}]*\b(?:api_key|token|secret)\b|\b(?:api_key|token|secret)\b\s*\[|,\s*(?:api_key|token|secret)\b|\b(?:api_key|token|secret)\b\s*\))/i;

function emitsCredentialValue(source) {
  return emitsCredential.test(source);
}

function shouldSkipIgnoredGeneratedPath(path, { repositoryRoot = root, runGit = execFileSync } = {}) {
  const generatedPath = relative(repositoryRoot, path);
  const approvedRoots = new Set([
    '.venv',
    '.cache',
    'node_modules',
    'models',
    'release',
    'backend/build',
    'backend/dist',
    'frontend/dist',
    'frontend/node_modules',
  ]);
  const approvedGeneratedName = new Set(['.pytest_cache', '__pycache__']);
  if (!approvedRoots.has(generatedPath) && !approvedGeneratedName.has(basename(path))) return false;

  try {
    runGit('git', ['check-ignore', '-q', '--', generatedPath], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
    return runGit('git', ['ls-files', '--', generatedPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim() === '';
  } catch {
    return false;
  }
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && shouldSkipIgnoredGeneratedPath(path)) return [];
    return entry.isDirectory() ? [path, ...walk(path)] : [path];
  });
}

test('skips only approved ignored and untracked generated directories', () => {
  const repositoryRoot = '/project';
  const calls = [];
  const runGit = (command, args, options) => {
    calls.push({ command, args, options });
    return '';
  };

  assert.equal(
    shouldSkipIgnoredGeneratedPath(resolve(repositoryRoot, '.venv'), { repositoryRoot, runGit }),
    true,
  );
  assert.equal(
    shouldSkipIgnoredGeneratedPath(resolve(repositoryRoot, 'node_modules'), { repositoryRoot, runGit }),
    true,
  );
  assert.equal(
    shouldSkipIgnoredGeneratedPath(resolve(repositoryRoot, 'backend', 'dist'), { repositoryRoot, runGit }),
    true,
  );
  assert.equal(
    shouldSkipIgnoredGeneratedPath(resolve(repositoryRoot, 'backend', 'app', '__pycache__'), { repositoryRoot, runGit }),
    true,
  );
  assert.equal(
    shouldSkipIgnoredGeneratedPath(resolve(repositoryRoot, 'backend', '.venv'), { repositoryRoot, runGit }),
    false,
  );
  assert.equal(
    shouldSkipIgnoredGeneratedPath(resolve(repositoryRoot, 'backend', 'vendor'), { repositoryRoot, runGit }),
    false,
  );
  assert.equal(
    shouldSkipIgnoredGeneratedPath(resolve(repositoryRoot, '.venv'), {
      repositoryRoot,
      runGit: (_command, args) => args[0] === 'ls-files' ? '.venv/lib/site.py\n' : '',
    }),
    false,
  );
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['git', ['check-ignore', '-q', '--', '.venv']],
    ['git', ['ls-files', '--', '.venv']],
    ['git', ['check-ignore', '-q', '--', 'node_modules']],
    ['git', ['ls-files', '--', 'node_modules']],
    ['git', ['check-ignore', '-q', '--', 'backend/dist']],
    ['git', ['ls-files', '--', 'backend/dist']],
    ['git', ['check-ignore', '-q', '--', 'backend/app/__pycache__']],
    ['git', ['ls-files', '--', 'backend/app/__pycache__']],
  ]);
});

test('contains the application source required by the Mac port', () => {
  for (const relative of [
    'backend/app/main.py',
    'backend/app/llm/client.py',
    'frontend/src/App.tsx',
    'frontend/src/audio/capture.ts',
    'electron/main.js',
    'data/knowledge',
    'package.json',
  ]) {
    assert.equal(existsSync(resolve(root, relative)), true, `missing ${relative}`);
  }
});

test('does not import credentials, Windows builds, or Git history', () => {
  for (const relative of [
    '.git', '.env', '.env.bak-130621', 'dist', '.sync',
  ]) {
    assert.equal(existsSync(resolve(root, relative)), false, `forbidden ${relative}`);
  }

  for (const relative of ['node_modules', 'frontend/node_modules', 'frontend/dist']) {
    const generatedPath = resolve(root, relative);
    if (existsSync(generatedPath)) {
      assert.equal(shouldSkipIgnoredGeneratedPath(generatedPath), true, `tracked or unignored ${relative}`);
    }
  }
});

test('contains no forbidden artifacts anywhere in the imported source tree', () => {
  const forbiddenDirectories = new Set([
    '.git', '.sync', '.venv', 'build', 'dist', 'node_modules', '__pycache__',
    '.pytest_cache', '.mypy_cache',
  ]);
  const forbiddenExtensions = new Set([
    '.bat', '.cmd', '.dll', '.dmg', '.exe', '.msi', '.pkg', '.ps1', '.p12',
    '.pem', '.pfx',
  ]);

  for (const path of walk(root)) {
    const pathFromRoot = relative(root, path);
    const name = pathFromRoot.split('/').at(-1);
    const isApprovedExample = pathFromRoot === '.env.example';

    assert.equal(forbiddenDirectories.has(name), false, `forbidden directory ${pathFromRoot}`);
    assert.equal(
      !isApprovedExample && (name === '.env' || name.startsWith('.env.')),
      false,
      `credential file ${pathFromRoot}`,
    );
    assert.equal(forbiddenExtensions.has(extname(name).toLowerCase()), false, `forbidden file ${pathFromRoot}`);
  }
});

test('does not contain literal credentials or code that emits credential values', () => {
  const sourceExtensions = new Set(['.js', '.mjs', '.py', '.sh', '.ts', '.tsx']);

  for (const path of walk(root)) {
    if (relative(root, path).startsWith('tests/')) continue;
    if (!sourceExtensions.has(extname(path))) continue;

    const source = readFileSync(path, 'utf8');
    assert.equal(liveToken.test(source), false, `literal credential in ${relative(root, path)}`);
    assert.equal(emitsCredentialValue(source), false, `credential emitted by ${relative(root, path)}`);
  }
});

test('recognizes direct credential-value output without rejecting static guidance', () => {
  for (const source of [
    'print(api_key)',
    'console.log(token)',
    'logger.info(secret)',
  ]) {
    assert.equal(emitsCredentialValue(source), true, `missed ${source}`);
  }

  assert.equal(
    emitsCredentialValue('logger.warning("Set DASHSCOPE_API_KEY to enable cloud fallback")'),
    false,
  );
});

test('uses the loopback-only backend boundary', () => {
  const config = readFileSync(resolve(root, 'backend/app/config.py'), 'utf8');
  const example = readFileSync(resolve(root, '.env.example'), 'utf8');
  const launcher = readFileSync(resolve(root, 'scripts/start-backend.sh'), 'utf8');

  assert.match(config, /backend_host:\s*str\s*=\s*"127\.0\.0\.1"/);
  assert.match(config, /backend_port:\s*int\s*=\s*8001/);
  assert.match(example, /^BACKEND_HOST=127\.0\.0\.1$/m);
  assert.match(example, /^BACKEND_PORT=8001$/m);
  assert.match(launcher, /--host 127\.0\.0\.1 --port 8001/);
});
