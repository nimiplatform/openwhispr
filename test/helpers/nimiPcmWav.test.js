const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readPcmWavInfo, readPcmWavWindow } = require("../../src/helpers/nimiPcmWav");

function wav(frames) {
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) buffer.writeInt16LE(i % 32768, 44 + i * 2);
  return buffer;
}

test("PCM windows preserve exact frames and do not inherit RIFF metadata as audio", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimi-pcm-"));
  const source = wav(16001);
  fs.writeFileSync(path.join(root, "source.wav"), source);
  const fd = fs.openSync(path.join(root, "source.wav"), "r");
  try {
    const info = readPcmWavInfo(fd);
    assert.equal(info.frameCount, 16001);
    const last = readPcmWavWindow(fd, info, 16000, 1);
    assert.equal(last.readUInt32LE(40), 2);
    assert.deepEqual(last.subarray(44), source.subarray(44 + 32000));
    assert.throws(() => readPcmWavWindow(fd, info, 16001, 1), /Invalid audio frame window/);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a declared PCM size larger than the real file is rejected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimi-pcm-"));
  const source = wav(2);
  source.writeUInt32LE(20, 40);
  fs.writeFileSync(path.join(root, "bad.wav"), source);
  const fd = fs.openSync(path.join(root, "bad.wav"), "r");
  try {
    assert.throws(() => readPcmWavInfo(fd), /Invalid PCM audio size/);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
