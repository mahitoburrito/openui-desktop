import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { X, FileText, Search, FolderOpen, Loader2 } from "lucide-react";

interface MarkdownFile {
  name: string;
  path: string;
  size: number;
  modified: number;
}

interface Props {
  initialPath?: string;
  excludePaths?: string[];
  onSelect: (path: string) => void;
  onClose: () => void;
}

function formatTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function MarkdownFilePicker({ initialPath, excludePaths = [], onSelect, onClose }: Props) {
  const [path, setPath] = useState(initialPath || "");
  const [pathInput, setPathInput] = useState(initialPath || "");
  const [files, setFiles] = useState<MarkdownFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!initialPath) {
      // Fetch launch cwd as default
      fetch("/api/config")
        .then((r) => r.json())
        .then((c) => {
          setPath(c.launchCwd || "");
          setPathInput(c.launchCwd || "");
        })
        .catch(() => {});
    }
  }, [initialPath]);

  useEffect(() => {
    if (!path) return;
    setLoading(true);
    setError(null);
    fetch(`/api/files/list?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
          setFiles([]);
        } else {
          setFiles(data.files || []);
        }
      })
      .catch((e) => setError(e.message || "Failed to load files"))
      .finally(() => setLoading(false));
  }, [path]);

  const filtered = useMemo(() => {
    const excluded = new Set(excludePaths);
    const q = query.trim().toLowerCase();
    return files.filter((f) => {
      if (excluded.has(f.path)) return false;
      if (!q) return true;
      return (
        f.name.toLowerCase().includes(q) ||
        f.path.toLowerCase().includes(q)
      );
    });
  }, [files, query, excludePaths]);

  const handleBrowse = () => {
    setPath(pathInput);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
        className="bg-canvas-dark border border-border rounded-xl w-[640px] max-w-[90vw] h-[560px] max-h-[85vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex-shrink-0 px-4 py-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-zinc-400" />
            <h2 className="text-sm font-medium text-white">Open Markdown File</h2>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-surface-active transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Path bar */}
        <div className="flex-shrink-0 px-4 py-3 border-b border-border">
          <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Search Folder</label>
          <div className="mt-1.5 flex items-center gap-2">
            <FolderOpen className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleBrowse();
              }}
              placeholder="~/projects"
              className="flex-1 px-2 py-1.5 rounded-md bg-canvas border border-border text-white text-xs font-mono focus:outline-none focus:border-zinc-500 transition-colors"
            />
            <button
              onClick={handleBrowse}
              className="px-3 py-1.5 rounded-md bg-surface-active text-zinc-300 text-xs hover:bg-zinc-700 transition-colors"
            >
              Scan
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="flex-shrink-0 px-4 py-2 border-b border-border">
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-canvas border border-border">
            <Search className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name…"
              className="flex-1 bg-transparent text-white text-xs focus:outline-none"
            />
            {filtered.length !== files.length && (
              <span className="text-[10px] text-zinc-500">
                {filtered.length}/{files.length}
              </span>
            )}
          </div>
        </div>

        {/* File list */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center h-full text-zinc-500 text-xs gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Scanning…
            </div>
          )}
          {!loading && error && (
            <div className="flex items-center justify-center h-full text-red-400 text-xs px-4 text-center">
              {error}
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div className="flex items-center justify-center h-full text-zinc-500 text-xs">
              {files.length === 0 ? "No markdown files found" : "No matches"}
            </div>
          )}
          {!loading && filtered.map((f) => (
            <button
              key={f.path}
              onClick={() => onSelect(f.path)}
              className="w-full px-4 py-2.5 flex items-start gap-3 hover:bg-surface-active transition-colors text-left border-b border-border/50 group"
            >
              <FileText className="w-4 h-4 text-zinc-500 group-hover:text-white flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white truncate">{f.name}</div>
                <div className="text-[10px] text-zinc-500 font-mono truncate mt-0.5">
                  {f.path.replace(path, "").replace(/^\//, "") || f.path}
                </div>
              </div>
              <div className="flex-shrink-0 text-right">
                <div className="text-[10px] text-zinc-500">{formatTime(f.modified)}</div>
                <div className="text-[10px] text-zinc-600 mt-0.5">{formatSize(f.size)}</div>
              </div>
            </button>
          ))}
        </div>

        <div className="flex-shrink-0 px-4 py-2 border-t border-border text-[10px] text-zinc-600">
          Searches up to 4 levels deep · skips node_modules, .git, dist
        </div>
      </motion.div>
    </motion.div>
  );
}
