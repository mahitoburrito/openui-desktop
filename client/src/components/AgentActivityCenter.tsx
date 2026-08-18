import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useStore, type AgentActivityEvent, type AgentStatus } from "../stores/useStore";
import { Codicon } from "./Codicon";

type ActivityFilter = "all" | "attention" | "done";

const ATTENTION_STATUSES = new Set<AgentStatus>(["waiting_input", "error", "disconnected"]);
const DONE_STATUSES = new Set<AgentStatus>(["idle"]);

const statusIcon: Record<AgentStatus, string> = {
  creating: "loading",
  running: "terminal",
  tool_calling: "tools",
  waiting_input: "comment-discussion",
  idle: "check",
  disconnected: "debug-disconnect",
  error: "error",
};

const statusLabel: Record<AgentStatus, string> = {
  creating: "Creating",
  running: "Running",
  tool_calling: "Using tool",
  waiting_input: "Needs input",
  idle: "Finished",
  disconnected: "Disconnected",
  error: "Error",
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
    setViewMode,
    addFocusedSession,
    setDiffRepoPath,
    setActivityCenterOpen,
    removeAgentActivityEvent,
  } = useStore();

  const icon = statusIcon[event.status] || "terminal";
  const sessionExists = sessions.has(event.nodeId);

  const openSession = () => {
    if (!sessionExists) return;
    useStore.getState().openSessionInFocus(event.nodeId);
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
    <div className="group border-b border-white/[0.055] px-3 py-2.5 transition-colors hover:bg-white/[0.035]">
      <div className="flex items-start gap-3">
        <div
          className="mt-0.5 h-8 w-8 flex-shrink-0 rounded-md flex items-center justify-center"
          style={{ backgroundColor: `${event.color}20`, color: event.color }}
        >
          <Codicon
            name={icon}
            size={15}
            className={event.status === "creating" ? "codicon-modifier-spin" : undefined}
          />
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
              {statusLabel[event.status]}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-zinc-400 leading-relaxed">{event.body}</div>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-zinc-500">
            <span>{timeAgo(event.createdAt)}</span>
            {event.repoPath && (
              <>
                <span>·</span>
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
            className="workspace-icon-button flex h-6 w-6 items-center justify-center rounded text-zinc-600 hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-600"
            title="Open in focus mode"
          >
            <Codicon name="screen-full" size={12} />
          </button>
          <button
            type="button"
            onClick={reviewChanges}
            disabled={!event.repoPath}
            className="workspace-icon-button flex h-6 w-6 items-center justify-center rounded text-zinc-600 hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-600"
            title="Review repo changes"
          >
            <Codicon name="git-compare" size={12} />
          </button>
          <button
            type="button"
            onClick={() => removeAgentActivityEvent(event.id)}
            className="workspace-icon-button flex h-6 w-6 items-center justify-center rounded text-zinc-600 hover:text-red-300"
            title="Remove event"
          >
            <Codicon name="close" size={12} />
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
            className="fixed inset-0 z-[84] bg-zinc-950/35 backdrop-blur-[2px]"
            onClick={() => setActivityCenterOpen(false)}
          />
          <motion.aside
            initial={{ x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 24, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="workspace-glass-strong fixed bottom-3 right-3 top-14 z-[85] flex w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl"
          >
            <div className="flex-shrink-0 border-b border-white/[0.065] px-4 py-3">
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
                    className="workspace-icon-button flex h-7 w-7 items-center justify-center rounded text-zinc-500 hover:text-red-300 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-500"
                    title="Clear activity"
                  >
                    <Codicon name="trash" size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setActivityCenterOpen(false)}
                    className="workspace-icon-button flex h-7 w-7 items-center justify-center rounded text-zinc-500 hover:text-zinc-100"
                    title="Close activity"
                  >
                    <Codicon name="close" size={14} />
                  </button>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Codicon name="search" size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search activity"
                    className="workspace-glass-segment w-full rounded-[7px] py-1.5 pl-8 pr-2 text-xs text-zinc-100 placeholder-zinc-600 transition-colors focus:outline-none"
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
                  <Codicon name="terminal" size={19} className="text-zinc-700" />
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
