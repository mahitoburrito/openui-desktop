import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { type Node } from "@xyflow/react";
import { useStore, type AgentSession, type AgentStatus } from "../stores/useStore";
import { AgentIcon, getAgentAccentColor } from "./AgentIcon";
import { destroyCachedTerminal } from "./Terminal";
import { Codicon } from "./Codicon";

const statusDot: Record<AgentStatus, string> = {
  creating: "oklch(0.72 0.08 270)",
  running: "oklch(0.72 0.1 150)",
  tool_calling: "oklch(0.72 0.1 150)",
  waiting_input: "oklch(0.72 0.1 48)",
  idle: "oklch(0.62 0.015 260)",
  disconnected: "oklch(0.52 0.012 260)",
  error: "oklch(0.68 0.14 25)",
};

const statusLabel: Record<AgentStatus, string> = {
  creating: "Starting",
  running: "Working",
  tool_calling: "Working",
  waiting_input: "Needs input",
  idle: "Ready",
  disconnected: "Offline",
  error: "Error",
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

const STALE_SESSION_MS = 24 * 60 * 60 * 1000;
const SESSION_RAIL_HOVER_DELAY_MS = 2000;

function sessionLastActivityAt(entry: SessionEntry): number {
  return entry.session.lastActivityAt || sessionCreatedAt(entry);
}

function isCleanupCandidate(entry: SessionEntry, now = Date.now()): boolean {
  if (entry.session.status === "disconnected") return true;
  return entry.session.status === "idle" && now - sessionLastActivityAt(entry) >= STALE_SESSION_MS;
}

function groupKeyFor(session: AgentSession): string {
  return session.originalCwd || session.cwd || "Other";
}

type SessionGroup = {
  key: string;
  name: string;
  entries: SessionEntry[];
  newestAt: number;
};

export function SessionListPanel() {
  const {
    sessionListOpen,
    setSessionListOpen,
    sessions,
    nodes,
    statusFilter,
    selectedNodeId,
    setSelectedNodeId,
    setSidebarOpen,
    viewMode,
    addFocusedSession,
    removeFocusedSession,
    focusedSessionIds,
    collapsedSessionGroups,
    toggleSessionGroup,
    removeSession,
    removeNode,
    setDeleteToast,
  } = useStore();

  const focusRailCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusRailOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [visibleCount, setVisibleCount] = useState(12);
  const [focusRailOpen, setFocusRailOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedForDelete, setSelectedForDelete] = useState<Set<string>>(new Set());

  const inFocusMode = viewMode === "focus";

  const { allOnlineSessions, sessionGroups, allEntries } = useMemo(() => {
    const allEntries = Array.from(sessions.entries()).map(([nodeId, session]) => ({
      nodeId,
      session,
      node: nodes.find((node) => node.id === nodeId),
    })) as SessionEntry[];

    const entries = allEntries.filter((entry) => entry.session.status !== "disconnected");

    const statusFiltered = entries.filter((entry) => {
      if (statusFilter === "all") return true;
      if (statusFilter === "running") {
        return entry.session.status === "running" || entry.session.status === "tool_calling";
      }
      return entry.session.status === statusFilter;
    });

    // Selection is also the cleanup view, so include offline sessions there.
    const listedEntries = selectionMode ? allEntries : statusFiltered;
    const sorted = [...listedEntries].sort((a, b) => sessionCreatedAt(b) - sessionCreatedAt(a));

    const groupsByKey = new Map<string, SessionGroup>();
    for (const entry of sorted) {
      const key = groupKeyFor(entry.session);
      let group = groupsByKey.get(key);
      if (!group) {
        const name = key.split("/").pop() || key;
        group = { key, name, entries: [], newestAt: 0 };
        groupsByKey.set(key, group);
      }
      group.entries.push(entry);
      group.newestAt = Math.max(group.newestAt, sessionCreatedAt(entry));
    }

    const groups = Array.from(groupsByKey.values()).sort((a, b) => b.newestAt - a.newestAt);

    return {
      allOnlineSessions: sorted,
      sessionGroups: groups,
      allEntries,
    };
  }, [nodes, selectionMode, sessions, statusFilter]);

  const cleanupCandidates = useMemo(
    () => allEntries.filter((entry) => isCleanupCandidate(entry)),
    [allEntries],
  );

  // Cap rendered rows across groups, expanding with "View more".
  const visibleGroups = useMemo(() => {
    const out: SessionGroup[] = [];
    let budget = visibleCount;
    for (const group of sessionGroups) {
      if (budget <= 0) break;
      const collapsed = collapsedSessionGroups.includes(group.key);
      if (collapsed) {
        out.push({ ...group, entries: [] });
        continue;
      }
      const take = group.entries.slice(0, budget);
      budget -= take.length;
      out.push({ ...group, entries: take });
    }
    return out;
  }, [collapsedSessionGroups, sessionGroups, visibleCount]);

  const renderedCount = visibleGroups.reduce((sum, group) => sum + group.entries.length, 0);
  const collapsedCount = sessionGroups.reduce(
    (sum, group) =>
      collapsedSessionGroups.includes(group.key) ? sum + group.entries.length : sum,
    0,
  );
  const hasMore = renderedCount + collapsedCount < allOnlineSessions.length;

  const handleDeleteEntries = useCallback(async (entries: SessionEntry[]) => {
    if (entries.length === 0) return;
    const activeCount = entries.filter(
      (entry) => !["idle", "disconnected", "error"].includes(entry.session.status),
    ).length;
    const confirmed = window.confirm(
      activeCount > 0
        ? `${activeCount} selected session${activeCount === 1 ? " is" : "s are"} still active. Delete all ${entries.length}? You'll have 5 seconds to undo.`
        : `Delete ${entries.length} selected session${entries.length === 1 ? "" : "s"}? You'll have 5 seconds to undo.`,
    );
    if (!confirmed) return;

    const cleared: { sessionId: string; nodeId: string; sessionName: string }[] = [];
    await Promise.all(
      entries.map(async (entry) => {
        try {
          const res = await fetch(`/api/sessions/${entry.session.sessionId}/soft-delete`, {
            method: "POST",
          });
          if (!res.ok) return;
        } catch {
          return;
        }
        cleared.push({
          sessionId: entry.session.sessionId,
          nodeId: entry.nodeId,
          sessionName: getSessionTitle(entry),
        });
      }),
    );

    if (cleared.length === 0) return;

    for (const item of cleared) {
      destroyCachedTerminal(item.sessionId);
      removeFocusedSession(item.nodeId);
      removeSession(item.nodeId);
      removeNode(item.nodeId);
      if (selectedNodeId === item.nodeId) {
        setSelectedNodeId(null);
        setSidebarOpen(false);
      }
    }

    const timeout = setTimeout(() => setDeleteToast(null), 5000);
    setDeleteToast({
      sessionId: cleared[0].sessionId,
      nodeId: cleared[0].nodeId,
      sessionName: cleared[0].sessionName,
      items: cleared,
      timeout,
    });
    setSelectedForDelete(new Set());
    setSelectionMode(false);
  }, [
    removeFocusedSession,
    removeNode,
    removeSession,
    selectedNodeId,
    setDeleteToast,
    setSelectedNodeId,
    setSidebarOpen,
  ]);

  const startSelection = useCallback((preselectCleanup: boolean) => {
    setSelectionMode(true);
    setSelectedForDelete(
      new Set(preselectCleanup ? cleanupCandidates.map((entry) => entry.nodeId) : []),
    );
    setVisibleCount((count) => Math.max(count, Math.min(allEntries.length, 48)));
  }, [allEntries.length, cleanupCandidates]);

  const toggleSelectedForDelete = useCallback((nodeId: string) => {
    setSelectedForDelete((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const cancelSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedForDelete(new Set());
  }, []);

  const deleteSelected = useCallback(() => {
    const selectedEntries = allEntries.filter((entry) => selectedForDelete.has(entry.nodeId));
    void handleDeleteEntries(selectedEntries);
  }, [allEntries, handleDeleteEntries, selectedForDelete]);

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
      if (focusRailOpenTimerRef.current) {
        clearTimeout(focusRailOpenTimerRef.current);
      }
    },
    [],
  );

  const openFocusRail = useCallback(() => {
    if (focusRailOpenTimerRef.current) {
      clearTimeout(focusRailOpenTimerRef.current);
      focusRailOpenTimerRef.current = null;
    }
    if (focusRailCloseTimerRef.current) {
      clearTimeout(focusRailCloseTimerRef.current);
      focusRailCloseTimerRef.current = null;
    }
    setFocusRailOpen(true);
  }, []);

  const scheduleFocusRailOpen = useCallback(() => {
    if (focusRailOpen) return;
    if (focusRailOpenTimerRef.current) clearTimeout(focusRailOpenTimerRef.current);
    focusRailOpenTimerRef.current = setTimeout(() => {
      focusRailOpenTimerRef.current = null;
      openFocusRail();
    }, SESSION_RAIL_HOVER_DELAY_MS);
  }, [focusRailOpen, openFocusRail]);

  const cancelFocusRailOpen = useCallback(() => {
    if (!focusRailOpenTimerRef.current) return;
    clearTimeout(focusRailOpenTimerRef.current);
    focusRailOpenTimerRef.current = null;
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
      if (selectionMode) {
        toggleSelectedForDelete(nodeId);
        return;
      }
      setSelectedNodeId(nodeId);
      if (viewMode === "focus") {
        // Already in focus: clicking a list row adds it as another pane.
        addFocusedSession(nodeId);
        setSidebarOpen(false);
        setFocusRailOpen(false);
        return;
      }

      // From canvas, one click opens the chat preview and keeps the map in view.
      setSidebarOpen(true);
    },
    [
      addFocusedSession,
      selectionMode,
      setSelectedNodeId,
      setSidebarOpen,
      toggleSelectedForDelete,
      viewMode,
    ],
  );

  // Double-click mirrors AgentNode: pin the session and jump into focus mode.
  const handleSessionDoubleClick = useCallback(
    (nodeId: string) => {
      if (selectionMode) return;
      setSelectedNodeId(nodeId);
      useStore.getState().openSessionInFocus(nodeId);
      setSidebarOpen(false);
      setFocusRailOpen(false);
    },
    [selectionMode, setSelectedNodeId, setSidebarOpen],
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

  const showPanel = inFocusMode ? focusRailOpen : sessionListOpen || focusRailOpen;

  if (!showPanel) {
    return (
      <button
        type="button"
        className={`group fixed bottom-0 left-0 top-12 w-5 cursor-default bg-transparent outline-none ${
          inFocusMode ? "z-[95]" : "z-[55]"
        }`}
        onPointerEnter={scheduleFocusRailOpen}
        onPointerLeave={cancelFocusRailOpen}
        onFocus={openFocusRail}
        onClick={openFocusRail}
        aria-label="Show sessions after hovering for two seconds"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-1/2 h-14 w-px -translate-y-1/2 rounded-full bg-current text-zinc-500/0 transition-colors duration-200 group-hover:text-zinc-500/35 group-focus-visible:text-zinc-400/70"
        />
      </button>
    );
  }

  return (
    <motion.aside
      initial={{ x: "-100%", opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: "-100%", opacity: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      onPointerEnter={() => {
        if (inFocusMode || !sessionListOpen) openFocusRail();
      }}
      onPointerLeave={() => {
        if ((inFocusMode || !sessionListOpen) && !selectionMode) scheduleFocusRailClose();
      }}
      className={`workspace-glass-strong fixed flex flex-col overflow-hidden ${
        inFocusMode
          ? "bottom-0 left-0 top-12 z-[70] w-[288px] rounded-none border-b-0 border-l-0 shadow-2xl"
          : "bottom-2 left-2 top-12 z-40 w-[276px] rounded-xl"
      }`}
    >
      <div className="flex-shrink-0 border-b border-white/[0.065] px-3 py-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-zinc-300">
            {selectionMode ? `${selectedForDelete.size} selected` : "Sessions"}
          </span>
          <div className="flex items-center gap-2">
            {selectionMode ? (
              <>
                {cleanupCandidates.length > 0 && (
                  <button
                    type="button"
                    onClick={() => startSelection(true)}
                    className="rounded-[5px] px-1.5 py-1 text-[10px] text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                    title="Select offline sessions and sessions idle for 24 hours"
                  >
                    Old {cleanupCandidates.length}
                  </button>
                )}
                <button
                  type="button"
                  onClick={cancelSelection}
                  className="rounded-[5px] px-1.5 py-1 text-[10px] text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                >
                  Done
                </button>
              </>
            ) : (
              <>
                <span className="text-[10px] text-zinc-700">{allOnlineSessions.length}</span>
                {cleanupCandidates.length > 0 && (
                  <button
                    type="button"
                    onClick={() => startSelection(true)}
                    className="flex h-5 items-center gap-1 rounded-[5px] px-1 text-zinc-600 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                    title={`Review ${cleanupCandidates.length} offline or 24-hour idle session${cleanupCandidates.length === 1 ? "" : "s"}`}
                  >
                    <Codicon name="trash" size={12} />
                    <span className="text-[10px]">{cleanupCandidates.length}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => startSelection(false)}
                  className="rounded-[5px] px-1.5 py-1 text-[10px] text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                >
                  Select
                </button>
              </>
            )}
            {!selectionMode && (
              <button
                type="button"
                onClick={() => {
                  if (inFocusMode || !sessionListOpen) {
                    setFocusRailOpen(false);
                  } else {
                    setSessionListOpen(false);
                  }
                }}
                className="flex h-5 w-5 items-center justify-center rounded-[5px] text-zinc-600 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                title="Close sessions"
              >
                <Codicon name="close" size={12} />
              </button>
            )}
          </div>
        </div>

      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {allOnlineSessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-zinc-600">
            {sessions.size === 0 ? "No sessions yet" : "No online sessions"}
          </div>
        ) : (
          <>
            {visibleGroups.map((group) => {
              const isCollapsed = collapsedSessionGroups.includes(group.key);
              const totalInGroup =
                sessionGroups.find((g) => g.key === group.key)?.entries.length ?? 0;
              return (
                <div key={group.key} className="mb-1">
                  <button
                    type="button"
                    onClick={() => toggleSessionGroup(group.key)}
                    className="group/header flex h-8 w-full items-center gap-1.5 px-2.5 text-left text-zinc-500 transition-colors hover:bg-white/[0.03] hover:text-zinc-300"
                    title={group.key}
                    aria-expanded={!isCollapsed}
                  >
                    {isCollapsed ? (
                      <Codicon name="chevron-right" size={12} className="flex-shrink-0" />
                    ) : (
                      <Codicon name="chevron-down" size={12} className="flex-shrink-0" />
                    )}
                    <Codicon
                      name={isCollapsed ? "folder" : "folder-opened"}
                      size={14}
                      className="flex-shrink-0 text-zinc-500 group-hover/header:text-zinc-300"
                    />
                    <span className="truncate text-[11px] font-medium">
                      {group.name}
                    </span>
                    <span className="ml-auto flex-shrink-0 font-mono text-[9px] text-zinc-600">
                      {totalInGroup}
                    </span>
                  </button>

                  {!isCollapsed && (
                    <div className="ml-[18px] border-l border-white/[0.055] pb-0.5 pl-1.5 pr-1.5">
                      {group.entries.map(({ nodeId, session, node }) => {
              const isSelected = selectedNodeId === nodeId;
              const isMarkedForDelete = selectedForDelete.has(nodeId);
              const displayName = getSessionTitle({ nodeId, session, node });
              const displayColor = getAgentAccentColor(
                session.agentId,
                session.customColor || session.color,
              );
              const iconId = (node?.data?.icon as string) || session.agentId;
              const statusColor = statusDot[session.status] || statusDot.idle;
              const isPinned = focusedSessionIds.includes(nodeId);

              return (
                <div
                  key={nodeId}
                  className={`group/session flex w-full items-center rounded-[7px] pr-1 text-left transition-colors ${
                    selectionMode && isMarkedForDelete
                      ? "bg-white/[0.075]"
                      : isSelected && !selectionMode
                      ? "bg-white/[0.065]"
                      : "hover:bg-white/[0.035]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleSessionClick(nodeId)}
                    onDoubleClick={() => handleSessionDoubleClick(nodeId)}
                    className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left"
                    title={selectionMode ? "Select session" : "Double-click to focus"}
                  >
                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-[6px] border border-white/[0.06] bg-white/[0.025]">
                      <AgentIcon
                        agentId={session.agentId}
                        iconId={iconId}
                        className="h-3.5 w-3.5"
                        style={{ color: displayColor }}
                      />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[11px] font-medium text-zinc-200">
                          {displayName}
                        </span>
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[9px] text-zinc-600">
                        <span
                          className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: statusColor }}
                        />
                        <span>{statusLabel[session.status]}</span>
                          {session.gitBranch && (
                            <span className="flex min-w-0 items-center gap-0.5">
                              <span aria-hidden="true">·</span>
                              <Codicon name="git-branch-compact" size={9} className="flex-shrink-0" />
                              <span className="truncate">{session.gitBranch}</span>
                            </span>
                          )}
                      </div>
                    </div>
                  </button>

                  {selectionMode ? (
                    <input
                      type="checkbox"
                      checked={isMarkedForDelete}
                      onChange={() => toggleSelectedForDelete(nodeId)}
                      className="mr-1 h-3.5 w-3.5 flex-shrink-0 accent-zinc-400"
                      aria-label={`Select ${displayName} for deletion`}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleSessionPinToggle(nodeId, isPinned)}
                      className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-[6px] transition-[color,background-color,opacity] ${
                        isPinned
                          ? "bg-white/[0.06] text-zinc-200"
                          : "text-zinc-600 opacity-0 hover:bg-white/[0.05] hover:text-zinc-200 group-hover/session:opacity-100 focus-visible:opacity-100"
                      }`}
                      title={isPinned ? "Unpin from focus mode" : "Pin to focus mode"}
                      aria-label={isPinned ? "Unpin from focus mode" : "Pin to focus mode"}
                    >
                      <Codicon name={isPinned ? "pinned" : "pin"} size={13} />
                    </button>
                  )}
                </div>
              );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            {hasMore && (
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
      {selectionMode && (
        <div className="flex flex-shrink-0 items-center justify-between border-t border-white/[0.065] px-3 py-2.5">
          <span className="text-[10px] text-zinc-600">Offline or idle 24h</span>
          <button
            type="button"
            onClick={deleteSelected}
            disabled={selectedForDelete.size === 0}
            className="rounded-[6px] bg-[oklch(0.42_0.07_25/0.35)] px-2.5 py-1.5 text-[10px] font-medium text-[oklch(0.76_0.1_25)] transition-colors hover:bg-[oklch(0.46_0.08_25/0.5)] disabled:cursor-not-allowed disabled:bg-white/[0.025] disabled:text-zinc-700"
          >
            Delete{selectedForDelete.size > 0 ? ` ${selectedForDelete.size}` : ""}
          </button>
        </div>
      )}
    </motion.aside>
  );
}
