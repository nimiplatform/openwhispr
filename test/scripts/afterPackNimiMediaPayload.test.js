const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { verifyUnpackedBinaries } = require("../../scripts/afterPack");

// Empty files exercise payload layout checks only, not executable correctness.
function payload(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimi-afterpack-media-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    ffmpeg: path.join(root, "resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe"),
    processList: path.join(
      root,
      "resources/app.asar.unpacked/node_modules/ps-list/vendor/fastlist-test.exe"
    ),
    keyListener: path.join(root, "resources/bin/windows-key-listener.exe"),
  };
  for (const file of Object.values(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
  }
  return { files, context: { electronPlatformName: "win32", appOutDir: root } };
}
test("a Nimi-only payload does not require the retired model worker or ORT library", (t) => {
  const { context } = payload(t);
  assert.doesNotThrow(() => verifyUnpackedBinaries(context));
});
for (const [name, message] of [
  ["ffmpeg", /ffmpeg-static/],
  ["processList", /fastlist/],
  ["keyListener", /windows-key-listener/],
]) {
  test("required media/capture payload still rejects missing " + name, (t) => {
    const { files, context } = payload(t);
    fs.unlinkSync(files[name]);
    assert.throws(() => verifyUnpackedBinaries(context), message);
  });
}
test("the real packager filter excludes retired ORT libraries and preserves capture/index/media payload", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimi-resource-filter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = require("../../electron-builder.json");
  const mapping = config.extraResources.find((value) => value.from === "resources/bin/");
  const fromBuilder = createRequire(require.resolve("electron-builder"));
  const { FileMatcher } = fromBuilder("app-builder-lib/out/fileMatcher");
  const filter = new FileMatcher(
    root,
    path.join(root, "output"),
    (value) => value,
    mapping.filter
  ).createFilter();
  for (const [name, expected] of [
    ["ow-onnxrt.dll", false],
    ["onnxruntime.dll", false],
    ["onnxruntime_providers_shared.dll", false],
    ["libonnxruntime.1.28.2.dylib", false],
    ["libonnxruntime.so.1.28.2", false],
    ["meeting-aec-helper-win32-x64.exe", true],
    ["windows-system-audio-helper.exe", true],
    ["windows-key-listener.exe", true],
    ["windows-fast-paste.exe", true],
    ["qdrant-win32-x64.exe", true],
    ["yt-dlp-win32-x64.exe", true],
    ["capture-library.dll", true],
  ]) {
    const file = path.join(root, name);
    fs.writeFileSync(file, "");
    assert.equal(filter(file, fs.statSync(file)), expected, name);
  }
});
