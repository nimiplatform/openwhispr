const fs = require("node:fs");
const path = require("node:path");
const { getSafeTempDir } = require("./safeTempDir");
const { transcribeNimiFile } = require("./nimiFileTranscription");

const rowIdentity = (row) =>
  JSON.stringify([
    row.id,
    row.client_transcription_id,
    row.timestamp,
    row.created_at,
    row.text,
    row.raw_text,
    row.status,
    row.recognition_result,
  ]);

async function retryNimiHistory(
  scope,
  input,
  owner,
  { transcribe, assertCurrent, editText },
  fileTranscriber = transcribeNimiFile
) {
  const fields = new Set([
    "requestId",
    "id",
    "language",
    "prompt",
    "preferredLanguage",
    "cleanupPrompt",
    "translationPrompt",
    "translationSourceLanguage",
    "translationTargetLanguage",
    "chineseScriptPreference",
  ]);
  if (Object.keys(input).some((key) => !fields.has(key)))
    throw new Error("Unsupported history retry input");
  for (const field of fields) {
    if (field === "id" || input[field] === undefined) continue;
    if (
      typeof input[field] !== "string" ||
      Buffer.byteLength(input[field], "utf8") > (field === "prompt" ? 4096 : 32768)
    )
      throw new Error("Invalid history retry input: " + field);
  }
  if (!Number.isSafeInteger(input.id) || input.id <= 0) throw new Error("Invalid history identity");
  const row = owner.database.getTranscriptionById(input.id);
  const audio = owner.audioStorage.getAudioPath(input.id);
  if (!row || !audio) throw new Error("Retained recording is unavailable");
  const identity = rowIdentity(row);
  const stat = fs.statSync(audio);
  if (!stat.isFile() || !stat.size) throw new Error("Retained recording is empty");
  const current = () => {
    assertCurrent(scope);
    const next = owner.database.getTranscriptionById(input.id);
    if (
      !next ||
      rowIdentity(next) !== identity ||
      owner.audioStorage.getAudioPath(input.id) !== audio
    )
      throw new Error("History changed during retry");
    const nextStat = fs.statSync(audio);
    if (nextStat.size !== stat.size || nextStat.mtimeMs !== stat.mtimeMs)
      throw new Error("Retained recording changed during retry");
  };
  current();
  scope.historyId = input.id;
  scope.directory = fs.mkdtempSync(path.join(getSafeTempDir(), "ow-nimi-upload-"));
  scope.originalName = path.basename(audio);
  scope.originalPath = path.join(scope.directory, path.basename(audio));
  await fs.promises.copyFile(audio, scope.originalPath);
  current();
  const result = await fileTranscriber(
    scope,
    { language: input.language || "", prompt: input.prompt || "", timestamps: false },
    {
      transcribe,
      assertCurrent: current,
    },
    true
  );
  current();
  if (!result.text)
    throw Object.assign(new Error("No speech was detected in the retained recording"), {
      code: "NO_SPEECH_DETECTED",
    });
  const rawText = result.text;
  let text = rawText;
  let translated = false;
  const warnings = [];
  const editing = {};
  for (const [stage, prompt] of [
    ["cleanup", input.cleanupPrompt],
    ["translation", row.route_kind === "translation" ? input.translationPrompt : undefined],
  ]) {
    if (!prompt) {
      editing[stage] = { status: "not_requested" };
      continue;
    }
    current();
    try {
      const edited = await editText(scope, text, prompt);
      current();
      if (!edited.trim()) throw new Error("Nimi returned empty editing output");
      if (stage === "translation") {
        translated = edited.trim().replace(/\s+/g, " ") !== text.trim().replace(/\s+/g, " ");
        if (!translated) warnings.push({ stage, message: "Translation returned unchanged text" });
      }
      editing[stage] = {
        status: stage === "translation" && !translated ? "unchanged" : "completed",
      };
      text = edited;
    } catch (error) {
      current(); // Cancellation/scope loss must not become a soft editing failure.
      warnings.push({ stage, message: error.message });
      editing[stage] = { status: "failed", message: error.message };
    }
  }
  const { applyChineseScript, resolveChineseScriptTarget } =
    await import("../utils/chineseScript.js");
  const outputLanguage =
    row.route_kind === "translation"
      ? (translated ? input.translationTargetLanguage : input.translationSourceLanguage) || "auto"
      : input.preferredLanguage || "auto";
  text = await applyChineseScript(
    text,
    resolveChineseScriptTarget(outputLanguage, input.chineseScriptPreference, text)
  );
  // Use the same single-pass final-body rule as ordinary dictation. Saved
  // snippets are App preferences; raw recognition and editing evidence stay raw.
  const { expandSnippets } = await import("../utils/snippets.ts");
  current();
  text = expandSnippets(text, owner.database.getSnippets());
  current();
  const languages = result.chunks
    .filter((chunk) => chunk.transcript.status === "transcribed")
    .map((chunk) => chunk.transcript.language);
  const recognition = {
    transcript: {
      status: "transcribed",
      text: rawText,
      language:
        languages.length && languages.every((language) => language === languages[0])
          ? languages[0]
          : "",
      words: result.segments.map((segment) => ({
        text: segment.text,
        startSeconds: segment.start,
        endSeconds: segment.end,
      })),
    },
    chunks: result.chunks,
    editing,
  };
  owner.database.db.transaction(() => {
    current();
    owner.database.updateTranscriptionText(input.id, text, rawText);
    owner.database.updateTranscriptionStatus(input.id, "completed");
    owner.database.updateTranscriptionAudio(input.id, {
      hasAudio: 1,
      audioDurationMs: result.durationSeconds * 1000,
      provider: "nimi",
      model: null,
    });
    owner.database.db
      .prepare("UPDATE transcriptions SET recognition_result = ? WHERE id = ?")
      .run(JSON.stringify(recognition), input.id);
  })();
  const updated = owner.database.getTranscriptionById(input.id);
  try {
    owner.onHistorySaved(updated);
  } catch (error) {
    warnings.push({
      stage: "notification",
      message: "History was committed but some windows could not be notified",
    });
    require("./debugLogger").warn("Committed history notification failed", {
      error: error.message,
    });
  }
  return { success: true, transcription: updated, warnings };
}

module.exports = { retryNimiHistory };
