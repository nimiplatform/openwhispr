import { useState, useCallback } from "react";

export function useNotesOnboarding() {
  const [isComplete, setIsComplete] = useState(() => localStorage.getItem("notesOnboardingComplete") === "true");
  const complete = useCallback(() => { localStorage.setItem("notesOnboardingComplete", "true"); setIsComplete(true); }, []);
  return { isComplete, complete };
}
