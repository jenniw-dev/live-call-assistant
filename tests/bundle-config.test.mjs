import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('bundles backend, models, knowledge, and the initial index', () => {
  const entries = pkg.build.extraResources.map(item => `${item.from}->${item.to}`);
  assert.deepEqual(entries, [
    'backend/dist/call-assistant-backend->backend',
    'models->models',
    'data/knowledge->data/knowledge',
    'backend/data/faiss_index->data/faiss_index',
  ]);
});

test('offers one Mac build command and no Windows distribution command', () => {
  assert.equal(pkg.scripts['dist:mac'], 'bash scripts/build-mac-app.sh');
  assert.equal(Object.hasOwn(pkg.scripts, 'dist'), false);
  assert.equal(Object.hasOwn(pkg.build, 'win'), false);
});

test('uses the resumable pinned Electron archive prepared by the Mac build', () => {
  assert.equal(
    pkg.build.electronDist,
    '.cache/electron/electron-v44.2.0-darwin-arm64.zip',
  );
});
