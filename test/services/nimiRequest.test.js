const { test } = require("node:test");
const assert = require("node:assert/strict");

test("canceling an edit request targets that request, refuses late results and releases the listener", async () => {
  const { createNimiRequestRunner } = await import("../../src/services/nimiRequest.ts");
  const calls = [];
  let settle;
  const run = createNimiRequestRunner((command, input) => {
    calls.push({ command, input });
    if (command.endsWith(".cancel")) return Promise.resolve({ canceled: true });
    return new Promise((resolve) => {
      settle = resolve;
    });
  });
  const controller = new AbortController();
  const pending = run("openwhispr.ai.edit-text", { text: "原文" }, controller.signal);
  controller.abort();
  assert.equal(calls[1].command, "openwhispr.ai.cancel");
  assert.equal(calls[1].input.requestId, calls[0].input.requestId);
  settle({ text: "late model output" });
  await assert.rejects(pending, (error) => error.name === "AbortError");
  const next = run("openwhispr.ai.edit-text", { text: "next request" });
  assert.notEqual(calls[2].input.requestId, calls[0].input.requestId);
  settle({ text: "next result" });
  assert.deepEqual(await next, { text: "next result" });
});

test("a request canceled before dispatch never invokes a Host command", async () => {
  const { createNimiRequestRunner } = await import("../../src/services/nimiRequest.ts");
  const controller = new AbortController();
  controller.abort();
  const run = createNimiRequestRunner(() => {
    assert.fail("must not dispatch");
  });
  await assert.rejects(
    run("openwhispr.ai.edit-text", {}, controller.signal),
    (error) => error.name === "AbortError"
  );
});

test("audio view disposal detaches observation while explicit user cancellation keeps stop uncertainty visible", async () => {
  const { createNimiRequestRunner, NIMI_USER_CANCEL } =
    await import("../../src/services/nimiRequest.ts");
  for (const explicit of [false, true]) {
    const calls = [];
    let settle;
    const run = createNimiRequestRunner((command) => {
      calls.push(command);
      if (command.endsWith(".detach")) return Promise.resolve({ detached: true });
      if (command.endsWith(".cancel"))
        return Promise.resolve({ requested: true, jobs: [{ stopOutcome: "unconfirmed" }] });
      return new Promise((resolve) => {
        settle = resolve;
      });
    });
    const controller = new AbortController();
    const work = run("openwhispr.ai.transcribe-file", {}, controller.signal);
    controller.abort(explicit ? NIMI_USER_CANCEL : undefined);
    settle({ text: "late" });
    await assert.rejects(work, (error) =>
      explicit ? error.code === "NIMI_AUDIO_CANCEL_UNCONFIRMED" : error.name === "AbortError"
    );
    assert.deepEqual(calls, [
      "openwhispr.ai.transcribe-file",
      explicit ? "openwhispr.ai.cancel" : "openwhispr.ai.detach",
    ]);
  }
});

test("a refused explicit Cancel is returned intact even when the request also rejects", async () => {
  const { createNimiRequestRunner, NIMI_USER_CANCEL } =
    await import("../../src/services/nimiRequest.ts");
  const failure = new Error("Owner refused cancellation");
  let rejectTask;
  const run = createNimiRequestRunner((command) =>
    command.endsWith(".cancel")
      ? Promise.reject(failure)
      : new Promise((_resolve, reject) => {
          rejectTask = reject;
        })
  );
  const controller = new AbortController();
  const work = run("openwhispr.history.retry", {}, controller.signal);
  controller.abort(NIMI_USER_CANCEL);
  rejectTask(new DOMException("View no longer observing", "AbortError"));
  await assert.rejects(
    work,
    (error) => error === failure && error.audioCancellationFailed === true
  );
});
