const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Hook-level lifecycle regressions at the normalized Nimi stream boundary.
// Real AI SDK instruction/tool contracts are tested in the service suite.
const EMPTY_RESPONSE_TEXT = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
).agentMode.chat.emptyResponse;

async function renderChatStreaming(
  t,
  {
    electronAPI = {},
    settings = {},
    onStreamComplete,
    live = false,
    stream,
    searchNotes = async () => [],
    onRequest = () => {},
  } = {}
) {
  installBrowserGlobals(t, { window: { electronAPI } });
  const container = live ? installHookDom(t) : null;
  globalThis.__cancelReasoning = {
    processTextStreamingAI: (...args) => {
      onRequest(...args);
      return stream
        ? stream.read()
        : (async function* () {
            yield { type: "done" };
          })();
    },
    cancelActiveStream: () => stream?.cancel(),
    destroy() {},
  };
  globalThis.__cancelSearch = searchNotes;
  t.after(() => {
    delete globalThis.__cancelReasoning;
    delete globalThis.__cancelSearch;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-streaming-cancellation-test-",
    mockModules: {
      "/services/ReasoningService": "export default globalThis.__cancelReasoning;",
      "/nimiNotes":
        "export const searchNimiNotes=(...args)=>globalThis.__cancelSearch(...args);export const readNimiNote=()=>{throw new Error('unexpected note read');};",
    },
  });
  const [{ default: viteI18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  if (!viteI18next.isInitialized) {
    const translation = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await viteI18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation } },
      interpolation: { escapeValue: false },
    });
  }

  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.3", policy: null });
  useSettingsStore.setState({
    chatAgentMode: "self-hosted",
    chatAgentProvider: "lan",
    chatAgentModel: "qwen3-4b-q4_k_m",
    chatAgentRemoteUrl: "http://127.0.0.1:11434/v1",
    chatAgentDisableThinking: true,
    isSignedIn: false,
    ...settings,
  });

  const { useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts");
  await (await vite.ssrLoadModule("/i18n.ts")).default.changeLanguage("en");
  let messages = [];
  let responseContentCalls = 0;
  const setMessages = (updater) => {
    messages = typeof updater === "function" ? updater(messages) : updater;
  };

  let captured = null;
  function Harness() {
    captured = useChatStreaming({
      messages,
      setMessages,
      onStreamComplete,
      onResponseContent: () => {
        responseContentCalls += 1;
      },
    });
    return null;
  }

  let unmount;
  if (live) {
    const { createRoot } = require("react-dom/client");
    const root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Harness)));
    let unmounted = false;
    unmount = async () => {
      if (unmounted) return;
      unmounted = true;
      await React.act(async () => root.unmount());
    };
    t.after(unmount);
  } else {
    renderToStaticMarkup(React.createElement(Harness));
  }

  return {
    captured,
    getMessages: () => messages,
    getResponseContentCalls: () => responseContentCalls,
    unmount,
  };
}

function pendingStream(text) {
  const started = Promise.withResolvers(),
    tail = Promise.withResolvers();
  let canceled = false;
  return {
    started: started.promise,
    async *read() {
      started.resolve();
      if (text) yield { type: "content", text };
      await tail.promise;
      if (canceled) throw new DOMException("aborted", "AbortError");
      yield { type: "done" };
    },
    cancel() {
      canceled = true;
      tail.resolve();
    },
    finish() {
      tail.resolve();
    },
  };
}
test("a genuine empty completion shows the fallback without request delivery", async (t) => {
  let delivered = 0;
  const h = await renderChatStreaming(t);
  await h.captured.sendToAI("hello", [], {
    suppressResponseContent: true,
    onComplete: () => delivered++,
  });
  assert.equal(h.getMessages()[0].content, EMPTY_RESPONSE_TEXT);
  assert.equal(h.getMessages()[0].isStreaming, false);
  assert.equal(delivered, 0);
});
test("completed content is delivered without opening response content when suppressed", async (t) => {
  const completions = [];
  const h = await renderChatStreaming(t, {
    stream: {
      async *read() {
        yield { type: "content", text: "Agent answer" };
        yield { type: "done" };
      },
      cancel() {},
    },
  });
  await h.captured.sendToAI("hello", [], {
    suppressResponseContent: true,
    onComplete: (result) => completions.push(result),
  });
  assert.equal(h.getResponseContentCalls(), 0);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].content, "Agent answer");
});
test("cancellation during Nimi note search does not start a model or assistant reply", async (t) => {
  const search = Promise.withResolvers(),
    started = Promise.withResolvers();
  let modelCalls = 0;
  const h = await renderChatStreaming(t, {
    searchNotes: () => {
      started.resolve();
      return search.promise;
    },
    onRequest: () => modelCalls++,
  });
  const completion = h.captured.sendToAI("hello", []);
  await started.promise;
  h.captured.cancelStream();
  search.resolve([]);
  await completion;
  assert.deepEqual(h.getMessages(), []);
  assert.equal(modelCalls, 0);
});
test("cancel before the first token ends silently without delivery or persistence", async (t) => {
  const stream = pendingStream();
  let persisted = 0,
    delivered = 0;
  const h = await renderChatStreaming(t, { stream, onStreamComplete: () => persisted++ });
  const completion = h.captured.sendToAI("hello", [], { onComplete: () => delivered++ });
  await stream.started;
  h.captured.cancelStream();
  await completion;
  assert.equal(h.getMessages()[0].content, "");
  assert.equal(h.getMessages()[0].isStreaming, false);
  assert.equal(h.getResponseContentCalls(), 0);
  assert.equal(persisted, 0);
  assert.equal(delivered, 0);
});
test("unmount persists the received partial reply without delivering it", async (t) => {
  const stream = pendingStream("Partial reply"),
    persisted = [];
  let delivered = 0,
    completion;
  const h = await renderChatStreaming(t, {
    stream,
    live: true,
    onStreamComplete: (_id, text) => persisted.push(text),
  });
  await React.act(async () => {
    completion = h.captured.sendToAI("hello", [], { onComplete: () => delivered++ });
    await stream.started;
    for (let i = 0; i < 50 && !h.getMessages().some((m) => m.content === "Partial reply"); i++)
      await new Promise((r) => setTimeout(r, 10));
  });
  assert.ok(h.getMessages().some((m) => m.content === "Partial reply"));
  await h.unmount();
  await completion;
  assert.deepEqual(persisted, ["Partial reply"]);
  assert.equal(delivered, 0);
  assert.equal(h.getMessages()[0].isStreaming, false);
});
test("screen attachments use the Nimi model image part without fake prompt claims", async (t) => {
  const requests = [];
  const h = await renderChatStreaming(t, { onRequest: (...args) => requests.push(args) });
  await h.captured.sendToAI(
    "What is on screen?",
    [{ id: "user-1", role: "user", content: "What is on screen?", isStreaming: false }],
    { attachment: { image: "base64-image", mediaType: "image/png" } }
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0][0].at(-1).content, [
    { type: "text", text: "What is on screen?" },
    { type: "image", image: "base64-image", mediaType: "image/png" },
  ]);
  assert.doesNotMatch(requests[0][1].systemPrompt, /SCREEN CONTEXT:/);
});
