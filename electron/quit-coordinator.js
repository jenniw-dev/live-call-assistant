function createQuitCoordinator({ app, backend, dispose }) {
  let allowFinalExit = false;
  let shutdownPromise = null;

  return function onWillQuit(event) {
    if (allowFinalExit) return Promise.resolve();
    event.preventDefault();
    if (shutdownPromise) return shutdownPromise;

    const operation = (async () => {
      try {
        await backend.stopForQuit();
      } catch {
        // Keep Electron alive when its owned child could not be confirmed stopped.
        return false;
      }
      try {
        dispose();
      } finally {
        allowFinalExit = true;
        app.exit(0);
      }
      return true;
    })();
    shutdownPromise = operation.finally(() => {
      if (!allowFinalExit && shutdownPromise) shutdownPromise = null;
    });
    return shutdownPromise;
  };
}

module.exports = { createQuitCoordinator };
