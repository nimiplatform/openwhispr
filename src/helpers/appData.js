const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

function getAppDataDirectory() {
  // Windows AppData can resolve individual files into a launcher's private
  // package cache. Business data needs one OS-user root across launchers.
  const directory =
    process.platform === "win32"
      ? path.join(app.getPath("home"), ".openwhispr-nimi")
      : path.join(app.getPath("appData"), "OpenWhispr-Nimi");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function eraseAppOwnedImports() {
  const root = path.resolve(getAppDataDirectory());
  const target = path.resolve(root, "imports");
  if (!target.startsWith(root + path.sep)) throw new Error("Invalid App import cleanup target");
  fs.rmSync(target, { recursive: true, force: true });
}

function eraseAppOwnedSearchIndexes() {
  const root = path.resolve(getAppDataDirectory());
  for (const name of ["qdrant-data-dev", "qdrant-data"]) {
    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep)) throw new Error("Invalid App index cleanup target");
    fs.rmSync(target, { recursive: true, force: true });
  }
}

module.exports = { getAppDataDirectory, eraseAppOwnedImports, eraseAppOwnedSearchIndexes };
