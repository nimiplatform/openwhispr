const test = require("node:test");
const assert = require("node:assert/strict");
const { runNimiAudioJob } = require("../../src/helpers/nimiAsyncAudioJob");

async function fixture(t, options = {}) {
  const transcript = {
    status: "transcribed",
    text: "Declared source transcript",
    language: "zh",
    words: [{ text: "Declared", startSeconds: 0.2, endSeconds: 0.8 }],
  };
  let submits = 0,
    gets = 0,
    cancels = 0,
    closes = 0,
    remoteStatus = "running";
  const lookups = [],
    identities = [];
  const snapshot = () => ({
    jobId: "original-audio-job",
    scenarioType: "speech-transcribe",
    status: remoteStatus,
    submissionOutcome: "accepted",
    ...(remoteStatus === "canceled" ? { stopOutcome: "unconfirmed" } : {}),
    artifacts: [],
    progressPercent: remoteStatus === "completed" ? 100 : 0,
    progressCurrentStep: 0,
    progressTotalSteps: 0,
    reasonCode: "action-executed",
    reasonDetail: "",
    traceId: "trace",
    createdAt: null,
    updatedAt: null,
    transcriptionText: remoteStatus === "completed" ? transcript.text : "",
    ...(remoteStatus === "completed" ? { transcription: transcript } : {}),
  });
  const { createNimiLocalAppAIConsumptionClient } = await import("@nimiplatform/sdk");
  const unused = async () => {
    throw new Error("unexpected operation");
  };
  const client = createNimiLocalAppAIConsumptionClient({
    text: { streamTurn: unused },
    scenario: { execute: unused },
    artifacts: { read: unused, upload: unused },
    voiceAssets: { list: unused, delete: unused },
    scenarioJobs: {
      submit: async (spec, submission) => {
        submits++;
        identities.push(submission.clientSubmissionId);
        assert.match(submission.clientSubmissionId, /^[\w-]+$/);
        assert.equal(submission.timeoutMs, undefined);
        assert.deepEqual(Buffer.from(spec.audioSource.bytes), Buffer.from("actual fixture input"));
        if (options.submitError) throw options.submitError;
        if (options.lostReceipt) throw new Error("Submit receipt lost after possible creation");
        return { job: snapshot() };
      },
      get: async (jobId, clientSubmissionId) => {
        if (clientSubmissionId) {
          lookups.push(clientSubmissionId);
          assert.equal(jobId, "");
          if (options.missingReceipt || !submits) throw new Error("original submission not found");
        } else {
          gets++;
          if (options.finishAfter && gets >= options.finishAfter) remoteStatus = "completed";
        }
        return {
          job: snapshot(),
          asset: null,
          voiceReference: null,
          ...(options.observationIssue && remoteStatus === "running"
            ? {
                observationIssue: {
                  reasonCode: "ai-provider-unavailable",
                  observedAt: { seconds: "5", nanos: 0 },
                },
              }
            : {}),
        };
      },
      subscribe: async () => ({
        events: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
        cancel: async () => {
          closes++;
        },
      }),
      cancel: async () => {
        cancels++;
        if (options.cancel) return options.cancel(snapshot);
        remoteStatus = "canceled";
        return { job: snapshot() };
      },
    },
  });
  const input = {
    type: "speech-transcribe",
    mimeType: "audio/wav",
    language: "",
    prompt: "",
    responseFormat: "",
    timestamps: true,
    diarization: false,
    audioSource: { type: "bytes", bytes: Buffer.from("actual fixture input") },
  };
  const run = (extra = {}) =>
    runNimiAudioJob({ ai: client, spec: input, assertCurrent() {}, getIntervalMs: 1, ...extra });
  return {
    run,
    transcript,
    lookups,
    identities,
    complete: () => {
      remoteStatus = "completed";
    },
    counts: () => ({ submits, gets, cancels, closes }),
  };
}

