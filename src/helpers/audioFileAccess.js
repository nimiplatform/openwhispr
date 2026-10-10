const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { getSafeTempDir } = require("./safeTempDir");
const { getAppDataDirectory } = require("./appData");

const approvedAudioPaths = new Set();
function approveAudioPath(filePath) {
  if (typeof filePath !== "string" || !filePath) return;
  try {
    approvedAudioPaths.add(fs.realpathSync(path.resolve(filePath)));
  } catch {}
}
function resolveAllowedAudioPath(filePath) {
  if (typeof filePath !== "string" || !filePath) return null;
  const real = fs.realpathSync(path.resolve(filePath));
  if (approvedAudioPaths.has(real)) return real;
  const allowed = [os.tmpdir(), getSafeTempDir(), getAppDataDirectory()].map((directory) => {
    try {
      return fs.realpathSync(directory);
    } catch {
      return directory;
    }
  });
  return allowed.some((directory) => real === directory || real.startsWith(directory + path.sep))
    ? real
    : null;
}
module.exports = { approveAudioPath, resolveAllowedAudioPath };
