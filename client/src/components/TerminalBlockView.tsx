import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  AlertTriangle,
  Bookmark,
  Check,
  ClipboardCopy,
  CornerDownLeft,
  FileText,
  RotateCcw,
  Search,
  Share2,
  StickyNote,
  X,
} from "lucide-react";
import { TerminalShareSheet } from "./TerminalShareSheet";

type TerminalBlockStatus = "running" | "succeeded" | "failed" | "interrupted" | "unknown";

interface TerminalBlock {
  id: string;
  sequence: number;
  command: string;
  cwd: string;
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  status: TerminalBlockStatus;
  failureKind?: "command_not_found" | "not_executable" | "exit_error";
  source: "shell-integration" | "inferred" | "recovered";
  output: string;
  outputTruncated: boolean;
  uiOutputTruncated?: boolean;
  bookmarked?: boolean;
  note?: string;
  sensitive?: boolean;
  shellDepth?: number;
}

interface TerminalBlockSnapshot {
  blocks: TerminalBlock[];
  activeBlockId?: string;
  totalBlocks: number;
  returnedBlocks: number;
  hasOlderBlocks: boolean;
}

interface TerminalBlockViewProps {
  sessionId: string;
  sessionName: string;
  onClose: () => void;
}

const statusLabels: Record<TerminalBlockStatus, string> = {
  running: "Running",
  succeeded: "Passed",
  failed: "Failed",
  interrupted: "Interrupted",
  unknown: "Unknown",
};

function statusClasses(status: TerminalBlockStatus): string {
  if (status === "succeeded") return "text-[oklch(76%_0.11_145)] bg-[oklch(18%_0.025_145)]";
  if (status === "failed") return "text-[oklch(76%_0.13_28)] bg-[oklch(18%_0.035_28)]";
  if (status === "interrupted") return "text-[oklch(78%_0.11_65)] bg-[oklch(19%_0.03_65)]";
  if (status === "running") return "text-[oklch(78%_0.12_48)] bg-[oklch(20%_0.035_48)]";
  return "text-zinc-500 bg-[oklch(17%_0.006_260)]";
}

function compactPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path || "~";
  return `…/${parts.slice(-3).join("/")}`;
}

function formatClock(value: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(value);
}

