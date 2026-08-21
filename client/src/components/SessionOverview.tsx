import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CornerUpLeft,
  Folder,
  Grid3X3,
  Loader2,
  Maximize2,
  MessageSquare,
  Plus,
  Search,
  X,
} from "lucide-react";
import { useStore, type AgentStatus } from "../stores/useStore";
import { getTerminalTheme } from "../theme/appearance";
import { agentStatusStyle } from "../theme/agentStatus";
import { AgentIcon, getAgentAccentColor } from "./AgentIcon";
import { Terminal } from "./Terminal";

const PAGE_SIZE = 9;
const ACTIVE_STATUSES = new Set<AgentStatus>(["creating", "running", "tool_calling"]);
type OverviewFilter = "all" | "working" | "attention";

function gridShape(count: number) {
  if (count <= 1) return { columns: 1, rows: 1 };
  if (count === 2) return { columns: 2, rows: 1 };
  if (count === 3) return { columns: 3, rows: 1 };
  if (count === 4) return { columns: 2, rows: 2 };
  return { columns: 3, rows: Math.ceil(count / 3) };
}

function useSettledPulse(status: AgentStatus) {
  const previous = useRef(status);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const wasActive = ACTIVE_STATUSES.has(previous.current);
    previous.current = status;
    if (!wasActive || (status !== "idle" && status !== "waiting_input")) return;
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 1_800);
    return () => window.clearTimeout(timer);
  }, [status]);

  return visible;
}

interface OverviewCardProps {
  nodeId: string;
  expanded: boolean;
  dimmed: boolean;
  terminalReady: boolean;
  onTerminalReady: () => void;
  onExpand: () => void;
  onCollapse: () => void;
  onOpenFocus: () => void;
  shortcutIndex: number;
}

