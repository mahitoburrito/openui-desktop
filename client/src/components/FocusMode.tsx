import { useState, useCallback, useMemo, useEffect, ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Minimize2,
  Maximize2,
  Wrench,
  MessageSquare,
  WifiOff,
  RotateCcw,
  Columns,
  Rows,
  Grid2X2,
  Square,
  Plus,
} from "lucide-react";
import { useStore, AgentStatus } from "../stores/useStore";
import { TERMINAL_THEMES, getTerminalTheme } from "../theme/appearance";
import { Terminal } from "./Terminal";
import { ResizableSplit } from "./ResizableSplit";
import { InPaneMarkdown } from "./InPaneMarkdown";
import { AgentIcon, getAgentAccentColor } from "./AgentIcon";

const statusConfig: Record<AgentStatus, { label: string; color: string }> = {
  creating: { label: "Creating...", color: "#818CF8" },
  running: { label: "Working", color: "#22C55E" },
  tool_calling: { label: "Working", color: "#22C55E" },
  waiting_input: { label: "Needs Input", color: "#D97652" },
  idle: { label: "Idle", color: "#FBBF24" },
  disconnected: { label: "Offline", color: "#6B7280" },
  error: { label: "Error", color: "#EF4444" },
};

const toolDisplayNames: Record<string, string> = {
  Read: "Reading",
  Write: "Writing",
  Edit: "Editing",
  Bash: "Running",
  Grep: "Searching",
  Glob: "Finding",
  Task: "Tasking",
  WebFetch: "Fetching",
  WebSearch: "Searching",
};

type SplitLayout = "auto" | "columns" | "rows" | "grid";

