import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  CheckCircle2,
  FileDiff,
  Maximize2,
  MessageSquare,
  Search,
  Terminal,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import { useStore, type AgentActivityEvent, type AgentStatus } from "../stores/useStore";
import { AGENT_STATUS } from "../theme/agentStatus";

type ActivityFilter = "all" | "attention" | "done";

const ATTENTION_STATUSES = new Set<AgentStatus>(["waiting_input", "error", "disconnected"]);
const DONE_STATUSES = new Set<AgentStatus>(["idle"]);

const statusIcon: Record<AgentStatus, typeof Terminal> = {
  creating: Terminal,
  running: Terminal,
  tool_calling: Terminal,
  waiting_input: MessageSquare,
  idle: CheckCircle2,
  disconnected: WifiOff,
  error: AlertCircle,
};

// The feed lists things that happened, so `idle` reads better in the past
// tense here than the canonical "Idle". Every other state uses the shared
// vocabulary — see theme/agentStatus.ts.
const statusLabel: Record<AgentStatus, string> = {
  ...Object.fromEntries(
    Object.entries(AGENT_STATUS).map(([status, style]) => [status, style.label]),
  ) as Record<AgentStatus, string>,
  idle: "Finished",
};

function timeAgo(timestamp: number): string {
  const seconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function matchesFilter(event: AgentActivityEvent, filter: ActivityFilter): boolean {
  if (filter === "attention") return ATTENTION_STATUSES.has(event.status);
  if (filter === "done") return DONE_STATUSES.has(event.status);
  return true;
}

function ActivityRow({ event }: { event: AgentActivityEvent }) {
  const {
    sessions,
    setSelectedNodeId,
    setSidebarOpen,
    setViewMode,
    addFocusedSession,
    setDiffRepoPath,
    setActivityCenterOpen,
    removeAgentActivityEvent,
  } = useStore();

  const Icon = statusIcon[event.status] || Terminal;
  const sessionExists = sessions.has(event.nodeId);

  const openSession = () => {
    if (!sessionExists) return;
    setSelectedNodeId(event.nodeId);
    setSidebarOpen(true);
    setViewMode("canvas");
    setActivityCenterOpen(false);
  };

  const focusSession = () => {
    if (!sessionExists) return;
    addFocusedSession(event.nodeId);
    setViewMode("focus");
    setActivityCenterOpen(false);
  };

  const reviewChanges = () => {
    if (!event.repoPath) return;
    setDiffRepoPath(event.repoPath);
    setViewMode("diff");
    setActivityCenterOpen(false);
  };

  return (
    <div className="group px-3 py-2.5 border-b border-border/70 hover:bg-surface/70 transition-colors">
      <div className="flex items-start gap-3">
        <div
          className="mt-0.5 h-8 w-8 flex-shrink-0 rounded-md flex items-center justify-center"
          style={{ backgroundColor: `${event.color}20`, color: event.color }}
        >
          <Icon className="h-4 w-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={openSession}
              disabled={!sessionExists}
              className="min-w-0 truncate text-left text-sm font-medium text-zinc-100 disabled:text-zinc-500 disabled:cursor-default"
              title={event.title}
            >
              {event.title}
            </button>
            <span className="flex-shrink-0 rounded bg-surface-active px-1.5 py-0.5 text-[10px] text-zinc-500">
              {statusLabel[event.status] || AGENT_STATUS.idle.label}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-zinc-400 leading-relaxed">{event.body}</div>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-zinc-500">
            <span>{timeAgo(event.createdAt)}</span>
            {event.repoPath && (
              <>
                <span>/</span>
                <span className="font-mono truncate">{event.repoPath.split("/").pop() || event.repoPath}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={focusSession}
            disabled={!sessionExists}
            className="h-6 w-6 rounded flex items-center justify-center text-zinc-600 hover:text-blue-300 hover:bg-blue-500/10 disabled:opacity-30 disabled:hover:text-zinc-600 disabled:hover:bg-transparent transition-colors"
            title="Open in focus mode"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={reviewChanges}
            disabled={!event.repoPath}
            className="h-6 w-6 rounded flex items-center justify-center text-zinc-600 hover:text-green-300 hover:bg-green-500/10 disabled:opacity-30 disabled:hover:text-zinc-600 disabled:hover:bg-transparent transition-colors"
            title="Review repo changes"
          >
            <FileDiff className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => removeAgentActivityEvent(event.id)}
            className="h-6 w-6 rounded flex items-center justify-center text-zinc-600 hover:text-red-300 hover:bg-red-500/10 transition-colors"
            title="Remove event"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function AgentActivityCenter() {
  const {
    activityCenterOpen,
    setActivityCenterOpen,
    agentActivityEvents,
    clearAgentActivityEvents,
    sessions,
  } = useStore();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ActivityFilter>("all");

  const attentionCount = useMemo(
    () =>
      Array.from(sessions.values()).filter((session) =>
        ATTENTION_STATUSES.has(session.status),
      ).length,
    [sessions],
  );

  const filteredEvents = useMemo(() => {
    const q = query.toLowerCase().trim();
    return agentActivityEvents.filter((event) => {
      if (!matchesFilter(event, filter)) return false;
      if (!q) return true;
      return `${event.title} ${event.body} ${event.repoPath || ""} ${event.status}`
        .toLowerCase()
        .includes(q);
    });
  }, [agentActivityEvents, filter, query]);

  const filters: { id: ActivityFilter; label: string; count: number }[] = [
    { id: "all", label: "All", count: agentActivityEvents.length },
    {
      id: "attention",
      label: "Attention",
      count: agentActivityEvents.filter((event) => ATTENTION_STATUSES.has(event.status)).length,
    },
    {
      id: "done",
      label: "Done",
      count: agentActivityEvents.filter((event) => DONE_STATUSES.has(event.status)).length,
    },
  ];

  return createPortal(
    <AnimatePresence>
      {activityCenterOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[84] bg-zinc-950/45"
            onClick={() => setActivityCenterOpen(false)}
          />
          <motion.aside
            initial={{ x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 24, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 42 }}
            className="fixed right-3 top-[68px] bottom-3 z-[85] w-[min(440px,calc(100vw-24px))] overflow-hidden rounded-lg border border-zinc-700/70 bg-[#0b0e0d] shadow-2xl flex flex-col"
          >
            <div className="flex-shrink-0 border-b border-border px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white">Agent activity</div>
                  <div className="mt-0.5 text-xs text-zinc-400">
                    {attentionCount > 0
                      ? `${attentionCount} session${attentionCount === 1 ? "" : "s"} need attention`
                      : "No sessions need attention"}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={clearAgentActivityEvents}
                    disabled={agentActivityEvents.length === 0}
                    className="h-7 w-7 rounded flex items-center justify-center text-zinc-500 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-40 disabled:hover:text-zinc-500 disabled:hover:bg-transparent transition-colors"
                    title="Clear activity"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setActivityCenterOpen(false)}
                    className="h-7 w-7 rounded flex items-center justify-center text-zinc-500 hover:text-zinc-100 hover:bg-surface-active transition-colors"
                    title="Close activity"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search activity"
                    className="w-full rounded-md border border-border bg-canvas py-1.5 pl-8 pr-2 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                  />
                </div>
              </div>

              <div className="mt-2 flex items-center gap-1.5">
                {filters.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setFilter(option.id)}
                    className={`rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
                      filter === option.id
                        ? "bg-surface-active text-zinc-100"
                        : "bg-canvas text-zinc-500 hover:text-zinc-300 hover:bg-surface"
                    }`}
                  >
                    {option.label}
                    {option.count > 0 && (
                      <span className="ml-1 text-zinc-600">{option.count}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {filteredEvents.length === 0 ? (
                <div className="px-6 py-12 text-center">
                  <Terminal className="mx-auto h-5 w-5 text-zinc-700" />
                  <div className="mt-3 text-sm text-zinc-500">
                    {agentActivityEvents.length === 0 ? "No agent events yet" : "No matching events"}
                  </div>
                  <div className="mt-1 text-xs text-zinc-700">
                    Finishes, input requests, errors, and disconnects appear here.
                  </div>
                </div>
              ) : (
                filteredEvents.map((event) => (
                  <ActivityRow key={event.id} event={event} />
                ))
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
