const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const load = Module._load;
Module._load = function (name, parent, main) {
  if (name === "electron")
    return { app: { getPath: () => process.cwd(), isReady: () => false, isPackaged: false } };
  if (name === "./tokenStore") return { getGeneration: () => 0, subscribe() {} };
  if (name === "./nimiBusinessAI") return { assertAllowed: async () => {} };
  return load.call(this, name, parent, main);
};
const ai = require("../../src/helpers/nimiAI");
Module._load = load;
test.afterEach(() => ai.invalidate());

for (const phase of ["submit", "get", "subscribe", "terminal", "cancel-failure"]) {
  test(`original transcription command cancels once during ${phase} and preserves actual failures`, async () => {
    const input = {
      event: { sender: { id: 81 } },
      payload: { requestId: phase, audio: new Uint8Array([1]), mimeType: "audio/wav" },
    };
    let cancellations = 0;
    let streamClosed = 0;
    let job = {
      jobId: "declared-cancellation-fixture",
      scenarioType: "speech-transcribe",
      submissionOutcome: "accepted",
      artifacts: [],
      progressPercent: 0,
      progressCurrentStep: 0,
      progressTotalSteps: 0,
      reasonCode: "action-executed",
      reasonDetail: "",
      traceId: "declared-trace",
      createdAt: null,
      updatedAt: null,
      transcriptionText: "",
      status: phase === "terminal" ? "completed" : "running",
      ...(phase === "terminal"
        ? { transcription: { status: "no-speech", text: "", language: "", words: [] } }
        : {}),
    };
    let control;
    const cancel = () => {
      control ??= ai.commandHandlers["openwhispr.ai.cancel"](input);
      control.catch(() => {});
    };
    ai.bindServices({
      ai: {
        scenarioJobs: {
          submit: async () => {
            if (!["get", "subscribe"].includes(phase)) cancel();
            return { job };
          },
          get: async () => {
            if (phase === "get") cancel();
            return { job };
          },
          cancel: async () => {
            cancellations++;
            if (phase === "cancel-failure") throw new Error("declared actual cancel failure");
            if (job.status !== "completed")
              job = { ...job, status: "canceled", stopOutcome: "confirmed" };
            return { job };
          },
          subscribe: async () => {
            cancel();
            return {
              [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
              cancel: async () => {
                streamClosed++;
              },
            };
          },
        },
      },
    });
    await assert.rejects(
      ai.commandHandlers["openwhispr.ai.transcribe"](input),
      phase === "cancel-failure"
        ? /declared actual cancel failure/
        : (error) => error.name === "AbortError" || error.details?.scenarioJobStatus === "CANCELED"
    );
    if (phase === "cancel-failure") await assert.rejects(control, /declared actual cancel failure/);
    else assert.equal((await control).requested, true);
    assert.equal(cancellations, 1);
    assert.equal(streamClosed, phase === "terminal" ? 0 : 1);
    assert.equal(
      (await ai.commandHandlers["openwhispr.ai.cancel"](input)).requested,
      false,
      "the retired request cannot cancel again"
    );
  });
}
