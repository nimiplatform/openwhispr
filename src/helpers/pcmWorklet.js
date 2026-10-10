// App capture owns sample conversion and flushing; Nimi receives the real WAV.
export const PCM_WORKLET_SOURCE = `
class PcmStreamingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(4096);
    this.offset = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data !== "stop" || this.stopped) return;
      this.flush();
      this.stopped = true;
      this.port.postMessage("flushed");
    };
  }
  flush() {
    if (!this.offset) return;
    const chunk = this.buffer.slice(0, this.offset);
    this.port.postMessage(chunk.buffer, [chunk.buffer]);
    this.offset = 0;
  }
  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const value of input) {
      const sample = Math.max(-1, Math.min(1, value));
      this.buffer[this.offset++] = sample < 0 ? sample * 32768 : sample * 32767;
      if (this.offset === this.buffer.length) this.flush();
    }
    return true;
  }
}
registerProcessor("pcm-streaming-processor", PcmStreamingProcessor);
`;
