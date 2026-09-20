const OPEN_DIRECTORY_CHANNEL = "dialog:open-directory";

/**
 * The native folder panel is only reachable under Electron. The browser client
 * served by the standalone server has no `electronAPI`, and falls back to the
 * in-app directory browser backed by `GET /api/browse`.
 */
export function canUseNativeDirectoryPicker(): boolean {
  return Boolean(window.electronAPI?.isElectron && typeof window.electronAPI.invoke === "function");
}

/** Resolves to the chosen absolute path, or null if cancelled or unavailable. */
export async function pickDirectoryNative(defaultPath?: string): Promise<string | null> {
  if (!canUseNativeDirectoryPicker()) return null;
  try {
    const result = await window.electronAPI!.invoke(OPEN_DIRECTORY_CHANNEL, defaultPath || undefined);
    return typeof result === "string" && result ? result : null;
  } catch {
    // A failed dialog should never block the modal — the caller keeps the
    // typed path and can still fall back to the in-app browser.
    return null;
  }
}
