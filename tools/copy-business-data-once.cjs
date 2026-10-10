// Explicit one-time recovery of an App-owned root; never loaded by the App.
// Run with this App's Electron in Node mode for the matching SQLite ABI.
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

async function copyBusinessData(source, destination) {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination))
    throw new Error("Use explicit absolute source and destination directories");
  const from = fs.realpathSync.native(source);
  const to = path.resolve(destination);
  const relative = path.relative(from, to);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative)))
    throw new Error("Destination must be outside the source root");
  if (fs.existsSync(to)) throw new Error("Destination already exists; nothing was overwritten");
  const databaseNames = fs
    .readdirSync(from)
    .filter((name) => /^transcriptions(?:-dev)?\.db$/.test(name));
  if (!databaseNames.length) throw new Error("Source has no OpenWhispr business database");
  // Open SQLite read-only and back it up through SQLite, so a retained WAL is
  // included consistently rather than copying only the main database file.
  fs.cpSync(from, to, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter(entry) {
      if (fs.lstatSync(entry).isSymbolicLink()) throw new Error("Source contains a symbolic link");
      return !/^transcriptions(?:-dev)?\.db(?:-wal|-shm|-journal)?$/.test(path.basename(entry));
    },
  });
  for (const name of databaseNames) {
    const database = new Database(path.join(from, name), { readonly: true, fileMustExist: true });
    try {
      await database.backup(path.join(to, name));
    } finally {
      database.close();
    }
  }
  return { source: from, destination: to, databases: databaseNames };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--source" || args[2] !== "--destination") {
    process.stderr.write(
      "Use --source <absolute root> --destination <new absolute root>; stop the App first.\n"
    );
    process.exitCode = 1;
  } else {
    copyBusinessData(args[1], args[3])
      .then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
      .catch((error) => {
        process.stderr.write(error.message + "\n");
        process.exitCode = 1;
      });
  }
}
module.exports = { copyBusinessData };
