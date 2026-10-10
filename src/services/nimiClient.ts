import { createNimiClient, type NimiLocalAppClient } from "@nimiplatform/sdk";
import {
  createNimiLocalAppStandardShellSurface,
  invoke,
} from "@nimiplatform/kit/shell/renderer/bridge";
import { createNimiRequestRunner } from "./nimiRequest";
import { usePolicyStore } from "../stores/policyStore";
import i18n from "../i18n";

let client: NimiLocalAppClient | null = null;
export const NIMI_AI_CONFIG_CHANGED_EVENT = "openwhispr:nimi-ai-config-changed";
export function notifyNimiAIConfigChanged(): void {
  window.dispatchEvent(new Event(NIMI_AI_CONFIG_CHANGED_EVENT));
}
export function getNimiClient(): NimiLocalAppClient {
  client ??= createNimiClient({
    localApp: { standardShell: createNimiLocalAppStandardShellSurface() },
  });
  return client;
}

export function invokeNimiBusiness<T>(command: string, input: Record<string, unknown>): Promise<T> {
  return invoke(command, input) as Promise<T>;
}

const MODEL_COMMANDS = new Set([
  "openwhispr.ai.edit-text",
  "openwhispr.ai.transcribe",
  "openwhispr.ai.transcribe-file",
  "openwhispr.recording.transcribe",
  "openwhispr.history.retry",
]);
const NEW_AI_WORK_COMMANDS = new Set([
  "openwhispr.recording.begin",
  "openwhispr.ai.edit-text",
  "openwhispr.ai.transcribe",
  "openwhispr.ai.transcribe-file",
  "openwhispr.history.retry",
]);

/** An explicit new task can recover this Host; it never retries a business command. */
export async function ensureNimiSessionReady(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  try {
    const status = await getNimiClient().auth.status();
    signal?.throwIfAborted();
    if (!status.sessionBound) throw Object.assign(new Error(status.reasonCode), status);
  } catch (cause) {
    signal?.throwIfAborted();
    const reason =
      cause && typeof cause === "object" && "reasonCode" in cause
        ? String(cause.reasonCode)
        : cause instanceof Error
          ? cause.message
          : String(cause);
    throw Object.assign(new Error(i18n.t("nimi.sessionConnectionUnavailable", { reason })), {
      code: "NIMI_SESSION_UNAVAILABLE",
      reasonCode: reason,
      messageKey: "nimi.sessionConnectionUnavailable",
      messageParams: { reason },
      settingsTarget: "speechToText",
      technicalDetails: { underlyingError: reason },
    });
  }
}

export async function prepareNimiAIWork(signal?: AbortSignal): Promise<void> {
  const initial = usePolicyStore.getState();
  const accountId = initial.accountId;
  const authGeneration = initial.authGeneration;
  await assertNimiBusinessAIAllowed(signal);
  await ensureNimiSessionReady(signal);
  signal?.throwIfAborted();
  const current = usePolicyStore.getState();
  if (current.accountId !== accountId || current.authGeneration !== authGeneration) {
    throw Object.assign(new Error(i18n.t("nimi.sessionScopeChanged")), {
      code: "NIMI_SESSION_CHANGED",
    });
  }
  await assertNimiBusinessAIAllowed(signal);
  signal?.throwIfAborted();
  const final = usePolicyStore.getState();
  if (final.accountId !== accountId || final.authGeneration !== authGeneration)
    throw Object.assign(new Error(i18n.t("nimi.sessionScopeChanged")), {
      code: "NIMI_SESSION_CHANGED",
    });
}

/** Configuration reads recover the technical connection without admitting AI work. */
export async function readNimiAIConfig(signal?: AbortSignal) {
  const initial = usePolicyStore.getState();
  const accountId = initial.accountId;
  const authGeneration = initial.authGeneration;
  const check = () => {
    signal?.throwIfAborted();
    const current = usePolicyStore.getState();
    if (current.accountId !== accountId || current.authGeneration !== authGeneration)
      throw Object.assign(new Error(i18n.t("nimi.sessionScopeChanged")), {
        code: "NIMI_SESSION_CHANGED",
      });
  };
  await ensureNimiSessionReady(signal);
  check();
  const snapshot = await getNimiClient().aiConfig.get();
  check();
  return snapshot;
}
const runRequest = createNimiRequestRunner(invokeNimiBusiness);
export async function runNimiRequest<T>(
  command: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  if (NEW_AI_WORK_COMMANDS.has(command)) await prepareNimiAIWork(signal);
  else if (MODEL_COMMANDS.has(command)) await assertNimiBusinessAIAllowed(signal);
  signal?.throwIfAborted();
  return runRequest<T>(command, input, signal);
}

export async function assertNimiBusinessAIAllowed(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const state = usePolicyStore.getState();
  if (state.status === "managed" || state.managed) {
    throw Object.assign(new Error(i18n.t("nimi.businessAIManaged")), {
      code: "BUSINESS_AI_POLICY_UNSUPPORTED",
    });
  }
  if (state.status === "loading" || state.status === "error") {
    throw Object.assign(new Error(i18n.t("nimi.businessAIUnresolved")), {
      code: "BUSINESS_AI_POLICY_UNRESOLVED",
    });
  }
  await invokeNimiBusiness("openwhispr.business.ai-access", {});
  signal?.throwIfAborted();
}
