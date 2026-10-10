const manifest = require("../../package.json");

if (
  typeof manifest.name !== "string" ||
  !manifest.name ||
  typeof manifest.version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
) {
  throw new Error("Invalid OpenWhispr App build identity");
}

module.exports = Object.freeze({ name: manifest.name, version: manifest.version });
