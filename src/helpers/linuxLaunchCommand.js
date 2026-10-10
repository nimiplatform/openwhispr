const fs = require("fs");
const WRAPPED_BINARY_SUFFIX = "-app";

function resolveExecutablePath() {
  if (process.env.APPIMAGE) return process.env.APPIMAGE;

  if (process.execPath.endsWith(WRAPPED_BINARY_SUFFIX)) {
    const wrapperPath = process.execPath.slice(0, -WRAPPED_BINARY_SUFFIX.length);
    if (fs.existsSync(wrapperPath)) return wrapperPath;
  }
  return process.execPath;
}

function quoteExecPath(execPath) {
  const escaped = execPath.replace(/\\/g, "\\\\\\\\").replace(/(["`$])/g, "\\$1");
  return `"${escaped}"`;
}

module.exports = { resolveExecutablePath, quoteExecPath };
