import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  CaseSensitive,
  CornerDownLeft,
  History,
  ListPlus,
  Loader2,
  Regex,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";

export type TerminalWorkbenchPanelMode = "find" | "history" | "queue";

interface TerminalWorkbenchPanelProps {
  mode: TerminalWorkbenchPanelMode;
  sessionId: string;
  sessionName: string;
  onClose: () => void;
  onModeChange: (mode: TerminalWorkbenchPanelMode) => void;
}

interface TerminalFindMatch {
  id: string;
  blockId: string;
  blockSequence: number;
  field: "command" | "output" | "note" | "cwd";
  line: number;
  excerpt: string;
  sensitive: boolean;
}

interface TerminalFindSnapshot {
  id: string;
  status: "scanning" | "complete" | "cancelled" | "error";
  version: number;
  scannedBlocks: number;
  totalBlocks: number;
  totalMatches: number;
  truncated: boolean;
  matches: TerminalFindMatch[];
  error?: string;
}

interface TerminalHistoryBlock {
  id: string;
  sequence: number;
  command: string;
  cwd: string;
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  status: "running" | "succeeded" | "failed" | "interrupted" | "unknown";
  bookmarked?: boolean;
  sensitive?: boolean;
}

interface TerminalQueuedCommand {
  id: string;
  command: string;
  createdAt: number;
  updatedAt: number;
  blockId?: string;
  startedAt?: number;
}

interface TerminalCommandQueueSnapshot {
  sessionId: string;
  version: number;
  pending: TerminalQueuedCommand[];
  inFlight?: TerminalQueuedCommand;
}

const modeMeta: Record<TerminalWorkbenchPanelMode, { label: string; icon: typeof Search }> = {
  find: { label: "Find in terminal", icon: Search },
  history: { label: "Command history", icon: History },
  queue: { label: "Command queue", icon: ListPlus },
};

function compactPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path || "~";
  return `…/${parts.slice(-2).join("/")}`;
}

function timeLabel(value?: number): string {
  if (!value) return "Now";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function statusTone(status: TerminalHistoryBlock["status"]): string {
  if (status === "succeeded") return "text-[oklch(76%_0.11_145)]";
  if (status === "failed") return "text-[oklch(72%_0.14_28)]";
  if (status === "interrupted") return "text-[oklch(76%_0.11_65)]";
  if (status === "running") return "text-[oklch(72%_0.13_48)]";
  return "text-zinc-500";
}

async function readApiBody(response: Response, fallbackMessage: string): Promise<any> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(response.ok ? fallbackMessage : `${fallbackMessage} (${response.status})`);
  }
}

