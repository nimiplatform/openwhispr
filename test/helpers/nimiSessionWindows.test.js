const test = require("node:test");
const assert = require("node:assert/strict");
const { createNimiSessionWindowLifecycle } = require("../../src/helpers/nimiSessionWindows");

test("destroy-all during a technical reset cannot request an App exit", async () => {
  const events = [];
  const lifecycle = createNimiSessionWindowLifecycle({
    destroyWindows: () => events.push(["all-closed", lifecycle.shouldQuitWhenAllClosed()]),
    createWindows: async () => events.push(["create"]),
    log: (message) => events.push([message]),
  });
  await lifecycle.reset();
  assert.deepEqual(
    events.find((e) => e[0] === "all-closed"),
    ["all-closed", false]
  );
  assert.equal(events.filter((e) => e[0] === "create").length, 1);
  assert.equal(lifecycle.shouldQuitWhenAllClosed(), true);
});

test("a real exit before the queued reset prevents any window creation", async () => {
  let calls = 0;
  const lifecycle = createNimiSessionWindowLifecycle({
    destroyWindows: () => calls++,
    createWindows: async () => calls++,
    log() {},
  });
  const pending = lifecycle.reset();
  lifecycle.beginShutdown();
  await pending;
  await lifecycle.reset();
  assert.equal(calls, 0);
});

test("shutdown during a pending load prevents queued invalidations from reopening windows", async () => {
  let entered,
    release,
    creates = 0;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const lifecycle = createNimiSessionWindowLifecycle({
    destroyWindows() {},
    createWindows: () => {
      creates++;
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    log() {},
  });
  const pending = lifecycle.reset();
  await waiting;
  assert.equal(lifecycle.reset(), pending);
  lifecycle.beginShutdown();
  release();
  await pending;
  assert.equal(creates, 1);
});

test("a second invalidation during creation gets its own disposal without concurrent resets", async () => {
  let entered,
    release,
    creates = 0;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const lifecycle = createNimiSessionWindowLifecycle({
    destroyWindows() {},
    createWindows: () => {
      if (++creates > 1) return;
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    log() {},
  });
  const pending = lifecycle.reset();
  await waiting;
  lifecycle.reset();
  release();
  await pending;
  assert.equal(creates, 2);
});

test("a failed window load releases the reset guard and reports failure", async () => {
  const lifecycle = createNimiSessionWindowLifecycle({
    destroyWindows() {},
    createWindows: async () => {
      throw new Error("declared load failure");
    },
    log() {},
  });
  await assert.rejects(lifecycle.reset(), /declared load failure/);
  assert.equal(lifecycle.shouldQuitWhenAllClosed(), true);
});
