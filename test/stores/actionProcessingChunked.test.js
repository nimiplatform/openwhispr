const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const ACTION = { id: 1, name: "Generate Notes", prompt: "Summarize the meeting." };
const LABELS = {
  noModel: "Nimi model unavailable",
  noEndpoint: "obsolete endpoint",
  actionFailed: "failed",
};
async function loadStore(t, { state = "ready", processText } = {}) {
  const updates = [],
    calls = [],
    legacyCalls = [];
  installBrowserGlobals(t, {
    initialStorage: { noteFormattingMode: "self-hosted", noteFormattingRemoteUrl: "" },
    window: {
      electronAPI: {
        updateNote: async (id, value) => {
          updates.push({ id, value });
          return { success: true };
        },
        getNote: async () => ({ enhanced_content: "prior summary" }),
        getLocalContextBudget: async () => {
          legacyCalls.push("budget");
          throw new Error("retired owner");
        },
        cancelLocalReasoning: async () => {
          legacyCalls.push("cancel");
        },
      },
    },
  });
  globalThis.__nimiNoteStep = async (text, config) => {
    calls.push({ text, config });
    return processText ? processText(text, config, calls.length) : "Declared note output";
  };
  globalThis.__nimiNoteState = state;
  t.after(() => {
    delete globalThis.__nimiNoteStep;
    delete globalThis.__nimiNoteState;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "nimi-action-parts-test-",
    mockModules: {
      "/services/nimiClient": `export const getNimiClient = () => ({ aiConfig: { get: async () => ({ effectiveSelections: [{ capabilityContract: "text.generate", state: globalThis.__nimiNoteState }] }) } });`,
      "/services/ReasoningService": `export default { processText: (text, _unused, _agent, config) => globalThis.__nimiNoteStep(text, config) };`,
      "/utils/generateTitle": `export const generateNoteTitle = async () => undefined;`,
    },
  });
  const store = await vite.ssrLoadModule("/stores/actionProcessingStore.ts");
  return { store, updates, calls, legacyCalls };
}
async function waitFor(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("timed out");
}
const inputLimit = () =>
  Object.assign(new Error("declared Runtime input refusal"), {
    reasonCode: "AI_INPUT_LIMIT_EXCEEDED",
  });
const material = () => ({
  notes: "Manual notes: keep the budget.",
  meetingContext: "Named people: 林遥.",
  transcript: "林遥: Wednesday orbit, Friday budget, 720000 yuan.\n".repeat(2500),
});
const run = (f, options = {}) => {
  const m = material();
  f.store.runBackgroundAction(
    1,
    m.transcript,
    "hash",
    ACTION,
    { material: m, isMeetingNote: true, ...options },
    LABELS
  );
};
test("Nimi readiness admits notes without old model or self-hosted endpoint choices", async (t) => {
  const f = await loadStore(t);
  run(f);
  await waitFor(() => f.updates.length);
  assert.equal(f.calls.length, 1);
  assert.equal(f.legacyCalls.length, 0);
  assert.ok(f.calls[0].config.signal instanceof AbortSignal);
});
test("unavailable Nimi text reports its real settings entry without calling inference", async (t) => {
  const f = await loadStore(t, { state: "blocked" });
  run(f);
  await waitFor(() => f.store.useActionProcessingStore.getState().errorEvents.length);
  assert.equal(f.calls.length, 0);
  assert.equal(f.updates.length, 0);
  assert.equal(f.store.consumeErrorEvents()[0].settingsTarget, "llms");
});
test("a Runtime limit splits only the transcript then merges actual part replies", async (t) => {
  const f = await loadStore(t, {
    processText: (_text, config, count) => {
      if (count === 1) throw inputLimit();
      return /this part only/i.test(config.systemPrompt)
        ? "Declared part details"
        : "Declared merged notes";
    },
  });
  run(f);
  await waitFor(() => f.updates.length);
  const parts = f.calls.filter((c) => /this part only/i.test(c.config.systemPrompt));
  assert.ok(parts.length > 1);
  assert.ok(parts.every((c) => c.text.includes("Named people: 林遥.")));
  const merged = f.calls.at(-1);
  assert.ok(merged.text.includes("Manual notes: keep the budget."));
  assert.ok(merged.text.includes("Declared part details"));
  assert.equal(f.legacyCalls.length, 0);
  assert.equal(f.updates[0].value.enhanced_content, "Declared merged notes");
});
test("a refused part is divided further without fabricated model capacity", async (t) => {
  let partRefused = false;
  const f = await loadStore(t, {
    processText: (_text, config, count) => {
      if (count === 1) throw inputLimit();
      if (/this part only/i.test(config.systemPrompt) && !partRefused) {
        partRefused = true;
        throw inputLimit();
      }
      return "Declared details";
    },
  });
  run(f);
  await waitFor(() => f.updates.length);
  assert.ok(partRefused);
  assert.equal(f.legacyCalls.length, 0);
});
test("empty part output cannot silently remove its original recording", async (t) => {
  const f = await loadStore(t, {
    processText: (_text, _config, count) => {
      if (count === 1) throw inputLimit();
      return "";
    },
  });
  run(f);
  await waitFor(() => f.store.useActionProcessingStore.getState().errorEvents.length);
  assert.equal(f.updates.length, 0);
  assert.equal(f.store.consumeErrorEvents()[0].messageKey, "notes.actions.emptyReply");
});
test("plain notes refused by Runtime are never condensed as if they were transcripts", async (t) => {
  const f = await loadStore(t, {
    processText: () => {
      throw inputLimit();
    },
  });
  f.store.runBackgroundAction(1, "Original plain notes", "hash", ACTION, {}, LABELS);
  await waitFor(() => f.store.useActionProcessingStore.getState().errorEvents.length);
  assert.equal(f.calls.length, 1);
  assert.equal(f.updates.length, 0);
});
test("cancel aborts the exact Nimi call and prevents its late note write", async (t) => {
  let complete;
  const f = await loadStore(t, {
    processText: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  run(f);
  await waitFor(() => complete);
  f.store.cancelAction(1);
  assert.equal(f.calls[0].config.signal.aborted, true);
  complete("Declared late output");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.updates.length, 0);
  assert.equal(f.legacyCalls.length, 0);
});
