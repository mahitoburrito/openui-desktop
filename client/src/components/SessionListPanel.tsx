import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Folder,
  GitBranch,
  Pin,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useReactFlow, useStoreApi, type Node } from "@xyflow/react";
import { useStore, type AgentSession } from "../stores/useStore";
import { AgentIcon, getAgentAccentColor } from "./AgentIcon";
import { destroyCachedTerminal } from "./Terminal";
import { agentStatusStyle } from "../theme/agentStatus";
import { sessionDisplayTitle } from "../utils/sessionTitle";

type SessionEntry = {
  nodeId: string;
  session: AgentSession;
  node: Node | undefined;
};

function getSessionTitle(entry: SessionEntry): string {
  return sessionDisplayTitle(entry.session);
}

function sessionCreatedAt(entry: SessionEntry): number {
  return new Date(entry.session.createdAt).getTime() || 0;
}

// Chrome/Dia-style tab group palette — stable per project name.
const GROUP_COLORS = [
  "#3B82F6", "#EF4444", "#FBBF24", "#22C55E", "#EC4899", "#8B5CF6", "#14B8A6", "#D97652",
];

function groupKeyFor(session: AgentSession): string {
  return session.originalCwd || session.cwd || "Other";
}

function groupColorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length];
}

type SessionGroup = {
  key: string;
  name: string;
  color: string;
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
    searchQuery,
    setSearchQuery,
    selectedNodeId,
    setSelectedNodeId,
    setSidebarOpen,
    viewMode,
    setViewMode,
    addFocusedSession,
    removeFocusedSession,
    focusedSessionIds,
    collapsedSessionGroups,
    toggleSessionGroup,
    removeSession,
    removeNode,
    setDeleteToast,
    selectionModeActive,
    multiSelectedNodeIds,
  } = useStore();

  const reactFlow = useReactFlow();
  const rfStore = useStoreApi();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const focusRailCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [visibleCount, setVisibleCount] = useState(12);
  const [focusRailOpen, setFocusRailOpen] = useState(false);

  const inFocusMode = viewMode === "focus";

  const isSearching = searchQuery.trim().length > 0;

  const { allOnlineSessions, sessionGroups, offlineEntries } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const allEntries = Array.from(sessions.entries()).map(([nodeId, session]) => ({
      nodeId,
      session,
      node: nodes.find((node) => node.id === nodeId),
    })) as SessionEntry[];

    const offline = allEntries.filter((entry) => entry.session.status === "disconnected");
    const entries = allEntries.filter((entry) => entry.session.status !== "disconnected");

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

    // Newest first everywhere: inside groups, and groups by their newest session.
    const sorted = [...filtered].sort((a, b) => sessionCreatedAt(b) - sessionCreatedAt(a));

    const groupsByKey = new Map<string, SessionGroup>();
    for (const entry of sorted) {
      const key = groupKeyFor(entry.session);
      let group = groupsByKey.get(key);
      if (!group) {
        const name = key.split("/").pop() || key;
        group = { key, name, color: groupColorFor(name), entries: [], newestAt: 0 };
        groupsByKey.set(key, group);
      }
      group.entries.push(entry);
      group.newestAt = Math.max(group.newestAt, sessionCreatedAt(entry));
    }

    const groups = Array.from(groupsByKey.values()).sort((a, b) => b.newestAt - a.newestAt);

    return {
      allOnlineSessions: sorted,
      sessionGroups: groups,
      offlineEntries: offline,
    };
  }, [nodes, searchQuery, sessions, statusFilter]);

  // Cap rendered rows across groups, expanding with "View more".
  const visibleGroups = useMemo(() => {
    const out: SessionGroup[] = [];
    let budget = visibleCount;
    for (const group of sessionGroups) {
      if (budget <= 0) break;
      const collapsed = !isSearching && collapsedSessionGroups.includes(group.key);
      if (collapsed) {
        out.push({ ...group, entries: [] });
        continue;
      }
      const take = group.entries.slice(0, budget);
      budget -= take.length;
      out.push({ ...group, entries: take });
    }
    return out;
  }, [collapsedSessionGroups, isSearching, sessionGroups, visibleCount]);

  const renderedCount = visibleGroups.reduce((sum, group) => sum + group.entries.length, 0);
  const collapsedCount = sessionGroups.reduce(
    (sum, group) =>
      !isSearching && collapsedSessionGroups.includes(group.key) ? sum + group.entries.length : sum,
    0,
  );
  const hasMore = renderedCount + collapsedCount < allOnlineSessions.length;

  const handleClearOffline = useCallback(async () => {
    if (offlineEntries.length === 0) return;
    const confirmed = window.confirm(
      `Clear ${offlineEntries.length} offline session${offlineEntries.length === 1 ? "" : "s"}? You'll have 5 seconds to undo.`,
    );
    if (!confirmed) return;

    const cleared: { sessionId: string; nodeId: string; sessionName: string }[] = [];
    await Promise.all(
      offlineEntries.map(async (entry) => {
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
  }, [
    offlineEntries,
    removeFocusedSession,
    removeNode,
    removeSession,
    selectedNodeId,
    setDeleteToast,
    setSelectedNodeId,
    setSidebarOpen,
  ]);

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
      // Selection mode: list clicks toggle canvas selection instead of opening.
      // Toggling goes through React Flow's API so its internal selection state
      // stays in sync with what group-drag and delete use.
      if (useStore.getState().selectionModeActive && viewMode === "canvas") {
        const current = useStore.getState().multiSelectedNodeIds;
        const desired = current.includes(nodeId)
          ? current.filter((id) => id !== nodeId)
          : [...current, nodeId];
        rfStore.getState().addSelectedNodes(desired);
        return;
      }

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
    [addFocusedSession, nodes, reactFlow, rfStore, setSelectedNodeId, setSidebarOpen, viewMode],
  );

  // Double-click mirrors AgentNode: pin the session and jump into focus mode.
  const handleSessionDoubleClick = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId);
      addFocusedSession(nodeId);
      setViewMode("focus");
      setSidebarOpen(false);
      setFocusRailOpen(false);
    },
    [addFocusedSession, setSelectedNodeId, setSidebarOpen, setViewMode],
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
            {offlineEntries.length > 0 && (
              <button
                type="button"
                onClick={handleClearOffline}
                className="flex h-5 items-center gap-1 rounded px-1 text-zinc-600 transition-colors hover:bg-surface-active hover:text-red-400"
                title={`Clear ${offlineEntries.length} offline session${offlineEntries.length === 1 ? "" : "s"}`}
              >
                <Trash2 className="h-3 w-3" />
                <span className="text-[10px]">{offlineEntries.length}</span>
              </button>
            )}
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
            {visibleGroups.map((group) => {
              const isCollapsed = !isSearching && collapsedSessionGroups.includes(group.key);
              const totalInGroup =
                sessionGroups.find((g) => g.key === group.key)?.entries.length ?? 0;
              return (
                <div key={group.key} className="mb-0.5">
                  {/* Dia/Chrome-style tab group header */}
                  <button
                    type="button"
                    onClick={() => toggleSessionGroup(group.key)}
                    className="group/header flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-colors hover:bg-surface"
                    title={group.key}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3 w-3 flex-shrink-0 text-zinc-600" />
                    ) : (
                      <ChevronDown className="h-3 w-3 flex-shrink-0 text-zinc-600" />
                    )}
                    <span
                      className="h-2 w-2 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: group.color }}
                    />
                    <span
                      className="truncate text-[10px] font-semibold uppercase tracking-wider"
                      style={{ color: group.color }}
                    >
                      {group.name}
                    </span>
                    <span className="ml-auto flex-shrink-0 text-[9px] text-zinc-600">
                      {totalInGroup}
                    </span>
                  </button>

                  {!isCollapsed && (
                    <div
                      className="ml-[13px] border-l pl-0"
                      style={{ borderColor: `${group.color}40` }}
                    >
                      {group.entries.map(({ nodeId, session, node }) => {
              const isSelected = selectedNodeId === nodeId;
              const isMultiSelected = selectionModeActive && multiSelectedNodeIds.includes(nodeId);
              const displayName = getSessionTitle({ nodeId, session, node });
              const displayColor = getAgentAccentColor(
                session.agentId,
                session.customColor || session.color,
              );
              const iconId = (node?.data?.icon as string) || session.agentId;
              const dirName = session.cwd?.split("/").filter(Boolean).pop() || session.cwd || "";
              const statusStyle = agentStatusStyle(session.status);
              const isPinned = focusedSessionIds.includes(nodeId);

              return (
                <div
                  key={nodeId}
                  className={`group/session flex w-full items-start gap-2 border-l-2 pr-2 text-left transition-colors ${
                    isMultiSelected
                      ? "border-l-blue-400 bg-blue-500/10"
                      : isSelected
                        ? "border-l-zinc-200 bg-surface-active"
                        : "border-l-transparent hover:border-l-zinc-600 hover:bg-surface"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleSessionClick(nodeId)}
                    onDoubleClick={() => handleSessionDoubleClick(nodeId)}
                    className="flex min-w-0 flex-1 items-start gap-2.5 py-2 pl-3 text-left"
                    title="Double-click to focus"
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
                          style={{ backgroundColor: statusStyle.color }}
                          title={statusStyle.label}
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

                  {selectionModeActive && viewMode === "canvas" ? (
                    <button
                      type="button"
                      onClick={() => handleSessionClick(nodeId)}
                      className={`mt-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded transition-colors ${
                        isMultiSelected
                          ? "text-blue-400"
                          : "text-zinc-600 hover:text-zinc-300"
                      }`}
                      title={isMultiSelected ? "Remove from selection" : "Add to selection"}
                      aria-label={isMultiSelected ? "Remove from selection" : "Add to selection"}
                    >
                      {isMultiSelected ? (
                        <CheckSquare className="h-3.5 w-3.5" />
                      ) : (
                        <Square className="h-3.5 w-3.5" />
                      )}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleSessionPinToggle(nodeId, isPinned)}
                      className={`mt-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded transition-colors ${
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
    </motion.aside>
  );
}
