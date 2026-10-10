const fs = require("node:fs");

function readExact(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = fs.readSync(fd, buffer, read, length - read, position + read);
    if (count === 0) throw new Error("Audio data is truncated");
    read += count;
  }
  return buffer;
}

function readPcmWavInfo(fd) {
  const size = fs.fstatSync(fd).size;
  const header = readExact(fd, 12, 0);
  const container = header.toString("ascii", 0, 4);
  if (!["RIFF", "RF64"].includes(container) || header.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("Invalid WAV container");
  let format;
  let rf64DataSize;
  for (let offset = 12; offset + 8 <= size;) {
    const chunk = readExact(fd, 8, offset);
    const name = chunk.toString("ascii", 0, 4);
    const length = chunk.readUInt32LE(4);
    if (name === "ds64" && length >= 28) {
      const data = readExact(fd, 28, offset + 8);
      rf64DataSize = Number(data.readBigUInt64LE(8));
      if (!Number.isSafeInteger(rf64DataSize))
        throw new Error("WAV data exceeds the supported frame range");
    } else if (name === "fmt " && length >= 16) {
      const data = readExact(fd, 16, offset + 8);
      format = {
        encoding: data.readUInt16LE(0),
        channels: data.readUInt16LE(2),
        sampleRate: data.readUInt32LE(4),
        frameBytes: data.readUInt16LE(12),
        bits: data.readUInt16LE(14),
      };
    } else if (name === "data") {
      if (
        !format ||
        format.encoding !== 1 ||
        format.channels !== 1 ||
        format.bits !== 16 ||
        format.frameBytes !== 2 ||
        format.sampleRate !== 16000
      ) {
        throw new Error("Decoded audio must be mono PCM16 at 16 kHz");
      }
      const dataBytes = length === 0xffffffff && container === "RF64" ? rf64DataSize : length;
      if (
        !Number.isSafeInteger(dataBytes) ||
        dataBytes <= 0 ||
        dataBytes % 2 ||
        offset + 8 + dataBytes > size
      )
        throw new Error("Invalid PCM audio size");
      return {
        dataOffset: offset + 8,
        frameCount: dataBytes / 2,
        sampleRate: format.sampleRate,
        frameBytes: 2,
      };
    }
    offset += 8 + length + (length % 2);
  }
  throw new Error("WAV PCM data is missing");
}

function readPcmWavWindow(fd, info, startFrame, frameCount) {
  if (
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(frameCount) ||
    startFrame < 0 ||
    frameCount <= 0 ||
    startFrame + frameCount > info.frameCount
  )
    throw new Error("Invalid audio frame window");
  const pcm = readExact(
    fd,
    frameCount * info.frameBytes,
    info.dataOffset + startFrame * info.frameBytes
  );
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(info.sampleRate, 24);
  header.writeUInt32LE(info.sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
module.exports = { readPcmWavInfo, readPcmWavWindow };
