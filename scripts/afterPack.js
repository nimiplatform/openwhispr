// electron-builder afterPack hook
//
// Runs after electron-builder assembles the output directory but before the
// final installer (DMG/NSIS/AppImage) is created. Operates only on the output
// directory — never touches source node_modules/.
//
// Keeps media, capture and platform-wrapper payload checks. AI model execution
// and ONNX inference belong to the supervised Nimi Runtime, outside this App.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Arch } = require("electron-builder");
const { buildLinuxWrapperScript } = require("./lib/linux-launcher");

// ---------------------------------------------------------------------------
// macOS resource binary signing
// ---------------------------------------------------------------------------

function resolveAppPath(context) {
  if (context.electronPlatformName !== "darwin") {
    return context.appOutDir;
  }

  if (context.appOutDir.endsWith(".app")) {
    return context.appOutDir;
  }

  return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
}

function resolveResourcesDir(context) {
  return context.electronPlatformName === "darwin"
    ? path.join(resolveAppPath(context), "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
}

function collectFiles(rootDir, skipDirs = new Set()) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (skipDirs.has(fullPath)) continue;
        queue.push(fullPath);
        continue;
      }

      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function collectFrameworks(rootDir) {
  if (!fs.existsSync(rootDir)) return [];

  const out = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.name.endsWith(".framework")) {
        out.push(fullPath);
        // Don't descend into a framework — the bundle is signed as a unit.
        continue;
      }
      queue.push(fullPath);
    }
  }

  return out;
}

function isMachOBinary(filePath) {
  try {
    const description = execFileSync("file", ["-b", filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return description.includes("Mach-O");
  } catch {
    return false;
  }
}

function registerMacResourceBinariesForSigning(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const resourcesDir = resolveResourcesDir(context);
  const frameworks = collectFrameworks(resourcesDir);
  const skipDirs = new Set(frameworks);
  const machOFiles = collectFiles(resourcesDir, skipDirs).filter(isMachOBinary);
  const toRegister = [...frameworks, ...machOFiles];

  if (toRegister.length === 0) {
    return;
  }

  const macConfig = context.packager.platformSpecificBuildOptions;
  const existingBinaries = Array.isArray(macConfig.binaries) ? macConfig.binaries : [];

  macConfig.binaries = [...new Set([...existingBinaries, ...toRegister])];

  console.log(
    `  afterPack: registered ${frameworks.length} framework(s) and ${machOFiles.length} loose Mach-O file(s) under Contents/Resources for signing`
  );
}

// ---------------------------------------------------------------------------
// Linux XWayland wrapper
// ---------------------------------------------------------------------------

function wrapLinuxBinary(context) {
  if (context.electronPlatformName !== "linux") return;

  const appDir = context.appOutDir;
  const binaryName = context.packager.executableName;
  const binaryPath = path.join(appDir, binaryName);
  const realBinaryPath = path.join(appDir, binaryName + "-app");

  fs.renameSync(binaryPath, realBinaryPath);

  fs.writeFileSync(binaryPath, buildLinuxWrapperScript(binaryName), { mode: 0o755 });
}

function verifyMeetingAecHelper(context) {
  const platform = context.electronPlatformName;
  const archName = Arch[context.arch];

  if (!["darwin", "linux", "win32"].includes(platform)) {
    return;
  }

  const binaryName = `meeting-aec-helper-${platform}-${archName}${platform === "win32" ? ".exe" : ""}`;
  const resourcesDir = resolveResourcesDir(context);
  const binaryPath = path.join(resourcesDir, "bin", binaryName);

  if (!fs.existsSync(binaryPath)) {
    console.warn(`  afterPack: missing optional meeting AEC helper (${binaryName})`);
    return;
  }

  if (platform !== "win32") {
    fs.chmodSync(binaryPath, 0o755);
  }
}

// compile:winkeys and download:windows-key-listener only warn when they can't
// produce the key listener, so without this check a build ships where Hold and
// modifier-only hotkeys (the default Control+Super) never fire (#2005).
function verifyWindowsKeyListener(binDir) {
  const listenerPath = path.join(binDir, "windows-key-listener.exe");
  if (!fs.existsSync(listenerPath)) {
    throw new Error(
      `afterPack: missing ${listenerPath} — run pnpm run compile:winkeys on Windows (compiles with MSVC, MinGW or Clang, or downloads the prebuilt binary); Push-to-Talk and modifier-only hotkeys would never fire on Windows`
    );
  }
}

function verifyUnpackedBinaries(context) {
  const unpackedDir = path.join(resolveResourcesDir(context), "app.asar.unpacked");
  const unpackedModulesDir = path.join(unpackedDir, "node_modules");

  const isWindows = context.electronPlatformName === "win32";

  const ffmpegPath = path.join(
    unpackedModulesDir,
    "ffmpeg-static",
    isWindows ? "ffmpeg.exe" : "ffmpeg"
  );
  if (!fs.existsSync(ffmpegPath)) {
    throw new Error(
      `afterPack: missing ${ffmpegPath} — ffmpeg-static was not unpacked from app.asar (asarUnpack/packaging failure); the packed app cannot spawn FFmpeg`
    );
  }

  // electron-builder strips *.exe from node_modules on non-Windows targets,
  // so the ps-list vendor executable only exists in Windows builds.
  if (isWindows) {
    const psListVendorDir = path.join(unpackedModulesDir, "ps-list", "vendor");
    const hasFastlist =
      fs.existsSync(psListVendorDir) &&
      fs.readdirSync(psListVendorDir).some((name) => /^fastlist-.*\.exe$/.test(name));
    if (!hasFastlist) {
      throw new Error(
        `afterPack: no fastlist-*.exe in ${psListVendorDir} — ps-list vendor executable was not unpacked from app.asar (asarUnpack/packaging failure); Windows process detection would break`
      );
    }
    const binDir = path.join(resolveResourcesDir(context), "bin");
    verifyWindowsKeyListener(binDir);
  }

  console.log("  afterPack: verified unpacked bundled binaries");
}

// ---------------------------------------------------------------------------
// Main hook
// ---------------------------------------------------------------------------

function verifyPackagedDatabase(context) {
  if (context.electronPlatformName !== "win32") return;
  const executable = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const databaseModule = path.join(resolveResourcesDir(context), "app.asar/node_modules/better-sqlite3");
  // Load the shipped native module with the shipped Electron ABI, without
  // launching the App or touching any user database. Node tests can otherwise
  // leave a different binary behind while electron-rebuild's marker is stale.
  execFileSync(executable, ["-e", `
    const Database = require(process.argv[1]);
    const db = new Database(':memory:');
    if (db.prepare('SELECT 1 AS ready').get().ready !== 1) throw new Error('SQLite failed');
    db.close();
  `, databaseModule], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
    stdio: "pipe",
    timeout: 30000,
  });
  console.log("  afterPack: loaded packaged SQLite with the shipped Electron ABI");
}

exports.default = async function (context) {
  wrapLinuxBinary(context);
  verifyMeetingAecHelper(context);
  verifyUnpackedBinaries(context);
  verifyPackagedDatabase(context);
  registerMacResourceBinariesForSigning(context);
};

exports.verifyWindowsKeyListener = verifyWindowsKeyListener;
exports.verifyUnpackedBinaries = verifyUnpackedBinaries;
exports.verifyPackagedDatabase = verifyPackagedDatabase;
