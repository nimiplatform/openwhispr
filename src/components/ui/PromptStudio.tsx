import { useContext, useEffect, useRef, useState } from "react";
import { SettingsTabActiveContext } from "./settingsTabActivity";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Button } from "./button";
import { Textarea } from "./textarea";
import { Eye, Edit3, Play, Save, RotateCcw, Copy, TestTube, AlertTriangle, Check } from "../icons";
import { AlertDialog } from "./dialog";
import { useDialogs } from "../../hooks/useDialogs";
import { useAgentName } from "../../utils/agentName";
import { testNimiPrompt } from "../../services/nimiPromptTest";
import { getNimiClient, NIMI_AI_CONFIG_CHANGED_EVENT } from "../../services/nimiClient";
import type { NimiAIConfigEffectiveSelection } from "@nimiplatform/sdk/ai";
import logger from "../../utils/logger";
import { getDefaultPromptText, type PromptKind } from "../../config/prompts";
import { useSettingsStore, selectPolicyEffectiveSettings } from "../../stores/settingsStore";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { getLanguageLabel } from "../../utils/languageSupport";

interface PromptStudioProps {
  className?: string;
  kind?: PromptKind;
}

export default function PromptStudio({ className = "", kind = "cleanup" }: PromptStudioProps) {
  const { t } = useTranslation();
  const tabActive = useContext(SettingsTabActiveContext);
  const [activeTab, setActiveTab] = useState<"current" | "edit" | "test">("current");
  const [testText, setTestText] = useState(() =>
    t(
      kind === "translate"
        ? "promptStudio.defaultTestInputTranslate"
        : "promptStudio.defaultTestInput"
    )
  );
  const [testResult, setTestResult] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [selection, setSelection] = useState<NimiAIConfigEffectiveSelection | null>(null);
  const activeTest = useRef<AbortController | null>(null);
  const cancelTest = () => {
    activeTest.current?.abort();
    activeTest.current = null;
    setIsLoading(false);
  };
  useEffect(() => {
    setIsLoading(false);
    setTestResult("");
    return () => {
      activeTest.current?.abort();
      activeTest.current = null;
    };
  }, [kind]);
  useEffect(() => {
    if (tabActive) return;
    activeTest.current?.abort();
    activeTest.current = null;
    setIsLoading(false);
  }, [tabActive]);
  useEffect(() => {
    if (activeTab !== "test" || !tabActive) return;
    let active = true;
    let sequence = 0;
    const refresh = async () => {
      const current = ++sequence;
      try {
        const snapshot = await getNimiClient().aiConfig.get();
        if (active && current === sequence)
          setSelection(
            snapshot.effectiveSelections.find(
              (value) => value.capabilityContract === "text.generate"
            ) ?? null
          );
      } catch {
        if (active && current === sequence) setSelection(null);
      }
    };
    void refresh();
    window.addEventListener(NIMI_AI_CONFIG_CHANGED_EVENT, refresh);
    return () => {
      active = false;
      window.removeEventListener(NIMI_AI_CONFIG_CHANGED_EVENT, refresh);
    };
  }, [activeTab, tabActive]);

  const { alertDialog, showAlertDialog, hideAlertDialog } = useDialogs();
  const { agentName } = useAgentName();
  const policyState = usePolicySnapshot();
  const effectiveSettings = useSettingsStore(
    useShallow((settings) => selectPolicyEffectiveSettings(settings, policyState))
  );
  const uiLanguage = effectiveSettings.uiLanguage;

  const useCleanupModel = effectiveSettings.useCleanupModel;
  const useDictationAgent = effectiveSettings.useDictationAgent;
  const useDictationTranslation = effectiveSettings.useDictationTranslation;
  const translationTargetLanguage = effectiveSettings.translationTargetLanguage;
  const isTranslate = kind === "translate";
  const isAgent = kind === "dictationAgent";

  const customPrompt = useSettingsStore((s) => s.customPrompts[kind]);
  const setCustomPrompt = useSettingsStore((s) => s.setCustomPrompt);
  const defaultPrompt = getDefaultPromptText(kind, uiLanguage);
  const [editedPrompt, setEditedPrompt] = useState(customPrompt || defaultPrompt);

  const savePrompt = () => {
    // Saving the unedited default is not a customization; keep resolving the
    // shipped default so future prompt updates still reach this install.
    setCustomPrompt(kind, editedPrompt === defaultPrompt ? "" : editedPrompt);
    showAlertDialog({
      title: t("promptStudio.dialogs.saved.title"),
      description: t("promptStudio.dialogs.saved.description"),
    });
  };

  const resetToDefault = () => {
    setEditedPrompt(defaultPrompt);
    setCustomPrompt(kind, "");
    showAlertDialog({
      title: t("promptStudio.dialogs.reset.title"),
      description: t("promptStudio.dialogs.reset.description"),
    });
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  };

  const testPrompt = async () => {
    if (!tabActive || !testText.trim()) return;

    setIsLoading(true);
    setTestResult("");

    const controller = new AbortController();
    activeTest.current?.abort();
    activeTest.current = controller;
    try {
      if (isTranslate && !useDictationTranslation) {
        setTestResult(t("promptStudio.test.translationDisabled"));
        return;
      }
      if (isTranslate && !translationTargetLanguage.trim()) {
        setTestResult(t("promptStudio.test.noTargetLanguage"));
        return;
      }
      if (isAgent && !useDictationAgent) {
        setTestResult(t("promptStudio.test.agentDisabled"));
        return;
      }
      if (!isTranslate && !isAgent && !useCleanupModel) {
        setTestResult(t("promptStudio.test.disabledReasoning"));
        return;
      }
      const result = await testNimiPrompt({
        kind,
        text: testText,
        draft: editedPrompt,
        agentName,
        settings: effectiveSettings,
        signal: controller.signal,
        noModelMessage: t("promptStudio.test.noModelSelected"),
      });
      if (activeTest.current !== controller || controller.signal.aborted) return;
      setSelection(result.selection);
      setTestResult(result.text);
    } catch (error) {
      if (activeTest.current !== controller || controller.signal.aborted) return;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("PromptStudio test failed", { error: errorMessage }, "prompt-studio");
      setTestResult(t("promptStudio.test.failed", { error: errorMessage }));
    } finally {
      if (activeTest.current === controller) {
        activeTest.current = null;
        setIsLoading(false);
      }
    }
  };

  const isAgentAddressed = testText.toLowerCase().includes(agentName.toLowerCase());
  const isCustomPrompt = customPrompt.length > 0;
  const currentPrompt = customPrompt || defaultPrompt;

  const tabs = [
    { id: "current" as const, label: t("promptStudio.tabs.view"), icon: Eye },
    { id: "edit" as const, label: t("promptStudio.tabs.customize"), icon: Edit3 },
    { id: "test" as const, label: t("promptStudio.tabs.test"), icon: TestTube },
  ];

  return (
    <div className={className}>
      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {/* Tab Navigation + Content in a single panel */}
      <div className="rounded-xl border border-border/70 dark:border-border-subtle bg-card dark:bg-surface-2 overflow-hidden">
        <div className="flex border-b border-border/70 dark:border-border-subtle">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => {
                  cancelTest();
                  setActiveTab(tab.id);
                }}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-xs font-medium transition-colors duration-150 border-b-2 ${
                  isActive
                    ? "border-primary text-foreground bg-primary/5 dark:bg-primary/3"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-black/2 dark:hover:bg-white/2"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* ── View Tab ── */}
        {activeTab === "current" && (
          <div className="divide-y divide-border/60 dark:divide-border-subtle">
            <div className="px-5 py-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wider">
                    {isCustomPrompt
                      ? t("promptStudio.view.customPrompt")
                      : t("promptStudio.view.defaultPrompt")}
                  </p>
                  {isCustomPrompt && (
                    <span className="text-xs font-semibold uppercase tracking-wider px-1.5 py-px rounded-full bg-primary/10 text-primary">
                      {t("promptStudio.view.modified")}
                    </span>
                  )}
                </div>
                <Button
                  onClick={() => copyText(currentPrompt)}
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                >
                  {copiedPrompt ? (
                    <>
                      <Check className="w-3 h-3 me-1 text-success" />{" "}
                      {t("promptStudio.common.copied")}
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3 me-1" /> {t("promptStudio.common.copy")}
                    </>
                  )}
                </Button>
              </div>
              <div className="bg-muted/30 dark:bg-surface-raised/30 border border-border/70 rounded-lg p-4 max-h-80 overflow-y-auto">
                <pre
                  dir="auto"
                  className="text-xs font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed"
                >
                  {currentPrompt.replace(/\{\{agentName\}\}/g, agentName)}
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* ── Edit Tab ── */}
        {activeTab === "edit" && (
          <div className="divide-y divide-border/60 dark:divide-border-subtle">
            <div className="px-5 py-4">
              <p className="text-xs text-muted-foreground leading-relaxed">
                <span className="font-medium text-warning">
                  {t("promptStudio.edit.cautionLabel")}
                </span>{" "}
                {t("promptStudio.edit.cautionTextPrefix")}{" "}
                <code dir="ltr" className="text-xs bg-muted/50 px-1 py-0.5 rounded font-mono">
                  {"{{agentName}}"}
                </code>{" "}
                {t("promptStudio.edit.cautionTextSuffix")}
              </p>
            </div>

            <div className="px-5 py-4">
              <Textarea
                dir="auto"
                value={editedPrompt}
                onChange={(e) => setEditedPrompt(e.target.value)}
                rows={16}
                className="font-mono text-xs leading-relaxed"
                placeholder={t("promptStudio.edit.placeholder")}
              />
              <p className="text-xs text-muted-foreground/70 mt-2">
                {t("promptStudio.edit.agentNameLabel")}{" "}
                <span dir="auto" className="font-medium text-foreground">
                  {agentName}
                </span>
              </p>
            </div>

            <div className="px-5 py-4">
              <div className="flex gap-2">
                <Button onClick={savePrompt} size="sm" className="flex-1">
                  <Save className="w-3.5 h-3.5 me-2" />
                  {t("promptStudio.common.save")}
                </Button>
                <Button onClick={resetToDefault} variant="outline" size="sm">
                  <RotateCcw className="w-3.5 h-3.5 me-2" />
                  {t("promptStudio.common.reset")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Test Tab ── */}
        {activeTab === "test" &&
          (() => {
            const displayModel =
              selection?.resource?.oneofKind === "local"
                ? selection.resource.local.label
                : selection?.resource?.oneofKind === "cloud"
                  ? selection.resource.cloud.target.label
                  : t("nimi.modelsTitle");
            const displayProvider = "Nimi";

            return (
              <div className="divide-y divide-border/60 dark:divide-border-subtle">
                {!isTranslate && !isAgent && !useCleanupModel && (
                  <div className="px-5 py-4">
                    <div className="rounded-lg border border-warning/20 bg-warning/5 dark:bg-warning/10 px-4 py-3">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-warning mt-0.5 shrink-0" />
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {t("promptStudio.test.disabledInSettingsPrefix")}{" "}
                          <span className="font-medium text-foreground">
                            {t("promptStudio.test.aiModels")}
                          </span>{" "}
                          {t("promptStudio.test.disabledInSettingsSuffix")}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="px-5 py-4">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-muted-foreground/70 uppercase tracking-wider">
                        {t("promptStudio.test.modelLabel")}
                      </p>
                      <p dir="ltr" className="text-xs font-medium text-foreground font-mono">
                        {displayModel}
                      </p>
                    </div>
                    <div className="h-3 w-px bg-border/40" />
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-muted-foreground/70 uppercase tracking-wider">
                        {t("promptStudio.test.providerLabel")}
                      </p>
                      <p dir="ltr" className="text-xs font-medium text-foreground">
                        {displayProvider}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="px-5 py-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-foreground">
                      {t("promptStudio.test.inputLabel")}
                    </p>
                    {testText && (
                      <span
                        className={`text-xs font-medium uppercase tracking-wider px-1.5 py-px rounded ${
                          isTranslate || isAgent || isAgentAddressed
                            ? "bg-primary/10 text-primary dark:bg-primary/15"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {isTranslate
                          ? t("promptStudio.test.translation")
                          : isAgent || isAgentAddressed
                            ? t("promptStudio.test.instruction")
                            : t("promptStudio.test.cleanup")}
                      </span>
                    )}
                  </div>
                  <Textarea
                    dir="auto"
                    value={testText}
                    onChange={(e) => setTestText(e.target.value)}
                    rows={3}
                    className="text-xs"
                    placeholder={t("promptStudio.test.inputPlaceholder")}
                  />
                  {/* The agent tab always runs the agent prompt, addressed or not. */}
                  {!isAgent && (
                    <p className="text-xs text-muted-foreground/70 mt-1.5">
                      {isTranslate
                        ? t("promptStudio.test.translateHint", {
                            language: getLanguageLabel(translationTargetLanguage),
                          })
                        : t("promptStudio.test.addressHint", { agentName })}
                    </p>
                  )}
                </div>

                <div className="px-5 py-4">
                  <Button
                    onClick={testPrompt}
                    disabled={
                      !testText.trim() ||
                      isLoading ||
                      (!isTranslate && !isAgent && !useCleanupModel)
                    }
                    size="sm"
                    className="w-full"
                  >
                    <Play className="w-3.5 h-3.5 me-2" />
                    {isLoading ? t("promptStudio.test.processing") : t("promptStudio.test.run")}
                  </Button>
                </div>

                {isLoading && (
                  <Button onClick={cancelTest} variant="outline" size="sm">
                    {t("common.cancel")}
                  </Button>
                )}

                {testResult && (
                  <div className="px-5 py-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-medium text-foreground">
                        {t("promptStudio.test.outputLabel")}
                      </p>
                      <Button
                        onClick={() => copyText(testResult)}
                        variant="ghost"
                        size="icon"
                        className="h-6 w-7"
                      >
                        <Copy className="w-3 h-3 text-muted-foreground" />
                      </Button>
                    </div>
                    <div className="bg-muted/30 dark:bg-surface-raised/30 border border-border/70 rounded-lg p-4 max-h-48 overflow-y-auto">
                      <pre
                        dir="auto"
                        className="text-xs text-foreground whitespace-pre-wrap leading-relaxed"
                      >
                        {testResult}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
      </div>
    </div>
  );
}