test("a lost receipt uses only its invocation identity and silent observation still Gets the complete result", async (t) => {
  const f = await fixture(t, { lostReceipt: true, finishAfter: 2, observationIssue: true });
  const observations = [];
  const result = await f.run({ onObservation: (response) => observations.push(response) });
  assert.equal(f.counts().submits, 1);
  assert.deepEqual(f.lookups, [f.identities[0]]);
  assert.ok(f.counts().gets >= 2);
  assert.ok(
    observations.some((response) => response.observationIssue && response.job.status !== 4)
  );
  assert.deepEqual(result.job.transcription, f.transcript);
});

test("missing or expired submission lookup never authorizes resubmission", async (t) => {
  const f = await fixture(t, { lostReceipt: true, missingReceipt: true });
  await assert.rejects(f.run(), { code: "NIMI_AUDIO_SUBMISSION_UNCONFIRMED" });
  assert.equal(f.counts().submits, 1);
  assert.deepEqual(f.lookups, [f.identities[0]]);
});

test("observation detach does not send Cancel or create a recovery workflow", async (t) => {
  const f = await fixture(t);
  const view = new AbortController();
  let seen;
  const observed = new Promise((resolve) => {
    seen = resolve;
  });
  const work = f.run({ signal: view.signal, onObservation: () => seen() });
  await observed;
  view.abort();
  await assert.rejects(work);
  assert.equal(f.counts().cancels, 0);
  assert.equal(f.counts().submits, 1);
});

test("explicit Cancel preserves unconfirmed stop facts instead of claiming the remote work stopped", async (t) => {
  const f = await fixture(t);
  const cancel = new AbortController();
  const facts = [];
  let seen;
  const observed = new Promise((resolve) => {
    seen = resolve;
  });
  const work = f.run({
    cancelSignal: cancel.signal,
    onObservation: () => seen(),
    onCancel: (fact) => facts.push(fact),
  });
  await observed;
  cancel.abort();
  await assert.rejects(work);
  assert.equal(f.counts().cancels, 1);
  assert.equal(facts[0].response.job.status, "canceled");
  assert.equal(facts[0].response.job.stopOutcome, "unconfirmed");
});

test("detaching during a refused Cancel does not hide its error or invent a canceled Job", async (t) => {
  let sent, refuse;
  const requested = new Promise((resolve) => {
    sent = resolve;
  });
  const f = await fixture(t, {
    cancel: async () => {
      sent();
      return new Promise((_resolve, reject) => {
        refuse = reject;
      });
    },
  });
  const view = new AbortController(),
    cancel = new AbortController();
  const facts = [];
  let seen;
  const observed = new Promise((resolve) => {
    seen = resolve;
  });
  const work = f.run({
    signal: view.signal,
    cancelSignal: cancel.signal,
    assertCurrent: () => view.signal.throwIfAborted(),
    assertControlCurrent() {},
    onObservation: () => seen(),
    onCancel: (fact) => facts.push(fact),
  });
  await observed;
  cancel.abort();
  await requested;
  view.abort();
  refuse(new Error("Cancel refused by owner"));
  await assert.rejects(work, /Cancel refused by owner/);
  assert.equal(facts[0].error.message, "Cancel refused by owner");
});

test("explicit validation, permission and capacity rejection stay original and never trigger lookup", async (t) => {
  for (const reasonCode of [
    "RUNTIME_INVALID_ARGUMENT",
    "RUNTIME_PERMISSION_DENIED",
    "RUNTIME_RESOURCE_EXHAUSTED",
  ]) {
    const error = Object.assign(new Error(reasonCode), { reasonCode });
    const f = await fixture(t, { submitError: error });
    await assert.rejects(f.run(), (actual) => actual === error);
    assert.deepEqual(f.lookups, []);
    assert.equal(f.counts().submits, 1);
  }
});

test("an explicit cancellation before admission does not dispatch or create a Job", async (t) => {
  const f = await fixture(t);
  const cancel = new AbortController();
  cancel.abort();
  const facts = [];
  await assert.rejects(
    f.run({ cancelSignal: cancel.signal, onCancel: (fact) => facts.push(fact) }),
    { name: "AbortError" }
  );
  assert.equal(f.counts().submits, 0);
  assert.deepEqual(facts, [{ notDispatched: true }]);
});
