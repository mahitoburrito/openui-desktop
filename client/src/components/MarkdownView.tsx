import { ReactNode, useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Plus,
  Minimize2,
  Columns,
  Rows,
  Grid2X2,
  Square,
  FileText,
} from "lucide-react";
import { useStore } from "../stores/useStore";
import { ResizableSplit } from "./ResizableSplit";
import { MarkdownPane } from "./MarkdownPane";
import { MarkdownFilePicker } from "./MarkdownFilePicker";

type SplitLayout = "auto" | "columns" | "rows" | "grid";

export function MarkdownView() {
  const {
    viewMode,
    setViewMode,
    openMarkdownFiles,
    addMarkdownFile,
    removeMarkdownFile,
  } = useStore();

  const [activePath, setActivePath] = useState<string | null>(null);
  const [layout, setLayout] = useState<SplitLayout>("auto");
  const [pickerOpen, setPickerOpen] = useState(false);

  // Auto-open picker if entering markdown view with no files
  useEffect(() => {
    if (viewMode === "markdown" && openMarkdownFiles.length === 0) {
      setPickerOpen(true);
    }
  }, [viewMode, openMarkdownFiles.length]);

  // Default the active pane to the first file
  useEffect(() => {
    if (openMarkdownFiles.length > 0 && (!activePath || !openMarkdownFiles.includes(activePath))) {
      setActivePath(openMarkdownFiles[0]);
    }
    if (openMarkdownFiles.length === 0) {
      setActivePath(null);
    }
  }, [openMarkdownFiles, activePath]);

  const handleClosePane = useCallback(
    (path: string) => {
      removeMarkdownFile(path);
      if (openMarkdownFiles.length <= 1) {
        // No files left → exit view
        setViewMode("canvas");
      }
    },
    [removeMarkdownFile, openMarkdownFiles.length, setViewMode],
  );

  const handlePickerSelect = (path: string) => {
    addMarkdownFile(path);
    setActivePath(path);
    setPickerOpen(false);
  };

  if (viewMode !== "markdown") return null;

  const count = openMarkdownFiles.length;

  // Pick effective layout. "auto" picks columns up to 3, otherwise grid.
  const effectiveLayout: SplitLayout =
    layout === "auto" ? (count <= 3 ? "columns" : "grid") : layout;

  const renderPane = (path: string): ReactNode => (
    <MarkdownPane
      key={path}
      path={path}
      isActive={activePath === path}
      onClick={() => setActivePath(path)}
      onClose={() => handleClosePane(path)}
    />
  );

  const filesKey = openMarkdownFiles.join(",");
  let body: ReactNode;
  if (count === 0) {
    body = (
      <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-3">
        <FileText className="w-10 h-10 text-zinc-700" />
        <p className="text-sm">No markdown files open</p>
        <button
          onClick={() => setPickerOpen(true)}
          className="px-3 py-1.5 rounded-md bg-white text-canvas text-xs font-medium hover:bg-zinc-100 transition-colors"
        >
          Open File
        </button>
      </div>
    );
  } else if (count === 1) {
    body = renderPane(openMarkdownFiles[0]);
  } else if (effectiveLayout === "rows") {
    body = (
      <ResizableSplit direction="col" storageKey={`md-rows:${filesKey}`}>
        {openMarkdownFiles.map(renderPane)}
      </ResizableSplit>
    );
  } else if (effectiveLayout === "grid") {
    const cols = Math.min(4, Math.ceil(Math.sqrt(count)));
    const rows: string[][] = [];
    for (let i = 0; i < openMarkdownFiles.length; i += cols) {
      rows.push(openMarkdownFiles.slice(i, i + cols));
    }
    body = (
      <ResizableSplit direction="col" storageKey={`md-grid-rows:${filesKey}`}>
        {rows.map((row, rowIdx) =>
          row.length === 1 ? (
            renderPane(row[0])
          ) : (
            <ResizableSplit
              key={rowIdx}
              direction="row"
              storageKey={`md-grid-row-${rowIdx}:${row.join(",")}`}
            >
              {row.map(renderPane)}
            </ResizableSplit>
          ),
        )}
      </ResizableSplit>
    );
  } else {
    body = (
      <ResizableSplit direction="row" storageKey={`md-cols:${filesKey}`}>
        {openMarkdownFiles.map(renderPane)}
      </ResizableSplit>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-30 bg-canvas flex flex-col"
    >
      {/* Top bar */}
      <div className="flex-shrink-0 h-8 px-3 flex items-center justify-between bg-canvas-dark border-b border-border">
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
            Markdown
          </span>
          <span className="text-[10px] text-zinc-600">
            {count} file{count !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {count > 1 && (
            <div className="flex items-center gap-0.5 mr-2 px-1 py-0.5 rounded bg-canvas">
              <button
                onClick={() => setLayout("auto")}
                className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
                  layout === "auto"
                    ? "text-white bg-surface-active"
                    : "text-zinc-600 hover:text-zinc-400"
                }`}
                title="Auto layout"
              >
                <Square className="w-3 h-3" />
              </button>
              <button
                onClick={() => setLayout("columns")}
                className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
                  layout === "columns"
                    ? "text-white bg-surface-active"
                    : "text-zinc-600 hover:text-zinc-400"
                }`}
                title="Side by side"
              >
                <Columns className="w-3 h-3" />
              </button>
              <button
                onClick={() => setLayout("rows")}
                className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
                  layout === "rows"
                    ? "text-white bg-surface-active"
                    : "text-zinc-600 hover:text-zinc-400"
                }`}
                title="Stacked"
              >
                <Rows className="w-3 h-3" />
              </button>
              {count >= 3 && (
                <button
                  onClick={() => setLayout("grid")}
                  className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
                    layout === "grid"
                      ? "text-white bg-surface-active"
                      : "text-zinc-600 hover:text-zinc-400"
                  }`}
                  title="Grid"
                >
                  <Grid2X2 className="w-3 h-3" />
                </button>
              )}
            </div>
          )}

          <button
            onClick={() => setPickerOpen(true)}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-zinc-300 hover:text-white bg-surface-active hover:bg-zinc-700 transition-colors"
            title="Open file (Cmd+O)"
          >
            <Plus className="w-3 h-3" />
            Open
          </button>

          <button
            onClick={() => setViewMode("canvas")}
            className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] text-zinc-400 hover:text-white hover:bg-surface-active transition-colors"
            title="Exit markdown view (Escape)"
          >
            <Minimize2 className="w-3 h-3" />
            Canvas
          </button>
        </div>
      </div>

      {/* Panes */}
      <div className="flex-1 min-h-0 bg-border">{body}</div>

      {pickerOpen && (
        <MarkdownFilePicker
          excludePaths={openMarkdownFiles}
          onSelect={handlePickerSelect}
          onClose={() => {
            setPickerOpen(false);
            // If user closes picker without picking and no files were ever open, bounce back to canvas
            if (openMarkdownFiles.length === 0) setViewMode("canvas");
          }}
        />
      )}
    </motion.div>
  );
}
