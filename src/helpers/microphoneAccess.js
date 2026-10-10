const STATUSES = new Set(["not-determined", "granted", "denied", "restricted", "unknown"]);

function readMicrophoneAccess(systemPreferences, platform = process.platform) {
  let status = "unknown";
  if (platform === "win32" || platform === "darwin") {
    try {
      const observed = systemPreferences.getMediaAccessStatus("microphone");
      if (STATUSES.has(observed)) status = observed;
    } catch {
      // An unavailable query cannot establish consent.
    }
  }
  return { granted: status === "granted", status };
}

async function requestMicrophoneAccess(systemPreferences, platform = process.platform) {
  if (platform === "darwin") await systemPreferences.askForMediaAccess("microphone");
  // Windows has no askForMediaAccess API. The explicit renderer action uses
  // getUserMedia; this part reports the OS setting without inventing a grant.
  return readMicrophoneAccess(systemPreferences, platform);
}

module.exports = { readMicrophoneAccess, requestMicrophoneAccess };
