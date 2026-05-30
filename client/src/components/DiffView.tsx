import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Minimize2,
  RefreshCw,
  GitBranch,
  FolderGit2,
  FileDiff,
  Loader2,
  ChevronRight,
  Columns2,
  Rows3,
  WrapText,
  Palette,
  Sparkles,
} from "lucide-react";
import { DIFF_THEMES, useStore, type DiffTheme } from "../stores/useStore";
import {
  buildFileTree,
  flattenFiles,
  parseDiff,
  type ChangedFile,
  type DiffLine,
} from "./diff/diffModel";
import { FileTree } from "./diff/FileTree";
import { UnifiedDiff, SplitDiff } from "./diff/DiffBody";
import { useHighlighter } from "./diff/useHighlighter";

// Which pane currently owns the keyboard. Tab toggles between them so ↑/↓ are
// unambiguous: they walk the file tree when it's focused, scroll the diff when
// the diff is focused.
type Focus = "tree" | "diff";

const THEME_LABELS: Record<DiffTheme, string> = {
  "github-dark": "GitHub Dark",
  "github-light": "GitHub Light",
  "one-dark-pro": "One Dark Pro",
  dracula: "Dracula",
  nord: "Nord",
  "vitesse-dark": "Vitesse Dark",
};

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
  const [focus, setFocus] = useState<Focus>("tree");
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);

  const diffScrollRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const diffReqId = useRef(0);

  const highlight = useHighlighter(diffTheme);

  // The repo we're reviewing. Defaults to the launch cwd until the user picks one.
  const repoPath = diffRepoPath || launchCwd;

  useEffect(() => {
    setPathInput(repoPath);
  }, [repoPath]);

  // Display tree (with collapsed single-child dirs) and the flattened file list
  // in display order — the latter drives keyboard up/down navigation.
  const tree = useMemo(() => buildFileTree(files), [files]);
  const orderedFiles = useMemo(() => flattenFiles(tree), [tree]);

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
          // Keep the active selection if it survived; else auto-focus the first
          // file in display order (OpenCode behavior).
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

  // Load the file list whenever the diff view opens or the repo changes.
  useEffect(() => {
    if (viewMode === "diff") loadFiles();
  }, [viewMode, loadFiles]);

  // Auto-focus the first file once the tree is built and nothing is selected.
  useEffect(() => {
    if (!activePath && orderedFiles.length > 0) {
      setActivePath(orderedFiles[0].path);
    }
  }, [orderedFiles, activePath]);

  // Load the selected file's diff.
  useEffect(() => {
    if (!activePath || !root) {
      setDiff([]);
      return;
    }
    const file = files.find((f) => f.path === activePath);
    const id = ++diffReqId.current;
    setLoadingDiff(true);
    const url = `/api/diff/file?path=${encodeURIComponent(repoPath)}&file=${encodeURIComponent(
      activePath,
    )}${file?.untracked ? "&untracked=1" : ""}`;
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
  }, [activePath, root, repoPath, files]);

  const moveSelection = useCallback(
    (delta: number) => {
      if (orderedFiles.length === 0) return;
      const idx = orderedFiles.findIndex((f) => f.path === activePath);
      const next = Math.max(0, Math.min(orderedFiles.length - 1, idx + delta));
      setActivePath(orderedFiles[next].path);
    },
    [orderedFiles, activePath],
  );

  // Keyboard model. Tab toggles focus between tree and diff; ↑/↓ navigate the
  // focused pane.
  useEffect(() => {
    if (viewMode !== "diff") return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"))
        return;

      if (e.key === "Tab") {
        e.preventDefault();
        setFocus((f) => (f === "tree" ? "diff" : "tree"));
        return;
      }

      if (focus === "tree") {
        if (e.key === "ArrowDown" || e.key === "j") {
          e.preventDefault();
          moveSelection(1);
        } else if (e.key === "ArrowUp" || e.key === "k") {
          e.preventDefault();
          moveSelection(-1);
        }
      } else {
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
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [viewMode, focus, moveSelection]);

  // Keep the selected file visible in the tree as you arrow through it.
  useEffect(() => {
    if (focus !== "tree" || !activePath || !treeRef.current) return;
    const el = treeRef.current.querySelector(`[data-path="${CSS.escape(activePath)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activePath, focus]);

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
    setActivePath(path);
    setFocus("tree");
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
        <div className="flex items-center gap-3 min-w-0">
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
        </div>

        <div className="flex items-center gap-2">
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

      {/* Body: file tree + diff pane */}
      <div className="flex-1 min-h-0 flex">
        {/* File tree */}
        <div
          ref={treeRef}
          onClick={() => setFocus("tree")}
          className="w-72 flex-shrink-0 overflow-y-auto bg-canvas-dark border-r transition-colors"
          style={{
            borderRightColor: focus === "tree" ? "#3b82f6" : "#2a2a2a",
          }}
        >
          <div className="px-2 py-1.5 flex items-center justify-between border-b border-border sticky top-0 bg-canvas-dark z-10">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
              Changed files
            </span>
            {focus === "tree" && (
              <span className="text-[9px] text-blue-400 font-medium">FOCUSED · Tab ⇄</span>
            )}
          </div>

          {loadingList && (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-zinc-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
            </div>
          )}
          {!loadingList && error && (
            <div className="px-3 py-3 text-xs text-red-400">{error}</div>
          )}
          {!loadingList && !error && files.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-zinc-600">
              No uncommitted changes
            </div>
          )}
          {!loadingList && files.length > 0 && (
            <FileTree tree={tree} activePath={activePath} onSelect={selectFile} />
          )}
        </div>

        {/* Diff pane */}
        <div
          onClick={() => setFocus("diff")}
          className="flex-1 min-w-0 flex flex-col bg-canvas"
        >
          <div className="flex-shrink-0 px-3 py-1.5 flex items-center justify-between border-b border-border">
            <div className="flex items-center gap-2 min-w-0">
              <FileDiff className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
              <span className="text-[12px] text-white font-mono truncate" title={activePath || ""}>
                {activePath || "No file selected"}
              </span>
            </div>
            {focus === "diff" && (
              <span className="text-[9px] text-blue-400 font-medium flex-shrink-0">
                FOCUSED · ↑↓ scroll · Tab ⇄
              </span>
            )}
          </div>

          <div ref={diffScrollRef} className="flex-1 min-h-0 overflow-auto">
            {loadingDiff && (
              <div className="flex items-center gap-2 px-4 py-3 text-xs text-zinc-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading diff…
              </div>
            )}
            {!loadingDiff && diff.length > 0 && activePath && (
              diffLayout === "split" ? (
                <SplitDiff lines={diff} filePath={activePath} highlight={highlight} wrap={diffWrap} />
              ) : (
                <UnifiedDiff lines={diff} filePath={activePath} highlight={highlight} wrap={diffWrap} />
              )
            )}
            {!loadingDiff && activePath && diff.length === 0 && (
              <div className="px-4 py-6 text-xs text-zinc-600">
                No textual diff (binary file, or no changes against HEAD).
              </div>
            )}
            {!loadingDiff && !activePath && (
              <div className="flex flex-col items-center justify-center h-full text-zinc-600 gap-2">
                <ChevronRight className="w-5 h-5" />
                <span className="text-xs">Select a file to view its diff</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
