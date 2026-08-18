import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useStore, type AgentStatus } from "../stores/useStore";
import {
  FOCUS_BACKDROPS,
  TERMINAL_THEMES,
  getFocusBackdrop,
} from "../theme/appearance";
import { AgentIcon, getAgentAccentColor } from "./AgentIcon";
import { Codicon } from "./Codicon";
import { InPaneMarkdown } from "./InPaneMarkdown";
import { ResearchView } from "./ResearchView";
import { ResizableSplit } from "./ResizableSplit";
import { SessionChat } from "./SessionChat";
import { Terminal } from "./Terminal";
import { WorkspaceIconButton } from "./WorkspaceChrome";
import { ExpandRing } from "./micro";

const statusConfig: Record<AgentStatus, { label: string; color: string }> = {
  creating: { label: "Creating…", color: "#818CF8" },
  running: { label: "Working", color: "#22C55E" },
  tool_calling: { label: "Working", color: "#22C55E" },
  waiting_input: { label: "Needs input", color: "#D97652" },
  idle: { label: "Idle", color: "#FBBF24" },
  disconnected: { label: "Offline", color: "#6B7280" },
  error: { label: "Error", color: "#EF4444" },
};

type WorkspaceView = "chat" | "terminal" | "split";

export function FocusMode() {
  const {
    viewMode,
    setViewMode,
    focusedSessionIds,
    addFocusedSession,
    removeFocusedSession,
    selectedNodeId,
    sessions,
    nodes,
    setNewSessionModalOpen,
    setNewSessionForNodeId,
    terminalTheme,
    setTerminalTheme,
    focusBackdrop,
    setFocusBackdrop,
    browserPanelOpen,
    setBrowserPanelOpen,
  } = useStore();

  const [activePane, setActivePane] = useState<string | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("chat");
  const [openedFiles, setOpenedFiles] = useState<Record<string, string | null>>({});
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [researchPanelOpen, setResearchPanelOpen] = useState(false);
  const [researchTarget, setResearchTarget] = useState<{ run?: string; metric?: string }>({});
  const backdrop = getFocusBackdrop(focusBackdrop);

  const focusedSessions = useMemo(
    () =>
      focusedSessionIds
        .map((nodeId) => ({
          nodeId,
          session: sessions.get(nodeId),
          node: nodes.find((node) => node.id === nodeId),
        }))
        .filter((entry) => entry.session != null),
    [focusedSessionIds, nodes, sessions],
  );

  const availableSessions = useMemo(
    () =>
      Array.from(sessions.entries())
        .filter(([nodeId]) => !focusedSessionIds.includes(nodeId))
        .map(([nodeId, session]) => ({ nodeId, session })),
    [focusedSessionIds, sessions],
  );

  useEffect(() => {
    if (selectedNodeId && focusedSessions.some((entry) => entry.nodeId === selectedNodeId)) {
      setActivePane(selectedNodeId);
      return;
    }
    if (!activePane || !focusedSessions.some((entry) => entry.nodeId === activePane)) {
      setActivePane(focusedSessions[0]?.nodeId ?? null);
    }
  }, [activePane, focusedSessions, selectedNodeId]);

  useEffect(() => {
    // Session data restores after the UI preference. Only leave focus when
    // there are truly no pinned ids; an unresolved id may appear a moment
    // before its live session during startup.
    if (viewMode === "focus" && focusedSessionIds.length === 0) {
      setViewMode("canvas");
    }
  }, [focusedSessionIds.length, setViewMode, viewMode]);

  useEffect(() => {
    const openWorkspaceView = (event: Event) => {
      const nextView = (event as CustomEvent<WorkspaceView>).detail;
      if (nextView === "chat" || nextView === "terminal" || nextView === "split") {
        setWorkspaceView(nextView);
      }
    };
    window.addEventListener("openui:workspace-view", openWorkspaceView);
    return () => window.removeEventListener("openui:workspace-view", openWorkspaceView);
  }, []);

  useEffect(() => {
    const openResearchPanel = (event: Event) => {
      const detail = (event as CustomEvent<{ run?: string; metric?: string }>).detail || {};
      setResearchTarget(detail);
      setResearchPanelOpen(true);
      setAppearanceOpen(false);
      setSessionPickerOpen(false);
    };
    window.addEventListener("openui:probe-research", openResearchPanel);
    return () => window.removeEventListener("openui:probe-research", openResearchPanel);
  }, []);

  const handleRemoveFocusedSession = useCallback(
    (nodeId: string) => {
      removeFocusedSession(nodeId);
      if (activePane === nodeId) setActivePane(null);
      if (focusedSessionIds.length <= 1) setViewMode("canvas");
    },
    [activePane, focusedSessionIds.length, removeFocusedSession, setViewMode],
  );

  const handleAddFocusedSession = useCallback(
    (nodeId: string) => {
      addFocusedSession(nodeId);
      setActivePane(nodeId);
      setSessionPickerOpen(false);
      setWorkspaceView("chat");
    },
    [addFocusedSession],
  );

  if (viewMode !== "focus" || focusedSessions.length === 0) return null;

  const activeEntry =
    focusedSessions.find((entry) => entry.nodeId === activePane) ?? focusedSessions[0];
  const activeInfo = activeEntry.session!;
  const focusTitle = activeInfo.customName || activeInfo.agentName;
  const focusCwd = activeInfo.cwd || activeInfo.originalCwd || "~";
  const focusDirectory = focusCwd.split("/").filter(Boolean).pop() || "~";
  const focusStatus = statusConfig[activeInfo.status] || statusConfig.idle;
  const displayColor = getAgentAccentColor(
    activeInfo.agentId,
    activeInfo.customColor || activeInfo.color,
  );

  const renderSessionWorkspace = (
    entry: (typeof focusedSessions)[number],
    showPaneHeader: boolean,
  ) => {
    const info = entry.session!;
    const cwd = info.cwd || info.originalCwd || "~";
    const status = statusConfig[info.status] || statusConfig.idle;
    const color = getAgentAccentColor(info.agentId, info.customColor || info.color);
    const title = info.customName || info.agentName;

    const terminal = (
      <div className="relative h-full min-h-0 overflow-hidden bg-[oklch(0.105_0.005_260/.34)]">
        <Terminal
          key={`focus-${info.sessionId}`}
          sessionId={info.sessionId}
          color={color}
          nodeId={entry.nodeId}
          cwd={info.cwd}
          glass
          onOpenFile={(path) =>
            setOpenedFiles((current) => ({ ...current, [entry.nodeId]: path }))
          }
        />
        <AnimatePresence>
          {openedFiles[entry.nodeId] && (
            <InPaneMarkdown
              key={openedFiles[entry.nodeId]!}
              path={openedFiles[entry.nodeId]!}
              onClose={() =>
                setOpenedFiles((current) => ({ ...current, [entry.nodeId]: null }))
              }
            />
          )}
        </AnimatePresence>
      </div>
    );

    const chat = (
      <SessionChat
        key={`chat-${info.sessionId}`}
        sessionId={info.sessionId}
        directory={cwd}
        statusLabel={status.label}
        statusColor={status.color}
        agentId={info.agentId}
        agentName={info.agentName}
        agentColor={color}
        showHeader={!showPaneHeader}
      />
    );

    const content = workspaceView === "chat" ? (
      chat
    ) : workspaceView === "split" ? (
      <ResizableSplit
        direction="row"
        storageKey={`chat-terminal:${info.sessionId}`}
        minPaneSize={220}
      >
        {chat}
        {terminal}
      </ResizableSplit>
    ) : (
      terminal
    );

    if (!showPaneHeader) return content;

    return (
      <section
        key={entry.nodeId}
        onPointerDown={() => setActivePane(entry.nodeId)}
        className={`flex h-full min-h-0 flex-col bg-[var(--focus-charcoal)] ${activeEntry.nodeId === entry.nodeId ? "ring-1 ring-inset ring-white/[0.08]" : ""}`}
        aria-label={`${title} focus pane`}
      >
        <header className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-white/[0.055] px-2.5">
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[6px] bg-white/[0.035]">
            <AgentIcon
              agentId={info.agentId}
              iconId={(entry.node?.data?.icon as string) || info.agentId}
              className="h-3 w-3"
              style={{ color }}
            />
          </span>
          <strong className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-zinc-400">{title}</strong>
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: status.color }} />
          <span className="text-[9px]" style={{ color: status.color }}>{status.label}</span>
          <WorkspaceIconButton
            icon="close"
            label={`Close ${title}`}
            onClick={() => handleRemoveFocusedSession(entry.nodeId)}
            className="h-6 w-6"
            iconSize={11}
          />
        </header>
        <div className="min-h-0 flex-1">{content}</div>
      </section>
    );
  };

  const sessionBody = focusedSessions.length > 1 ? (
    <ResizableSplit
      direction="row"
      storageKey={`focus-sessions:${focusedSessions.map((entry) => entry.nodeId).join(":")}`}
      minPaneSize={320}
    >
      {focusedSessions.map((entry) => renderSessionWorkspace(entry, true))}
    </ResizableSplit>
  ) : (
    renderSessionWorkspace(activeEntry, false)
  );

  const body = researchPanelOpen ? (
    <ResizableSplit direction="row" storageKey="focus-probe-research" minPaneSize={360}>
      {sessionBody}
      <ResearchView
        embedded
        requestedRun={researchTarget.run}
        requestedMetric={researchTarget.metric}
        onClose={() => setResearchPanelOpen(false)}
      />
    </ResizableSplit>
  ) : sessionBody;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
      className="focus-glass-stage absolute inset-0 z-30 flex flex-col overflow-hidden"
      style={{ background: backdrop.background }}
    >
      <div className="focus-charcoal-header absolute inset-x-0 top-0 z-[70] h-12" aria-hidden="true" />
      <div className="titlebar-drag pointer-events-none absolute inset-x-0 top-0 z-[75] flex h-12 items-center px-3">
        <div className="focus-charcoal-control titlebar-no-drag pointer-events-auto relative ml-[92px] min-w-0 rounded-[11px] p-0.5">
          <button
            type="button"
            onClick={() => {
              setAppearanceOpen(false);
              setSessionPickerOpen((open) => !open);
            }}
            className="flex h-9 min-w-[210px] max-w-[430px] items-center gap-2.5 rounded-[9px] px-2.5 text-left transition-colors hover:bg-white/[0.055] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            aria-expanded={sessionPickerOpen}
          >
            <span
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-[7px] border border-white/[0.06] bg-white/[0.035]"
            >
              <AgentIcon
                agentId={activeInfo.agentId}
                iconId={(activeEntry.node?.data?.icon as string) || activeInfo.agentId}
                className="h-3.5 w-3.5"
                style={{ color: displayColor }}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-semibold leading-4 text-zinc-100">
                {focusTitle}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-[9px] leading-3 text-zinc-600">
                <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: focusStatus.color }} />
                <span style={{ color: focusStatus.color }}>{focusStatus.label}</span>
                <span aria-hidden="true">·</span>
                <span className="truncate" title={focusCwd}>{focusDirectory}</span>
              </span>
            </span>
            <Codicon name="chevron-down" size={11} className="flex-shrink-0 text-zinc-600" />
          </button>

          <AnimatePresence>
            {sessionPickerOpen && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                className="workspace-glass-menu absolute left-0 top-12 z-[90] w-72 overflow-hidden rounded-[11px]"
              >
                <div className="border-b border-white/[0.065] px-3 py-2 text-[9px] font-medium uppercase tracking-[0.1em] text-zinc-600">
                  Sessions
                </div>
                <div className="max-h-72 overflow-y-auto py-1">
                  {focusedSessions.map(({ nodeId, session, node }) => {
                    if (!session) return null;
                    const color = getAgentAccentColor(
                      session.agentId,
                      session.customColor || session.color,
                    );
                    const status = statusConfig[session.status] || statusConfig.idle;
                    return (
                      <div key={nodeId} className="group flex items-center px-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setActivePane(nodeId);
                            setSessionPickerOpen(false);
                          }}
                          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[7px] px-2 py-2 text-left transition-colors hover:bg-white/[0.055]"
                        >
                          <AgentIcon
                            agentId={session.agentId}
                            iconId={(node?.data?.icon as string) || session.agentId}
                            className="h-3.5 w-3.5 flex-shrink-0"
                            style={{ color }}
                          />
                          <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-300">
                            {session.customName || session.agentName}
                          </span>
                          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: status.color }} />
                          {nodeId === activeEntry.nodeId && <Codicon name="check" size={12} className="text-zinc-300" />}
                        </button>
                        {focusedSessions.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveFocusedSession(nodeId)}
                            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[7px] text-zinc-700 opacity-0 transition-[opacity,color,background-color] hover:bg-white/[0.055] hover:text-zinc-300 group-hover:opacity-100"
                            aria-label="Remove from focus"
                          >
                            <Codicon name="close" size={11} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {availableSessions.length > 0 && (
                    <>
                      <div className="mx-3 my-1 h-px bg-white/[0.065]" />
                      <div className="px-3 py-1 text-[9px] uppercase tracking-[0.1em] text-zinc-700">Open session</div>
                      {availableSessions.map(({ nodeId, session }) => (
                        <button
                          key={nodeId}
                          type="button"
                          onClick={() => handleAddFocusedSession(nodeId)}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-zinc-500 transition-colors hover:bg-white/[0.055] hover:text-zinc-200"
                        >
                          <Codicon name="add" size={12} />
                          <span className="truncate">{session.customName || session.agentName}</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="workspace-command-zone titlebar-no-drag pointer-events-auto relative ml-auto flex h-12 items-center justify-end pl-10">
        <nav className="workspace-command-dock focus-charcoal-control relative flex items-center gap-0.5 rounded-[11px] p-1" aria-label="Focus tools">
          <WorkspaceIconButton
            icon="zoom-out"
            label="Canvas"
            interaction="nudge-left"
            onClick={() => setViewMode("canvas")}
            title="Back to canvas (Escape)"
            iconSize={14}
          />
          <span className="mx-0.5 h-4 w-px bg-white/[0.075]" />
          <div className="focus-charcoal-segment flex items-center gap-0.5 rounded-[7px] p-0.5">
            <WorkspaceIconButton
              icon="comment-discussion"
              label="Chat"
              active={workspaceView === "chat"}
              onClick={() => setWorkspaceView("chat")}
              className="h-7 w-7"
              iconSize={14}
            />
            <WorkspaceIconButton
              icon="terminal"
              label="Terminal"
              active={workspaceView === "terminal"}
              onClick={() => setWorkspaceView("terminal")}
              className="h-7 w-7"
              iconSize={14}
            />
            <WorkspaceIconButton
              icon="split-horizontal"
              label="Chat and terminal"
              active={workspaceView === "split"}
              onClick={() => setWorkspaceView("split")}
              className="h-7 w-7"
              iconSize={14}
            />
          </div>
          <WorkspaceIconButton
            icon="graph-line"
            label="Model training"
            active={researchPanelOpen}
            onClick={() => {
              setAppearanceOpen(false);
              setSessionPickerOpen(false);
              setResearchPanelOpen((open) => !open);
            }}
            title="Probe model training"
            iconSize={14}
          />
          <WorkspaceIconButton
            icon="globe"
            label="Browser"
            active={browserPanelOpen}
            onClick={() => {
              setAppearanceOpen(false);
              setSessionPickerOpen(false);
              setBrowserPanelOpen(!browserPanelOpen);
            }}
            title="Browser dock (Cmd+Shift+B)"
            iconSize={14}
          />
          <WorkspaceIconButton
            icon="add"
            label="New session"
            interaction="rotate-quarter"
            onClick={() => {
              setAppearanceOpen(false);
              setSessionPickerOpen(false);
              setNewSessionForNodeId(null);
              setNewSessionModalOpen(true);
            }}
            iconSize={14}
          />
          <div className="relative">
            <WorkspaceIconButton
              icon="symbol-color"
              label="Appearance"
              active={appearanceOpen}
              onClick={() => {
                setSessionPickerOpen(false);
                setAppearanceOpen((open) => !open);
              }}
              iconSize={14}
            />
            <AnimatePresence>
              {appearanceOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                  className="workspace-glass-menu absolute right-0 top-10 z-[90] w-64 rounded-[10px] p-3"
                >
                  <div className="text-[9px] font-medium uppercase tracking-[0.1em] text-zinc-600">Backdrop</div>
                  <div className="mt-2 flex items-center gap-2">
                    {FOCUS_BACKDROPS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setFocusBackdrop(option.id)}
                        className={`relative h-7 w-7 rounded-full border transition-transform duration-150 hover:scale-105 ${focusBackdrop === option.id ? "border-zinc-200" : "border-white/10"}`}
                        style={{
                          background:
                            option.preview.length > 1
                              ? `linear-gradient(135deg, ${option.preview.join(", ")})`
                              : option.preview[0],
                        }}
                        title={`${option.name}: ${option.description}`}
                      >
                        <ExpandRing active={focusBackdrop === option.id} />
                      </button>
                    ))}
                  </div>
                  <div className="mt-4 text-[9px] font-medium uppercase tracking-[0.1em] text-zinc-600">Terminal</div>
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    {TERMINAL_THEMES.map((theme) => (
                      <button
                        key={theme.id}
                        type="button"
                        onClick={() => setTerminalTheme(theme.id)}
                        className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-[10px] transition-colors ${terminalTheme === theme.id ? "border-white/20 bg-white/[0.07] text-zinc-200" : "border-white/[0.06] text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300"}`}
                      >
                        <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: theme.background }} />
                        {theme.name}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </nav>
        </div>
      </div>

      <main className="min-h-0 flex-1 pt-12">{body}</main>
    </motion.div>
  );
}
