import { useStore } from "../stores/useStore";
import { destroyCachedTerminal } from "./Terminal";
import { WorkspaceIconButton } from "./WorkspaceChrome";

export function Header({ isFullscreen = false }: { isFullscreen?: boolean }) {
  const {
    setAddAgentModalOpen,
    sessions,
    launchCwd,
    addFocusedSession,
    focusedSessionIds,
    removeFocusedSession,
    removeNode,
    removeSession,
    selectedNodeId,
    setSelectedNodeId,
    setSidebarOpen,
    setDeleteToast,
    setViewMode,
    activityCenterOpen,
    setActivityCenterOpen,
    agentActivityEvents,
    activityLastSeenAt,
    viewMode,
    browserPanelOpen,
    setBrowserPanelOpen,
    browserUrl,
  } = useStore();

  const selectedSession = selectedNodeId ? sessions.get(selectedNodeId) : null;
  const latestSession = Array.from(sessions.values()).sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )[0];
  const workspaceCwd =
    selectedSession?.originalCwd ||
    selectedSession?.cwd ||
    latestSession?.originalCwd ||
    latestSession?.cwd ||
    launchCwd;
  const workspaceName = workspaceCwd?.split("/").filter(Boolean).pop() || "~";
  const canOpenFocusMode = !!selectedSession || focusedSessionIds.length > 0;
  const canOpenBrowserPreview = viewMode === "focus" || viewMode === "research" || canOpenFocusMode;
  const isTrackingOpen = viewMode === "research";
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
    if (viewMode === "focus" || viewMode === "research") {
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

  const openModelTracking = () => {
    setSidebarOpen(false);
    setViewMode(viewMode === "research" ? "canvas" : "research");
  };

  const deleteSelectedSession = async () => {
    if (!selectedNodeId || !selectedSession) return;

    const sessionName = selectedSession.customName || selectedSession.agentName || "Session";
    const confirmed = window.confirm(`Delete "${sessionName}"? You'll have 5 seconds to undo.`);
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/sessions/${selectedSession.sessionId}/soft-delete`, { method: "POST" });
      if (!res.ok) {
        window.alert(`Could not delete "${sessionName}".`);
        return;
      }
    } catch {
      window.alert(`Could not delete "${sessionName}".`);
      return;
    }

    destroyCachedTerminal(selectedSession.sessionId);
    removeFocusedSession(selectedNodeId);
    removeSession(selectedNodeId);
    removeNode(selectedNodeId);
    setSelectedNodeId(null);
    setSidebarOpen(false);

    const timeout = setTimeout(() => {
      setDeleteToast(null);
    }, 5000);

    setDeleteToast({
      sessionId: selectedSession.sessionId,
      nodeId: selectedNodeId,
      sessionName,
      timeout,
    });
  };

  return (
    <header className="titlebar-drag pointer-events-none absolute inset-x-0 top-0 z-[60] flex h-12 items-center px-3">
      <div className={`flex min-w-0 items-center gap-2 ${isFullscreen ? "ml-1" : "ml-[82px]"}`}>
        <button
          type="button"
          onClick={openModelTracking}
          className="probe-brand-button titlebar-no-drag pointer-events-auto flex h-7 items-center gap-1.5 rounded-[7px] px-1.5 text-zinc-700 transition-colors hover:bg-white/[0.09] hover:text-zinc-950"
          title="Open native Probe model training"
        >
          <img src="/probe-mark.svg" alt="" className="probe-brand-mark h-[17px] w-[17px]" />
          <span className="text-[11px] font-semibold tracking-[-0.015em]">Probe</span>
        </button>
        {workspaceName.toLowerCase() !== "probe" && (
          <span
            className="max-w-40 truncate text-[10px] font-medium tracking-[-0.01em] text-zinc-600"
            title={workspaceCwd || "~"}
          >
            {workspaceName}
          </span>
        )}
      </div>

      <div className="workspace-command-zone titlebar-no-drag pointer-events-auto ml-auto flex h-12 items-center justify-end pl-8">
      <div className="workspace-command-dock workspace-glass flex items-center gap-0.5 rounded-[10px] p-1">
        <WorkspaceIconButton
          icon="graph-line"
          label="Model training"
          onClick={openModelTracking}
          active={isTrackingOpen}
          title="Open native Probe model training"
        />
        <WorkspaceIconButton
          icon="globe"
          label="Web preview"
          onClick={openBrowserPreview}
          disabled={!canOpenBrowserPreview}
          active={(viewMode === "focus" || viewMode === "research") && browserPanelOpen}
          title={
            viewMode === "focus" || viewMode === "research"
              ? browserUrl
                ? `Web preview: ${browserUrl}`
                : "Web preview (Cmd+Shift+B)"
              : canOpenFocusMode
                ? "Open web preview in focus mode"
                : "Select or pin a session to preview a browser"
          }
        />
        <WorkspaceIconButton
          icon="screen-full"
          label="Focus session"
          onClick={openFocusMode}
          disabled={!canOpenFocusMode}
          title={
            selectedSession
              ? "Open selected session in focus mode"
              : focusedSessionIds.length > 0
                ? "Open pinned sessions in focus mode"
                : "Select or pin a session to focus"
          }
        />
        <WorkspaceIconButton
          icon="bell"
          label="Agent activity"
          interaction="shake"
          onClick={() => setActivityCenterOpen(!activityCenterOpen)}
          active={activityCenterOpen}
          title={
            unreadActivityCount > 0
              ? `${unreadActivityCount} unread agent event${unreadActivityCount === 1 ? "" : "s"}`
              : "Agent activity"
          }
          badge={unreadActivityCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold leading-none text-zinc-50 ring-2 ring-[oklch(0.16_0.008_255/.9)]">
              {unreadActivityCount > 9 ? "9+" : unreadActivityCount}
            </span>
          ) : null}
        />
        <WorkspaceIconButton
          icon="trash"
          label="Delete session"
          interaction="none"
          onClick={deleteSelectedSession}
          disabled={!selectedSession}
          title={selectedSession ? "Delete selected session" : "Select a session to delete"}
        />
        <WorkspaceIconButton
          icon="add"
          label="New agent"
          interaction="rotate-quarter"
          onClick={() => setAddAgentModalOpen(true)}
          primary
        />
      </div>
      </div>
    </header>
  );
}
