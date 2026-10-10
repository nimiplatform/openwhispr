const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const sourcePath = require.resolve("../../src/helpers/sidecarReaper");
const source = fs.readFileSync(sourcePath, "utf8");

// No real process, PID file, signal or user data is touched by these regressions.
function loadReaper({
  entries = [],
  alive = [],
  commands = {},
  ignoreTerm = false,
  ignoreKill = false,
} = {}) {
  const living = new Set(alive);
  const state = { probes: [], signals: [], commandReads: [], cleared: [] };
  const sandbox = {
    module: { exports: {} },
    Date,
    setTimeout,
    process: {
      platform: "win32",
      kill(pid, signal) {
        if (signal === 0) {
          state.probes.push(pid);
          if (!living.has(pid))
            throw Object.assign(new Error("No such process"), {
              code: "ESRCH",
            });
          return;
        }
        state.signals.push([pid, signal]);
        if ((signal === "SIGTERM" && !ignoreTerm) || (signal === "SIGKILL" && !ignoreKill))
          living.delete(pid);
      },
    },
    require(name) {
      if (name === "child_process")
        return {
          execFileSync(_command, args) {
            const pid = Number(args[1].replace("PID eq ", ""));
            state.commandReads.push(pid);
            return Buffer.from('"' + (commands[pid] ?? "") + '","' + pid + '"');
          },
        };
      if (name === "./debugLogger") return { warn() {}, error() {} };
      if (name === "./sidecarPidFile")
        return {
          readAll: () => entries,
          clear: (name) => state.cleared.push(name),
        };
      throw new Error("Unexpected dependency: " + name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: sourcePath });
  return { ...state, ...sandbox.module.exports };
}
const graces = { sigtermGraceMs: 0, sigkillGraceMs: 0 };

test("retired and unknown PID entries are neither inspected, signaled nor cleared", async () => {
  const entries = [
    "parakeet",
    "whisper",
    "llama",
    "diarization",
    "unknown",
    "constructor",
    "__proto__",
  ].map((name, index) => ({ name, pid: 100 + index }));
  const h = loadReaper({ entries, alive: entries.map((entry) => entry.pid) });
  await h.reapStaleSidecars(graces);
  assert.deepEqual(h.probes, []);
  assert.deepEqual(h.commandReads, []);
  assert.deepEqual(h.signals, []);
  assert.deepEqual(h.cleared, []);
});
test("Qdrant startup cleanup remains scoped when old AI entries coexist", async () => {
  const h = loadReaper({
    entries: [
      { name: "qdrant", pid: 200 },
      { name: "whisper", pid: 201 },
    ],
    alive: [200, 201],
    commands: { 200: "qdrant.exe", 201: "whisper-server.exe" },
  });
  await h.reapStaleSidecars(graces);
  assert.deepEqual(h.signals, [[200, "SIGTERM"]]);
  assert.deepEqual(h.commandReads, [200]);
  assert.equal(h.probes.includes(201), false);
  assert.deepEqual(h.cleared, ["qdrant"]);
});
test("Qdrant cleanup still escalates when its process ignores SIGTERM", async () => {
  const h = loadReaper({
    entries: [{ name: "qdrant", pid: 300 }],
    alive: [300],
    commands: { 300: "qdrant.exe" },
    ignoreTerm: true,
  });
  await h.reapStaleSidecars(graces);
  assert.deepEqual(h.signals, [
    [300, "SIGTERM"],
    [300, "SIGKILL"],
  ]);
  assert.deepEqual(h.cleared, ["qdrant"]);
});
test("a surviving Qdrant process retains its recovery entry", async () => {
  const h = loadReaper({
    entries: [{ name: "qdrant", pid: 400 }],
    alive: [400],
    commands: { 400: "qdrant.exe" },
    ignoreTerm: true,
    ignoreKill: true,
  });
  await h.reapStaleSidecars(graces);
  assert.deepEqual(h.signals, [
    [400, "SIGTERM"],
    [400, "SIGKILL"],
  ]);
  assert.deepEqual(h.cleared, []);
});
test("an exited Qdrant process clears only its owned recovery entry", async () => {
  const h = loadReaper({
    entries: [
      { name: "qdrant", pid: 500 },
      { name: "llama", pid: 501 },
    ],
  });
  await h.reapStaleSidecars(graces);
  assert.deepEqual(h.signals, []);
  assert.deepEqual(h.cleared, ["qdrant"]);
});
test("a reused Qdrant PID with another image is not signaled", async () => {
  const h = loadReaper({
    entries: [{ name: "qdrant", pid: 600 }],
    alive: [600],
    commands: { 600: "other-app.exe" },
  });
  await h.reapStaleSidecars(graces);
  assert.deepEqual(h.signals, []);
  assert.deepEqual(h.cleared, ["qdrant"]);
});
test("the Qdrant waitForExit consumer still distinguishes live and exited processes", async () => {
  const h = loadReaper({ alive: [700] });
  assert.equal(await h.waitForExit(700, 0), false);
  assert.equal(await h.waitForExit(701, 0), true);
  assert.deepEqual(h.signals, []);
});
