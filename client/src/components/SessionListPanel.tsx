import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  X,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Pin,
  PinOff,
  Filter,
  Sparkles,
  Code,
  Cpu,
  Zap,
  Rocket,
  Bot,
  Brain,
  Wand2,
  Folder,
  GitBranch,
  MessageSquare,
  WifiOff,
  Wrench,
} from "lucide-react";
import { useStore, AgentStatus, StatusFilter } from "../stores/useStore";
import { useReactFlow } from "@xyflow/react";

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

const statusConfig: Record<AgentStatus, { label: string; color: string; sortPriority: number }> = {
  waiting_input: { label: "Needs Input", color: "#F97316", sortPriority: 0 },
  running: { label: "Working", color: "#22C55E", sortPriority: 1 },
  tool_calling: { label: "Working", color: "#22C55E", sortPriority: 2 },
  error: { label: "Error", color: "#EF4444", sortPriority: 3 },
  creating: { label: "Creating...", color: "#818CF8", sortPriority: 4 },
  idle: { label: "Idle", color: "#FBBF24", sortPriority: 5 },
  disconnected: { label: "Offline", color: "#6B7280", sortPriority: 6 },
};

const filterOptions: { value: StatusFilter; label: string; color?: string }[] = [
  { value: "all", label: "All" },
  { value: "waiting_input", label: "Needs Input", color: "#F97316" },
  { value: "running", label: "Running", color: "#22C55E" },
  { value: "idle", label: "Idle", color: "#FBBF24" },
  { value: "error", label: "Error", color: "#EF4444" },
  { value: "disconnected", label: "Offline", color: "#6B7280" },
];

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
  TodoWrite: "Planning",
  AskUserQuestion: "Asking",
};