export function FocusMode() {
  const {
    viewMode,
    setViewMode,
    focusedSessionIds,
    addFocusedSession,
    removeFocusedSession,
    sessions,
    nodes,
    setNewSessionModalOpen,
    setNewSessionForNodeId,
    terminalTheme,
    setTerminalTheme,
  } = useStore();

  const [activePane, setActivePane] = useState<string | null>(null);
  const [maximizedPane, setMaximizedPane] = useState<string | null>(null);
  const [layout, setLayout] = useState<SplitLayout>("auto");
  const [openedFiles, setOpenedFiles] = useState<Record<string, string | null>>({});
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const terminalPalette = getTerminalTheme(terminalTheme);

  const setOpenedFile = (nodeId: string, path: string | null) => {
    setOpenedFiles((prev) => ({ ...prev, [nodeId]: path }));
  };

  const focusedSessions = useMemo(
    () =>
      focusedSessionIds
        .map((nodeId) => ({
          nodeId,
          session: sessions.get(nodeId),
          node: nodes.find((n) => n.id === nodeId),
        }))
        .filter((e) => e.session != null),
    [focusedSessionIds, sessions, nodes]
  );

  const availableSessions = useMemo(
    () =>
      Array.from(sessions.entries())
        .filter(([nodeId]) => !focusedSessionIds.includes(nodeId))
        .map(([nodeId, session]) => ({
          nodeId,
          session,
          node: nodes.find((n) => n.id === nodeId),
        })),
    [focusedSessionIds, sessions, nodes]
  );

  // Auto-set active pane to first session if none set
  useEffect(() => {
    if (focusedSessions.length > 0 && !activePane) {
      setActivePane(focusedSessions[0].nodeId);
    }
  }, [focusedSessions, activePane]);

  // Clear maximized if that pane was removed
  useEffect(() => {
    if (maximizedPane && !focusedSessionIds.includes(maximizedPane)) {
      setMaximizedPane(null);
    }
  }, [focusedSessionIds, maximizedPane]);

  useEffect(() => {
    if (availableSessions.length === 0) {
      setSessionPickerOpen(false);
    }
  }, [availableSessions.length]);

  const handleClose = useCallback(
    (nodeId: string) => {
      removeFocusedSession(nodeId);
      if (activePane === nodeId) {
        setActivePane(null);
      }
      if (maximizedPane === nodeId) {
        setMaximizedPane(null);
      }
      // If no more focused sessions, exit focus mode
      if (focusedSessionIds.length <= 1) {
        setViewMode("canvas");
      }
    },
    [removeFocusedSession, focusedSessionIds, setViewMode, activePane, maximizedPane]
  );

  const handleNewSession = useCallback(
    (nodeId: string) => {
      setNewSessionForNodeId(nodeId);
      setNewSessionModalOpen(true);
    },
    [setNewSessionForNodeId, setNewSessionModalOpen]
  );

  const handleAddFocusedSession = useCallback(
    (nodeId: string) => {
      addFocusedSession(nodeId);
      setActivePane(nodeId);
      setSessionPickerOpen(false);
      setMaximizedPane(null);
    },
    [addFocusedSession]
  );

  const toggleMaximize = useCallback(
    (nodeId: string) => {
      setMaximizedPane((prev) => (prev === nodeId ? null : nodeId));
    },
    []
  );

  if (viewMode !== "focus" || focusedSessions.length === 0) return null;

  const count = focusedSessions.length;
  const visibleSessions = maximizedPane
    ? focusedSessions.filter((s) => s.nodeId === maximizedPane)
    : focusedSessions;

  // Pick effective layout. "auto" picks columns up to 3, otherwise grid.
  const effectiveLayout: SplitLayout = maximizedPane
    ? "columns"
    : layout === "auto"
    ? count <= 3
      ? "columns"
      : "grid"
    : layout;

  const renderPane = ({
    nodeId,
    session,
    node,
  }: (typeof focusedSessions)[number]) => {
    if (!session) return null;
    const displayColor = getAgentAccentColor(
      session.agentId,
      session.customColor || session.color,
    );
    const displayName = session.customName || session.agentName;
    const iconId = (node?.data?.icon as string) || "cpu";
    const status = statusConfig[session.status] || statusConfig.idle;
    const isActive = activePane === nodeId;
    const isDisconnected = session.status === "disconnected";
    const needsInput = session.status === "waiting_input";
    const toolDisplay = session.currentTool
      ? toolDisplayNames[session.currentTool] || session.currentTool
      : null;

    return (
      <div
        key={nodeId}
        className={`flex flex-col h-full min-h-0 cursor-text transition-all ${
          isActive ? "bg-canvas" : "bg-canvas-dark"
        }`}
        onClick={() => setActivePane(nodeId)}
        style={{
          backgroundColor: isActive ? terminalPalette.surface : terminalPalette.background,
          outline: isActive
            ? `1px solid ${displayColor}40`
            : needsInput
            ? `1px solid ${status.color}60`
            : "none",
        }}
      >
        <div
          className="flex-shrink-0 h-8 px-2.5 flex items-center justify-between border-b transition-colors"
          style={{
            borderColor: isActive ? `${displayColor}30` : terminalPalette.border,
            backgroundColor: isActive ? `${displayColor}08` : "transparent",
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: `${displayColor}15` }}
            >
              <AgentIcon
                agentId={session.agentId}
                iconId={iconId}
                className="w-2.5 h-2.5"
                style={{ color: displayColor }}
              />
            </div>
            <span className="text-[11px] font-medium text-white truncate">
              {displayName}
            </span>
            <div
              className="flex items-center gap-1 flex-shrink-0 px-1.5 py-0.5 rounded-full"
              style={{ backgroundColor: `${status.color}15` }}
            >
              <div className="relative">
                <div
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: status.color }}
                />
                {(session.status === "running" || session.status === "tool_calling") && (
                  <div
                    className="absolute inset-0 w-1.5 h-1.5 rounded-full animate-ping"
                    style={{
                      backgroundColor: status.color,
                      opacity: 0.4,
                      animationDuration: "2s",
                    }}
                  />
                )}
              </div>
              <span
                className="text-[9px] font-medium"
                style={{ color: status.color }}
              >
                {status.label}
              </span>
              {session.status === "tool_calling" && toolDisplay && (
                <span className="text-[8px] text-zinc-500 flex items-center gap-0.5">
                  <Wrench className="w-2 h-2" />
                  {toolDisplay}
                </span>
              )}
              {needsInput && (
                <MessageSquare
                  className="w-2.5 h-2.5"
                  style={{ color: status.color }}
                />
              )}
              {isDisconnected && (
                <WifiOff className="w-2.5 h-2.5" style={{ color: status.color }} />
              )}
            </div>
          </div>

          <div className="flex items-center gap-0.5 flex-shrink-0">
            {isDisconnected && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleNewSession(nodeId);
                }}
                className="w-5 h-5 rounded flex items-center justify-center text-red-400 hover:bg-red-500/10 transition-colors"
                title="New session"
              >
                <RotateCcw className="w-2.5 h-2.5" />
              </button>
            )}
            {count > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleMaximize(nodeId);
                }}
                className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
                  maximizedPane === nodeId
                    ? "text-blue-400 bg-blue-500/10"
                    : "text-zinc-600 hover:text-zinc-300 hover:bg-surface-active"
                }`}
                title={maximizedPane === nodeId ? "Restore" : "Maximize"}
              >
                <Maximize2 className="w-2.5 h-2.5" />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleClose(nodeId);
              }}
              className="w-5 h-5 rounded flex items-center justify-center text-zinc-600 hover:text-white hover:bg-surface-active transition-colors"
              title="Remove from focus view"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>

        <div
          className="flex-1 min-h-0 relative"
          style={{ backgroundColor: terminalPalette.background }}
        >
          <Terminal
            key={`focus-${session.sessionId}`}
            sessionId={session.sessionId}
            color={displayColor}
            nodeId={nodeId}
            cwd={session.cwd}
            onOpenFile={(p) => setOpenedFile(nodeId, p)}
          />
          <AnimatePresence>
            {openedFiles[nodeId] && (
              <InPaneMarkdown
                key={openedFiles[nodeId]!}
                path={openedFiles[nodeId]!}
                onClose={() => setOpenedFile(nodeId, null)}
              />
            )}
          </AnimatePresence>
        </div>
      </div>
    );
  };

  // Build the split tree based on effective layout.
  // When >1 session in same direction, use a single ResizableSplit.
  // For "grid", chunk into rows of up to 4, then vertical split of horizontal splits.
  const sessionsKey = visibleSessions.map((s) => s.nodeId).join(",");
  let body: ReactNode;
  if (visibleSessions.length === 1) {
    body = renderPane(visibleSessions[0]);
  } else if (effectiveLayout === "rows") {
    body = (
      <ResizableSplit
        direction="col"
        storageKey={`rows:${sessionsKey}`}
      >
        {visibleSessions.map(renderPane)}
      </ResizableSplit>
    );
  } else if (effectiveLayout === "grid") {
    const cols = Math.min(4, Math.ceil(Math.sqrt(visibleSessions.length)));
    const rows: (typeof visibleSessions)[] = [];
    for (let i = 0; i < visibleSessions.length; i += cols) {
      rows.push(visibleSessions.slice(i, i + cols));
    }
    body = (
      <ResizableSplit
        direction="col"
        storageKey={`grid-rows:${sessionsKey}`}
      >
        {rows.map((row, rowIdx) =>
          row.length === 1 ? (
            renderPane(row[0])
          ) : (
            <ResizableSplit
              key={rowIdx}
              direction="row"
              storageKey={`grid-row-${rowIdx}:${row.map((s) => s.nodeId).join(",")}`}
            >
              {row.map(renderPane)}
            </ResizableSplit>
          ),
        )}
      </ResizableSplit>
    );
  } else {
    // columns (default for >1)
    body = (
      <ResizableSplit
        direction="row"
        storageKey={`cols:${sessionsKey}`}
      >
        {visibleSessions.map(renderPane)}
      </ResizableSplit>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-30 bg-canvas flex flex-col"
    >
      {/* Top bar */}
      <div className="flex-shrink-0 h-8 px-3 flex items-center justify-between bg-canvas-dark border-b border-border">
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
            Focus Mode
          </span>
          <span className="text-[10px] text-zinc-600">
            {count} session{count !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <div className="relative">
            <button
              onClick={() => setSessionPickerOpen((open) => !open)}
              disabled={availableSessions.length === 0}
              className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] text-zinc-400 hover:text-white hover:bg-surface-active disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-400 transition-colors"
              title={
                availableSessions.length === 0
                  ? "All sessions are already in focus"
                  : "Add session to focus mode"
              }
            >
              <Plus className="w-3 h-3" />
              Session
            </button>

            <AnimatePresence>
              {sessionPickerOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.12 }}
                  className="absolute right-0 top-7 z-[80] w-64 rounded-md border border-border bg-canvas-dark shadow-2xl overflow-hidden"
                >
                  <div className="px-2.5 py-1.5 border-b border-border text-[9px] uppercase tracking-wider text-zinc-600 font-semibold">
                    Add To Focus
                  </div>
                  <div className="max-h-72 overflow-y-auto py-1">
                    {availableSessions.map(({ nodeId, session, node }) => {
                      const displayColor = getAgentAccentColor(
                        session.agentId,
                        session.customColor || session.color,
                      );
                      const displayName = session.customName || session.agentName;
                      const iconId = (node?.data?.icon as string) || session.agentId;
                      const status = statusConfig[session.status] || statusConfig.idle;

                      return (
                        <button
                          key={nodeId}
                          onClick={() => handleAddFocusedSession(nodeId)}
                          className="w-full min-w-0 px-2.5 py-2 flex items-center gap-2 text-left hover:bg-surface-active transition-colors"
                          title={`Add ${displayName} to focus mode`}
                        >
                          <div
                            className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0"
                            style={{ backgroundColor: `${displayColor}18` }}
                          >
                            <AgentIcon
                              agentId={session.agentId}
                              iconId={iconId}
                              className="w-3.5 h-3.5"
                              style={{ color: displayColor }}
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-[11px] text-zinc-200 truncate">
                              {displayName}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[9px] text-zinc-600">
                              <span
                                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                                style={{ backgroundColor: status.color }}
                              />
                              <span>{status.label}</span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="hidden md:flex items-center gap-1 mr-2 px-1 py-0.5 rounded bg-canvas">
            {TERMINAL_THEMES.map((theme) => (
              <button
                key={theme.id}
                onClick={() => setTerminalTheme(theme.id)}
                className={`w-5 h-5 rounded border transition-transform hover:scale-105 ${
                  terminalTheme === theme.id ? "border-zinc-200" : "border-zinc-700"
                }`}
                style={{ backgroundColor: theme.background }}
                title={`${theme.name} terminal background`}
              />
            ))}
          </div>

          {/* Layout switcher — only show when >1 session and not maximized */}
          {count > 1 && !maximizedPane && (
            <div className="flex items-center gap-0.5 mr-2 px-1 py-0.5 rounded bg-canvas">
              <button
                onClick={() => setLayout("auto")}
                className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
                  layout === "auto" ? "text-white bg-surface-active" : "text-zinc-600 hover:text-zinc-400"
                }`}
                title="Auto layout"
              >
                <Square className="w-3 h-3" />
              </button>
              <button
                onClick={() => setLayout("columns")}
                className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
                  layout === "columns" ? "text-white bg-surface-active" : "text-zinc-600 hover:text-zinc-400"
                }`}
                title="Side by side"
              >
                <Columns className="w-3 h-3" />
              </button>
              <button
                onClick={() => setLayout("rows")}
                className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
                  layout === "rows" ? "text-white bg-surface-active" : "text-zinc-600 hover:text-zinc-400"
                }`}
                title="Stacked"
              >
                <Rows className="w-3 h-3" />
              </button>
              {count >= 3 && (
                <button
                  onClick={() => setLayout("grid")}
                  className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
                    layout === "grid" ? "text-white bg-surface-active" : "text-zinc-600 hover:text-zinc-400"
                  }`}
                  title="Grid"
                >
                  <Grid2X2 className="w-3 h-3" />
                </button>
              )}
            </div>
          )}

          <button
            onClick={() => setViewMode("canvas")}
            className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] text-zinc-400 hover:text-white hover:bg-surface-active transition-colors"
            title="Exit focus mode (Escape)"
          >
            <Minimize2 className="w-3 h-3" />
            Canvas
          </button>
        </div>
      </div>

      {/* Resizable terminal panes */}
      <div className="flex-1 min-h-0 bg-border">{body}</div>
    </motion.div>
  );
}
