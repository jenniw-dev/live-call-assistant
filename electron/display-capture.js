'use strict';

const configuredSessions = new WeakSet();

function replyOnce(callback, streams) {
  try {
    callback(streams);
  } catch {
    // Electron owns the callback; a native teardown race must not trigger a second reply.
  }
}

function configureDisplayCapture({ session, desktopCapturer, platform }) {
  const targetSession = session.defaultSession;
  if (configuredSessions.has(targetSession)) return;

  if (platform === 'darwin') {
    targetSession.setDisplayMediaRequestHandler(
      (_request, callback) => replyOnce(callback, {}),
      { useSystemPicker: true },
    );
    configuredSessions.add(targetSession);
    return;
  }

  targetSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    let sources;
    try {
      sources = await desktopCapturer.getSources({ types: ['screen'] });
    } catch {
      replyOnce(callback, {});
      return;
    }

    const source = sources[0];
    replyOnce(callback, source ? { video: source, audio: 'loopback' } : {});
  });
  configuredSessions.add(targetSession);
}

module.exports = { configureDisplayCapture };
