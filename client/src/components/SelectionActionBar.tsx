import { motion, AnimatePresence } from "framer-motion";
import { BoxSelect, Maximize2, Trash2, X } from "lucide-react";
import { useStoreApi } from "@xyflow/react";
import { useStore } from "../stores/useStore";
import { bulkDeleteSessions } from "../utils/bulkDeleteSessions";

// Floating bar shown while selection mode is active — count, select all,
// open-in-focus, bulk delete, and exit. Hidden while the undo toast is up
// since both live at bottom-center.
export function SelectionActionBar() {
  const {
    selectionModeActive,
    setSelectionModeActive,
    multiSelectedNodeIds,
    nodes,
    sessions,
    setFocusedSessions,
    setViewMode,
    setSidebarOpen,
    viewMode,
    deleteToast,
  } = useStore();

  const rfStore = useStoreApi();
  const count = multiSelectedNodeIds.length;
  const totalAgents = nodes.filter((n) => n.type === "agent").length;
  const show = selectionModeActive && viewMode === "canvas" && !deleteToast;

  // Selection goes through React Flow's API so its internal selection state
  // stays in sync — prop-level selected flags alone diverge from it.
  const selectAll = () =>
    rfStore
      .getState()
      .addSelectedNodes(nodes.filter((n) => n.type === "agent").map((n) => n.id));

  const clearSelection = () => rfStore.getState().unselectNodesAndEdges();

  const openInFocusMode = () => {
    const ids = multiSelectedNodeIds.filter((id) => sessions.has(id));
    if (ids.length === 0) return;
    setFocusedSessions(ids);
    setSelectionModeActive(false);
    setSidebarOpen(false);
    setViewMode("focus");
  };

  const textButton =
    "rounded-md px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-active hover:text-white";

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className="fixed bottom-6 left-1/2 z-[90] flex -translate-x-1/2 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 shadow-2xl"
        >
          {count === 0 ? (
            <span className="px-1 text-xs text-zinc-400">
              Click sessions or drag a box to select
            </span>
          ) : (
            <>
              <span className="px-1 text-xs text-zinc-300">
                <span className="font-semibold text-white">{count}</span> selected
              </span>
              <div className="h-4 w-px bg-zinc-700" />
              {count < totalAgents && (
                <button type="button" onClick={selectAll} className={textButton}>
                  Select all
                </button>
              )}
              <button type="button" onClick={clearSelection} className={textButton}>
                Clear
              </button>
              <button
                type="button"
                onClick={openInFocusMode}
                className={`${textButton} flex items-center gap-1.5`}
                title="Open selected sessions in focus mode"
              >
                <Maximize2 className="h-3.5 w-3.5" />
                Focus
              </button>
              <button
                type="button"
                onClick={() => void bulkDeleteSessions(multiSelectedNodeIds)}
                className="flex items-center gap-1.5 rounded-md bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/25 hover:text-red-200"
                title={`Delete ${count} session${count === 1 ? "" : "s"}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            </>
          )}
          <div className="h-4 w-px bg-zinc-700" />
          {count === 0 && totalAgents > 0 && (
            <button
              type="button"
              onClick={selectAll}
              className={`${textButton} flex items-center gap-1.5`}
              title="Select all sessions (Cmd+A)"
            >
              <BoxSelect className="h-3.5 w-3.5" />
              Select all
            </button>
          )}
          <button
            type="button"
            onClick={() => setSelectionModeActive(false)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-surface-active hover:text-white"
            title="Exit selection mode (Esc)"
            aria-label="Exit selection mode"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