function formatDuration(block: TerminalBlock): string {
  if (!block.completedAt) return block.status === "running" ? "live" : "";
  const duration = Math.max(0, block.completedAt - block.startedAt);
  if (duration < 1_000) return `${duration} ms`;
  if (duration < 60_000) return `${(duration / 1_000).toFixed(duration < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(duration / 60_000);
  const seconds = Math.floor((duration % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

async function readApiBody(response: Response, fallback: string) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || fallback);
  return body;
}

export function TerminalBlockView({ sessionId, sessionName, onClose }: TerminalBlockViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<TerminalBlockSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(60);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copiedAction, setCopiedAction] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [sensitiveConfirmationId, setSensitiveConfirmationId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  const loadBlocks = useCallback(async (signal?: AbortSignal, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const params = new URLSearchParams({
        includeOutput: "true",
        plainOutput: "true",
        limit: String(visibleLimit),
      });
      const response = await fetch(`/api/sessions/${sessionId}/blocks?${params}`, { signal });
      const body = await readApiBody(response, "Command blocks are unavailable");
      const next = body as TerminalBlockSnapshot;
      setSnapshot(next);
      setSelectedId((current) => {
        if (current && next.blocks.some((block) => block.id === current)) return current;
        return next.activeBlockId || next.blocks.at(-1)?.id || null;
      });
      setError(null);
    } catch (loadError) {
      if ((loadError as Error).name !== "AbortError") {
        setError(loadError instanceof Error ? loadError.message : "Command blocks are unavailable");
      }
    } finally {
      if (!signal?.aborted && !quiet) setLoading(false);
    }
  }, [sessionId, visibleLimit]);

  useEffect(() => {
    setSnapshot(null);
    setSelectedId(null);
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
    setVisibleLimit(60);
    setQuery("");
    setBookmarkedOnly(false);
    setError(null);
    setMessage(null);
    setShareOpen(false);
  }, [sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadBlocks(controller.signal);
    const interval = window.setInterval(() => {
      void loadBlocks(controller.signal, true);
    }, 1_000);
    requestAnimationFrame(() => rootRef.current?.focus());
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [loadBlocks]);

  const blocks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (snapshot?.blocks || []).filter((block) => {
      if (bookmarkedOnly && !block.bookmarked) return false;
      if (!normalized) return true;
      return `${block.command}\n${block.output}\n${block.cwd}\n${block.note || ""}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [bookmarkedOnly, query, snapshot?.blocks]);

  const selectedIndex = blocks.findIndex((block) => block.id === selectedId);
  const selectedBlock = selectedIndex >= 0 ? blocks[selectedIndex] : undefined;
  const snapshotBlockIdKey = (snapshot?.blocks || []).map((block) => block.id).join("\u0000");
  const selectedBlockIds = useMemo(
    () => (snapshot?.blocks || []).filter((block) => selectedIds.has(block.id)).map((block) => block.id),
    // Output may refresh every second; selection order only depends on block identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedIds, snapshotBlockIdKey],
  );

  useEffect(() => {
    if (!selectedId) return;
    listRef.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  useEffect(() => {
    if (!blocks.length) return;
    if (!selectedBlock) setSelectedId(blocks.at(-1)!.id);
  }, [blocks, selectedBlock]);

  useEffect(() => {
    if (!selectedId || !snapshot) return;
    const available = new Set(snapshot.blocks.map((block) => block.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)));
      if (next.size === 0) next.add(selectedId);
      if (next.size === current.size && [...next].every((id) => current.has(id))) return current;
      return next;
    });
    setSelectionAnchorId((current) => current && available.has(current) ? current : selectedId);
  }, [selectedId, snapshot]);

  const updateBlock = (next: TerminalBlock) => {
    setSnapshot((current) => current ? {
      ...current,
      blocks: current.blocks.map((block) => block.id === next.id ? next : block),
    } : current);
  };

  const performBlockCommand = async (block: TerminalBlock, mode: "insert" | "queue") => {
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/blocks/${block.id}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      await readApiBody(response, "Command action failed");
      setMessage(mode === "insert" ? "Command inserted at the terminal cursor" : "Command started or joined the queue");
      if (mode === "insert") onClose();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Command action failed");
    }
  };

  const toggleBookmark = async (block: TerminalBlock) => {
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/blocks/${block.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookmarked: !block.bookmarked }),
      });
      const body = await readApiBody(response, "Bookmark could not be updated");
      updateBlock(body.block);
      setMessage(block.bookmarked ? "Bookmark removed" : "Block bookmarked");
    } catch (bookmarkError) {
      setError(bookmarkError instanceof Error ? bookmarkError.message : "Bookmark could not be updated");
    }
  };

  const saveNote = async (block: TerminalBlock) => {
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/blocks/${block.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: noteDraft }),
      });
      const body = await readApiBody(response, "Note could not be saved");
      updateBlock(body.block);
      setEditingNoteId(null);
      setMessage(noteDraft.trim() ? "Note saved" : "Note removed");
      rootRef.current?.focus();
    } catch (noteError) {
      setError(noteError instanceof Error ? noteError.message : "Note could not be saved");
    }
  };

  const copyText = async (text: string, key: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAction(key);
      setMessage(label);
      window.setTimeout(() => setCopiedAction((current) => current === key ? null : current), 1_600);
    } catch {
      setError("Clipboard access was denied. Select the text and copy it manually.");
    }
  };

  const copyShare = async (block: TerminalBlock, confirmed = false) => {
    setError(null);
    try {
      const params = new URLSearchParams({ format: "markdown", outputMode: "plain" });
      if (confirmed) params.set("confirm", "share-sensitive-terminal-data");
      const response = await fetch(`/api/sessions/${sessionId}/blocks/${block.id}/share?${params}`);
      if (response.status === 409 && block.sensitive && !confirmed) {
        setSensitiveConfirmationId(block.id);
        return;
      }
      const body = await readApiBody(response, "Share payload could not be created");
      await copyText(body.content, `share:${block.id}`, "Redacted Markdown copied");
      setSensitiveConfirmationId(null);
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : "Share payload could not be created");
    }
  };

  const selectOnly = (blockId: string) => {
    setSelectedId(blockId);
    setSelectedIds(new Set([blockId]));
    setSelectionAnchorId(blockId);
  };

  const selectRange = (blockId: string, additive = false) => {
    const anchorId = selectionAnchorId && blocks.some((block) => block.id === selectionAnchorId)
      ? selectionAnchorId
      : selectedId;
    const anchorIndex = blocks.findIndex((block) => block.id === anchorId);
    const targetIndex = blocks.findIndex((block) => block.id === blockId);
    if (anchorIndex < 0 || targetIndex < 0) {
      selectOnly(blockId);
      return;
    }
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    setSelectedIds((current) => new Set([
      ...(additive ? current : []),
      ...blocks.slice(start, end + 1).map((block) => block.id),
    ]));
    setSelectedId(blockId);
  };

  const toggleSelection = (blockId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(blockId) && next.size > 1) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
    setSelectedId(blockId);
    setSelectionAnchorId(blockId);
  };

  const moveSelection = (delta: number, extend = false) => {
    if (!blocks.length) return;
    const current = selectedIndex >= 0 ? selectedIndex : blocks.length - 1;
    const next = Math.max(0, Math.min(blocks.length - 1, current + delta));
    if (extend) selectRange(blocks[next].id);
    else selectOnly(blocks[next].id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
      if (event.key === "Escape") {
        event.preventDefault();
        target.blur();
        rootRef.current?.focus();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.nativeEvent.stopImmediatePropagation();
      if (shareOpen) setShareOpen(false);
      else onClose();
    } else if (event.key.toLowerCase() === "s" && event.shiftKey && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      setShareOpen(true);
    } else if (event.key.toLowerCase() === "a" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      setSelectedIds(new Set(blocks.map((block) => block.id)));
      setSelectedId(blocks.at(-1)?.id || null);
      setSelectionAnchorId(blocks[0]?.id || null);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1, event.shiftKey);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1, event.shiftKey);
    } else if (event.key === "Home" && blocks.length) {
      event.preventDefault();
      selectOnly(blocks[0].id);
    } else if (event.key === "End" && blocks.length) {
      event.preventDefault();
      selectOnly(blocks.at(-1)!.id);
    } else if (selectedBlock && event.key.toLowerCase() === "b") {
      event.preventDefault();
      void toggleBookmark(selectedBlock);
    } else if (selectedBlock && event.key.toLowerCase() === "i") {
      event.preventDefault();
      void performBlockCommand(selectedBlock, "insert");
    } else if (selectedBlock && event.key.toLowerCase() === "r") {
      event.preventDefault();
      void performBlockCommand(selectedBlock, "queue");
    }
  };

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="absolute inset-0 z-30 flex min-h-0 flex-col bg-[oklch(8%_0.004_260)] text-zinc-200 outline-none"
      role="region"
      aria-label={`Command blocks for ${sessionName}`}
    >
      <header className="flex h-11 flex-shrink-0 items-center justify-between border-b border-[oklch(23%_0.007_260)] bg-[oklch(9%_0.004_260)] px-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <FileText className="h-3.5 w-3.5 flex-shrink-0 text-[oklch(75%_0.11_48)]" />
          <span className="text-[11px] font-medium text-zinc-100">Blocks</span>
          <span className="truncate text-[9px] text-zinc-600">{sessionName}</span>
        </div>
        <div className="flex items-center gap-2">
          {selectedBlockIds.length > 1 && <span className="text-[9px] tabular-nums text-[oklch(76%_0.09_48)]">{selectedBlockIds.length} selected</span>}
          <span className="text-[9px] tabular-nums text-zinc-600">{snapshot?.totalBlocks || 0} total</span>
          <button onClick={() => setShareOpen(true)} disabled={!snapshot?.blocks.length} className="flex h-7 items-center gap-1.5 rounded px-2 text-[9px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-35" title="Share selected blocks (Cmd+Shift+S)">
            <Share2 className="h-3 w-3" /> Share
          </button>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[oklch(72%_0.13_48)]" aria-label="Close command blocks">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[oklch(22%_0.006_260)] bg-[oklch(9%_0.004_260)] px-3.5 py-2">
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter command, output, cwd, or note" className="h-8 w-full rounded-md border border-[oklch(27%_0.008_260)] bg-[oklch(12%_0.005_260)] pl-7 pr-2.5 text-[10px] text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-[oklch(60%_0.09_48)]" />
        </label>
        <button onClick={() => setBookmarkedOnly((value) => !value)} className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[9px] transition-colors ${bookmarkedOnly ? "bg-[oklch(23%_0.035_75)] text-[oklch(80%_0.11_75)]" : "text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"}`} aria-pressed={bookmarkedOnly}>
          <Bookmark className="h-3 w-3" fill={bookmarkedOnly ? "currentColor" : "none"} />
          Bookmarked
        </button>
      </div>

      {(error || message) && (
        <div className={`flex-shrink-0 border-b px-3.5 py-2 text-[10px] ${error ? "border-[oklch(38%_0.07_28)] bg-[oklch(16%_0.025_28)] text-[oklch(78%_0.11_28)]" : "border-[oklch(30%_0.04_145)] bg-[oklch(15%_0.02_145)] text-[oklch(76%_0.09_145)]"}`} role="status">
          {error || message}
        </div>
      )}

      <div ref={listRef} role="listbox" aria-activedescendant={selectedBlock ? `terminal-block-${selectedBlock.id}` : undefined} className="min-h-0 flex-1 overflow-y-auto">
        {loading && !snapshot && (
          <div className="space-y-px p-3" aria-label="Loading command blocks">
            {[0, 1, 2].map((item) => <div key={item} className="h-28 animate-pulse rounded-md bg-[oklch(12%_0.005_260)] motion-reduce:animate-none" />)}
          </div>
        )}

        {!loading && blocks.length === 0 && (
          <div className="flex h-full min-h-48 flex-col items-center justify-center px-6 text-center">
            <FileText className="h-5 w-5 text-zinc-700" />
            <p className="mt-3 text-[11px] text-zinc-400">{snapshot?.totalBlocks ? "No blocks match this filter" : "Run a command to create the first block"}</p>
            <p className="mt-1 text-[9px] text-zinc-600">Command and output will stay grouped here.</p>
          </div>
        )}

        {snapshot?.hasOlderBlocks && !query.trim() && !bookmarkedOnly && (
          <div className="flex justify-center border-b border-[oklch(19%_0.006_260)] py-2">
            <button onClick={() => setVisibleLimit((value) => Math.min(250, value + 60))} className="h-7 rounded px-3 text-[9px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
              Load older blocks
            </button>
          </div>
        )}

        {blocks.map((block) => {
          const active = block.id === selectedId;
          const selected = selectedIds.has(block.id);
          const copiedCommand = copiedAction === `command:${block.id}`;
          const copiedOutput = copiedAction === `output:${block.id}`;
          const copiedShare = copiedAction === `share:${block.id}`;
          return (
            <article
              key={block.id}
              id={`terminal-block-${block.id}`}
              data-block-id={block.id}
              role="option"
              aria-selected={selected}
              onClick={(event) => {
                if (event.shiftKey) selectRange(block.id, event.metaKey || event.ctrlKey);
                else if (event.metaKey || event.ctrlKey) toggleSelection(block.id);
                else selectOnly(block.id);
              }}
              className={`relative border-b border-[oklch(20%_0.006_260)] ${selected ? "bg-[oklch(11.5%_0.006_260)]" : "bg-[oklch(8.5%_0.004_260)] hover:bg-[oklch(10%_0.005_260)]"} ${active ? "shadow-[inset_0_0_0_1px_oklch(45%_0.045_48)]" : selected ? "shadow-[inset_3px_0_0_oklch(55%_0.07_48)]" : ""}`}
            >
              <div className={`sticky top-0 z-10 flex items-start gap-2.5 border-b px-3.5 py-2.5 ${selected ? "border-[oklch(30%_0.025_48)] bg-[oklch(12%_0.008_260)]" : "border-[oklch(18%_0.005_260)] bg-[oklch(9.5%_0.004_260)]"}`}>
                {selected && <span className="mt-1 flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-sm border border-[oklch(60%_0.08_48)] bg-[oklch(55%_0.09_48)] text-[oklch(10%_0.01_48)]"><Check className="h-2.5 w-2.5" /></span>}
                <span className={`mt-0.5 flex h-5 flex-shrink-0 items-center rounded px-1.5 text-[8px] font-medium uppercase tracking-[0.08em] ${statusClasses(block.status)}`}>
                  {block.status === "running" && <span className="mr-1 h-1.5 w-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />}
                  {statusLabels[block.status]}
                </span>
                <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-zinc-100">{block.command || "Background output"}</code>
                <button onClick={(event) => { event.stopPropagation(); void toggleBookmark(block); }} className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded ${block.bookmarked ? "text-[oklch(80%_0.11_75)]" : "text-zinc-700 hover:bg-zinc-800 hover:text-zinc-400"}`} aria-label={block.bookmarked ? "Remove block bookmark" : "Bookmark block"}>
                  <Bookmark className="h-3 w-3" fill={block.bookmarked ? "currentColor" : "none"} />
                </button>
              </div>

              <div className="flex items-center gap-2 px-3.5 py-1.5 text-[8px] text-zinc-600">
                <span className="font-mono">{compactPath(block.cwd)}</span>
                <span className="text-zinc-800">·</span>
                <span>{formatClock(block.startedAt)}</span>
                {formatDuration(block) && <><span className="text-zinc-800">·</span><span>{formatDuration(block)}</span></>}
                {block.exitCode !== undefined && <><span className="text-zinc-800">·</span><span>exit {block.exitCode}</span></>}
                {block.shellDepth ? <><span className="text-zinc-800">·</span><span>shell depth {block.shellDepth}</span></> : null}
                {block.sensitive && <span className="ml-auto text-[oklch(72%_0.10_65)]">Sensitive values redacted</span>}
              </div>

              {block.note && editingNoteId !== block.id && (
                <div className="mx-3.5 mb-2 flex items-start gap-2 rounded-md bg-[oklch(15%_0.015_75)] px-2.5 py-2 text-[9px] leading-4 text-[oklch(78%_0.06_75)]">
                  <StickyNote className="mt-0.5 h-3 w-3 flex-shrink-0" />
                  <span className="whitespace-pre-wrap">{block.note}</span>
                </div>
              )}

              <pre className="m-0 min-h-10 overflow-x-auto whitespace-pre-wrap break-words px-3.5 pb-3 pt-1 font-mono text-[10px] leading-[1.65] text-zinc-400 selection:bg-[oklch(35%_0.06_48)]">
                {block.output || (block.status === "running" ? "Waiting for output…" : "No output")}
              </pre>

              {(block.outputTruncated || block.uiOutputTruncated) && (
                <div className="flex items-center gap-1.5 border-t border-[oklch(20%_0.006_260)] px-3.5 py-1.5 text-[8px] text-zinc-600">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  {block.outputTruncated ? "Stored output was truncated" : "Middle output is hidden in this view"}
                </div>
              )}

              {active && (
                <div className="flex flex-wrap items-center gap-1 border-t border-[oklch(24%_0.008_260)] px-3.5 py-2">
                  <button onClick={() => void copyText(block.command, `command:${block.id}`, "Command copied")} className="flex h-7 items-center gap-1.5 rounded px-2 text-[9px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
                    {copiedCommand ? <Check className="h-3 w-3" /> : <ClipboardCopy className="h-3 w-3" />} Command
                  </button>
                  <button onClick={() => void copyText(block.output, `output:${block.id}`, "Output copied")} className="flex h-7 items-center gap-1.5 rounded px-2 text-[9px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
                    {copiedOutput ? <Check className="h-3 w-3" /> : <ClipboardCopy className="h-3 w-3" />} Output
                  </button>
                  {block.command && (
                    <>
                      <button onClick={() => void performBlockCommand(block, "insert")} className="flex h-7 items-center gap-1.5 rounded px-2 text-[9px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"><CornerDownLeft className="h-3 w-3" /> Insert</button>
                      <button onClick={() => void performBlockCommand(block, "queue")} className="flex h-7 items-center gap-1.5 rounded px-2 text-[9px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"><RotateCcw className="h-3 w-3" /> Run or queue</button>
                    </>
                  )}
                  <button onClick={() => { setEditingNoteId(block.id); setNoteDraft(block.note || ""); }} className="flex h-7 items-center gap-1.5 rounded px-2 text-[9px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"><StickyNote className="h-3 w-3" /> Note</button>
                  <button onClick={() => void copyShare(block)} className="ml-auto flex h-7 items-center gap-1.5 rounded px-2 text-[9px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
                    {copiedShare ? <Check className="h-3 w-3" /> : <Share2 className="h-3 w-3" />} Copy Markdown
                  </button>
                </div>
              )}

              {editingNoteId === block.id && (
                <div className="border-t border-[oklch(24%_0.008_260)] bg-[oklch(10%_0.005_260)] p-3.5">
                  <label className="mb-1.5 block text-[9px] text-zinc-500">Block note</label>
                  <textarea autoFocus value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} rows={3} maxLength={2_000} className="w-full resize-y rounded-md border border-[oklch(28%_0.008_260)] bg-[oklch(13%_0.006_260)] px-2.5 py-2 text-[10px] leading-4 text-zinc-200 outline-none focus:border-[oklch(60%_0.09_48)]" />
                  <div className="mt-2 flex justify-end gap-1.5"><button onClick={() => setEditingNoteId(null)} className="h-7 rounded px-2 text-[9px] text-zinc-500 hover:bg-zinc-800">Cancel</button><button onClick={() => void saveNote(block)} className="h-7 rounded bg-[oklch(65%_0.11_48)] px-2.5 text-[9px] font-medium text-[oklch(13%_0.02_48)]">Save note</button></div>
                </div>
              )}

              {sensitiveConfirmationId === block.id && (
                <div className="flex items-center gap-2 border-t border-[oklch(35%_0.05_65)] bg-[oklch(16%_0.025_65)] px-3.5 py-2 text-[9px] text-[oklch(79%_0.09_65)]">
                  <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                  <span className="min-w-0 flex-1">This block contained sensitive data. OpenUI will rescan and redact the Markdown.</span>
                  <button onClick={() => setSensitiveConfirmationId(null)} className="h-6 rounded px-2 hover:bg-[oklch(21%_0.03_65)]">Cancel</button>
                  <button onClick={() => void copyShare(block, true)} className="h-6 rounded bg-[oklch(62%_0.09_65)] px-2 font-medium text-[oklch(13%_0.02_65)]">Copy redacted</button>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {shareOpen && (
        <TerminalShareSheet
          sessionId={sessionId}
          sessionName={sessionName}
          selectedBlockIds={selectedBlockIds}
          totalBlockCount={snapshot?.totalBlocks || 0}
          onClose={() => {
            setShareOpen(false);
            requestAnimationFrame(() => rootRef.current?.focus());
          }}
        />
      )}

      <footer className="flex h-6 flex-shrink-0 items-center gap-3 border-t border-[oklch(21%_0.006_260)] bg-[oklch(8.5%_0.004_260)] px-3.5 text-[8px] text-zinc-600">
        <span>↑↓ select</span><span>⇧↑↓ range</span><span>⌘A all</span><span>⌘⇧S share</span><span>B bookmark</span><span>I insert</span><span>R run</span><span className="ml-auto">Esc terminal</span>
      </footer>
    </div>
  );
}
