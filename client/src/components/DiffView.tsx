import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { motion } from "framer-motion";
import {
  Minimize2,
  RefreshCw,
  GitBranch,
  FolderGit2,
  FileDiff,
  Loader2,
  ChevronDown,
  Columns2,
  Rows3,
  WrapText,
  Palette,
  Sparkles,
  Trash2,
  Undo2,
  Clipboard,
  Check,
  History,
  Save,
  RotateCcw,
} from "lucide-react";
import { DIFF_THEMES, useStore, type DiffTheme } from "../stores/useStore";
import {
  parseDiff,
  type ChangedFile,
  type DiffLine,
} from "./diff/diffModel";
import { UnifiedDiff, SplitDiff } from "./diff/DiffBody";
import { useHighlighter } from "./diff/useHighlighter";

interface GitCheckpointSummary {
  id: string;
  name: string;
  createdAt: number;
  files: { path: string; exists: boolean }[];
}

const THEME_LABELS: Record<DiffTheme, string> = {
  "github-dark": "GitHub Dark",
  "github-light": "GitHub Light",
  "one-dark-pro": "One Dark Pro",
  dracula: "Dracula",
  nord: "Nord",
  "vitesse-dark": "Vitesse Dark",
};

const DIFF_THEME_SURFACES: Record<
  DiffTheme,
  { background: string; foreground: string; muted: string; gutter: string; border: string }
> = {
  "github-dark": {
    background: "#0d1117",
    foreground: "#e6edf3",
    muted: "#7d8590",
    gutter: "#161b22",
    border: "#30363d",
  },
  "github-light": {
    background: "#ffffff",
    foreground: "#24292f",
    muted: "#6e7781",
    gutter: "#f6f8fa",
    border: "#d0d7de",
  },
  "one-dark-pro": {
    background: "#282c34",
    foreground: "#abb2bf",
    muted: "#6b7280",
    gutter: "#21252b",
    border: "#3b4048",
  },
  dracula: {
    background: "#282a36",
    foreground: "#f8f8f2",
    muted: "#7f8497",
    gutter: "#21222c",
    border: "#44475a",
  },
  nord: {
    background: "#2e3440",
    foreground: "#d8dee9",
    muted: "#8f9bad",
    gutter: "#252b36",
    border: "#4c566a",
  },
  "vitesse-dark": {
    background: "#121212",
    foreground: "#dbd7ca",
    muted: "#85806f",
    gutter: "#191919",
    border: "#343434",
  },
};

function formatCheckpointTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatFileOption(file: ChangedFile): string {
  const status = file.untracked ? "A" : file.status.replace("?", "M").charAt(0) || "M";
  const stats = [file.added > 0 ? `+${file.added}` : "", file.removed > 0 ? `-${file.removed}` : ""]
    .filter(Boolean)
    .join(" ");
  return `${status} ${file.path}${stats ? ` (${stats})` : ""}`;
}

