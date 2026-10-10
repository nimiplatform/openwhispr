const fs = require("node:fs");
const path = require("node:path");
const { resolveAllowedAudioPath } = require("./audioFileAccess");
const { getSafeTempDir } = require("./safeTempDir");
const { convertToWav } = require("./ffmpegUtils");
const { readPcmWavInfo, readPcmWavWindow } = require("./nimiPcmWav");

async function transcribeNimiFile(
  scope,
  input,
  { transcribe, assertCurrent, onProgress },
  ownedRecording = false
) {
  const sourcePath = ownedRecording ? scope.originalPath : resolveAllowedAudioPath(input.filePath);
  if (!sourcePath) throw new Error("Choose an audio file before transcribing it");
  if (!ownedRecording) {
    scope.directory = fs.mkdtempSync(path.join(getSafeTempDir(), "ow-nimi-upload-"));
    scope.originalName = path.basename(sourcePath);
    scope.originalPath = path.join(scope.directory, `source${path.extname(sourcePath)}`);
    await fs.promises.copyFile(sourcePath, scope.originalPath);
  }
  scope.audioPath = path.join(scope.directory, "audio.wav");
  if (scope.audioPath === scope.originalPath)
    scope.audioPath = path.join(scope.directory, "normalized.wav");
  assertCurrent(scope);
  await convertToWav(scope.originalPath, scope.audioPath, {
    sampleRate: 16000,
    channels: 1,
    signal: scope.controller.signal,
  });
  assertCurrent(scope);
  const fd = fs.openSync(scope.audioPath, "r");
  try {
    const info = readPcmWavInfo(fd);
    const windowFrames = 300 * info.sampleRate;
    const chunksTotal = Math.ceil(info.frameCount / windowFrames);
    const chunks = [];
    const segments = [];
    for (let startFrame = 0; startFrame < info.frameCount; startFrame += windowFrames) {
      assertCurrent(scope);
      const frameCount = Math.min(windowFrames, info.frameCount - startFrame);
      const durationSeconds = frameCount / info.sampleRate;
      const offsetSeconds = startFrame / info.sampleRate;
      const result = await transcribe(scope, {
        audio: readPcmWavWindow(fd, info, startFrame, frameCount),
        mimeType: "audio/wav",
        language: input.language || "",
        prompt: input.prompt || "",
        timestamps: Boolean(input.timestamps),
        diarization: input.diarization === true,
      });
      assertCurrent(scope);
      if (
        result.transcript.diarization &&
        Math.abs(result.transcript.diarization.durationSeconds - durationSeconds) > 1 / info.sampleRate
      )
        throw new Error("The returned speaker clock differs from the original audio window");
      if (
        input.timestamps &&
        result.transcript.status === "transcribed" &&
        !result.transcript.words.length
      )
        throw new Error("The selected transcription resource returned no requested alignment");
      chunks.push({
        offsetSeconds,
        durationSeconds: frameCount / info.sampleRate,
        transcript: result.transcript,
        jobId: result.jobId,
        speakerMatching: result.speakerMatching,
        speakerMap: result.speakerMap,
      });
      for (const word of result.transcript.words) {
        if (
          typeof word.text !== "string" ||
          !Number.isFinite(word.startSeconds) ||
          !Number.isFinite(word.endSeconds) ||
          word.startSeconds < 0 ||
          word.endSeconds < word.startSeconds ||
          word.endSeconds > durationSeconds + 1 / info.sampleRate
        )
          throw new Error(
            "The selected transcription resource returned alignment outside the original audio window"
          );
        const speakerFields = require("./nimiSpeakerTracking").projectWordSpeaker(
          result.transcript,
          word.startSeconds,
          word.endSeconds,
          result.speakerMap,
          result.speakerMatching
        );
        segments.push({
          text: word.text,
          start: offsetSeconds + word.startSeconds,
          end: offsetSeconds + word.endSeconds,
          ...speakerFields,
          ...(speakerFields.speakerMatching && speakerFields.speakerMatching !== "matched-space"
            ? { speakerStatus: "provisional" }
            : {}),
        });
      }
      scope.speakerRepresentations = {
        ...scope.speakerRepresentations,
        ...result.speakerRepresentations,
      };
      onProgress?.({ chunksTotal, chunksCompleted: chunks.length });
    }
    const text = chunks
      .filter((chunk) => chunk.transcript.status === "transcribed")
      .map((chunk) => chunk.transcript.text)
      .join("\n");
    scope.fileResult = {
      success: true,
      text,
      segments,
      chunks,
      durationSeconds: info.frameCount / info.sampleRate,
      status: text ? "transcribed" : "no-speech",
      diarized: chunks.some((chunk) => chunk.transcript.diarization?.status === "diarized"),
      speakerMatching: Object.assign({}, ...chunks.map((chunk) => chunk.speakerMatching || {})),
    };
    return scope.fileResult;
  } finally {
    fs.closeSync(fd);
  }
}

function cleanupNimiFile(scope) {
  if (!scope.directory) return;
  const root = path.resolve(getSafeTempDir());
  const target = path.resolve(scope.directory);
  if (!target.startsWith(root + path.sep) || !path.basename(target).startsWith("ow-nimi-upload-"))
    throw new Error("Invalid upload cleanup target");
  fs.rmSync(target, { recursive: true, force: true });
  scope.directory = undefined;
}
module.exports = { transcribeNimiFile, cleanupNimiFile };
