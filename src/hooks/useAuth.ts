import { useEffect, useState, useSyncExternalStore } from "react";
import { authClient, getGracePeriodRemainingMs, isWithinGracePeriod } from "../lib/auth";
import {
  accountScopeHasMandatoryReconciliation,
  accountScopeRequiresPurge,
  accountScopeRequiresReconciliation,
  getAccountScopeRevision,
  getAccountScopeServerRevision,
  isAccountScopeRetryWaiting,
  markAccountScopePurgeRequired,
  reconcileAccountScope,
  resetAccountScopeRetry,
  scheduleAccountScopeRetry,
  shouldBlockAccountScope,
  shouldReconcileAccountScope,
  subscribeAccountScope,
} from "../lib/authAccountScope";
import {
  assertAuthGenerationCurrent,
  commitValidatedAuthContext,
  getAuthRequestContextServerSnapshot,
  getAuthRequestContextSnapshot,
  getBoundSessionGeneration,
  getValidatedAuthGeneration,
  invalidateValidatedAuthContext,
  subscribeAuthRequestContext,
} from "../lib/authRequestContext";
import logger from "../utils/logger";
import { useSettingsStore } from "../stores/settingsStore";
import { usePolicyStore } from "../stores/policyStore";
import { useEnterpriseIdentityStore } from "../stores/enterpriseIdentityStore";
import { useLeaderboardParticipationStore } from "../stores/leaderboardParticipationStore";

const useStaticSession = () => ({
  data: null,
  isPending: false,
  error: null,
  refetch: async () => null,
});

async function loadAccountDependencies() {
  const [
    { syncService },
    { invalidateSpaceRoster },
    { resetForAccountChange },
    { useWorkspaceStore },
  ] = await Promise.all([
    import("../services/SyncService.js"),
    import("../lib/spaceRosterCache"),
    import("../stores/noteStore"),
    import("../stores/workspaceStore"),
  ]);

  const resetRendererCaches = () => {
    invalidateSpaceRoster();
    resetForAccountChange();
    useWorkspaceStore.getState().resetForAccountChange();
  };
  return { syncService, resetRendererCaches };
}

export function useAuth() {
  const useSession = authClient?.useSession ?? useStaticSession;
  const { data: ambientSession, isPending, error: sessionError, refetch } = useSession();
  const accountRevision = useSyncExternalStore(
    subscribeAccountScope,
    getAccountScopeRevision,
    getAccountScopeServerRevision
  );
  const authContext = useSyncExternalStore(
    subscribeAuthRequestContext,
    getAuthRequestContextSnapshot,
    getAuthRequestContextServerSnapshot
  );
  const [, setGraceExpiryTick] = useState(0);

  const ambientUser = ambientSession?.user ?? null;
  const ambientUserId = typeof ambientUser?.id === "string" ? ambientUser.id : null;
  // Not gated on sessionError: the binding survives a transient refetch failure
  // and is cleared on its own by a 401 or a credential-generation change.
  const boundGeneration = isPending ? null : getBoundSessionGeneration(ambientUserId);
  const sessionIsBound = boundGeneration != null;
  const resolvedUserId = sessionIsBound ? ambientUserId : null;
  const rawIsSignedIn = sessionIsBound && Boolean(ambientUser);
  const gracePeriodActive = sessionIsBound && !rawIsSignedIn && isWithinGracePeriod();
  const sessionResolutionFailed = Boolean(sessionError) || (!isPending && !sessionIsBound);
  const requiresReconciliation = sessionIsBound
    ? accountScopeRequiresReconciliation(resolvedUserId)
    : true;
  const cloudContextReady = !rawIsSignedIn || getValidatedAuthGeneration() === boundGeneration;
  const accountScopeBlocked =
    isPending ||
    shouldBlockAccountScope(
      isPending,
      gracePeriodActive,
      rawIsSignedIn,
      requiresReconciliation,
      accountScopeHasMandatoryReconciliation(),
      sessionResolutionFailed
    ) ||
    !cloudContextReady;
  // A reconciled session whose refetch failed transiently keeps its binding but
  // loses its validated lease. Keep presenting it instead of flashing to guest;
  // sync stays fenced by getValidatedAuthGeneration() until a refetch succeeds.
  const transientlyAuthenticated =
    Boolean(sessionError) &&
    rawIsSignedIn &&
    !requiresReconciliation &&
    !accountScopeHasMandatoryReconciliation();
  const accountScopePresentable = !accountScopeBlocked || transientlyAuthenticated;
  const isSignedIn = rawIsSignedIn && accountScopePresentable;
  // Loaded means the session settled: fully validated, or failed/signed-out
  // (presented as a guest). Resolution failure must not hold windows hostage —
  // dictation works without an account, and sync stays fenced by
  // hasValidatedAuthContext either way.
  const isLoaded = !isPending && (sessionResolutionFailed || !accountScopeBlocked);

  useEffect(() => {
    if (!gracePeriodActive) return;
    const remaining = getGracePeriodRemainingMs();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setGraceExpiryTick((value) => value + 1), remaining + 10);
    return () => window.clearTimeout(timer);
  }, [gracePeriodActive]);

  useEffect(() => {
    if (!sessionError) return;
    invalidateValidatedAuthContext();
  }, [sessionError]);

  return {
    isSignedIn,
    isGracePeriodOnly: gracePeriodActive,
    isLoaded,
    session: sessionIsBound && accountScopePresentable ? ambientSession : null,
    user: isSignedIn ? ambientUser : null,
    refetch,
  };
}
