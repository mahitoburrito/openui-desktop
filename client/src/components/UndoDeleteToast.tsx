import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Undo2, X } from "lucide-react";
import { useStore } from "../stores/useStore";

export function UndoDeleteToast() {
  const { deleteToast, setDeleteToast, addSession, addNode, sessions } = useStore();
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    if (!deleteToast) {
      setProgress(100);
      return;
    }

    const start = Date.now();
    const duration = 5000;

    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, 100 - (elapsed / duration) * 100);
      setProgress(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 50);

    return () => clearInterval(interval);
  }, [deleteToast]);

  const handleUndo = async () => {
    if (!deleteToast) return;

    // Cancel the auto-dismiss timeout
    clearTimeout(deleteToast.timeout);

    // Tell server to undo the soft-delete
    await fetch(`/api/sessions/${deleteToast.sessionId}/undo-delete`, { method: "POST" });

    // Dismiss toast
    setDeleteToast(null);

    // Reload the page to restore the session and node from server state
    // (simplest approach — the session still exists server-side)
    window.location.reload();
  };

  const handleDismiss = () => {
    if (deleteToast) {
      clearTimeout(deleteToast.timeout);
    }
    setDeleteToast(null);
  };

  return (
    <AnimatePresence>
      {deleteToast && (
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-4 py-3 rounded-lg bg-zinc-800 border border-zinc-700 shadow-2xl"
        >
          {/* Progress bar */}
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-zinc-700 rounded-b-lg overflow-hidden">
            <div
              className="h-full bg-orange-500 transition-all duration-100 ease-linear"
              style={{ width: `${progress}%` }}
            />
          </div>

          <span className="text-sm text-zinc-300">
            Deleted <span className="font-medium text-white">"{deleteToast.sessionName}"</span>
          </span>

          <button
            onClick={handleUndo}
            className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-white text-zinc-900 text-sm font-medium hover:bg-zinc-100 transition-colors"
          >
            <Undo2 className="w-3.5 h-3.5" />
            Undo
          </button>

          <button
            onClick={handleDismiss}
            className="p-1 text-zinc-500 hover:text-white transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
