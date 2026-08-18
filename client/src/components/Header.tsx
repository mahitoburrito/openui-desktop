import { Folder, Maximize2, Search } from "lucide-react";
import { useStore } from "../stores/useStore";

export function Header() {
  const {
    sessions,
    launchCwd,
    setCommandPaletteOpen,
    addFocusedSession,
    focusedSessionIds,
    selectedNodeId,
    setSidebarOpen,
    setViewMode,
  } = useStore();

  const selectedSession = selectedNodeId ? sessions.get(selectedNodeId) : null;
  const canOpenFocusMode = !!selectedSession || focusedSessionIds.length > 0;

  const openFocusMode = () => {
    if (!canOpenFocusMode) return;
    if (selectedNodeId && selectedSession) addFocusedSession(selectedNodeId);
    setSidebarOpen(false);
    setViewMode("focus");
  };

  const commandButton =
    "flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-surface-active hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-zinc-500";

  return (
    <header className="titlebar-drag flex h-14 items-center justify-between border-b border-border bg-canvas-dark px-4">
      <div className="flex min-w-0 items-center gap-2 pl-16">
        <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-zinc-600" />
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <Folder className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="max-w-[360px] truncate font-mono">{launchCwd || "~"}</span>
        </div>
      </div>

      <div className="titlebar-no-drag flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setCommandPaletteOpen(true)}
          className={commandButton}
          title="Search (Cmd+K)"
          aria-label="Search"
        >
          <Search className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={openFocusMode}
          disabled={!canOpenFocusMode}
          className={commandButton}
          title={canOpenFocusMode ? "Open focused session" : "Choose a session first"}
          aria-label="Open focused session"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