export function DiffView() {
  const {
    viewMode,
    setViewMode,
    diffRepoPath,
    setDiffRepoPath,
    launchCwd,
    diffLayout,
    setDiffLayout,
    diffWrap,
    setDiffWrap,
    diffTheme,
    setDiffTheme,
    diffAutoOpen,
    setDiffAutoOpen,
  } = useStore();

  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [branch, setBranch] = useState("");
  const [root, setRoot] = useState("");
  const [activePath, setActivePath] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffLine[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [discarding, setDiscarding] = useState<"file" | "all" | null>(null);
  const [rejectingHunkIndex, setRejectingHunkIndex] = useState<number | null>(null);
  const [copyingMessage, setCopyingMessage] = useState(false);
  const [commitSummary, setCommitSummary] = useState<string | null>(null);
  const [copiedCommitMessage, setCopiedCommitMessage] = useState(false);
  const [checkpoints, setCheckpoints] = useState<GitCheckpointSummary[]>([]);
  const [checkpointMenuOpen, setCheckpointMenuOpen] = useState(false);
  const [checkpointing, setCheckpointing] = useState(false);
  const [restoringCheckpointId, setRestoringCheckpointId] = useState<string | null>(null);

  const diffScrollRef = useRef<HTMLDivElement>(null);
  const diffReqId = useRef(0);

  const highlight = useHighlighter(diffTheme);
  const diffSurface = DIFF_THEME_SURFACES[diffTheme];
  const diffSurfaceStyle = {
    backgroundColor: diffSurface.background,
    color: diffSurface.foreground,
    "--diff-bg": diffSurface.background,
    "--diff-fg": diffSurface.foreground,
    "--diff-muted": diffSurface.muted,
    "--diff-gutter": diffSurface.gutter,
    "--diff-border": diffSurface.border,
  } as CSSProperties;

  // The repo we're reviewing. Defaults to the launch cwd until the user picks one.
  const repoPath = diffRepoPath || launchCwd;

  useEffect(() => {
    setPathInput(repoPath);
  }, [repoPath]);

  const activeFile = useMemo(
    () => files.find((file) => file.path === activePath) ?? null,
    [files, activePath],
  );

  const loadFiles = useCallback(() => {
    if (!repoPath) return;
    setLoadingList(true);
    setError(null);
    fetch(`/api/diff/files?path=${encodeURIComponent(repoPath)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setError(d.error);
          setFiles([]);
          setBranch("");
          setRoot("");
        } else {
          setFiles(d.files || []);
          setBranch(d.branch || "");
          setRoot(d.root || "");
          if (d.root && d.root !== repoPath) {
            setDiffRepoPath(d.root);
          }
          // Keep the active selection if it survived; else auto-focus the first
          // file after the list settles.
          setActivePath((prev) =>
            prev && (d.files || []).some((f: { path: string }) => f.path === prev)
              ? prev
              : null,
          );
        }
      })
      .catch((e) => setError(e.message || "Failed to load diff"))
      .finally(() => setLoadingList(false));
  }, [repoPath]);

  const loadCheckpoints = useCallback(async () => {
    if (!repoPath) return;
    try {
      const res = await fetch(`/api/checkpoints?path=${encodeURIComponent(repoPath)}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        setCheckpoints([]);
        return;
      }
      setCheckpoints(data.checkpoints || []);
    } catch {
      setCheckpoints([]);
    }
  }, [repoPath]);

  // Load the file list whenever the diff view opens or the repo changes.
  useEffect(() => {
    if (viewMode === "diff") {
      loadFiles();
      void loadCheckpoints();
    }
  }, [viewMode, loadFiles, loadCheckpoints]);

  // Auto-focus the most recently edited file once the list loads and nothing
  // is selected, so opening the diff lands on the file that was just changed.
  useEffect(() => {
    if (activePath || files.length === 0) return;
    const newest = files.reduce((a, b) => (b.mtime > a.mtime ? b : a));
    setActivePath(newest.mtime > 0 ? newest.path : files[0]?.path ?? null);
  }, [files, activePath]);

  // Load the selected file's diff.
  useEffect(() => {
    const reviewPath = root || repoPath;
    if (!activePath || !reviewPath) {
      setDiff([]);
      return;
    }
    const id = ++diffReqId.current;
    setLoadingDiff(true);
    const url = `/api/diff/file?path=${encodeURIComponent(reviewPath)}&file=${encodeURIComponent(
      activePath,
    )}${activeFile?.untracked ? "&untracked=1" : ""}`;
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        if (id !== diffReqId.current) return;
        if (d.error) {
          setDiff(parseDiff(`Error: ${d.error}`));
        } else {
          setDiff(parseDiff(d.diff || ""));
          if (diffScrollRef.current) diffScrollRef.current.scrollTop = 0;
        }
      })
      .catch((e) => {
        if (id !== diffReqId.current) return;
        setDiff(parseDiff(`Error: ${e.message}`));
      })
      .finally(() => {
        if (id === diffReqId.current) setLoadingDiff(false);
      });
  }, [activePath, root, repoPath, activeFile]);

  // Keyboard model: once inside the diff view, ↑/↓ and j/k scroll the diff.
  useEffect(() => {
    if (viewMode !== "diff") return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.tagName === "BUTTON")
      ) {
        return;
      }

      const el = diffScrollRef.current;
      if (!el) return;
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        el.scrollTop += 40;
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        el.scrollTop -= 40;
      } else if (e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        el.scrollTop += el.clientHeight * 0.9;
      } else if (e.key === "PageUp") {
        e.preventDefault();
        el.scrollTop -= el.clientHeight * 0.9;
      } else if (e.key === "Escape") {
        e.preventDefault();
        setViewMode("canvas");
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [viewMode, setViewMode]);

  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const f of files) {
      added += f.added;
      removed += f.removed;
    }
    return { added, removed };
  }, [files]);

  if (viewMode !== "diff") return null;

  const applyRepoInput = () => {
    const p = pathInput.trim();
    if (p) setDiffRepoPath(p);
  };

  const selectFile = (path: string) => {
    setActivePath(path || null);
  };

  const discardChanges = async (scope: "file" | "all") => {
    if (scope === "file" && !activePath) return;
    const reviewPath = root || repoPath;
    const target = scope === "all" ? `${files.length} changed file${files.length === 1 ? "" : "s"}` : activePath;
    const confirmed = window.confirm(`Discard changes in ${target}? This cannot be undone.`);
    if (!confirmed) return;

    setDiscarding(scope);
    setError(null);
    try {
      const res = await fetch("/api/diff/discard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: reviewPath,
          scope,
          file: scope === "file" ? activePath : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to discard changes");
      }
      if (scope === "file") {
        setActivePath(null);
        setDiff([]);
      }
      loadFiles();
    } catch (e: any) {
      setError(e.message || "Failed to discard changes");
    } finally {
      setDiscarding(null);
    }
  };

  const discardHunk = async (hunkIndex: number) => {
    if (!activePath || activeFile?.untracked) return;
    const reviewPath = root || repoPath;
    const confirmed = window.confirm(
      `Reject hunk ${hunkIndex + 1} in ${activePath}? This cannot be undone.`,
    );
    if (!confirmed) return;

    setRejectingHunkIndex(hunkIndex);
    setError(null);
    try {
      const res = await fetch("/api/diff/discard-hunk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: reviewPath,
          file: activePath,
          hunkIndex,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to reject hunk");
      }
      loadFiles();
    } catch (e: any) {
      setError(e.message || "Failed to reject hunk");
    } finally {
      setRejectingHunkIndex(null);
    }
  };

  const copyCommitMessage = async () => {
    const reviewPath = root || repoPath;
    if (!reviewPath) return;
    setCopyingMessage(true);
    setCopiedCommitMessage(false);
    setError(null);
    try {
      const res = await fetch(`/api/diff/summary?path=${encodeURIComponent(reviewPath)}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to build commit message");
      }
      if (!data.commitMessage) {
        setCommitSummary("No uncommitted changes");
        return;
      }
      await navigator.clipboard.writeText(data.commitMessage);
      setCommitSummary(data.summary || "Commit message copied");
      setCopiedCommitMessage(true);
      setTimeout(() => setCopiedCommitMessage(false), 1800);
    } catch (e: any) {
      setError(e.message || "Failed to copy commit message");
    } finally {
      setCopyingMessage(false);
    }
  };

  const createCheckpoint = async () => {
    const reviewPath = root || repoPath;
    if (!reviewPath) return;
    setCheckpointing(true);
    setError(null);
    try {
      const res = await fetch("/api/checkpoints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: reviewPath,
          name: `Manual checkpoint ${new Date().toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}`,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to create checkpoint");
      }
      await loadCheckpoints();
      setCheckpointMenuOpen(true);
    } catch (e: any) {
      setError(e.message || "Failed to create checkpoint");
    } finally {
      setCheckpointing(false);
    }
  };

  const restoreCheckpoint = async (checkpoint: GitCheckpointSummary) => {
    const reviewPath = root || repoPath;
    const confirmed = window.confirm(
      `Restore "${checkpoint.name}"? Current uncommitted changes after this checkpoint will be discarded.`,
    );
    if (!confirmed) return;

    setRestoringCheckpointId(checkpoint.id);
    setError(null);
    try {
      const res = await fetch(`/api/checkpoints/${encodeURIComponent(checkpoint.id)}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: reviewPath }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to restore checkpoint");
      }
      setActivePath(null);
      setDiff([]);
      loadFiles();
      await loadCheckpoints();
      setCheckpointMenuOpen(false);
    } catch (e: any) {
      setError(e.message || "Failed to restore checkpoint");
    } finally {
      setRestoringCheckpointId(null);
    }
  };

  const deleteCheckpoint = async (checkpoint: GitCheckpointSummary) => {
    const reviewPath = root || repoPath;
    setError(null);
    try {
      const res = await fetch(
        `/api/checkpoints/${encodeURIComponent(checkpoint.id)}?path=${encodeURIComponent(reviewPath)}`,
        { method: "DELETE" },
      );
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to delete checkpoint");
      }
      await loadCheckpoints();
    } catch (e: any) {
      setError(e.message || "Failed to delete checkpoint");
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-30 bg-canvas flex flex-col"
    >
      {/* Top bar */}
      <div className="flex-shrink-0 h-8 px-3 flex items-center justify-between bg-canvas-dark border-b border-border">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
            Diff
          </span>
          {branch && (
            <span className="flex items-center gap-1 text-[10px] text-zinc-500">
              <GitBranch className="w-3 h-3" />
              {branch}
            </span>
          )}
          {files.length > 0 && (
            <span className="text-[10px] text-zinc-600">
              {files.length} file{files.length !== 1 ? "s" : ""}
              <span className="text-green-500 ml-2">+{totals.added}</span>
              <span className="text-red-400 ml-1">−{totals.removed}</span>
            </span>
          )}
          <div className="relative flex min-w-[220px] max-w-[min(560px,42vw)] flex-1 items-center rounded border border-border bg-canvas">
            <FileDiff className="ml-2 h-3.5 w-3.5 flex-shrink-0 text-zinc-600" />
            <select
              value={activePath || ""}
              onChange={(event) => selectFile(event.target.value)}
              disabled={loadingList || files.length === 0}
              className="h-6 min-w-0 flex-1 appearance-none bg-transparent py-0 pl-2 pr-7 font-mono text-[11px] text-zinc-200 outline-none disabled:text-zinc-600"
              title="Changed file"
            >
              <option value="" disabled>
                {loadingList
                  ? "Loading changed files..."
                  : files.length === 0
                    ? "No changed files"
                    : "Select a changed file"}
              </option>
              {files.map((file) => (
                <option key={file.path} value={file.path}>
                  {formatFileOption(file)}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-zinc-600" />
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          {/* Layout toggle: unified / split */}
          <div className="flex items-center rounded bg-canvas border border-border overflow-hidden">
            <button
              onClick={() => setDiffLayout("unified")}
              className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] transition-colors ${
                diffLayout === "unified"
                  ? "bg-surface-active text-white"
                  : "text-zinc-500 hover:text-white"
              }`}
              title="Unified diff"
            >
              <Rows3 className="w-3 h-3" />
              Unified
            </button>
            <button
              onClick={() => setDiffLayout("split")}
              className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] transition-colors ${
                diffLayout === "split"
                  ? "bg-surface-active text-white"
                  : "text-zinc-500 hover:text-white"
              }`}
              title="Split diff"
            >
              <Columns2 className="w-3 h-3" />
              Split
            </button>
          </div>

          {/* Auto-open toggle */}
          <button
            onClick={() => setDiffAutoOpen(!diffAutoOpen)}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
              diffAutoOpen
                ? "bg-green-500/20 text-green-300 hover:bg-green-500/30"
                : "text-zinc-500 hover:text-white hover:bg-surface-active"
            }`}
            title={
              diffAutoOpen
                ? "Auto-open: on — opens this view when an agent finishes with changes"
                : "Auto-open: off"
            }
          >
            <Sparkles className="w-3 h-3" />
            Auto
          </button>

          {/* Wrap toggle */}
          <button
            onClick={() => setDiffWrap(!diffWrap)}
            className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
              diffWrap
                ? "bg-surface-active text-white"
                : "text-zinc-500 hover:text-white hover:bg-surface-active"
            }`}
            title={diffWrap ? "Line wrapping: on" : "Line wrapping: off"}
          >
            <WrapText className="w-3 h-3" />
          </button>

          {/* Local checkpoints */}
          <div className="relative flex items-center rounded bg-canvas border border-border">
            <button
              onClick={createCheckpoint}
              disabled={checkpointing}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-white hover:bg-surface-active disabled:opacity-40 transition-colors"
              title="Save a local restore point for this repo"
            >
              {checkpointing ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Save className="w-3 h-3" />
              )}
              Save
            </button>
            <button
              onClick={() => {
                setCheckpointMenuOpen((open) => !open);
                setThemeMenuOpen(false);
              }}
              className={`flex items-center gap-1 px-1.5 py-0.5 border-l border-border text-[10px] transition-colors ${
                checkpointMenuOpen
                  ? "bg-surface-active text-white"
                  : "text-zinc-500 hover:text-white hover:bg-surface-active"
              }`}
              title="Restore a saved checkpoint"
            >
              <History className="w-3 h-3" />
              {checkpoints.length}
            </button>
            {checkpointMenuOpen && (
              <div className="absolute right-0 top-7 z-40 w-72 rounded bg-canvas-dark border border-border shadow-xl overflow-hidden">
                <div className="px-2.5 py-2 border-b border-border">
                  <div className="text-[10px] text-zinc-400 font-semibold uppercase tracking-wider">
                    Checkpoints
                  </div>
                </div>
                {checkpoints.length === 0 ? (
                  <div className="px-2.5 py-3 text-[11px] text-zinc-600">
                    No checkpoints saved for this repo.
                  </div>
                ) : (
                  <div className="max-h-72 overflow-y-auto py-1">
                    {checkpoints.map((checkpoint) => (
                      <div
                        key={checkpoint.id}
                        className="px-2.5 py-2 border-b border-border/60 last:border-b-0"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-[11px] text-zinc-200 truncate">
                              {checkpoint.name}
                            </div>
                            <div className="text-[10px] text-zinc-600 mt-0.5">
                              {formatCheckpointTime(checkpoint.createdAt)} · {checkpoint.files.length} file
                              {checkpoint.files.length === 1 ? "" : "s"}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={() => restoreCheckpoint(checkpoint)}
                              disabled={restoringCheckpointId !== null}
                              className="w-6 h-6 rounded flex items-center justify-center text-zinc-500 hover:text-blue-300 hover:bg-blue-500/10 disabled:opacity-40 transition-colors"
                              title="Restore checkpoint"
                            >
                              {restoringCheckpointId === checkpoint.id ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <RotateCcw className="w-3 h-3" />
                              )}
                            </button>
                            <button
                              onClick={() => deleteCheckpoint(checkpoint)}
                              disabled={restoringCheckpointId !== null}
                              className="w-6 h-6 rounded flex items-center justify-center text-zinc-600 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
                              title="Delete checkpoint"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <button
            onClick={() => discardChanges("file")}
            disabled={!activePath || discarding !== null}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-zinc-500 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-40 disabled:hover:text-zinc-500 disabled:hover:bg-transparent transition-colors"
            title="Discard selected file changes"
          >
            {discarding === "file" ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Undo2 className="w-3 h-3" />
            )}
            File
          </button>

          <button
            onClick={() => discardChanges("all")}
            disabled={files.length === 0 || discarding !== null}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-zinc-500 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-40 disabled:hover:text-zinc-500 disabled:hover:bg-transparent transition-colors"
            title="Discard all uncommitted changes in this repo"
          >
            {discarding === "all" ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Trash2 className="w-3 h-3" />
            )}
            All
          </button>

          <button
            onClick={copyCommitMessage}
            disabled={copyingMessage || files.length === 0}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors disabled:opacity-40 ${
              copiedCommitMessage
                ? "bg-green-500/20 text-green-300"
                : "text-zinc-500 hover:text-white hover:bg-surface-active"
            }`}
            title="Generate and copy a commit message from this diff"
          >
            {copyingMessage ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : copiedCommitMessage ? (
              <Check className="w-3 h-3" />
            ) : (
              <Clipboard className="w-3 h-3" />
            )}
            Message
          </button>

          {/* Theme picker */}
          <div className="relative">
            <button
              onClick={() => setThemeMenuOpen((o) => !o)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-zinc-500 hover:text-white hover:bg-surface-active transition-colors"
              title="Code theme"
            >
              <Palette className="w-3 h-3" />
              {THEME_LABELS[diffTheme]}
            </button>
            {themeMenuOpen && (
              <div className="absolute right-0 top-7 z-40 min-w-[140px] rounded bg-canvas-dark border border-border shadow-xl py-1">
                {DIFF_THEMES.map((t) => (
                  <button
                    key={t}
                    onClick={() => {
                      setDiffTheme(t);
                      setThemeMenuOpen(false);
                    }}
                    className={`w-full text-left px-2.5 py-1 text-[11px] transition-colors ${
                      t === diffTheme
                        ? "text-blue-400 bg-surface-active/50"
                        : "text-zinc-400 hover:text-white hover:bg-surface-active/40"
                    }`}
                  >
                    {THEME_LABELS[t]}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Repo path input */}
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-canvas border border-border">
            <FolderGit2 className="w-3 h-3 text-zinc-600 flex-shrink-0" />
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyRepoInput();
              }}
              placeholder="~/repo"
              className="w-40 bg-transparent text-[11px] font-mono text-zinc-300 focus:outline-none"
            />
          </div>
          <button
            onClick={loadFiles}
            className="w-6 h-6 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-surface-active transition-colors"
            title="Refresh diff"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
          <button
            onClick={() => setViewMode("canvas")}
            className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] text-zinc-400 hover:text-white hover:bg-surface-active transition-colors"
            title="Exit diff view (Escape)"
          >
            <Minimize2 className="w-3 h-3" />
            Canvas
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex">
        {/* Diff pane */}
        <div
          className="flex-1 min-w-0 flex flex-col bg-canvas"
        >
          <div className="flex-shrink-0 px-3 py-1.5 flex items-center justify-between border-b border-border">
            <div className="flex items-center gap-2 min-w-0">
              <FileDiff className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
              <span className="text-[12px] text-white font-mono truncate" title={activePath || ""}>
                {activePath || "No file selected"}
              </span>
              {commitSummary && (
                <span className="hidden md:inline text-[10px] text-zinc-600 truncate">
                  {commitSummary}
                </span>
              )}
            </div>
            <span className="hidden md:inline text-[9px] text-zinc-600 font-medium flex-shrink-0">
              ↑↓ scroll · Esc closes
            </span>
          </div>

          <div ref={diffScrollRef} className="flex-1 min-h-0 overflow-auto" style={diffSurfaceStyle}>
            {loadingList && (
              <div className="flex items-center gap-2 px-4 py-3 text-xs text-zinc-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading changed files…
              </div>
            )}
            {!loadingList && error && (
              <div className="px-4 py-4 text-xs text-red-400">{error}</div>
            )}
            {!loadingList && !error && files.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-600">
                <FileDiff className="w-5 h-5" />
                <span className="text-xs">No uncommitted changes</span>
              </div>
            )}
            {loadingDiff && (
              <div className="flex items-center gap-2 px-4 py-3 text-xs text-zinc-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading diff…
              </div>
            )}
            {!loadingList && !error && !loadingDiff && diff.length > 0 && activePath && (
              diffLayout === "split" ? (
                <SplitDiff
                  lines={diff}
                  filePath={activePath}
                  highlight={highlight}
                  wrap={diffWrap}
                  canRejectHunks={!activeFile?.untracked}
                  rejectingHunkIndex={rejectingHunkIndex}
                  onRejectHunk={discardHunk}
                />
              ) : (
                <UnifiedDiff
                  lines={diff}
                  filePath={activePath}
                  highlight={highlight}
                  wrap={diffWrap}
                  canRejectHunks={!activeFile?.untracked}
                  rejectingHunkIndex={rejectingHunkIndex}
                  onRejectHunk={discardHunk}
                />
              )
            )}
            {!loadingList && !error && !loadingDiff && activePath && diff.length === 0 && (
              <div className="px-4 py-6 text-xs text-zinc-600">
                No textual diff (binary file, or no changes against HEAD).
              </div>
            )}
            {!loadingList && !error && !loadingDiff && files.length > 0 && !activePath && (
              <div className="flex flex-col items-center justify-center h-full text-zinc-600 gap-2">
                <FileDiff className="w-5 h-5" />
                <span className="text-xs">Choose a file from the dropdown</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
