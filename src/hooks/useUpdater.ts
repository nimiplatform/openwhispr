import { useCallback } from "react";
export function useUpdater() {
  const getAppVersion = useCallback(async () => {
    const result = await window.electronAPI.getAppVersion();
    return result.version;
  }, []);
  return { getAppVersion };
}
