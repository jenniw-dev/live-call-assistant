import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  configureWindowSecurity,
  registerExternalLinkIpc,
} from '../electron/window-security.js';

test('packaged renderer policy permits only local assets and loopback backend connections', () => {
  const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const match = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);

  assert.ok(match, 'missing renderer Content Security Policy');
  const policy = match[1];
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /img-src 'self' data:/);
  assert.match(policy, /connect-src 'self' http:\/\/127\.0\.0\.1:8001 ws:\/\/127\.0\.0\.1:8001/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'none'/);
  assert.doesNotMatch(policy, /img-src[^;]*(?:https?:|\*)/);
});

test('window security denies renderer navigation and every new window', () => {
  const webContents = new EventEmitter();
  let openHandler;
  webContents.setWindowOpenHandler = (handler) => { openHandler = handler; };

  configureWindowSecurity(webContents);

  const navigation = { prevented: 0, preventDefault() { this.prevented += 1; } };
  webContents.emit('will-navigate', navigation, 'https://untrusted.example/path');

  assert.equal(navigation.prevented, 1);
  assert.deepEqual(openHandler({ url: 'https://untrusted.example/path' }), { action: 'deny' });
});

test('external-link IPC opens only canonical http and https URLs', async () => {
  const listeners = new Map();
  const ipcMain = {
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
  };
  const opened = [];
  const shell = { openExternal: async (url) => { opened.push(url); } };
  const dispose = registerExternalLinkIpc({ ipcMain, shell });
  const open = listeners.get('external:open');

  for (const value of [
    'javascript:alert(1)',
    'file:///tmp/private',
    'data:text/html,private',
    '//untrusted.example/path',
    'https://user:password@example.com/private',
    'https://example.com/docs?q=1',
    'http://example.org/path',
  ]) open({}, value);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(opened, [
    'https://example.com/docs?q=1',
    'http://example.org/path',
  ]);
  dispose();
  assert.equal(listeners.has('external:open'), false);
});
