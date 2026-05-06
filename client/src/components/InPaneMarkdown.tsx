import { motion } from "framer-motion";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { useStore } from "../stores/useStore";
import { MarkdownPane } from "./MarkdownPane";

interface Props {
  path: string;
  onClose: () => void;
}

// Floating overlay that shows a rendered markdown file inside a terminal pane.
// The terminal stays mounted underneath, so the agent session is uninterrupted.
export function InPaneMarkdown({ path, onClose }: Props) {
  const { addMarkdownFile, setViewMode } = useStore();

  const openInFullViewer = () => {
    addMarkdownFile(path);
    setViewMode("markdown");
    onClose();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.15 }}
      className="absolute inset-0 z-30 flex flex-col bg-canvas border-l-2"
      style={{ borderLeftColor: "#8b5cf6" }}
    >
      {/* Sticky overlay toolbar — sits above MarkdownPane's own header */}
      <div className="flex-shrink-0 px-2 py-1.5 flex items-center justify-between bg-canvas-dark border-b border-border">
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] text-zinc-300 hover:text-white hover:bg-surface-active transition-colors"
          title="Back to terminal"
        >
          <ArrowLeft className="w-3 h-3" />
          Back to terminal
        </button>
        <button
          onClick={openInFullViewer}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-zinc-400 hover:text-white hover:bg-surface-active transition-colors"
          title="Open in full markdown viewer"
        >
          <ExternalLink className="w-3 h-3" />
          Full viewer
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <MarkdownPane path={path} isActive onClose={onClose} />
      </div>
    </motion.div>
  );
}