function OverviewCard({
  nodeId,
  expanded,
  dimmed,
  terminalReady,
  onTerminalReady,
  onExpand,
  onCollapse,
  onOpenFocus,
  shortcutIndex,
}: OverviewCardProps) {
  const session = useStore((state) => state.sessions.get(nodeId));
  const node = useStore((state) => state.nodes.find((item) => item.id === nodeId));
  const terminalTheme = useStore((state) => state.terminalTheme);
  const palette = getTerminalTheme(terminalTheme);
  const settledPulse = useSettledPulse(session?.status || "idle");

  if (!session) return null;

  const displayColor = getAgentAccentColor(
    session.agentId,
    session.customColor || session.color,
  );
  const displayName = session.customName || session.agentName;
  const iconId = (node?.data?.icon as string) || "cpu";
  const status = agentStatusStyle(session.status);
  const needsAttention = session.status === "waiting_input" || session.status === "error";
  const isWorking = session.status === "running" || session.status === "tool_calling";
  const isCreating = session.status === "creating";
  const directory = (session.originalCwd || session.cwd || "~").split("/").filter(Boolean).pop() || "~";

  return (
    <motion.article
      layout
      initial={{ opacity: 0, scale: 0.985 }}
      animate={{ opacity: dimmed ? 0 : 1, scale: dimmed ? 0.975 : 1 }}
      exit={{ opacity: 0, scale: 0.985 }}
      transition={{
        layout: { duration: 0.28, ease: [0.16, 1, 0.3, 1] },
        opacity: { duration: 0.18 },
        scale: { duration: 0.22, ease: [0.16, 1, 0.3, 1] },
      }}
      className={`${expanded ? "absolute inset-0 z-30" : "relative min-h-0"} flex overflow-hidden rounded-xl border`}
      style={{
        backgroundColor: palette.background,
        borderColor: needsAttention ? status.borderStrong : expanded ? displayColor : palette.border,
        boxShadow: expanded
          ? "0 26px 70px rgb(0 0 0 / 0.52)"
          : needsAttention
            ? `0 0 0 1px ${status.border}, 0 14px 34px rgb(0 0 0 / 0.3)`
            : "0 12px 30px rgb(0 0 0 / 0.26)",
        pointerEvents: dimmed ? "none" : "auto",
      }}
      aria-hidden={dimmed}
      data-overview-node-id={nodeId}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          className={`${expanded ? "h-12 px-4" : "h-10 px-3"} flex flex-shrink-0 items-center justify-between gap-3 border-b`}
          style={{
            borderColor: palette.border,
            backgroundColor: needsAttention
              ? `color-mix(in oklch, ${status.color} 8%, ${palette.surface})`
              : palette.surface,
          }}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            {expanded && (
              <button
                type="button"
                onClick={onCollapse}
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-100"
                title="Back to overview (Esc)"
                aria-label="Back to session overview"
              >
                <CornerUpLeft className="h-3.5 w-3.5" />
              </button>
            )}
            <div
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md"
              style={{ backgroundColor: `color-mix(in oklch, ${displayColor} 15%, transparent)` }}
            >
              <AgentIcon
                agentId={session.agentId}
                iconId={iconId}
                className="h-3.5 w-3.5"
                style={{ color: displayColor }}
              />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className={`${expanded ? "text-xs" : "text-[11px]"} truncate font-medium text-zinc-100`}>
                  {displayName}
                </h2>
                <motion.span
                  key={session.status}
                  initial={{ opacity: 0, y: 2 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex flex-shrink-0 items-center gap-1 text-[9px]"
                  style={{ color: status.color }}
                >
                  <span className="relative flex h-1.5 w-1.5">
                    {isWorking && (
                      <span
                        className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-25 motion-reduce:animate-none"
                        style={{ backgroundColor: status.color, animationDuration: "2.2s" }}
                      />
                    )}
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ backgroundColor: status.color }} />
                  </span>
                  {status.label}
                </motion.span>
              </div>
              {expanded && (
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[9px] text-zinc-600">
                  <Folder className="h-2.5 w-2.5 flex-shrink-0" />
                  <span className="truncate font-mono">{session.cwd || "~"}</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-shrink-0 items-center gap-2">
            {!expanded && (
              <>
                <span className="max-w-[18ch] truncate font-mono text-[9px] text-zinc-600">{directory}</span>
                <kbd
                  className="flex h-5 min-w-5 items-center justify-center rounded border px-1 font-mono text-[8px] text-zinc-600"
                  style={{ borderColor: palette.border }}
                  title={`Open with Cmd/Ctrl+${shortcutIndex + 1}`}
                >
                  {shortcutIndex + 1}
                </kbd>
              </>
            )}
            {needsAttention && (
              <MessageSquare className="h-3 w-3 flex-shrink-0" style={{ color: status.color }} />
            )}
            {expanded && (
              <button
                type="button"
                onClick={onOpenFocus}
                className="flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[9px] text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
                style={{ borderColor: palette.border }}
                title="Open this session in the focus workspace"
              >
                <Maximize2 className="h-3 w-3" />
                Focus workspace
              </button>
            )}
          </div>
        </header>

        <div className="relative min-h-0 flex-1" style={{ backgroundColor: palette.background }}>
          {isCreating ? (
            <div className="flex h-full items-center justify-center gap-2 text-[10px] text-zinc-600">
              <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: status.color }} />
              Preparing terminal…
            </div>
          ) : (
            <motion.div
              className="h-full w-full"
              animate={{ opacity: terminalReady || session.status === "disconnected" ? 1 : 0.7 }}
              transition={{ duration: 0.2 }}
            >
              <Terminal
                key={`overview-${session.sessionId}`}
                sessionId={session.sessionId}
                color={displayColor}
                nodeId={nodeId}
                cwd={session.cwd}
                compact={!expanded}
                workbench={expanded}
                onReady={onTerminalReady}
              />
            </motion.div>
          )}

          {!expanded && (
            <button
              type="button"
              onClick={onExpand}
              className="absolute inset-0 z-20 cursor-zoom-in rounded-b-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[oklch(72%_0.13_48)]"
              aria-label={`Open ${displayName}`}
              title={`Open ${displayName}`}
            />
          )}

          {!isCreating && !terminalReady && session.status !== "disconnected" && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="pointer-events-none absolute bottom-2 right-2 z-10 flex items-center gap-1 rounded-md border border-white/5 bg-black/45 px-1.5 py-1 text-[8px] text-zinc-500 backdrop-blur-sm"
            >
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              Connecting
            </motion.div>
          )}

          <AnimatePresence>
            {settledPulse && (
              <motion.div
                initial={{ opacity: 0.65, scale: 0.992 }}
                animate={{ opacity: 0, scale: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.05 } }}
                transition={{ duration: 1.6, ease: "easeOut" }}
                className="pointer-events-none absolute inset-1 z-10 rounded-lg border"
                data-overview-settled-pulse
                style={{ borderColor: status.color, boxShadow: `inset 0 0 28px ${status.bg}` }}
              />
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.article>
  );
}