export function TerminalWorkbenchPanel({
  mode,
  sessionId,
  sessionName,
  onClose,
  onModeChange,
}: TerminalWorkbenchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [findSnapshot, setFindSnapshot] = useState<TerminalFindSnapshot | null>(null);
  const [history, setHistory] = useState<TerminalHistoryBlock[]>([]);
  const [queue, setQueue] = useState<TerminalCommandQueueSnapshot | null>(null);
  const [queuedCommand, setQueuedCommand] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    setQuery("");
    setFindSnapshot(null);
    setError(null);
    setActionMessage(null);
  }, [sessionId]);

  useEffect(() => {
    if (mode === "find" || mode === "history") {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [mode, sessionId]);

  useEffect(() => {
    if (mode !== "find" || !query.trim()) {
      setFindSnapshot(null);
      return;
    }

    const controller = new AbortController();
    let searchId: string | undefined;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const startResponse = await fetch("/api/terminal/find", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            clientId: `focus-workbench-${sessionId}`,
            query,
            regex,
            caseSensitive,
            fields: ["command", "output"],
            order: "newest-first",
            limit: 100,
          }),
          signal: controller.signal,
        });
        const startBody = await readApiBody(startResponse, "Terminal search is unavailable");
        if (!startResponse.ok) throw new Error(startBody.error || "Search failed");

        let snapshot = startBody.search as TerminalFindSnapshot;
        searchId = snapshot.id;
        setFindSnapshot(snapshot);
        setLoading(snapshot.status === "scanning");

        while (!controller.signal.aborted && snapshot.status === "scanning") {
          const response = await fetch(
            `/api/terminal/find/${snapshot.id}?afterVersion=${snapshot.version}&waitMs=10000`,
            { signal: controller.signal },
          );
          const body = await readApiBody(response, "Terminal search is unavailable");
          if (!response.ok) throw new Error(body.error || "Search failed");
          snapshot = body.search as TerminalFindSnapshot;
          setFindSnapshot(snapshot);
          setLoading(snapshot.status === "scanning");
        }
      } catch (searchError) {
        if (!controller.signal.aborted) {
          setLoading(false);
          setError(searchError instanceof Error ? searchError.message : "Search failed");
        }
      }
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
      if (searchId) {
        void fetch(`/api/terminal/find/${searchId}`, { method: "DELETE" });
      }
    };
  }, [caseSensitive, mode, query, regex, sessionId]);

  useEffect(() => {
    if (mode !== "history") return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/sessions/${sessionId}/blocks?includeOutput=false`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await readApiBody(response, "Command history is unavailable");
        if (!response.ok) throw new Error(body.error || "Could not load command history");
        const blocks = Array.isArray(body.blocks) ? body.blocks : [];
        setHistory([...blocks].reverse());
      })
      .catch((historyError) => {
        if (!controller.signal.aborted) {
          setError(historyError instanceof Error ? historyError.message : "Could not load history");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [mode, sessionId]);

  const loadQueue = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/sessions/${sessionId}/command-queue`, { signal });
    const body = await readApiBody(response, "Command queue is unavailable");
    if (!response.ok) throw new Error(body.error || "Could not load command queue");
    setQueue(body.queue);
  }, [sessionId]);

  useEffect(() => {
    if (mode !== "queue") return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void loadQueue(controller.signal)
      .catch((queueError) => {
        if (!controller.signal.aborted) {
          setError(queueError instanceof Error ? queueError.message : "Could not load queue");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    const interval = window.setInterval(() => {
      void loadQueue(controller.signal).catch(() => {});
    }, 1_200);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [loadQueue, mode]);

  const visibleHistory = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return history;
    return history.filter((block) =>
      `${block.command}\n${block.cwd}`.toLowerCase().includes(normalized),
    );
  }, [history, query]);

  const runBlockCommand = async (blockId: string, runMode: "insert" | "execute") => {
    setActionMessage(null);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/blocks/${blockId}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: runMode }),
      });
      const body = await readApiBody(response, "Command action is unavailable");
      if (!response.ok) throw new Error(body.error || "Command action failed");
      setActionMessage(runMode === "execute" ? "Command started" : "Command inserted");
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : "Command action failed");
    }
  };

  const toggleBookmark = async (block: TerminalHistoryBlock) => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/blocks/${block.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookmarked: !block.bookmarked }),
      });
      const body = await readApiBody(response, "Bookmarks are unavailable");
      if (!response.ok) throw new Error(body.error || "Could not update bookmark");
      setHistory((items) => items.map((item) => item.id === block.id ? body.block : item));
    } catch (bookmarkError) {
      setError(bookmarkError instanceof Error ? bookmarkError.message : "Could not update bookmark");
    }
  };

  const addQueuedCommand = async (event: FormEvent) => {
    event.preventDefault();
    if (!queuedCommand.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/command-queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: queuedCommand }),
      });
      const body = await readApiBody(response, "Command queue is unavailable");
      if (!response.ok) throw new Error(body.error || "Could not queue command");
      setQueuedCommand("");
      setQueue(body.queue);
    } catch (queueError) {
      setError(queueError instanceof Error ? queueError.message : "Could not queue command");
    } finally {
      setLoading(false);
    }
  };

  const mutateQueue = async (path: string, init: RequestInit) => {
    setError(null);
    try {
      const response = await fetch(path, init);
      const body = await readApiBody(response, "Command queue is unavailable");
      if (!response.ok) throw new Error(body.error || "Could not update queue");
      setQueue(body.queue);
    } catch (queueError) {
      setError(queueError instanceof Error ? queueError.message : "Could not update queue");
    }
  };

  const reorderQueuedCommand = (index: number, direction: -1 | 1) => {
    if (!queue) return;
    const item = queue.pending[index];
    if (!item) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= queue.pending.length) return;
    const beforeId = direction < 0
      ? queue.pending[targetIndex].id
      : queue.pending[targetIndex + 1]?.id || null;
    void mutateQueue(
      `/api/sessions/${sessionId}/command-queue/${item.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beforeId }),
      },
    );
  };

  const meta = modeMeta[mode];
  const MetaIcon = meta.icon;

  return (
    <aside
      className="flex h-full w-[min(360px,100vw)] flex-shrink-0 flex-col border-l border-[oklch(25%_0.008_260)] bg-[oklch(9.5%_0.005_260)] text-zinc-200"
      aria-label={`${meta.label} for ${sessionName}`}
    >
      <div className="flex h-11 flex-shrink-0 items-center justify-between border-b border-[oklch(23%_0.007_260)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <MetaIcon className="h-3.5 w-3.5 text-[oklch(72%_0.13_48)]" />
          <span className="truncate text-[12px] font-medium">{meta.label}</span>
        </div>
        <button
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[oklch(72%_0.13_48)]"
          aria-label={`Close ${meta.label}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1 border-b border-[oklch(23%_0.007_260)] p-1.5" role="tablist">
        {(Object.keys(modeMeta) as TerminalWorkbenchPanelMode[]).map((item) => {
          const ItemIcon = modeMeta[item].icon;
          return (
            <button
              key={item}
              role="tab"
              aria-selected={mode === item}
              onClick={() => onModeChange(item)}
              className={`flex h-8 items-center justify-center gap-1.5 rounded-md text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[oklch(72%_0.13_48)] ${
                mode === item
                  ? "bg-[oklch(18%_0.008_260)] text-zinc-100"
                  : "text-zinc-500 hover:bg-[oklch(15%_0.006_260)] hover:text-zinc-300"
              }`}
            >
              <ItemIcon className="h-3 w-3" />
              {item === "find" ? "Find" : item === "history" ? "History" : "Queue"}
            </button>
          );
        })}
      </div>

      {(mode === "find" || mode === "history") && (
        <div className="border-b border-[oklch(23%_0.007_260)] p-3">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={mode === "find" ? "Search command output" : "Filter commands"}
              className="h-9 w-full rounded-md border border-[oklch(27%_0.008_260)] bg-[oklch(12%_0.005_260)] pl-8 pr-2.5 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-[oklch(62%_0.10_48)]"
            />
          </label>
          {mode === "find" && (
            <div className="mt-2 flex items-center justify-between">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setCaseSensitive((value) => !value)}
                  className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${caseSensitive ? "bg-[oklch(25%_0.04_48)] text-[oklch(80%_0.12_48)]" : "text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"}`}
                  aria-label="Match case"
                  aria-pressed={caseSensitive}
                >
                  <CaseSensitive className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setRegex((value) => !value)}
                  className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${regex ? "bg-[oklch(25%_0.04_48)] text-[oklch(80%_0.12_48)]" : "text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"}`}
                  aria-label="Use regular expression"
                  aria-pressed={regex}
                >
                  <Regex className="h-3.5 w-3.5" />
                </button>
              </div>
              {findSnapshot && (
                <span className="text-[10px] tabular-nums text-zinc-600">
                  {findSnapshot.totalMatches} match{findSnapshot.totalMatches === 1 ? "" : "es"}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {mode === "queue" && (
        <form onSubmit={addQueuedCommand} className="border-b border-[oklch(23%_0.007_260)] p-3">
          <label className="mb-2 block text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-600">
            Run after current work
          </label>
          <textarea
            value={queuedCommand}
            onChange={(event) => setQueuedCommand(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            rows={3}
            placeholder="npm test"
            className="w-full resize-none rounded-md border border-[oklch(27%_0.008_260)] bg-[oklch(12%_0.005_260)] px-2.5 py-2 font-mono text-[11px] leading-5 text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-[oklch(62%_0.10_48)]"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[9px] text-zinc-600">⌘↵ to queue</span>
            <button
              type="submit"
              disabled={!queuedCommand.trim() || loading}
              className="flex h-7 items-center gap-1.5 rounded-md bg-[oklch(72%_0.13_48)] px-2.5 text-[11px] font-medium text-[oklch(14%_0.02_48)] transition-colors hover:bg-[oklch(76%_0.13_48)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ListPlus className="h-3 w-3" />
              Queue
            </button>
          </div>
        </form>
      )}

      {(error || actionMessage) && (
        <div
          className={`border-b px-3 py-2 text-[10px] ${error ? "border-[oklch(42%_0.10_28)] bg-[oklch(18%_0.035_28)] text-[oklch(79%_0.11_28)]" : "border-[oklch(34%_0.055_145)] bg-[oklch(17%_0.025_145)] text-[oklch(76%_0.09_145)]"}`}
          role="status"
        >
          {error || actionMessage}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !findSnapshot && history.length === 0 && !queue && (
          <div className="flex h-32 items-center justify-center gap-2 text-[11px] text-zinc-600">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading
          </div>
        )}

        {mode === "find" && (
          <div className="py-1">
            {!query.trim() && (
              <div className="px-4 py-10 text-center">
                <Search className="mx-auto mb-3 h-5 w-5 text-zinc-700" />
                <p className="text-[12px] text-zinc-400">Find across commands and output</p>
                <p className="mt-1 text-[10px] leading-4 text-zinc-600">Results stay scoped to this terminal session.</p>
              </div>
            )}
            {query.trim() && findSnapshot?.status === "complete" && findSnapshot.matches.length === 0 && (
              <div className="px-4 py-10 text-center text-[11px] text-zinc-600">No matches in this session</div>
            )}
            {findSnapshot?.matches.map((match) => (
              <div key={match.id} className="group border-b border-[oklch(18%_0.006_260)] px-3 py-2.5 hover:bg-[oklch(13.5%_0.006_260)]">
                <div className="mb-1.5 flex items-center justify-between text-[9px] uppercase tracking-[0.1em] text-zinc-600">
                  <span>{match.field} · block {match.blockSequence}</span>
                  {match.sensitive && <span>Sensitive</span>}
                </div>
                <p className="line-clamp-3 whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-zinc-300">{match.excerpt}</p>
                <button
                  onClick={() => void runBlockCommand(match.blockId, "insert")}
                  className="mt-2 flex h-6 items-center gap-1 rounded px-1.5 text-[9px] text-zinc-600 opacity-0 transition-all hover:bg-zinc-800 hover:text-zinc-300 focus:opacity-100 group-hover:opacity-100"
                >
                  <CornerDownLeft className="h-2.5 w-2.5" />
                  Insert command
                </button>
              </div>
            ))}
          </div>
        )}

        {mode === "history" && (
          <div className="py-1">
            {!loading && visibleHistory.length === 0 && (
              <div className="px-4 py-10 text-center">
                <History className="mx-auto mb-3 h-5 w-5 text-zinc-700" />
                <p className="text-[11px] text-zinc-600">No matching commands</p>
              </div>
            )}
            {visibleHistory.map((block) => (
              <div key={block.id} className="group border-b border-[oklch(18%_0.006_260)] px-3 py-2.5 hover:bg-[oklch(13.5%_0.006_260)]">
                <div className="flex items-start gap-2">
                  <span className={`mt-0.5 text-[9px] uppercase ${statusTone(block.status)}`}>{block.status}</span>
                  <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-zinc-200">{block.command || "Shell input"}</code>
                  <button
                    onClick={() => void toggleBookmark(block)}
                    className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded transition-colors ${block.bookmarked ? "text-[oklch(78%_0.12_80)]" : "text-zinc-700 hover:bg-zinc-800 hover:text-zinc-400"}`}
                    aria-label={block.bookmarked ? "Remove bookmark" : "Bookmark command"}
                  >
                    <Bookmark className="h-3 w-3" fill={block.bookmarked ? "currentColor" : "none"} />
                  </button>
                </div>
                <div className="mt-1.5 flex items-center justify-between text-[9px] text-zinc-600">
                  <span className="truncate font-mono">{compactPath(block.cwd)}</span>
                  <span className="ml-2 flex-shrink-0">{timeLabel(block.completedAt || block.startedAt)}</span>
                </div>
                <div className="mt-2 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <button
                    onClick={() => void runBlockCommand(block.id, "insert")}
                    className="flex h-6 items-center gap-1 rounded px-1.5 text-[9px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    <CornerDownLeft className="h-2.5 w-2.5" />
                    Insert
                  </button>
                  <button
                    onClick={() => void runBlockCommand(block.id, "execute")}
                    className="flex h-6 items-center gap-1 rounded px-1.5 text-[9px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    <RotateCcw className="h-2.5 w-2.5" />
                    Run again
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {mode === "queue" && (
          <div className="py-1">
            {queue?.inFlight && (
              <div className="border-b border-[oklch(25%_0.04_48)] bg-[oklch(15%_0.02_48)] px-3 py-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[9px] font-medium uppercase tracking-[0.12em] text-[oklch(76%_0.11_48)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[oklch(72%_0.13_48)]" />
                  Running from queue
                </div>
                <code className="whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-zinc-200">{queue.inFlight.command}</code>
              </div>
            )}

            {queue && !queue.inFlight && queue.pending.length === 0 && (
              <div className="px-5 py-10 text-center">
                <ListPlus className="mx-auto mb-3 h-5 w-5 text-zinc-700" />
                <p className="text-[12px] text-zinc-400">Queue is clear</p>
                <p className="mt-1 text-[10px] leading-4 text-zinc-600">Add commands without interrupting the active process.</p>
              </div>
            )}

            {queue?.pending.map((item, index) => (
              <div key={item.id} className="group flex gap-2 border-b border-[oklch(18%_0.006_260)] px-3 py-2.5 hover:bg-[oklch(13.5%_0.006_260)]">
                <span className="mt-0.5 w-4 flex-shrink-0 text-right font-mono text-[9px] text-zinc-700">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <code className="whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-zinc-200">{item.command}</code>
                  <div className="mt-2 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <button
                      onClick={() => reorderQueuedCommand(index, -1)}
                      disabled={index === 0}
                      className="flex h-6 w-6 items-center justify-center rounded text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-20"
                      aria-label="Move command earlier"
                    >
                      <ArrowUp className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => reorderQueuedCommand(index, 1)}
                      disabled={index === queue.pending.length - 1}
                      className="flex h-6 w-6 items-center justify-center rounded text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-20"
                      aria-label="Move command later"
                    >
                      <ArrowDown className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => void mutateQueue(
                        `/api/sessions/${sessionId}/command-queue/${item.id}`,
                        { method: "DELETE" },
                      )}
                      className="ml-auto flex h-6 w-6 items-center justify-center rounded text-zinc-700 hover:bg-[oklch(20%_0.04_28)] hover:text-[oklch(74%_0.12_28)]"
                      aria-label="Remove queued command"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {mode === "queue" && queue && queue.pending.length > 0 && (
        <div className="flex h-10 flex-shrink-0 items-center justify-between border-t border-[oklch(23%_0.007_260)] px-3">
          <span className="text-[9px] text-zinc-600">{queue.pending.length} pending</span>
          <button
            onClick={() => void mutateQueue(`/api/sessions/${sessionId}/command-queue`, { method: "DELETE" })}
            className="text-[10px] text-zinc-600 transition-colors hover:text-[oklch(74%_0.12_28)]"
          >
            Clear pending
          </button>
        </div>
      )}
    </aside>
  );
}
