const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function owner() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimi-upload-life-"));
  const scopes = [];
  const cleanup = [];
  let authGeneration = 0;
  let throwCleanup = false;
  let pending;
  const modulePath = require.resolve("../../src/helpers/nimiAI");
  delete require.cache[modulePath];
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron")
      return {
        app: {
          getPath: () => root,
          getAppPath: () => process.cwd(),
          isReady: () => false,
          isPackaged: false,
        },
      };
    if (parent?.filename === modulePath && request === "./appData")
      return { getAppDataDirectory: () => root };
    if (request === "./tokenStore")
      return { getGeneration: () => authGeneration, subscribe: () => {} };
    if (parent?.filename === modulePath && request === "./debugLogger") return { warn: () => {} };
    if (parent?.filename === modulePath && request === "./nimiFileTranscription")
      return {
        transcribeNimiFile: async (scope, input) => {
          scopes.push(scope);
          if (input.wait)
            return new Promise((resolve) => {
              pending = resolve;
            });
          scope.originalName = "source.wav";
          scope.originalPath = path.join(root, "source.wav");
          scope.audioPath = scope.originalPath;
          fs.writeFileSync(scope.originalPath, "unit-media");
          scope.fileResult = {
            text: "unit-transcript",
            segments: [],
            chunks: [],
            durationSeconds: 1,
          };
          return scope.fileResult;
        },
        cleanupNimiFile: (scope) => {
          cleanup.push(scope);
          if (throwCleanup) throw new Error("busy unit file");
        },
      };
    return original.call(this, request, parent, isMain);
  };
  let ai;
  try {
    ai = require(modulePath);
  } finally {
    Module._load = original;
  }
  const database = {
    activeAccountId: "A",
    saveImportedNote: () => {
      assert.fail("unexpected commit");
    },
  };
  ai.configureUploadOwner({ database, onSaved() {} });
  ai.bindServices({});
  const input = (id, extra = {}) => ({
    event: { sender: { id: 1, isDestroyed: () => false, send() {} } },
    payload: { requestId: id, retainForNote: true, ...extra },
  });
  return {
    root,
    ai,
    scopes,
    cleanup,
    input,
    database,
    setGeneration(value) {
      authGeneration = value;
    },
    setCleanupFailure() {
      throwCleanup = true;
    },
    finishPending() {
      pending?.({ text: "late" });
    },
  };
}

test("a failed ready-file cleanup cannot stop aborting and unbinding other work", async () => {
  const state = owner();
  try {
    await state.ai.commandHandlers["openwhispr.ai.transcribe-file"](state.input("first"));
    const pending = state.ai.commandHandlers["openwhispr.ai.transcribe-file"](
      state.input("second", { wait: true })
    );
    state.setCleanupFailure();
    state.ai.invalidate();
    assert.equal(state.scopes[1].controller.signal.aborted, true);
    await assert.rejects(
      state.ai.commandHandlers["openwhispr.ai.transcribe-file"](state.input("new")),
      { code: "NIMI_SESSION_UNAVAILABLE" }
    );
    state.finishPending();
    await assert.rejects(pending, (error) => error.name === "AbortError");
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test("A to logout to A and invalid commit preparation cannot retain old upload work", async () => {
  const state = owner();
  try {
    await state.ai.commandHandlers["openwhispr.ai.transcribe-file"](state.input("old"));
    state.setGeneration(2);
    await assert.rejects(
      state.ai.commandHandlers["openwhispr.upload.commit-note"](
        state.input("old", { title: "new account" })
      ),
      /session changed/
    );
    await state.ai.commandHandlers["openwhispr.ai.cancel"](state.input("old"));
    await state.ai.commandHandlers["openwhispr.ai.transcribe-file"](state.input("bad-title"));
    await assert.rejects(
      state.ai.commandHandlers["openwhispr.upload.commit-note"](
        state.input("bad-title", { title: "" })
      ),
      /Invalid note title/
    );
    assert.equal(
      await (
        await state.ai.commandHandlers["openwhispr.ai.cancel"](state.input("bad-title"))
      ).requested,
      false
    );
    assert.ok(state.cleanup.length >= 2);
  } finally {
    state.ai.invalidate();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test("cancel while copying leaves cleanup to the in-flight commit and never writes a note", async () => {
  const state = owner();
  const actualCopy = fs.promises.copyFile;
  let release;
  try {
    await state.ai.commandHandlers["openwhispr.ai.transcribe-file"](state.input("copy"));
    fs.promises.copyFile = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const committing = state.ai.commandHandlers["openwhispr.upload.commit-note"](
      state.input("copy", { title: "copy" })
    );
    await state.ai.commandHandlers["openwhispr.ai.cancel"](state.input("copy"));
    assert.equal(state.cleanup.length, 0);
    release();
    await assert.rejects(committing, (error) => error.name === "AbortError");
    assert.equal(state.cleanup.length, 1);
  } finally {
    fs.promises.copyFile = actualCopy;
    state.ai.invalidate();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test("directory preparation failure releases committing work", async () => {
  const state = owner();
  const mkdir = fs.mkdirSync;
  try {
    await state.ai.commandHandlers["openwhispr.ai.transcribe-file"](state.input("mkdir"));
    fs.mkdirSync = (target, options) => {
      if (target === path.join(state.root, "imports"))
        throw new Error("unit directory preparation failed");
      return mkdir(target, options);
    };
    await assert.rejects(
      state.ai.commandHandlers["openwhispr.upload.commit-note"](
        state.input("mkdir", { title: "valid" })
      ),
      /directory preparation failed/
    );
    assert.equal(
      await (
        await state.ai.commandHandlers["openwhispr.ai.cancel"](state.input("mkdir"))
      ).requested,
      false
    );
    assert.equal(state.cleanup.length, 1);
  } finally {
    fs.mkdirSync = mkdir;
    state.ai.invalidate();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});
