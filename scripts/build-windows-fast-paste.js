#!/usr/bin/env node
// Build changed native source locally; never replace it with an older release helper.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.platform !== "win32") process.exit(0);
const root = path.resolve(__dirname, "..");
const source = path.join(root, "resources", "windows-fast-paste.c");
const output = path.join(root, "resources", "bin", "windows-fast-paste.exe");
const objects = path.join(root, ".nimi", "local", "windows-fast-paste");
const required = ["paste-v1", "selection-copy-v1", "target-identity-v2", "focus-restore-v2"];

function compatible() {
  if (!fs.existsSync(output)) return false;
  const result = spawnSync(output, ["--capabilities"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 1500,
  });
  const capabilities = (result.stdout || "").trim().split(/\s+/);
  return result.status === 0 && required.every((value) => capabilities.includes(value));
}

function quote(value) {
  if (/["\r\n%]/.test(value)) throw new Error("Unsupported compiler path");
  return '"' + value + '"';
}

function compile() {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(objects, { recursive: true });
  const clCommand =
    "cl /O2 /utf-8 /nologo " +
    quote(source) +
    " /Fo:" +
    quote(path.join(objects, "windows-fast-paste.obj")) +
    " /Fe:" +
    quote(output) +
    " user32.lib";
  const candidates = [{ command: "cmd.exe", args: ["/d", "/s", "/c", clCommand] }];
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe"
  );
  if (fs.existsSync(vswhere)) {
    const discovery = spawnSync(
      vswhere,
      [
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath",
      ],
      { encoding: "utf8", windowsHide: true }
    );
    const installation = discovery.status === 0 ? discovery.stdout.trim() : "";
    const devcmd = installation && path.join(installation, "Common7", "Tools", "VsDevCmd.bat");
    if (devcmd && fs.existsSync(devcmd))
      candidates.unshift({
        command: "cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          "call " + quote(devcmd) + " -arch=x64 -host_arch=x64 && " + clCommand,
        ],
      });
  }
  for (const command of ["gcc", "clang"])
    candidates.push({ command, args: ["-O2", source, "-o", output, "-luser32"] });
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.args, {
      cwd: root,
      windowsHide: true,
      windowsVerbatimArguments: candidate.command === "cmd.exe",
      stdio: "inherit",
    });
    if (result.status === 0 && compatible()) return;
  }
  throw new Error(
    "Could not build the target-validated Windows paste helper. Install MSVC, MinGW-w64 or Clang and rerun compile:winpaste."
  );
}

try {
  if (
    compatible() &&
    (!fs.existsSync(source) || fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs)
  ) {
    console.log("[windows-fast-paste] Target-validated helper is up to date");
  } else {
    if (!fs.existsSync(source)) throw new Error("Windows paste source is missing");
    compile();
    console.log("[windows-fast-paste] Built target-validated helper from local source");
  }
} catch (error) {
  console.error("[windows-fast-paste] " + error.message);
  process.exitCode = 1;
}
