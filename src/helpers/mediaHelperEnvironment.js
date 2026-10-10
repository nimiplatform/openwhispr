const REQUIRED_KEYS = new Set([
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
]);

function mediaHelperEnvironment() {
  const environment = { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
  for (const [key, value] of Object.entries(process.env)) {
    if (REQUIRED_KEYS.has(key.toUpperCase()) && typeof value === "string") environment[key] = value;
  }
  return environment;
}
module.exports = { mediaHelperEnvironment };
