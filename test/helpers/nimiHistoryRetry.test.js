const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimi-history-owner-"));
const load = Module._load;
Module._load = function (name, parent, main) {
  if (name === "electron")
    return {
      app: {
        getPath: () => root,
        getAppPath: () => process.cwd(),
        isReady: () => false,
        isPackaged: false,
      },
    };
  return load.call(this, name, parent, main);
};
const DatabaseManager = require("../../src/helpers/database");
const AudioStorage = require("../../src/helpers/audioStorage");
const { retryNimiHistory } = require("../../src/helpers/nimiHistoryRetry");
const { cleanupNimiFile } = require("../../src/helpers/nimiFileTranscription");
Module._load = load;

function fixture() {
  const database = new DatabaseManager();
  database.setSnippets([]);
  const audioStorage = new AudioStorage();
  const saved = database.saveTranscription("Before retry", "Earlier recognition");
  const id = saved.transcription.id;
  audioStorage.saveAudio(id, Buffer.from("declared retained recording fixture"));
  database.updateTranscriptionAudio(id, {
    hasAudio: 1,
    audioDurationMs: 301000,
    provider: "old",
    model: "old",
  });
  const controller = new AbortController();
  const scope = { controller };
  const raw = {
    status: "transcribed",
    text: "原始字词",
    language: "zh",
    words: [{ text: "原始字词", startSeconds: 0.5, endSeconds: 0.9 }],
  };
  const result = {
    text: raw.text,
    durationSeconds: 301,
    chunks: [
      { offsetSeconds: 300, durationSeconds: 1, transcript: raw, jobId: "declared-consumer-job" },
    ],
    segments: [{ text: raw.text, start: 300.5, end: 300.9 }],
  };
  const published = [];
  const owner = { database, audioStorage, onHistorySaved: (row) => published.push(row) };
  const deps = {
    assertCurrent: () => controller.signal.throwIfAborted(),
    transcribe: () => {
      throw new Error("file consumer owns transcription");
    },
    editText: async (_scope, text) => text,
  };
  const input = { id, preferredLanguage: "auto", chineseScriptPreference: "as-transcribed" };
  const cleanup = () => {
    cleanupNimiFile(scope);
    database.db.close();
  };
  return {
    id,
    database,
    audioStorage,
    controller,
    scope,
    result,
    published,
    owner,
    deps,
    input,
    cleanup,
  };
}

test("history retry commits raw chunks and exact offsets together and retains the recording", async () => {
  const f = fixture();
  try {
    const saved = await retryNimiHistory(f.scope, f.input, f.owner, f.deps, async (scope) => {
      assert.equal(
        fs.readFileSync(scope.originalPath, "utf8"),
        "declared retained recording fixture"
      );
      return f.result;
    });
    const recognition = JSON.parse(saved.transcription.recognition_result);
    assert.equal(saved.transcription.raw_text, f.result.text);
    assert.deepEqual(recognition.chunks, f.result.chunks);
    assert.equal(recognition.transcript.words[0].startSeconds, 300.5);
    assert.equal(saved.transcription.provider, "nimi");
    assert.equal(saved.transcription.audio_duration_ms, 301000);
    assert.equal(f.published.length, 1);
    assert.equal(
      fs.readFileSync(f.audioStorage.getAudioPath(f.id), "utf8"),
      "declared retained recording fixture"
    );
  } finally {
    f.cleanup();
  }
});

for (const stage of ["transcription", "cleanup"])
  test(`cancel during ${stage} makes no history write and keeps the audio`, async () => {
    const f = fixture();
    try {
      if (stage === "cleanup") f.input.cleanupPrompt = "declared cleanup instruction";
      f.deps.editText = async () => {
        f.controller.abort();
        return "late editing output";
      };
      await assert.rejects(
        retryNimiHistory(f.scope, f.input, f.owner, f.deps, async () => {
          if (stage === "transcription") f.controller.abort();
          return f.result;
        }),
        { name: "AbortError" }
      );
      assert.equal(f.database.getTranscriptionById(f.id).text, "Before retry");
      assert.equal(f.published.length, 0);
      assert.ok(fs.existsSync(f.audioStorage.getAudioPath(f.id)));
    } finally {
      f.cleanup();
    }
  });

