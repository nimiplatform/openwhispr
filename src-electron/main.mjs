import { app, BrowserWindow, ipcMain, protocol, session, webContents } from "electron";
import { configureNimiElectronAppHostProfile } from "@nimiplatform/kit/shell/electron/host-profile";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

try {
  configureNimiElectronAppHostProfile(app);
} catch (error) {
  process.stderr.write(`[nimi-app-host-profile] ${error.message}\n`);
  app.exit(78);
  throw error;
}

const {
  registerNimiElectronAppAssetProtocolScheme,
  registerNimiElectronAppBridge,
  createNimiElectronAppExitController,
} = await import("@nimiplatform/kit/shell/electron/main");
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nimiAI = require("../src/helpers/nimiAI.js");
const developmentUrl = process.argv.find((value) => value.startsWith("--nimi-dev-renderer-url="));
const rendererUrl = developmentUrl
  ? developmentUrl.slice("--nimi-dev-renderer-url=".length).replace(/\/$/, "") + "/"
  : pathToFileURL(path.join(root, "src/dist/index.html")).href;
if (developmentUrl) {
  const parsed = new URL(rendererUrl);
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error("OpenWhispr requires an exact loopback development renderer URL.");
  }
  process.env.NODE_ENV = "development";
  process.env.OPENWHISPR_DEV_SERVER_PORT = new URL(rendererUrl).port;
}

registerNimiElectronAppAssetProtocolScheme(protocol);
app.whenReady().then(() => {
  const bridge = registerNimiElectronAppBridge({
    appId: "ai.nimi.openwhispr",
    allowedRendererUrls: [
      rendererUrl,
      ...["panel", "meeting-notification", "agent-dictation-pill", "permission-guide"].map(
        (name) => `${rendererUrl}?${name}=true`
      ),
    ],
    assetMediaPlatform: { protocol, webRequest: session.defaultSession.webRequest, webContents },
    ipcMain,
    appCommandHandlers: nimiAI.commandHandlers,
    onSessionReady: (services) => nimiAI.bindServices(services),
    onSessionInvalidated: () => {
      nimiAI.invalidate();
      business.default.resetNimiSessionWindows();
    },
  });
  nimiAI.configureSessionPreparation((signal) => bridge.prepareSession(signal));
  nimiAI.bindServices(bridge.services);
  app.on("before-quit", () => {
    nimiAI.configureSessionPreparation(undefined);
    nimiAI.invalidate();
    bridge.unregister();
  });
});

const business = await import("../main.js");
business.default.configureNimiExitController(createNimiElectronAppExitController(app));
