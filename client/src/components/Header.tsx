import { Bell, Folder, Globe, Maximize2, MousePointer2, Plus, Search, Trash2 } from "lucide-react";
import { motion } from "framer-motion";
import { useStore } from "../stores/useStore";
import { bulkDeleteSessions } from "../utils/bulkDeleteSessions";

export function Header() {
  const {
    setAddAgentModalOpen,
    sessions,
    launchCwd,
    setCommandPaletteOpen,
    addFocusedSession,
    focusedSessionIds,
    selectedNodeId,
    setSidebarOpen,
    setViewMode,
    activityCenterOpen,
    setActivityCenterOpen,
    agentActivityEvents,
    activityLastSeenAt,
    viewMode,
    browserPanelOpen,
    setBrowserPanelOpen,
    browserUrl,
    selectionModeActive,
    setSelectionModeActive,
    multiSelectedNodeIds,
  } = useStore();

  const selectedSession = selectedNodeId ? sessions.get(selectedNodeId) : null;
  const canOpenFocusMode = !!selectedSession || focusedSessionIds.length > 0;
  const canOpenBrowserPreview = viewMode === "focus" || canOpenFocusMode;
  const unreadActivityCount = agentActivityEvents.filter(
    (event) => event.createdAt > activityLastSeenAt,
  ).length;

  const openFocusMode = () => {
    if (!canOpenFocusMode) return;
    if (selectedNodeId && selectedSession) {
      addFocusedSession(selectedNodeId);
    }
    setSidebarOpen(false);
    setViewMode("focus");
  };

  const openBrowserPreview = () => {
    if (viewMode === "focus") {
      setBrowserPanelOpen(!browserPanelOpen);
      return;
    }
    if (!canOpenFocusMode) return;
    if (selectedNodeId && selectedSession) {
      addFocusedSession(selectedNodeId);
    }
    setSidebarOpen(false);
    setViewMode("focus");
    setBrowserPanelOpen(true);
  };

  const multiDeleteActive = selectionModeActive && multiSelectedNodeIds.length > 0;

  const deleteSelectedSession = () => {
    if (multiDeleteActive) {
      void bulkDeleteSessions(multiSelectedNodeIds);
      return;
    }
    if (!selectedNodeId || !selectedSession) return;
    void bulkDeleteSessions([selectedNodeId]);
  };

  const commandButton =
    "relative flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-surface-active hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-zinc-500";

  return (
    <header className="h-14 px-4 flex items-center justify-between border-b border-border bg-canvas-dark titlebar-drag">
      <div className="flex min-w-0 items-center gap-2 pl-16">
        <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-zinc-600" />
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <Folder className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="max-w-[360px] truncate font-mono">{launchCwd || "~"}</span>
        </div>
      </div>

      <div className="flex items-center gap-1.5 titlebar-no-drag">
        <button
          onClick={() => setSelectionModeActive(!selectionModeActive)}
          disabled={viewMode !== "canvas"}
          className={`${commandButton} ${
            selectionModeActive ? "bg-surface-active text-zinc-100" : ""
          }`}
          title={
            viewMode !== "canvas"
              ? "Selection mode is available on the canvas"
              : selectionModeActive
                ? "Exit selection mode (Esc)"
                : "Selection mode — click or drag a box to select multiple sessions"
          }
          aria-label="Selection mode"
        >
          <MousePointer2 className="h-4 w-4" />
        </button>
        <button
          onClick={() => setCommandPaletteOpen(true)}
          className={commandButton}
          title="Search commands (Cmd+K)"
        >
          <Search className="h-4 w-4" />
        </button>
        <button
          onClick={openBrowserPreview}
          disabled={!canOpenBrowserPreview}
          className={`${commandButton} ${
            viewMode === "focus" && browserPanelOpen ? "bg-surface-active text-zinc-100" : ""
          }`}
          title={
            viewMode === "focus"
              ? browserUrl
                ? `Web preview: ${browserUrl}`
                : "Web preview (Cmd+Shift+B)"
              : canOpenFocusMode
                ? "Open web preview in focus mode"
                : "Select or pin a session to preview a browser"
          }
          aria-label="Web preview"
        >
          <Globe className="h-4 w-4" />
        </button>
        <button
          onClick={openFocusMode}
          disabled={!canOpenFocusMode}
          className={commandButton}
          title={
            selectedSession
              ? "Open selected session in focus mode"
              : focusedSessionIds.length > 0
                ? "Open pinned sessions in focus mode"
                : "Select or pin a session to focus"
          }
        >
          <Maximize2 className="h-4 w-4" />
        </button>
        <button
          onClick={() => setActivityCenterOpen(!activityCenterOpen)}
          className={commandButton}
          title={
            unreadActivityCount > 0
              ? `${unreadActivityCount} unread agent event${unreadActivityCount === 1 ? "" : "s"}`
              : "Agent activity"
          }
          aria-label="Agent activity"
        >
          <Bell className="h-4 w-4" />
          {unreadActivityCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold leading-none text-white ring-2 ring-canvas-dark">
              {unreadActivityCount > 9 ? "9+" : unreadActivityCount}
            </span>
          )}
        </button>
        <button
          onClick={deleteSelectedSession}
          disabled={!selectedSession && !multiDeleteActive}
          className={commandButton}
          title={
            multiDeleteActive
              ? `Delete ${multiSelectedNodeIds.length} selected session${
                  multiSelectedNodeIds.length === 1 ? "" : "s"
                }`
              : selectedSession
                ? "Delete selected session"
                : "Select a session to delete"
          }
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <motion.button
          onClick={() => setAddAgentModalOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-md bg-zinc-100 text-canvas transition-colors hover:bg-white"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          title="New agent"
        >
          <Plus className="h-4 w-4" />
        </motion.button>
      </div>
    </header>
  );
}
