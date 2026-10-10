const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const originalLoad = Module._load;
const requests = [];
const selection = [{ capabilityContract: "audio.transcribe", state: "ready" }];
let result, failure, modelsWork;
Module._load = function (request, parent, isMain) {
  if (request === "electron")
    return { app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() } };
  if (request === "./windowBroadcast") return { broadcastToWindows() {} };
  if (request === "./nimiAI")
    return {
      cliTranscriptionSelection: async (signal) => (modelsWork ? modelsWork(signal) : selection),
      transcribeCliFile: async (input) => {
        requests.push(input);
        if (failure) throw failure;
        return result;
      },
    };
  return originalLoad.call(this, request, parent, isMain);
};
const CliBridge = require("../../src/helpers/cliBridge.js");
const { call } = require("./harness/cliBridge.js");
test.after(() => {
  Module._load = originalLoad;
});
function setup(t) {
  requests.length = 0;
  failure = null;
  modelsWork = null;
  result = { success: true, text: "contract-test output" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cli-transcribe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "memo.wav");
  fs.writeFileSync(file, "not acoustic acceptance media");
  const approved = [];
  return {
    file,
    dir,
    approved,
    bridge: new CliBridge({ databaseManager: {}, approveAudioPath: (p) => approved.push(p) }),
  };
}
test("listing reflects the supervised Nimi selection", async (t) => {
  const { bridge } = setup(t);
  assert.deepEqual(await call(bridge, "GET", "/v1/transcribe/models"), { data: selection });
});
test("CLI sends canonical media and language without model selectors", async (t) => {
  const { bridge, file, approved } = setup(t);
  assert.deepEqual(await call(bridge, "POST", "/v1/transcribe", { path: file, language: "zh" }), {
    data: { text: result.text },
  });
  assert.deepEqual(approved, [fs.realpathSync(file)]);
  assert.deepEqual(requests, [{ filePath: fs.realpathSync(file), language: "zh" }]);
});
test("retired selectors are refused before model work, including empty values", async (t) => {
  const { bridge, file, approved } = setup(t);
  for (const extra of [
    { model: "" },
    { provider: "legacy" },
    { apiKey: "ignored" },
    { language: 3 },
  ])
    await assert.rejects(call(bridge, "POST", "/v1/transcribe", { path: file, ...extra }), {
      code: "VALIDATION",
    });
  assert.deepEqual(approved, []);
  assert.deepEqual(requests, []);
});
test("no speech is an explicit empty acoustic result", async (t) => {
  const { bridge, file } = setup(t);
  result = { success: false, code: "NO_SPEECH_DETECTED" };
  assert.deepEqual(await call(bridge, "POST", "/v1/transcribe", { path: file }), {
    data: { text: "", warning: "No speech detected" },
  });
});
test("session failures propagate without another backend", async (t) => {
  const { bridge, file } = setup(t);
  failure = new Error("runtime-unauthenticated");
  await assert.rejects(
    call(bridge, "POST", "/v1/transcribe", { path: file }),
    (e) => e === failure
  );
  assert.equal(requests.length, 1);
});
test("invalid paths never reach Nimi", async (t) => {
  const { bridge, dir, approved } = setup(t);
  await assert.rejects(call(bridge, "POST", "/v1/transcribe", {}), { code: "VALIDATION" });
  await assert.rejects(call(bridge, "POST", "/v1/transcribe", { path: dir }), {
    code: "VALIDATION",
  });
  await assert.rejects(
    call(bridge, "POST", "/v1/transcribe", { path: path.join(dir, "missing.wav") }),
    { code: "NOT_FOUND" }
  );
  assert.deepEqual(approved, []);
  assert.deepEqual(requests, []);
});

test("CLI transport preserves bounded Host reason and status", (t) => {
  const { bridge } = setup(t);
  let status, output;
  bridge._sendError(
    {
      writeHead: (value) => {
        status = value;
      },
      end: (value) => {
        output = JSON.parse(value);
      },
    },
    Object.assign(new Error("runtime-service-unavailable"), {
      reasonCode: "runtime-service-unavailable",
      retryable: true,
    })
  );
  assert.equal(status, 503);
  assert.deepEqual(output.error, {
    code: "runtime-service-unavailable",
    message: "runtime-service-unavailable",
  });
});

test("a disconnected CLI HTTP request cancels pending preparation and sends no late response", async (t) => {
  const { bridge } = setup(t);
  bridge.token = "declared-test-token";
  bridge.port = 8200;
  let entered, observedSignal;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  modelsWork = (signal) =>
    new Promise((_resolve, reject) => {
      observedSignal = signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      entered();
    });
  const req = Object.assign(new EventEmitter(), {
    method: "GET",
    url: "/v1/transcribe/models",
    socket: { remoteAddress: "127.0.0.1" },
    headers: { authorization: "Bearer declared-test-token" },
  });
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writeHead: () => assert.fail("must not publish after disconnect"),
    end: () => assert.fail("must not publish after disconnect"),
  });
  const pending = bridge._handleRequest(req, res);
  await waiting;
  res.destroyed = true;
  res.emit("close");
  await pending;
  assert.equal(observedSignal.aborted, true);
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(res.listenerCount("close"), 0);
});
