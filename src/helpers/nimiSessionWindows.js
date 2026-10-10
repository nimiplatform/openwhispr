// Business windows belong to this App; a technical-session reset is not an exit.
function createNimiSessionWindowLifecycle({ destroyWindows, createWindows, log }) {
  let shuttingDown = false;
  let resetting = false;
  let requested = false;
  let pending;

  return {
    beginShutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      requested = false;
      log("Nimi business window shutdown began");
    },
    shouldQuitWhenAllClosed() {
      return !resetting && !shuttingDown;
    },
    reset() {
      if (shuttingDown) return Promise.resolve();
      requested = true;
      if (pending) return pending;
      // Install the guard before destruction can emit window-all-closed.
      resetting = true;
      pending = Promise.resolve()
        .then(async () => {
          while (requested && !shuttingDown) {
            requested = false;
            log("Nimi session business windows reset started");
            destroyWindows();
            if (shuttingDown) break;
            await createWindows();
            if (shuttingDown) break;
            log("Nimi session business windows reset completed");
          }
        })
        .finally(() => {
          resetting = false;
          pending = undefined;
        });
      return pending;
    },
  };
}

module.exports = { createNimiSessionWindowLifecycle };
