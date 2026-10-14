const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
// The renderer asks the Host to commit the captured result under the same request ID.
// Actual transactional persistence is covered by the Nimi upload Host tests.
async function waitForQueueSettled(store, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { queue, isProcessing } = store.getState();
    if (!isProcessing && queue.every((i) => i.status === "done" || i.status === "error")) {
      return queue;
    }
    if (Date.now() > deadline) {
      throw new Error(`queue never settled: ${JSON.stringify(store.getState().queue)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const source of ["file", "url"])
  for (const enabled of [true, false]) {
    test(`${source} upload commits the Host-owned result with diarization=${enabled}`, async (t) => {
      const calls = [],
        deleted = [];
      const { window } = installBrowserGlobals(t);
      Object.assign(window.electronAPI, {
        onUrlDownloadProgress: () => () => {},
        downloadUrlAudio: async () => ({
          success: true,
          tempPath: "/tmp/download.m4a",
          title: "Board recording",
          sizeBytes: 4096,
          durationSeconds: 9999,
        }),
        deleteTempFile: (path) => deleted.push(path),
        cancelUrlDownload: () => {},
        saveNote: () => assert.fail("renderer must not commit its own transcription"),
        updateNote: () => assert.fail("renderer must not overwrite Host timing/speaker metadata"),
      });
      globalThis.__uploadRequest = async (command, payload, signal) => {
        calls.push({ command, payload, signal });
        if (command === "openwhispr.ai.transcribe-file")
          return {
            success: true,
            text: "hello from the recording",
            durationSeconds: 4359.87,
            segments: [{ text: "hello", start: 0, end: 2, speaker: "Speaker 1" }],
            diarized: enabled,
          };
        if (command === "openwhispr.upload.commit-note") return { success: true, note: { id: 7 } };
        if (command === "openwhispr.ai.detach") return {};
        assert.fail(`unexpected command ${command}`);
      };
      t.after(() => {
        delete globalThis.__uploadRequest;
      });
      const vite = await createRendererServer(t, {
        cachePrefix: "openwhispr-upload-handoff-",
        mockModules: {
          "/nimiClient":
            "export const runNimiRequest=(...args)=>globalThis.__uploadRequest(...args);export const invokeNimiBusiness=runNimiRequest;",
          "./settingsStore": "export const getSettings=()=>({});",
          "./policyStore": "export const usePolicyStore={getState:()=>({})};",
          "./policyRules": "export const isNimiBusinessAIAllowed=()=>true;",
        },
      });
      const store = await vite.ssrLoadModule("/stores/batchQueueStore.ts");
      if (source === "file")
        store.addFiles([{ name: "board.m4a", path: "/tmp/board.m4a", sizeBytes: 2048 }]);
      else store.addUrls(["https://example.com/board.mp4"]);
      store.processBatchQueue(
        { transcription: { language: "en" }, folderId: null },
        { enabled, numSpeakers: enabled ? 2 : null }
      );
      const queue = await waitForQueueSettled(store.useBatchQueueStore);
      assert.equal(queue[0].status, "done");
      assert.equal(queue[0].noteId, 7);
      const [transcription, commit, detach] = calls;
      assert.equal(transcription.command, "openwhispr.ai.transcribe-file");
      assert.equal(transcription.payload.diarization, enabled);
      assert.equal(transcription.payload.timestamps, true);
      assert.equal(transcription.payload.retainForNote, true);
      assert.equal(commit.command, "openwhispr.upload.commit-note");
      assert.equal(commit.payload.requestId, transcription.payload.requestId);
      assert.deepEqual(Object.keys(commit.payload).sort(), [
        "folderId",
        "requestId",
        "sourceName",
        "title",
      ]);
      assert.equal(commit.signal, transcription.signal);
      assert.equal(detach.payload.requestId, commit.payload.requestId);
      assert.deepEqual(deleted, source === "url" ? ["/tmp/download.m4a"] : []);
    });
  }
