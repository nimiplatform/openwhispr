const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { promisify } = require("node:util");
const read = promisify(fs.read);
const write = promisify(fs.write);

function wav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Capture and finite scheduling belong to this App. Disk cursors retain every
// received frame while at most two protected transcription Jobs execute.
class NimiMeetingAudio {
  constructor({
    root,
    transcribe,
    assertCurrent,
    signal,
    onResult,
    onError,
    sampleRate = 24000,
    windowSeconds = 10,
  }) {
    if (
      !Number.isInteger(sampleRate) ||
      sampleRate <= 0 ||
      !Number.isFinite(windowSeconds) ||
      windowSeconds <= 0 ||
      windowSeconds > 300
    )
      throw new Error("Invalid finite meeting window");
    fs.mkdirSync(root, { recursive: true });
    this.directory = fs.mkdtempSync(path.join(root, "meeting-work-"));
    this.transcribe = transcribe;
    this.assertCurrent = assertCurrent;
    this.signal = signal;
    this.onResult = onResult;
    this.onError = onError;
    this.sampleRate = sampleRate;
    this.windowFrames = sampleRate * windowSeconds;
    this.sources = new Map();
    this.pending = new Set();
    this.results = [];
    this.stopping = false;
    this.closed = false;
    this.failure = null;
  }

  push(source, bytes, capturedAt) {
    if (this.closed || this.stopping) return;
    this.assertCurrent();
    this.signal.throwIfAborted();
    if (!["mic", "system"].includes(source) || !Buffer.isBuffer(bytes) || bytes.length % 2)
      throw new Error("Invalid meeting PCM input");
    if (!bytes.length) return;
    let state = this.sources.get(source);
    if (!state) {
      state = {
        fd: fs.openSync(path.join(this.directory, source + ".pcm"), "w+"),
        frames: 0,
        cursor: 0,
        busy: false,
        anchorMs: capturedAt ?? Date.now(),
        clockBasis: capturedAt == null ? "arrival" : "capture",
      };
      this.sources.set(source, state);
    }
    let written = 0;
    while (written < bytes.length) {
      const count = fs.writeSync(
        state.fd,
        bytes,
        written,
        bytes.length - written,
        state.frames * 2 + written
      );
      if (!count) throw new Error("Meeting PCM spool write did not advance");
      written += count;
    }
    state.frames += bytes.length / 2;
    this.pump();
  }

  pump() {
    if (this.closed || this.failure || this.signal.aborted) return;
    for (const [source, state] of this.sources) {
      if (this.pending.size >= 2) break;
      const available = state.frames - state.cursor;
      if (state.busy || !available || (!this.stopping && available < this.windowFrames)) continue;
      const startFrame = state.cursor;
      const count = Math.min(available, this.windowFrames);
      const pcm = Buffer.alloc(count * 2);
      if (fs.readSync(state.fd, pcm, 0, pcm.length, startFrame * 2) !== pcm.length)
        throw new Error("Meeting PCM spool was truncated");
      state.cursor += count;
      state.busy = true;
      const work = (async () => {
        this.assertCurrent();
        this.signal.throwIfAborted();
        const result = await this.transcribe(wav(pcm, this.sampleRate));
        this.assertCurrent();
        this.signal.throwIfAborted();
        if (this.closed) return;
        const output = {
          source,
          startFrame,
          endFrame: startFrame + count,
          sampleRate: this.sampleRate,
          anchorMs: state.anchorMs,
          clockBasis: state.clockBasis,
          transcript: result.transcript,
          jobId: result.jobId,
          speakerMap: result.speakerMap,
          speakerRepresentations: result.speakerRepresentations,
          speakerMatching: result.speakerMatching,
        };
        this.results.push(output);
        this.onResult?.(output);
      })()
        .catch((error) => {
          if (!this.closed && !this.signal.aborted) {
            this.failure = error;
            this.onError?.(error);
          }
        })
        .finally(() => {
          state.busy = false;
          this.pending.delete(work);
          this.pump();
        });
      this.pending.add(work);
    }
  }

  async finish() {
    this.stopping = true;
    for (;;) {
      this.assertCurrent();
      this.signal.throwIfAborted();
      if (this.failure) throw this.failure;
      this.pump();
      if (!this.pending.size) break;
      await Promise.allSettled([...this.pending]);
    }
    return this.results;
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.cleanup();
    return this.closing;
  }

  async cleanup() {
    await Promise.allSettled([...this.pending]);
    await this.retaining?.catch(() => {});
    for (const state of this.sources.values()) fs.closeSync(state.fd);
    this.sources.clear();
    fs.rmSync(this.directory, { recursive: true, force: true });
  }

  retain(root) {
    if (this.retaining) return this.retaining;
    this.retaining = this.retainMedia(root);
    const pending = this.retaining;
    pending
      .finally(() => {
        if (this.retaining === pending) this.retaining = undefined;
      })
      .catch(() => {});
    return pending;
  }

  async retainMedia(root) {
    this.assertCurrent();
    this.signal.throwIfAborted();
    fs.mkdirSync(root, { recursive: true });
    const directory = path.join(path.resolve(root), randomUUID());
    if (!directory.startsWith(path.resolve(root) + path.sep))
      throw new Error("Invalid meeting media destination");
    fs.mkdirSync(directory);
    const tracks = [];
    try {
      for (const [source, state] of this.sources) {
        if (!state.frames) continue;
        this.assertCurrent();
        this.signal.throwIfAborted();
        const filename = path.join(directory, source + ".wav");
        const bytes = state.frames * 2;
        if (bytes > 0xffffffff - 36) throw new Error("Meeting track exceeds WAV storage limit");
        const header = wav(Buffer.alloc(0), this.sampleRate);
        header.writeUInt32LE(36 + bytes, 4);
        header.writeUInt32LE(bytes, 40);
        const target = fs.openSync(filename, "wx");
        try {
          let headerWritten = 0;
          while (headerWritten < header.length) {
            const { bytesWritten } = await write(
              target,
              header,
              headerWritten,
              header.length - headerWritten,
              headerWritten
            );
            if (!bytesWritten) throw new Error("Meeting archive header write did not advance");
            headerWritten += bytesWritten;
          }
          const buffer = Buffer.alloc(Math.min(2 * 1024 * 1024, bytes));
          for (let position = 0; position < bytes;) {
            this.assertCurrent();
            this.signal.throwIfAborted();
            const count = Math.min(buffer.length, bytes - position);
            if ((await read(state.fd, buffer, 0, count, position)).bytesRead !== count)
              throw new Error("Meeting archive source was truncated");
            let written = 0;
            while (written < count) {
              this.assertCurrent();
              this.signal.throwIfAborted();
              const { bytesWritten: n } = await write(
                target,
                buffer,
                written,
                count - written,
                44 + position + written
              );
              if (!n) throw new Error("Meeting archive write did not advance");
              written += n;
            }
            position += count;
          }
        } finally {
          fs.closeSync(target);
        }
        tracks.push({
          source,
          path: filename,
          anchorMs: state.anchorMs,
          clockBasis: state.clockBasis,
          sampleRate: this.sampleRate,
          frameCount: state.frames,
        });
      }
      return { directory, tracks };
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
module.exports = { NimiMeetingAudio, wav };
