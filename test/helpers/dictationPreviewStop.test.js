const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const listeners = new Map();
const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on() {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, handler) => listeners.set(channel, handler),
    removeHandler() {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath && request === "./debugLogger") {
    return new Proxy({}, { get: () => () => {} });
  }
  return originalLoad.call(this, request, parent, isMain);
};
test.after(() => {
  Module._load = originalLoad;
});

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function scenario(t, { decode, stream, online = false } = {}) {
  const timers = new Map();
  t.mock.method(global, "setInterval", (callback) => {
    const id = {};
    timers.set(id, callback);
    return id;
  });
  t.mock.method(global, "clearInterval", (id) => timers.delete(id));
  const calls = { decode: [], appended: [], shown: [], held: [], hidden: 0 };
  const target = {
    parakeetManager: {
      supportsOnlineStreaming: () => online,
      createOnlineStream: async () => {
        if (stream instanceof Error) throw stream;
        return stream;
      },
      transcribeLocalParakeet: async (audio, options) => {
        calls.decode.push({ audio, options });
        return decode ? decode(audio, options) : { success: true, text: "recognized" };
      },
    },
    windowManager: {
      showTranscriptionPreview: (text) => calls.shown.push(text),
      appendTranscriptionPreview: (text) => calls.appended.push(text),
      holdTranscriptionPreview: (options) => calls.held.push(options),
      hideTranscriptionPreview: () => {
        calls.hidden++;
      },
    },
  };
  const IPCHandlers = require(handlersModulePath);
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
  const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);
  const start = (model = "orukeet-v0.1.0") =>
    invoke("start-dictation-preview", {
      provider: "nvidia",
      model,
      language: "en",
      display: true,
    });
  t.after(() => invoke("dismiss-dictation-preview"));
  return {
    calls,
    invoke,
    start,
    tick: () => Promise.all([...timers.values()].map((callback) => callback())),
  };
}

test("native preview operations display supplied real text and never run an App inference backend", async (t) => {
  const s = scenario(t, {
    online: true,
    stream: {
      finish() {
        assert.fail("retired inference stream");
      },
    },
  });
  await s.start();
  await s.invoke("update-dictation-preview", "actual Nimi text");
  assert.deepEqual(await s.invoke("stop-dictation-preview", { showCleanup: true }), {
    success: true,
    streamed: false,
    text: "",
  });
  assert.equal(s.calls.decode.length, 0);
  assert.equal(s.calls.held.length, 1);
  assert.ok(s.calls.shown.includes("actual Nimi text"));
  assert.equal(listeners.has("dictation-preview-audio"), false);
});
test("completion and dismiss remain ordered after native preview creation", async (t) => {
  const s = scenario(t);
  await s.start();
  await s.invoke("update-dictation-preview", "returned text");
  await s.invoke("dismiss-dictation-preview");
  assert.equal(s.calls.hidden, 1);
  assert.deepEqual(await s.invoke("stop-dictation-preview"), {
    success: true,
    streamed: false,
    text: "",
  });
});
