const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPreloadApi() {
  let exposedApi;
  const listeners = new Map();
  const invocations = [];
  const sends = [];
  const ipcRenderer = {
    invoke: async (...args) => {
      invocations.push(args);
      return undefined;
    },
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
    send: (...args) => sends.push(args),
    sendSync: () => undefined,
  };
  const electron = {
    contextBridge: {
      exposeInMainWorld: (_name, api) => {
        exposedApi = api;
      },
    },
    ipcRenderer,
    webUtils: {},
  };
  const source = fs.readFileSync(path.join(__dirname, "../../preload.js"), "utf8");
  vm.runInNewContext(source, {
    require: (specifier) => {
      if (specifier === "electron") return electron;
      if (specifier === "@nimiplatform/kit/shell/electron/preload-cjs")
        return {
          installNimiElectronRuntimeBridge: (input) => {
            assert.equal(input.contextBridge, electron.contextBridge);
            assert.equal(input.ipcRenderer, ipcRenderer);
          },
        };
      throw new Error(`Unexpected preload dependency: ${specifier}`);
    },
    process,
  });
  return { api: exposedApi, invocations, listeners, sends };
}

test("auth token-state listener strips the Electron event object", () => {
  const { api, listeners } = loadPreloadApi();
  const payload = { generation: 7, hasToken: true };
  let received;
  const unsubscribe = api.onAuthTokenStateChanged((state) => {
    received = state;
  });

  listeners.get("auth-token-state-changed")?.({ sender: "ipc" }, payload);

  assert.equal(received, payload);
  unsubscribe();
  assert.equal(listeners.has("auth-token-state-changed"), false);
});

test("account ownership operations forward the account and credential generation", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.setActiveAccountScope("account-a", 7);
  await api.deleteAccountData("account-a", 7, { erasingDevice: true });

  assert.deepEqual(invocations, [
    ["set-active-account-scope", "account-a", 7],
    // Erasing the device also revokes a Gmail grant shared with a calendar.
    ["delete-account-data", "account-a", 7, { erasingDevice: true }],
  ]);
});

test("meeting stop forwards the optional expected recording session ID", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.meetingTranscriptionStop("meeting-2");

  assert.deepEqual(invocations, [["meeting-transcription-stop", "meeting-2"]]);
});

test("meeting system-audio availability forwards the scoped session", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.meetingTranscriptionSetSystemAudioAvailable("meeting-2", true);

  assert.deepEqual(invocations, [
    ["meeting-transcription-set-system-audio-available", "meeting-2", true],
  ]);
});

test("meeting auto-end listener strips the event and can unsubscribe", () => {
  const { api, listeners } = loadPreloadApi();
  const payload = { sessionId: "meeting-2" };
  let received;
  const unsubscribe = api.onMeetingAutoEndRequested((request) => {
    received = request;
  });

  listeners.get("meeting-auto-end-requested")?.({ sender: "ipc" }, payload);

  assert.equal(received, payload);
  unsubscribe();
  assert.equal(listeners.has("meeting-auto-end-requested"), false);
});

test("assistant busy state is forwarded to the main-process hotkey guard", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.setAssistantPanelBusy(true);

  assert.deepEqual(invocations, [["set-assistant-panel-busy", true]]);
});

test("dictation lifecycle and audio levels preserve companion routing metadata", () => {
  const { api, sends } = loadPreloadApi();

  api.dictationLifecycleStateChanged("recording", "assistant");
  api.dictationAudioLevelChanged(0.42);

  assert.deepEqual(sends, [
    ["dictation-lifecycle-state-changed", "recording", "assistant"],
    ["dictation-audio-level-changed", 0.42],
  ]);
});

test("the Agent companion owns only its scoped window bridges", async () => {
  const { api, invocations, sends } = loadPreloadApi();

  await api.resizeAgentDictationPillToContent(240);
  await api.resizeAgentDictationPillToContent(null);
  await api.setAgentDictationPillInteractivity(true);
  await api.cancelAgentPanelDictation();
  api.showAgentDictationFinalTranscript("recovered text");

  assert.deepEqual(invocations, [
    ["resize-agent-dictation-pill-to-content", 240],
    ["resize-agent-dictation-pill-to-content", null],
    ["set-agent-dictation-pill-interactivity", true],
    ["cancel-agent-panel-dictation"],
  ]);
  assert.deepEqual(
    sends.filter(([channel]) => channel === "show-agent-dictation-final-transcript"),
    [["show-agent-dictation-final-transcript", "recovered text"]]
  );
});

test("prepare-dictation forwards the input kind without the Electron event", () => {
  const { api, listeners } = loadPreloadApi();
  const received = [];
  const dispose = api.onPrepareDictation((options) => received.push(options));

  listeners.get("prepare-dictation")?.({ senderId: 1 }, { inputKind: "assistant" });

  dispose();
  assert.deepEqual(received, [{ inputKind: "assistant" }]);
  assert.equal(listeners.has("prepare-dictation"), false);
});

test("retired provider transports are absent from the business preload", () => {
  const { api } = loadPreloadApi();
  for (const name of [
    "startAgentStream",
    "cancelCloudReason",
    "cancelEnterpriseReasoning",
    "cancelCloudTranscription",
    "onAgentStreamChunk",
  ])
    assert.equal(api[name], undefined);
});
