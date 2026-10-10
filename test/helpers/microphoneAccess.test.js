const test = require("node:test");
const assert = require("node:assert/strict");
const {
  readMicrophoneAccess,
  requestMicrophoneAccess,
} = require("../../src/helpers/microphoneAccess");

test("Windows forwards every actual OS permission status without requesting access", () => {
  for (const status of ["granted", "denied", "restricted", "not-determined", "unknown"]) {
    let calls = 0;
    const preferences = {
      getMediaAccessStatus: (media) => {
        assert.equal(media, "microphone");
        calls++;
        return status;
      },
      askForMediaAccess: () => {
        throw new Error("Read-only query must not prompt");
      },
    };
    assert.deepEqual(readMicrophoneAccess(preferences, "win32"), {
      granted: status === "granted",
      status,
    });
    assert.equal(calls, 1);
  }
});

test("unsupported, invalid and failed OS queries remain unknown", () => {
  const unknown = { granted: false, status: "unknown" };
  assert.deepEqual(
    readMicrophoneAccess(
      {
        getMediaAccessStatus: () => {
          throw new Error("unavailable");
        },
      },
      "win32"
    ),
    unknown
  );
  assert.deepEqual(
    readMicrophoneAccess({ getMediaAccessStatus: () => "invalid" }, "win32"),
    unknown
  );
  assert.deepEqual(
    readMicrophoneAccess(
      {
        getMediaAccessStatus: () => {
          throw new Error("Linux query must not run");
        },
      },
      "linux"
    ),
    unknown
  );
});

test("a Windows request never claims an automatic grant or calls the macOS prompt", async () => {
  assert.deepEqual(
    await requestMicrophoneAccess(
      {
        getMediaAccessStatus: () => "denied",
        askForMediaAccess: () => {
          throw new Error("Windows must not use the macOS prompt");
        },
      },
      "win32"
    ),
    { granted: false, status: "denied" }
  );
});

test("an explicit macOS request reads the real post-request status", async () => {
  let requested = false;
  const result = await requestMicrophoneAccess(
    {
      askForMediaAccess: async (media) => {
        assert.equal(media, "microphone");
        requested = true;
        return false;
      },
      getMediaAccessStatus: () => {
        assert.equal(requested, true);
        return "restricted";
      },
    },
    "darwin"
  );
  assert.deepEqual(result, { granted: false, status: "restricted" });
});
