const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimi-media-cancel-"));

function converter(spawn) {
  const modulePath = require.resolve("../../src/helpers/ffmpegUtils");
  delete require.cache[modulePath];
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron")
      return { app: { getPath: () => root, isReady: () => false, isPackaged: false } };
    if (request === "child_process") return { ...childProcess, spawn };
    return original.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath).convertToWav;
  } finally {
    Module._load = original;
  }
}

test("media cancellation waits for close and passes only the helper environment", async () => {
  const controller = new AbortController();
  let child;
  let options;
  process.env.NIMI_TEST_CREDENTIAL_MARKER = "non-sensitive-marker";
  try {
    const convert = converter((_command, _args, inputOptions) => {
      options = inputOptions;
      child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 100;
      child.kill = () => true;
      return child;
    });
    let settled = false;
    const pending = convert("input.wav", path.join(root, "output.wav"), {
      signal: controller.signal,
    });
    pending.catch(() => {
      settled = true;
    });
    controller.abort();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(Object.hasOwn(options.env, "NIMI_TEST_CREDENTIAL_MARKER"), false);
    assert.ok(Object.keys(options.env).every((key) => !key.startsWith("NIMI_")));
    child.emit("close", null);
    await assert.rejects(pending, (error) => error.name === "AbortError");
  } finally {
    delete process.env.NIMI_TEST_CREDENTIAL_MARKER;
  }
});

test("the real canceled FFmpeg process is gone before output cleanup", async () => {
  const input = path.join(root, "input.wav");
  const generated = childProcess.spawnSync(
    require("ffmpeg-static"),
    [
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=16000:cl=mono",
      "-t",
      "305",
      "-c:a",
      "pcm_s16le",
      "-y",
      input,
    ],
    { encoding: "utf8" }
  );
  assert.equal(generated.status, 0, generated.stderr);
  const controller = new AbortController();
  let child;
  const convert = converter((command, args, options) => {
    child = childProcess.spawn(command, args, options);
    child.once("spawn", () => controller.abort());
    return child;
  });
  await assert.rejects(
    convert(input, path.join(root, "cancel-output.wav"), { signal: controller.signal }),
    (error) => error.name === "AbortError"
  );
  assert.notEqual(child.exitCode === null && child.signalCode === null, true);
  assert.throws(() => process.kill(child.pid, 0));
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false);
});