export function SessionListPanel() {
  const {
    sessionListOpen,
    setSessionListOpen,
    sessions,
    nodes,
    statusFilter,
    setStatusFilter,
    searchQuery,
    setSearchQuery,
    selectedNodeId,
    setSelectedNodeId,
    setSidebarOpen,
    viewMode,
    setViewMode,
    focusedSessionIds,
    addFocusedSession,
    removeFocusedSession,
  } = useStore();

  const reactFlow = useReactFlow();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showFilters, setShowFilters] = useState(false);

  // Get sorted and filtered session list
  const sessionList = useMemo(() => {
    const entries = Array.from(sessions.entries()).map(([nodeId, session]) => ({
      nodeId,
      session,
      node: nodes.find((n) => n.id === nodeId),
    }));

    // Filter by status
    let filtered = entries;
    if (statusFilter !== "all") {
      // Also include tool_calling when filtering for "running"
      if (statusFilter === "running") {
        filtered = filtered.filter(
          (e) => e.session.status === "running" || e.session.status === "tool_calling"
        );
      } else {
        filtered = filtered.filter((e) => e.session.status === statusFilter);
      }
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (e) =>
          (e.session.customName || e.session.agentName).toLowerCase().includes(q) ||
          e.session.cwd.toLowerCase().includes(q) ||
          (e.session.gitBranch || "").toLowerCase().includes(q) ||
          (e.session.ticketId || "").toLowerCase().includes(q) ||
          (e.session.ticketTitle || "").toLowerCase().includes(q)
      );
    }

    // Sort: needs attention first, then by status priority, then by creation time
    filtered.sort((a, b) => {
      const aPriority = statusConfig[a.session.status]?.sortPriority ?? 99;
      const bPriority = statusConfig[b.session.status]?.sortPriority ?? 99;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return new Date(b.session.createdAt).getTime() - new Date(a.session.createdAt).getTime();
    });

    return filtered;
  }, [sessions, nodes, statusFilter, searchQuery]);

  // Status counts for filter badges
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: sessions.size };
    sessions.forEach((session) => {
      const s = session.status === "tool_calling" ? "running" : session.status;
      counts[s] = (counts[s] || 0) + 1;
    });
    return counts;
  }, [sessions]);

  const handleSessionClick = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId);
      setSidebarOpen(true);
      // Zoom to the node on the canvas
      if (viewMode === "canvas") {
        const node = nodes.find((n) => n.id === nodeId);
        if (node) {
          reactFlow.setCenter(node.position.x + 110, node.position.y + 60, {
            zoom: 1.2,
            duration: 400,
          });
        }
      }
    },
    [setSelectedNodeId, setSidebarOpen, viewMode, nodes, reactFlow]
  );

  const handleSessionDoubleClick = useCallback(
    (nodeId: string) => {
      // Enter focus mode with this session
      setViewMode("focus");
      if (!focusedSessionIds.includes(nodeId)) {
        addFocusedSession(nodeId);
      }
    },
    [setViewMode, focusedSessionIds, addFocusedSession]
  );

  const handlePinToggle = useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      e.stopPropagation();
      if (focusedSessionIds.includes(nodeId)) {
        removeFocusedSession(nodeId);
      } else {
        addFocusedSession(nodeId);
      }
    },
    [focusedSessionIds, addFocusedSession, removeFocusedSession]
  );

  const handleFocusClick = useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      e.stopPropagation();
      if (!focusedSessionIds.includes(nodeId)) {
        addFocusedSession(nodeId);
      }
      setViewMode("focus");
    },
    [addFocusedSession, focusedSessionIds, setViewMode]
  );

  // Keyboard shortcut: Cmd+K to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (!sessionListOpen) setSessionListOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 100);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sessionListOpen, setSessionListOpen]);

  // Collapsed state — just show a toggle button
  if (!sessionListOpen) {
    return (
      <button
        onClick={() => setSessionListOpen(true)}
        className="fixed left-0 top-14 z-40 flex items-center gap-1 px-1.5 py-3 bg-surface border-r border-b border-border rounded-br-lg text-zinc-500 hover:text-white hover:bg-surface-active transition-colors"
        title="Open session list (Cmd+\\)"
      >
        <ChevronRight className="w-4 h-4" />
      </button>
    );
  }

  return (
    <motion.div
      initial={{ x: "-100%", opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: "-100%", opacity: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 40 }}
      className="fixed left-0 top-14 bottom-0 z-40 w-[280px] flex flex-col bg-canvas-dark border-r border-border"
    >
      {/* Header */}
      <div className="flex-shrink-0 px-3 py-2.5 border-b border-border">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
            Sessions
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
                statusFilter !== "all"
                  ? "text-white bg-surface-active"
                  : "text-zinc-500 hover:text-white hover:bg-surface-active"
              }`}
              title="Filter by status"
            >
              <Filter className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setSessionListOpen(false)}
              className="w-6 h-6 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-surface-active transition-colors"
              title="Close panel (Cmd+\\)"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search sessions... (Cmd+K)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-7 py-1.5 rounded-md bg-canvas border border-border text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Status filters */}
      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="flex-shrink-0 overflow-hidden border-b border-border"
          >
            <div className="px-3 py-2 flex flex-wrap gap-1.5">
              {filterOptions.map((opt) => {
                const count = statusCounts[opt.value] || 0;
                const isActive = statusFilter === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={() => setStatusFilter(opt.value)}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium transition-all ${
                      isActive
                        ? "bg-white/10 text-white ring-1 ring-white/20"
                        : "bg-canvas text-zinc-500 hover:text-zinc-300 hover:bg-surface-active"
                    }`}
                  >
                    {opt.color && (
                      <div
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: opt.color }}
                      />
                    )}
                    {opt.label}
                    {count > 0 && (
                      <span className="text-zinc-600 ml-0.5">{count}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {sessionList.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-zinc-600">
              {sessions.size === 0
                ? "No sessions yet"
                : "No sessions match your filters"}
            </p>
          </div>
        ) : (
          <div className="py-1">
            {sessionList.map(({ nodeId, session, node }, index) => {
              const isSelected = selectedNodeId === nodeId;
              const isPinned = focusedSessionIds.includes(nodeId);
              const status = statusConfig[session.status] || statusConfig.idle;
              const displayName = session.customName || session.agentName;
              const displayColor = session.customColor || session.color || "#888";
              const iconId = (node?.data?.icon as string) || "cpu";
              const Icon = iconMap[iconId] || Cpu;
              const dirName = session.cwd?.split("/").pop() || "";
              const toolDisplay = session.currentTool
                ? toolDisplayNames[session.currentTool] || session.currentTool
                : null;

              return (
                <div
                  key={nodeId}
                  onClick={() => handleSessionClick(nodeId)}
                  onDoubleClick={() => handleSessionDoubleClick(nodeId)}
                  className={`group relative px-3 py-2 cursor-pointer transition-all border-l-2 ${
                    isSelected
                      ? "bg-surface-active border-l-white"
                      : "border-l-transparent hover:bg-surface hover:border-l-zinc-600"
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    {/* Icon */}
                    <div
                      className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 mt-0.5"
                      style={{ backgroundColor: `${displayColor}20` }}
                    >
                      <Icon className="w-3.5 h-3.5" style={{ color: displayColor }} />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-white truncate">
                          {displayName}
                        </span>
                        {/* Keyboard shortcut hint for first 9 */}
                        {index < 9 && (
                          <span className="text-[9px] text-zinc-700 font-mono flex-shrink-0">
                            {index + 1}
                          </span>
                        )}
                      </div>

                      {/* Status row */}
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <div className="relative flex items-center justify-center">
                          <div
                            className="w-1.5 h-1.5 rounded-full"
                            style={{ backgroundColor: status.color }}
                          />
                          {(session.status === "running" || session.status === "tool_calling") && (
                            <div
                              className="absolute w-2.5 h-2.5 rounded-full animate-ping"
                              style={{
                                backgroundColor: status.color,
                                opacity: 0.3,
                                animationDuration: "1.5s",
                              }}
                            />
                          )}
                        </div>
                        <span
                          className="text-[10px]"
                          style={{ color: status.color }}
                        >
                          {status.label}
                        </span>
                        {session.status === "tool_calling" && toolDisplay && (
                          <span className="text-[9px] text-zinc-500 flex items-center gap-0.5">
                            <Wrench className="w-2 h-2" />
                            {toolDisplay}
                          </span>
                        )}
                        {session.status === "waiting_input" && (
                          <MessageSquare className="w-2.5 h-2.5" style={{ color: status.color }} />
                        )}
                        {session.status === "disconnected" && (
                          <WifiOff className="w-2.5 h-2.5" style={{ color: status.color }} />
                        )}
                      </div>

                      {/* Context row */}
                      <div className="flex items-center gap-2 mt-0.5">
                        {dirName && (
                          <span className="text-[9px] text-zinc-600 font-mono flex items-center gap-0.5 truncate">
                            <Folder className="w-2 h-2 flex-shrink-0" />
                            {dirName}
                          </span>
                        )}
                        {session.gitBranch && (
                          <span className="text-[9px] text-purple-500/70 font-mono flex items-center gap-0.5 truncate">
                            <GitBranch className="w-2 h-2 flex-shrink-0" />
                            {session.gitBranch}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Action buttons (visible on hover) */}
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <button
                        onClick={(e) => handlePinToggle(e, nodeId)}
                        className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
                          isPinned
                            ? "text-blue-400 bg-blue-500/10"
                            : "text-zinc-600 hover:text-zinc-300 hover:bg-surface-active"
                        }`}
                        title={isPinned ? "Unpin from focus view" : "Pin to focus view"}
                      >
                        {isPinned ? (
                          <PinOff className="w-2.5 h-2.5" />
                        ) : (
                          <Pin className="w-2.5 h-2.5" />
                        )}
                      </button>
                      <button
                        onClick={(e) => handleFocusClick(e, nodeId)}
                        className="w-5 h-5 rounded flex items-center justify-center text-zinc-600 hover:text-zinc-300 hover:bg-surface-active transition-colors"
                        title="Open in focus mode"
                      >
                        <Maximize2 className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  </div>

                  {/* Pin indicator */}
                  {isPinned && (
                    <div className="absolute right-1.5 top-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer with focus mode toggle */}
      {focusedSessionIds.length > 0 && (
        <div className="flex-shrink-0 px-3 py-2 border-t border-border">
          <button
            onClick={() => setViewMode(viewMode === "focus" ? "canvas" : "focus")}
            className={`w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              viewMode === "focus"
                ? "bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"
                : "bg-surface-active text-zinc-300 hover:bg-zinc-700"
            }`}
          >
            <Maximize2 className="w-3 h-3" />
            {viewMode === "focus"
              ? `Focus Mode (${focusedSessionIds.length})`
              : `Enter Focus Mode (${focusedSessionIds.length} pinned)`}
          </button>
        </div>
      )}
    </motion.div>
  );
}
