import { useState, useCallback, useMemo, useEffect, ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Minimize2,
  Maximize2,
  Sparkles,
  Code,
  Cpu,
  Zap,
  Rocket,
  Bot,
  Brain,
  Wand2,
  Wrench,
  MessageSquare,
  WifiOff,
  RotateCcw,
  Columns,
  Rows,
  Grid2X2,
  Square,
} from "lucide-react";
import { useStore, AgentStatus } from "../stores/useStore";
import { Terminal } from "./Terminal";
import { ResizableSplit } from "./ResizableSplit";
import { InPaneMarkdown } from "./InPaneMarkdown";

const iconMap: Record<string, any> = {
  sparkles: Sparkles,
  code: Code,
  cpu: Cpu,
  zap: Zap,
  rocket: Rocket,
  bot: Bot,
  brain: Brain,
  wand2: Wand2,
};

const statusConfig: Record<AgentStatus, { label: string; color: string }> = {
  running: { label: "Working", color: "#22C55E" },
  tool_calling: { label: "Working", color: "#22C55E" },
  waiting_input: { label: "Needs Input", color: "#F97316" },
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
    removeFocusedSession,
    sessions,
    nodes,
    setNewSessionModalOpen,
    setNewSessionForNodeId,
  } = useStore();

  const [activePane, setActivePane] = useState<string | null>(null);
  const [maximizedPane, setMaximizedPane] = useState<string | null>(null);
  const [layout, setLayout] = useState<SplitLayout>("auto");
  const [openedFiles, setOpenedFiles] = useState<Record<string, string | null>>({});

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
    const displayColor = session.customColor || session.color || "#888";
    const displayName = session.customName || session.agentName;
    const iconId = (node?.data?.icon as string) || "cpu";
    const Icon = iconMap[iconId] || Cpu;
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
            borderColor: isActive ? `${displayColor}30` : "#2a2a2a",
            backgroundColor: isActive ? `${displayColor}08` : "transparent",
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: displayColor }}
            />
            <div
              className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: `${displayColor}15` }}
            >
              <Icon className="w-2.5 h-2.5" style={{ color: displayColor }} />
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

        <div className="flex-1 min-h-0 bg-[#0d0d0d] relative">
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
