import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

test('primary README retires the legacy Windows/Qwen/plaintext-key instructions', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

  assert.match(readme, /README-mac\.md/);
  assert.match(readme, /Apple Silicon/);
  assert.match(readme, /bash scripts\/verify-mac-bundle\.sh/);
  assert.doesNotMatch(readme, /Qwen|Windows|\.bat|\.env/);
  assert.doesNotMatch(readme, /(?:export|set)\s+(?:LLM_API_KEY|DEEPSEEK_API_KEY)/);
});

test('Mac guide accurately discloses every class of text sent for cloud answers', () => {
  const guide = readFileSync(resolve(root, 'README-mac.md'), 'utf8');

  assert.match(guide, /last two Q&A rounds/);
  assert.match(guide, /selected knowledge-base sections/);
  assert.match(guide, /system prompt/);
  assert.match(guide, /Raw audio.*never sent to DeepSeek/);
  assert.match(guide, /full knowledge base.*never sent to DeepSeek/);
  assert.doesNotMatch(guide, /entire transcript is sent to DeepSeek/);
  assert.doesNotMatch(guide, /\.env/);
});
