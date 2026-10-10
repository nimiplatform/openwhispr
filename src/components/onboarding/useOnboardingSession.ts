import { useCallback, useEffect, useState } from "react";
import type { PermissionGuideId } from "../../types/permissionGuide";
import {
  ONBOARDING_SESSION_KEY,
  createOnboardingSession,
  parseOnboardingSession,
  type OnboardingAuthPath,
  type OnboardingSession,
  type OnboardingSetupMode,
  type OnboardingStepId,
} from "./flow";

function readInitialSession(): OnboardingSession {
  if (typeof window === "undefined") return createOnboardingSession();

  const stored = parseOnboardingSession(localStorage.getItem(ONBOARDING_SESSION_KEY));
  if (stored) return stored;

  return createOnboardingSession();
}

export function useOnboardingSession() {
  const [session, setSession] = useState<OnboardingSession>(readInitialSession);

  useEffect(() => {
    localStorage.setItem(ONBOARDING_SESSION_KEY, JSON.stringify(session));
    // AppRouter uses presence of this legacy key to distinguish an OAuth
    // callback from a returning user. Keep it until finalization is atomic.
  }, [session]);

  const goTo = useCallback((stepId: OnboardingStepId) => {
    setSession((current) => {
      if (current.currentStepId === stepId) return current;
      return {
        ...current,
        currentStepId: stepId,
        history: [...current.history, current.currentStepId],
      };
    });
  }, []);

  const goBack = useCallback(() => {
    setSession((current) => {
      const history = [...current.history];
      const previous = history.pop();
      return previous ? { ...current, currentStepId: previous, history } : current;
    });
  }, []);

  const setAuthPath = useCallback((authPath: OnboardingAuthPath) => {
    setSession((current) => ({ ...current, authPath }));
  }, []);

  const setSetupMode = useCallback((setupMode: OnboardingSetupMode) => {
    setSession((current) => ({ ...current, setupMode }));
  }, []);

  const setSelfHostedRequested = useCallback((selfHostedRequested: boolean) => {
    setSession((current) => ({ ...current, selfHostedRequested }));
  }, []);

  const setScreenContextRequested = useCallback((screenContextRequested: boolean) => {
    setSession((current) => ({ ...current, screenContextRequested }));
  }, []);

  const setPermissionGuide = useCallback((permissionGuide: PermissionGuideId | null) => {
    setSession((current) => ({ ...current, permissionGuide }));
  }, []);

  const clearSession = useCallback(() => {
    localStorage.removeItem(ONBOARDING_SESSION_KEY);
  }, []);

  return {
    session,
    setSession,
    goTo,
    goBack,
    setAuthPath,
    setSetupMode,
    setSelfHostedRequested,
    setScreenContextRequested,
    setPermissionGuide,
    clearSession,
  };
}
