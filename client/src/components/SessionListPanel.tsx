import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ChevronRight, Folder, GitBranch, Pin, Search, X } from "lucide-react";
import { useReactFlow, type Node } from "@xyflow/react";
import { useStore, type AgentSession, type AgentStatus } from "../stores/useStore";
import { AgentIcon, getAgentAccentColor } from "./AgentIcon";

const statusDot: Record<AgentStatus, string> = {
  creating: "#818CF8",
  running: "#22C55E",
  tool_calling: "#22C55E",
  waiting_input: "#D97652",
  idle: "#8A8F98",
  disconnected: "#6B7280",
  error: "#EF4444",
};

type SessionEntry = {
  nodeId: string;
  session: AgentSession;
  node: Node | undefined;
};

function getSessionTitle(entry: SessionEntry): string {
  const label = typeof entry.node?.data?.label === "string" ? entry.node.data.label.trim() : "";
  const agentName = entry.session.agentName?.trim() || "";
  const customName = entry.session.customName?.trim();
  const ticketTitle = entry.session.ticketTitle?.trim();

  if (customName) return customName;
  if (ticketTitle) return ticketTitle;
  if (label && label !== agentName && label !== entry.session.agentId) return label;
  return agentName || "Session";
}

function sessionCreatedAt(entry: SessionEntry): number {
  return new Date(entry.session.createdAt).getTime() || 0;
}

