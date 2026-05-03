import { useCallback, useState } from "react";
import { NodeProps } from "@xyflow/react";
import { motion } from "framer-motion";
import { Sparkles, Code, Cpu, Zap, Rocket, Bot, Brain, Wand2, FilePlus, Loader2 } from "lucide-react";
import { useStore, AgentStatus } from "../../stores/useStore";
import { AgentNodeCard } from "./AgentNodeCard";
import { AgentNodeContextMenu } from "./AgentNodeContextMenu";
import { useAgentNodeState } from "./useAgentNodeState";

const iconMap: Record<string, any> = {
  sparkles: Sparkles,
  code: Code,
  cpu: Cpu,
  zap: Zap,
  rocket: Rocket,
  bot: Bot,
  brain: Brain,
  wand2: Wand2,
};

interface AgentNodeData {
  label: string;
  agentId: string;
  color: string;
  icon: string;
  sessionId: string;
}

export const AgentNode = ({ id, data, selected }: NodeProps) => {
  const nodeData = data as unknown as AgentNodeData;

  // Subscribe directly to status and currentTool as primitive values - this guarantees re-render on change
  const status: AgentStatus = useStore((state) => state.sessions.get(id)?.status) || "idle";
  const currentTool = useStore((state) => state.sessions.get(id)?.currentTool);

  // Get the full session for other data
  const session = useStore((state) => state.sessions.get(id));

  const {
    contextMenu,
    handleContextMenu,
    handleDelete,
    closeContextMenu,
  } = useAgentNodeState(id, nodeData, session);

  const addFocusedSession = useStore((state) => state.addFocusedSession);
  const setViewMode = useStore((state) => state.setViewMode);
  const focusedSessionIds = useStore((state) => state.focusedSessionIds);

  const handleDoubleClick = useCallback(() => {
    if (!focusedSessionIds.includes(id)) {
      addFocusedSession(id);
    }
    setViewMode("focus");
  }, [id, focusedSessionIds, addFocusedSession, setViewMode]);

  // Drag-and-drop file upload
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [uploadState, setUploadState] = useState<{
    phase: "idle" | "uploading" | "done" | "error";
    message?: string;
  }>({ phase: "idle" });

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!session?.sessionId) return;
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(true);
  }, [session?.sessionId]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDraggingFile(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(false);

    if (!session?.sessionId) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    setUploadState({ phase: "uploading", message: `Uploading ${files.length} file${files.length === 1 ? "" : "s"}...` });

    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file);
      }

      const res = await fetch(`/api/sessions/${session.sessionId}/upload`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setUploadState({ phase: "error", message: err.error || "Upload failed" });
      } else {
        const body = await res.json();
        const skippedCount = Array.isArray(body.skipped) ? body.skipped.length : 0;
        const savedCount = Array.isArray(body.saved) ? body.saved.length : 0;
        const msg = skippedCount > 0
          ? `Added ${savedCount}, skipped ${skippedCount}`
          : `Added ${savedCount} file${savedCount === 1 ? "" : "s"}`;
        setUploadState({ phase: "done", message: msg });
      }
    } catch (err: any) {
      setUploadState({ phase: "error", message: err?.message || "Upload failed" });
    } finally {
      setTimeout(() => setUploadState({ phase: "idle" }), 2500);
    }
  }, [session?.sessionId]);

  const displayColor = session?.customColor || session?.color || nodeData.color || "#22C55E";
  const displayName = session?.customName || session?.agentName || nodeData.label || "Agent";
  const displayIcon = nodeData.icon || "cpu";
  const Icon = iconMap[displayIcon] || Cpu;

  return (
    <>
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onContextMenu={handleContextMenu}
        onDoubleClick={handleDoubleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="relative"
      >
        <AgentNodeCard
          selected={selected}
          displayColor={displayColor}
          displayName={displayName}
          Icon={Icon}
          agentId={nodeData.agentId}
          status={status}
          currentTool={currentTool}
          cwd={session?.cwd}
          originalCwd={session?.originalCwd}
          gitBranch={session?.gitBranch}
          ticketId={session?.ticketId}
          ticketTitle={session?.ticketTitle}
          worktreePaths={session?.worktreePaths}
        />

        {isDraggingFile && (
          <div className="absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-blue-500/15 border-2 border-dashed border-blue-400/70 backdrop-blur-[1px] pointer-events-none">
            <div className="text-center px-2">
              <FilePlus className="w-6 h-6 text-blue-300 mx-auto mb-1" />
              <p className="text-[11px] text-blue-200 font-medium">Drop files to attach</p>
            </div>
          </div>
        )}

        {uploadState.phase !== "idle" && (
          <div
            className={`absolute bottom-1 left-1 right-1 z-20 flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium pointer-events-none ${
              uploadState.phase === "uploading"
                ? "bg-blue-500/20 text-blue-200"
                : uploadState.phase === "done"
                  ? "bg-green-500/20 text-green-200"
                  : "bg-red-500/20 text-red-200"
            }`}
          >
            {uploadState.phase === "uploading" ? (
              <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
            ) : (
              <FilePlus className="w-3 h-3 flex-shrink-0" />
            )}
            <span className="truncate">{uploadState.message}</span>
          </div>
        )}
      </motion.div>

      {contextMenu && (
        <AgentNodeContextMenu
          position={contextMenu}
          onClose={closeContextMenu}
          onDelete={handleDelete}
        />
      )}
    </>
  );
};