export function SessionOverview() {
  const {
    viewMode,
    setViewMode,
    sessions,
    overviewExpandedNodeId,
    setOverviewExpandedNodeId,
    setOverviewVisibleNodeIds,
    addFocusedSession,
    setSidebarOpen,
    setNewSessionModalOpen,
    setSelectedNodeId,
    terminalTheme,
  } = useStore();
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<OverviewFilter>("all");
  const [readySessionIds, setReadySessionIds] = useState<Set<string>>(() => new Set());
  const palette = getTerminalTheme(terminalTheme);

  const entries = useMemo(() => Array.from(sessions.entries()), [sessions]);
  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter(([, session]) => {
      if (filter === "working" && !ACTIVE_STATUSES.has(session.status)) return false;
      if (filter === "attention" && session.status !== "waiting_input" && session.status !== "error") return false;
      if (!needle) return true;
      return [
        session.customName,
        session.agentName,
        session.agentId,
        session.cwd,
        session.originalCwd,
        session.gitBranch,
        agentStatusStyle(session.status).label,
      ].some((value) => value?.toLowerCase().includes(needle));
    });
  }, [entries, filter, query]);
  const pageCount = Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visibleEntries = useMemo(
    () => filteredEntries.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    [filteredEntries, safePage],
  );
  const shape = gridShape(visibleEntries.length);
  const activeCount = filteredEntries.filter(([, session]) => ACTIVE_STATUSES.has(session.status)).length;
  const attentionCount = filteredEntries.filter(([, session]) => session.status === "waiting_input" || session.status === "error").length;

  useEffect(() => {
    setPage(0);
    setOverviewExpandedNodeId(null);
  }, [filter, query, setOverviewExpandedNodeId]);

  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);

  useEffect(() => {
    if (overviewExpandedNodeId && !visibleEntries.some(([nodeId]) => nodeId === overviewExpandedNodeId)) {
      setOverviewExpandedNodeId(null);
    }
  }, [overviewExpandedNodeId, setOverviewExpandedNodeId, visibleEntries]);

  useEffect(() => {
    setOverviewVisibleNodeIds(
      viewMode === "overview" ? visibleEntries.map(([nodeId]) => nodeId) : [],
    );
  }, [setOverviewVisibleNodeIds, viewMode, visibleEntries]);

  if (viewMode !== "overview") return null;

  const openFocusWorkspace = (nodeId: string) => {
    addFocusedSession(nodeId);
    setOverviewExpandedNodeId(null);
    setSidebarOpen(false);
    setViewMode("focus");
  };

  return (
    <motion.section
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-[55] flex min-h-0 flex-col"
      style={{ backgroundColor: "oklch(7.5% 0.004 260 / 0.985)" }}
      aria-label="Session overview"
    >
      <div className="flex h-12 flex-shrink-0 items-center justify-between border-b px-4" style={{ borderColor: palette.border }}>
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setViewMode("canvas")}
            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[10px] text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Canvas
          </button>
          <div className="h-4 w-px" style={{ backgroundColor: palette.border }} />
          <div className="flex items-center gap-2">
            <Grid3X3 className="h-3.5 w-3.5 text-zinc-500" />
            <span className="text-[11px] font-medium text-zinc-300">Session overview</span>
            <span className="text-[9px] text-zinc-600">up to 9 live terminals</span>
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-2 text-[9px] text-zinc-600">
          {!overviewExpandedNodeId && entries.length > 0 && (
            <>
              <div
                className="flex h-7 w-44 items-center gap-1.5 rounded-md border px-2 transition-colors focus-within:border-zinc-600"
                style={{ borderColor: palette.border, backgroundColor: palette.background }}
              >
                <Search className="h-3 w-3 flex-shrink-0 text-zinc-600" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find a session"
                  aria-label="Find a session"
                  className="min-w-0 flex-1 bg-transparent text-[9px] text-zinc-300 outline-none placeholder:text-zinc-700"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="flex h-4 w-4 items-center justify-center rounded text-zinc-600 hover:text-zinc-300"
                    aria-label="Clear session search"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </div>
              <div className="flex h-7 items-center rounded-md border p-0.5" style={{ borderColor: palette.border, backgroundColor: palette.background }}>
                {(["all", "working", "attention"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setFilter(value)}
                    className={`h-6 rounded px-2 text-[8px] capitalize transition-colors ${
                      filter === value ? "bg-white/[0.07] text-zinc-200" : "text-zinc-600 hover:text-zinc-400"
                    }`}
                    aria-pressed={filter === value}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </>
          )}
          {activeCount > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[oklch(74%_0.12_145)]" />
              {activeCount} working
            </span>
          )}
          {attentionCount > 0 && (
            <span className="flex items-center gap-1.5 text-[oklch(72%_0.13_48)]">
              <MessageSquare className="h-2.5 w-2.5" />
              {attentionCount} need attention
            </span>
          )}
          {activeCount === 0 && attentionCount === 0 && visibleEntries.length > 0 && (
            <span className="flex items-center gap-1.5 text-zinc-500">
              <Check className="h-2.5 w-2.5" /> All quiet
            </span>
          )}
          {pageCount > 1 && !overviewExpandedNodeId && (
            <div className="flex items-center gap-1 rounded-md border px-1" style={{ borderColor: palette.border }}>
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                disabled={safePage === 0}
                className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:text-zinc-200 disabled:opacity-25"
                aria-label="Previous sessions"
              >
                <ChevronLeft className="h-3 w-3" />
              </button>
              <span className="min-w-[72px] text-center font-mono">
                {safePage * PAGE_SIZE + 1}–{Math.min(filteredEntries.length, (safePage + 1) * PAGE_SIZE)} of {filteredEntries.length}
              </span>
              <button
                type="button"
                onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
                disabled={safePage === pageCount - 1}
                className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:text-zinc-200 disabled:opacity-25"
                aria-label="Next sessions"
              >
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 p-4">
        {visibleEntries.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border" style={{ borderColor: palette.border, backgroundColor: palette.surface }}>
                <Grid3X3 className="h-5 w-5 text-zinc-600" />
              </div>
              <h2 className="mt-3 text-xs font-medium text-zinc-300">
                {entries.length === 0 ? "No sessions to monitor" : "No matching sessions"}
              </h2>
              <p className="mt-1 text-[10px] text-zinc-600">
                {entries.length === 0
                  ? "Start a session and it will appear here automatically."
                  : "Try another name or broaden the status filter."}
              </p>
              {entries.length === 0 ? (
                <button
                  type="button"
                  onClick={() => setNewSessionModalOpen(true)}
                  className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md bg-zinc-100 px-3 text-[10px] font-medium text-zinc-900 transition-colors hover:bg-white"
                >
                  <Plus className="h-3 w-3" /> New session
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { setQuery(""); setFilter("all"); }}
                  className="mt-4 h-8 rounded-md border px-3 text-[10px] text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
                  style={{ borderColor: palette.border }}
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>
        ) : (
          <div
            className="relative grid h-full min-h-0 gap-3"
            style={{
              gridTemplateColumns: `repeat(${shape.columns}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${shape.rows}, minmax(0, 1fr))`,
            }}
          >
            {visibleEntries.map(([nodeId, session], index) => (
              <OverviewCard
                key={nodeId}
                nodeId={nodeId}
                expanded={overviewExpandedNodeId === nodeId}
                dimmed={overviewExpandedNodeId !== null && overviewExpandedNodeId !== nodeId}
                terminalReady={readySessionIds.has(session.sessionId)}
                onTerminalReady={() => setReadySessionIds((current) => {
                  if (current.has(session.sessionId)) return current;
                  const next = new Set(current);
                  next.add(session.sessionId);
                  return next;
                })}
                onExpand={() => {
                  setSelectedNodeId(nodeId);
                  setOverviewExpandedNodeId(nodeId);
                }}
                onCollapse={() => setOverviewExpandedNodeId(null)}
                onOpenFocus={() => openFocusWorkspace(nodeId)}
                shortcutIndex={index}
              />
            ))}
          </div>
        )}
      </div>
    </motion.section>
  );
}
