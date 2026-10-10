import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NimiAIConfigSnapshot } from "@nimiplatform/sdk/ai";
import { ModelConfigAIConfigSurface } from "@nimiplatform/kit/features/model-config";
import { openDesktopIntent } from "@nimiplatform/kit/shell/renderer/bridge";
import { createNimiDesktopOpenRequestId } from "@nimiplatform/kit/core/desktop-open";
import { getNimiClient, notifyNimiAIConfigChanged } from "../../services/nimiClient";

export default function NimiAISettings({
  initialCapability = "audio.transcribe",
}: {
  initialCapability?: string;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<NimiAIConfigSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const status = await getNimiClient().auth.status();
      setSessionUnavailable(!status.sessionBound);
      if (!status.sessionBound) {
        setSnapshot(null);
        setError(status.reasonCode);
        return;
      }
      setSnapshot(await getNimiClient().aiConfig.get());
    } catch (cause) {
      const reason =
        cause && typeof cause === "object" && "reasonCode" in cause ? cause.reasonCode : undefined;
      if (
        reason === "runtime-unauthenticated" ||
        (cause instanceof Error && cause.message === "runtime-unauthenticated")
      ) {
        setSessionUnavailable(true);
        setSnapshot(null);
        setError(String(reason || cause));
      } else setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const openNimi = async () => {
    setError(null);
    try {
      const result = await openDesktopIntent({
        requestId: createNimiDesktopOpenRequestId(),
        intent: { kind: "open-apps", appId: "ai.nimi.openwhispr", section: "ai-models" },
      });
      if (result.status === "rejected")
        setError(
          `${t(result.reasonCode === "desktop-open-desktop-not-ready" ? "nimi.desktopNotReady" : "nimi.openNimi")} (${result.reasonCode})`
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  if (sessionUnavailable)
    return (
      <section className="space-y-3" aria-label={t("nimi.modelsTitle")}>
        <p role="status">{t("nimi.sessionConnectionTitle")}</p>
        {error && <p role="alert">{error}</p>}
        <div className="flex gap-3">
          <button type="button" onClick={() => void openNimi()}>
            {t("nimi.openNimi")}
          </button>
          <button type="button" onClick={() => void refresh()}>
            {t("nimi.retry")}
          </button>
        </div>
      </section>
    );
  return (
    <section className="flex min-h-0 flex-col" aria-label={t("nimi.modelsTitle")}>
      <ModelConfigAIConfigSurface
        context={{ owner: "app-ai-config", appId: "ai.nimi.openwhispr" }}
        capabilityContracts={[
          "audio.transcribe",
          "text.generate",
          "text.embed",
          "audio.speaker.embed",
        ]}
        initialCapabilityContract={initialCapability}
        capabilities={snapshot?.config ? snapshot.config.capabilities : snapshot ? null : undefined}
        revision={snapshot?.revision}
        effectiveSelections={snapshot?.effectiveSelections}
        listOptions={(query) => getNimiClient().aiConfig.listOptions(query)}
        loading={loading && !snapshot}
        loadError={error}
        onRetry={() => {
          void refresh();
        }}
        onOverwrite={async (input) => {
          const result = await getNimiClient().aiConfig.overwrite(input);
          if (result.outcome === "committed") {
            notifyNimiAIConfigChanged();
            await refresh();
          }
          return result;
        }}
        onOpenOwnerConfiguration={() => void openNimi()}
        copy={{
          title: t("nimi.modelsTitle"),
          description: t("nimi.modelsDescription"),
          capabilityLabel: (contract, fallback) =>
            contract === "audio.speaker.embed" ? t("nimi.speakerRepresentations") : fallback,
        }}
      />
    </section>
  );
}