test("retry expands the saved snippet in final text while raw recognition stays unchanged", async () => {
  const f = fixture();
  try {
    f.database.setSnippets([{ trigger: f.result.text, replacement: "用户明确保存的展开正文" }]);
    const saved = await retryNimiHistory(f.scope, f.input, f.owner, f.deps, async () => f.result);
    assert.equal(saved.transcription.text, "用户明确保存的展开正文");
    assert.equal(saved.transcription.raw_text, f.result.text);
    const raw = JSON.parse(saved.transcription.recognition_result);
    assert.equal(raw.transcript.text, f.result.text);
    assert.deepEqual(raw.chunks, f.result.chunks);
  } finally {
    f.cleanup();
  }
});
test("retry applies the shared single-pass snippet rule after editing", async () => {
  const f = fixture();
  try {
    f.input.cleanupPrompt = "declared editing fixture";
    f.deps.editText = async () => "spoken trigger";
    f.database.setSnippets([{ trigger: "spoken trigger", replacement: "$5\ncomplete saved text" }]);
    const saved = await retryNimiHistory(f.scope, f.input, f.owner, f.deps, async () => f.result);
    assert.equal(saved.transcription.text, "$5\ncomplete saved text");
    assert.equal(saved.transcription.raw_text, f.result.text);
    assert.equal(
      JSON.parse(saved.transcription.recognition_result).editing.cleanup.status,
      "completed"
    );
  } finally {
    f.cleanup();
  }
});
test("snippet expansion cannot publish after cancellation and cannot accept caller-defined snippets", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      retryNimiHistory(f.scope, { ...f.input, snippets: [] }, f.owner, f.deps, async () => {
        throw new Error("must not transcribe");
      }),
      /Unsupported history retry input/
    );
    f.database.getSnippets = () => {
      f.controller.abort();
      return [{ trigger: f.result.text, replacement: "late body" }];
    };
    await assert.rejects(
      retryNimiHistory(f.scope, f.input, f.owner, f.deps, async () => f.result),
      { name: "AbortError" }
    );
    assert.equal(f.database.getTranscriptionById(f.id).text, "Before retry");
    assert.equal(f.published.length, 0);
  } finally {
    f.cleanup();
  }
});

test("a changed row cannot receive the late recognition", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      retryNimiHistory(f.scope, f.input, f.owner, f.deps, async () => {
        f.database.updateTranscriptionText(f.id, "Concurrent manual edit", "Earlier recognition");
        return f.result;
      }),
      /History changed/
    );
    assert.equal(f.database.getTranscriptionById(f.id).text, "Concurrent manual edit");
    assert.equal(f.published.length, 0);
  } finally {
    f.cleanup();
  }
});

test("failed editing is disclosed while the actual raw result persists", async () => {
  const f = fixture();
  try {
    f.input.cleanupPrompt = "declared cleanup instruction";
    f.deps.editText = async () => {
      throw new Error("declared editing failure");
    };
    const saved = await retryNimiHistory(f.scope, f.input, f.owner, f.deps, async () => f.result);
    assert.deepEqual(saved.warnings, [{ stage: "cleanup", message: "declared editing failure" }]);
    assert.equal(saved.transcription.text, f.result.text);
    assert.equal(saved.transcription.raw_text, f.result.text);
    assert.deepEqual(JSON.parse(saved.transcription.recognition_result).chunks, f.result.chunks);
    assert.deepEqual(JSON.parse(saved.transcription.recognition_result).editing.cleanup, {
      status: "failed",
      message: "declared editing failure",
    });
  } finally {
    f.cleanup();
  }
});

test("a failed commit rolls back text, status and recognition without retiring the media", async () => {
  const f = fixture();
  try {
    f.database.updateTranscriptionStatus = () => {
      throw new Error("declared SQLite write failure");
    };
    await assert.rejects(
      retryNimiHistory(f.scope, f.input, f.owner, f.deps, async () => f.result),
      /SQLite write failure/
    );
    const row = f.database.getTranscriptionById(f.id);
    assert.equal(row.text, "Before retry");
    assert.equal(row.raw_text, "Earlier recognition");
    assert.equal(row.recognition_result, null);
    assert.equal(f.published.length, 0);
    assert.ok(fs.existsSync(f.audioStorage.getAudioPath(f.id)));
  } finally {
    f.cleanup();
  }
});

test("retry refuses provider/model selectors rather than opening a legacy route", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      retryNimiHistory(
        f.scope,
        { ...f.input, model: "old-selector" },
        f.owner,
        f.deps,
        async () => f.result
      ),
      /Unsupported history retry input/
    );
    assert.equal(f.database.getTranscriptionById(f.id).text, "Before retry");
  } finally {
    f.cleanup();
  }
});

test("post-commit notification failure cannot deny the stored result or retire its audio", async () => {
  const f = fixture();
  try {
    f.owner.onHistorySaved = () => {
      throw new Error("declared window notification failure");
    };
    const saved = await retryNimiHistory(f.scope, f.input, f.owner, f.deps, async () => f.result);
    assert.equal(saved.success, true);
    assert.equal(f.database.getTranscriptionById(f.id).raw_text, f.result.text);
    assert.equal(saved.warnings[0].stage, "notification");
    assert.ok(fs.existsSync(f.audioStorage.getAudioPath(f.id)));
  } finally {
    f.cleanup();
  }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