export function SessionListPanel() {
  const {
    sessionListOpen,
    setSessionListOpen,
    sessions,
    nodes,
    statusFilter,
    searchQuery,
    setSearchQuery,
    selectedNodeId,
    setSelectedNodeId,
    setSidebarOpen,
    viewMode,
    addFocusedSession,
    removeFocusedSession,
    focusedSessionIds,
  } = useStore();

  const reactFlow = useReactFlow();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const focusRailCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [visibleCount, setVisibleCount] = useState(12);
  const [focusRailOpen, setFocusRailOpen] = useState(false);

  const inFocusMode = viewMode === "focus";

  const { allOnlineSessions, visibleSessions } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const entries = Array.from(sessions.entries())
      .map(([nodeId, session]) => ({
        nodeId,
        session,
        node: nodes.find((node) => node.id === nodeId),
      }))
      .filter((entry) => entry.session.status !== "disconnected") as SessionEntry[];

    const statusFiltered = entries.filter((entry) => {
      if (statusFilter === "all") return true;
      if (statusFilter === "running") {
        return entry.session.status === "running" || entry.session.status === "tool_calling";
      }
      return entry.session.status === statusFilter;
    });

    const filtered = q
      ? statusFiltered.filter((entry) => {
          const title = getSessionTitle(entry).toLowerCase();
          return (
            title.includes(q) ||
            entry.session.cwd.toLowerCase().includes(q) ||
            (entry.session.gitBranch || "").toLowerCase().includes(q) ||
            (entry.session.ticketId || "").toLowerCase().includes(q) ||
            (entry.session.ticketTitle || "").toLowerCase().includes(q)
          );
        })
      : statusFiltered;

    const sorted = [...filtered].sort((a, b) => sessionCreatedAt(b) - sessionCreatedAt(a));
    return {
      allOnlineSessions: sorted,
      visibleSessions: sorted.slice(0, visibleCount),
    };
  }, [nodes, searchQuery, sessions, statusFilter, visibleCount]);

  useEffect(() => {
    setVisibleCount(12);
  }, [searchQuery]);

  useEffect(() => {
    if (!inFocusMode) {
      setFocusRailOpen(false);
      return;
    }
    setSessionListOpen(false);
    setFocusRailOpen(false);
  }, [inFocusMode, setSessionListOpen]);

  useEffect(
    () => () => {
      if (focusRailCloseTimerRef.current) {
        clearTimeout(focusRailCloseTimerRef.current);
      }
    },
    [],
  );

  const openFocusRail = useCallback(() => {
    if (focusRailCloseTimerRef.current) {
      clearTimeout(focusRailCloseTimerRef.current);
      focusRailCloseTimerRef.current = null;
    }
    setFocusRailOpen(true);
  }, []);

  const scheduleFocusRailClose = useCallback(() => {
    if (focusRailCloseTimerRef.current) {
      clearTimeout(focusRailCloseTimerRef.current);
    }
    focusRailCloseTimerRef.current = setTimeout(() => {
      setFocusRailOpen(false);
      focusRailCloseTimerRef.current = null;
    }, 450);
  }, []);

  const handleSessionClick = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId);
      if (viewMode === "focus") {
        addFocusedSession(nodeId);
        setSidebarOpen(false);
        setFocusRailOpen(false);
        return;
      }

      setSidebarOpen(true);
      if (viewMode !== "canvas") return;

      const node = nodes.find((item) => item.id === nodeId);
      if (node) {
        reactFlow.setCenter(node.position.x + 110, node.position.y + 60, {
          zoom: 1.2,
          duration: 350,
        });
      }
    },
    [addFocusedSession, nodes, reactFlow, setSelectedNodeId, setSidebarOpen, viewMode],
  );

  const handleSessionPinToggle = useCallback(
    (nodeId: string, isPinned: boolean) => {
      if (isPinned) {
        removeFocusedSession(nodeId);
      } else {
        addFocusedSession(nodeId);
      }
    },
    [addFocusedSession, removeFocusedSession],
  );

  const showPanel = inFocusMode ? focusRailOpen : sessionListOpen;

  if (inFocusMode && !focusRailOpen) {
    return (
      <div
        className="fixed left-0 top-14 bottom-0 z-[70] w-3"
        onMouseEnter={openFocusRail}
        title="Show sessions"
      >
        <div className="absolute left-0 top-1/2 h-16 w-1 -translate-y-1/2 rounded-r bg-zinc-500/30" />
      </div>
    );
  }

  if (!showPanel) {
    return (
      <button
        onClick={() => setSessionListOpen(true)}
        className="fixed left-0 top-14 z-40 flex items-center gap-1 rounded-br-lg border-b border-r border-border bg-surface px-1.5 py-3 text-zinc-500 transition-colors hover:bg-surface-active hover:text-white"
        title="Open session list (Cmd+\\)"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    );
  }

  return (
    <motion.aside
      initial={{ x: "-100%", opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: "-100%", opacity: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 40 }}
      onMouseEnter={() => {
        if (inFocusMode) openFocusRail();
      }}
      onMouseLeave={() => {
        if (inFocusMode) scheduleFocusRailClose();
      }}
      className={`fixed left-0 top-14 bottom-0 flex w-[280px] flex-col border-r border-border bg-canvas-dark ${
        inFocusMode ? "z-[70] shadow-2xl" : "z-40"
      }`}
    >
      <div className="flex-shrink-0 border-b border-border px-3 py-2.5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
            Sessions
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-700">{allOnlineSessions.length}</span>
            <button
              type="button"
              onClick={() => {
                if (inFocusMode) {
                  setFocusRailOpen(false);
                } else {
                  setSessionListOpen(false);
                }
              }}
              className="flex h-5 w-5 items-center justify-center rounded text-zinc-600 transition-colors hover:bg-surface-active hover:text-zinc-200"
              title="Close sessions"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search sessions"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="w-full rounded-md border border-border bg-canvas py-1.5 pl-8 pr-7 text-xs text-white placeholder-zinc-600 transition-colors focus:border-zinc-500 focus:outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
              title="Clear search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {allOnlineSessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-zinc-600">
            {sessions.size === 0 ? "No sessions yet" : "No online sessions"}
          </div>
        ) : (
          <>
            {visibleSessions.map(({ nodeId, session, node }) => {
              const isSelected = selectedNodeId === nodeId;
              const displayName = getSessionTitle({ nodeId, session, node });
              const displayColor = getAgentAccentColor(
                session.agentId,
                session.customColor || session.color,
              );
              const iconId = (node?.data?.icon as string) || session.agentId;
              const dirName = session.cwd?.split("/").pop() || "";
              const statusColor = statusDot[session.status] || statusDot.idle;
              const isPinned = focusedSessionIds.includes(nodeId);

              return (
                <div
                  key={nodeId}
                  className={`group/session flex w-full items-start gap-2 border-l-2 pr-2 text-left transition-colors ${
                    isSelected
                      ? "border-l-zinc-200 bg-surface-active"
                      : "border-l-transparent hover:border-l-zinc-600 hover:bg-surface"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleSessionClick(nodeId)}
                    className="flex min-w-0 flex-1 items-start gap-2.5 py-2 pl-3 text-left"
                  >
                    <div
                      className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md"
                      style={{ backgroundColor: `${displayColor}20` }}
                    >
                      <AgentIcon
                        agentId={session.agentId}
                        iconId={iconId}
                        className="h-4 w-4"
                        style={{ color: displayColor }}
                      />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-xs font-medium text-zinc-100">
                          {displayName}
                        </span>
                        <span
                          className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: statusColor }}
                          title={session.status.replace("_", " ")}
                        />
                      </div>
                      {(dirName || session.gitBranch) && (
                        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[9px] text-zinc-600">
                          {dirName && (
                            <span className="flex min-w-0 items-center gap-0.5 font-mono">
                              <Folder className="h-2 w-2 flex-shrink-0" />
                              <span className="truncate">{dirName}</span>
                            </span>
                          )}
                          {session.gitBranch && (
                            <span className="flex min-w-0 items-center gap-0.5 font-mono">
                              <GitBranch className="h-2 w-2 flex-shrink-0" />
                              <span className="truncate">{session.gitBranch}</span>
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleSessionPinToggle(nodeId, isPinned)}
                    className={`mt-2 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded transition-colors ${
                      isPinned
                        ? "text-zinc-100 bg-surface-active"
                        : "text-zinc-600 hover:bg-surface-active hover:text-zinc-200"
                    }`}
                    title={isPinned ? "Unpin from focus mode" : "Pin to focus mode"}
                    aria-label={isPinned ? "Unpin from focus mode" : "Pin to focus mode"}
                  >
                    <Pin
                      className="h-3.5 w-3.5"
                      fill={isPinned ? "currentColor" : "none"}
                    />
                  </button>
                </div>
              );
            })}

            {visibleCount < allOnlineSessions.length && (
              <div className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => setVisibleCount((count) => count + 12)}
                  className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-xs font-medium text-zinc-500 transition-colors hover:bg-surface hover:text-zinc-200"
                >
                  View more
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </motion.aside>
  );
}
