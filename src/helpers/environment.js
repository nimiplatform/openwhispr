const { getAppDataDirectory } = require("./appData");
const path = require("node:path");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const { normalizeUiLanguage } = require("./i18nMain");
const PERSISTED_KEYS = [
  "DICTATION_KEY",
  "VOICE_AGENT_KEY",
  "TRANSLATION_KEY",
  "MEETING_KEY",
  "ACTIVATION_MODE",
  "FLOATING_ICON_AUTO_HIDE",
  "PANEL_START_POSITION",
  "START_MINIMIZED",
  "UI_LANGUAGE",
];
const LOAD_KEYS = new Set([
  ...PERSISTED_KEYS,
  "OPENWHISPR_API_URL",
  "AUTH_URL",
  "VITE_AUTH_URL",
  "VITE_OPENWHISPR_API_URL",
  "VITE_OPENWHISPR_OAUTH_CALLBACK_URL",
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "MICROSOFT_CALENDAR_CLIENT_ID",
  "OPENWHISPR_LOG_LEVEL",
  "LOG_LEVEL",
  "OPENWHISPR_CHANNEL",
  "OPENWHISPR_DEV_SERVER_PORT",
  "VITE_DEV_SERVER_PORT",
]);
let envWriteQueue = Promise.resolve();
class EnvironmentManager {
  constructor() {
    this.loadEnvironmentVariables();
  }
  loadEnvironmentVariables() {
    const paths = [
      path.join(getAppDataDirectory(), ".env"),
      path.join(__dirname, "..", "..", ".env"),
    ];
    if (process.resourcesPath)
      paths.push(
        path.join(process.resourcesPath, ".env"),
        path.join(process.resourcesPath, "app.asar.unpacked", ".env")
      );
    for (const [index, p] of paths.entries())
      try {
        const values = require("dotenv").parse(fs.readFileSync(p));
        for (const [key, value] of Object.entries(values))
          if (LOAD_KEYS.has(key) && (index === 0 || process.env[key] === undefined))
            process.env[key] = value;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
  }
  _saveKey(key, value) {
    if (!PERSISTED_KEYS.includes(key)) throw new Error("Unsupported business setting");
    if (typeof value !== "string" || /[\r\n]/.test(value))
      throw new Error("Business settings must be single-line strings");
    if (value) process.env[key] = value;
    else delete process.env[key];
    return { success: true };
  }
  async saveAllKeysToEnvFile() {
    const envPath = path.join(getAppDataDirectory(), ".env");
    envWriteQueue = envWriteQueue
      .catch(() => {})
      .then(async () => {
        let content = "";
        try {
          content = await fsPromises.readFile(envPath, "utf8");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const updated = new Set();
        const lines = content.split(/\r?\n/).map((line) => {
          const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
          if (!m || !PERSISTED_KEYS.includes(m[1])) return line;
          updated.add(m[1]);
          return m[1] + "=" + '"' + (process.env[m[1]] || "") + '"';
        });
        for (const key of PERSISTED_KEYS)
          if (!updated.has(key) && process.env[key])
            lines.push(key + "=" + '"' + process.env[key] + '"');
        await fsPromises.mkdir(path.dirname(envPath), { recursive: true });
        const temp = envPath + ".tmp";
        await fsPromises.writeFile(temp, lines.join("\n"), "utf8");
        await fsPromises.rename(temp, envPath);
      });
    await envWriteQueue;
    return { success: true, path: envPath };
  }
  async clearAllPersistedData() {
    for (const key of LOAD_KEYS) delete process.env[key];
    await Promise.all([
      fsPromises.rm(path.join(getAppDataDirectory(), ".env"), { force: true }),
      fsPromises.rm(path.join(getAppDataDirectory(), "secure-keys"), {
        recursive: true,
        force: true,
      }),
    ]);
    return { success: true };
  }
  _getKey(envVarName) {
    return process.env[envVarName] || "";
  }

  getDictationKey() {
    return this._getKey("DICTATION_KEY");
  }

  saveDictationKey(key) {
    const result = this._saveKey("DICTATION_KEY", key);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getVoiceAgentKey() {
    return this._getKey("VOICE_AGENT_KEY");
  }

  saveVoiceAgentKey(key) {
    const result = this._saveKey("VOICE_AGENT_KEY", key);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getTranslationKey() {
    return this._getKey("TRANSLATION_KEY");
  }

  saveTranslationKey(key) {
    const result = this._saveKey("TRANSLATION_KEY", key);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getMeetingKey() {
    return this._getKey("MEETING_KEY");
  }

  saveMeetingKey(key) {
    const result = this._saveKey("MEETING_KEY", key);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getActivationMode() {
    const mode = this._getKey("ACTIVATION_MODE");
    return mode === "push" ? "push" : "tap";
  }

  saveActivationMode(mode) {
    const validMode = mode === "push" ? "push" : "tap";
    const result = this._saveKey("ACTIVATION_MODE", validMode);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getFloatingIconAutoHide() {
    return this._getKey("FLOATING_ICON_AUTO_HIDE") === "true";
  }

  saveFloatingIconAutoHide(enabled) {
    const result = this._saveKey("FLOATING_ICON_AUTO_HIDE", String(enabled));
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getStartMinimized() {
    return this._getKey("START_MINIMIZED") === "true";
  }

  saveStartMinimized(enabled) {
    const result = this._saveKey("START_MINIMIZED", String(enabled));
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getPanelStartPosition() {
    const v = this._getKey("PANEL_START_POSITION");
    if (v === "bottom-right" || v === "center" || v === "bottom-left") return v;
    return "bottom-right";
  }

  savePanelStartPosition(position) {
    const result = this._saveKey("PANEL_START_POSITION", position);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  getUiLanguage(fallbackLanguage = "") {
    const language = this._getKey("UI_LANGUAGE") || fallbackLanguage;
    return language ? normalizeUiLanguage(language) : "";
  }

  saveUiLanguage(language) {
    const normalized = normalizeUiLanguage(language);
    const result = this._saveKey("UI_LANGUAGE", normalized);
    this.saveAllKeysToEnvFile().catch(() => {});
    return { ...result, language: normalized };
  }

  removeKeyFromEnvFile(key) {
    const envPath = path.join(getAppDataDirectory(), ".env");
    envWriteQueue = envWriteQueue.catch(() => {}).then(() => this._removeKeyLine(envPath, key));
    return envWriteQueue;
  }

  async _removeKeyLine(envPath, key) {
    let content;
    try {
      content = await fsPromises.readFile(envPath, "utf8");
    } catch {
      return; // No .env — nothing to remove.
    }
    const keyLine = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const lines = content.split("\n");
    const kept = lines.filter((line) => !keyLine.test(line));
    if (kept.length === lines.length) return;
    const tmpPath = `${envPath}.tmp`;
    await fsPromises.writeFile(tmpPath, kept.join("\n"), "utf8");
    await fsPromises.rename(tmpPath, envPath);
  }
}
module.exports = EnvironmentManager;
