import { buildWav } from "../utils/wavBuilder";

// App-owned finite-window preview. It owns no model, session, socket or final
// transcript; stopping always retires it before the full recording is submitted.
export class NimiPreview {
  constructor({
    transcribe,
    onText,
    onError,
    sampleRate = 16000,
    windowSeconds = 30,
    intervalSeconds = 2,
  }) {
    this.transcribe = transcribe;
    this.onText = onText;
    this.onError = onError;
    this.sampleRate = sampleRate;
    this.maximum = sampleRate * windowSeconds;
    this.interval = sampleRate * intervalSeconds;
    this.parts = [];
    this.stored = 0;
    this.total = 0;
    this.submitted = 0;
    this.closed = false;
    this.pending = null;
    this.controller = new AbortController();
  }

  push(samples) {
    if (this.closed || !samples.length) return;
    const copy = new Int16Array(samples);
    this.parts.push(copy);
    this.stored += copy.length;
    this.total += copy.length;
    while (this.stored > this.maximum) {
      const excess = this.stored - this.maximum;
      const head = this.parts[0];
      if (head.length <= excess) {
        this.parts.shift();
        this.stored -= head.length;
      } else {
        this.parts[0] = head.slice(excess);
        this.stored -= excess;
      }
    }
    this.pump();
  }

  pump() {
    if (this.closed || this.pending || this.total - this.submitted < this.interval) return;
    const endFrame = this.total;
    const startFrame = endFrame - this.stored;
    const samples = new Int16Array(this.stored);
    let offset = 0;
    for (const part of this.parts) {
      samples.set(part, offset);
      offset += part.length;
    }
    this.submitted = endFrame;
    const signal = this.controller.signal;
    this.pending = (async () => {
      const audio = new Uint8Array(await buildWav(samples, this.sampleRate).arrayBuffer());
      signal.throwIfAborted();
      const result = await this.transcribe(audio, signal);
      signal.throwIfAborted();
      if (!this.closed && result.transcript?.text)
        this.onText(result.transcript.text, { startFrame, endFrame, sampleRate: this.sampleRate });
    })()
      .catch((error) => {
        if (!this.closed && !signal.aborted) {
          this.onError?.(error);
          this.close();
        }
      })
      .finally(() => {
        this.pending = null;
        if (!this.closed) this.pump();
      });
  }

  close() {
    this.closed = true;
    this.controller.abort();
    this.parts = [];
    this.stored = 0;
    return this.pending?.catch(() => {});
  }
}
