import { useCallback, useState } from "react";
import { NodeProps } from "@xyflow/react";
import { motion } from "framer-motion";
import { useStore, AgentStatus } from "../../stores/useStore";
import { AgentNodeCard } from "./AgentNodeCard";
import { AgentNodeContextMenu } from "./AgentNodeContextMenu";
import { useAgentNodeState } from "./useAgentNodeState";
import { getAgentAccentColor } from "../AgentIcon";
import { Codicon } from "../Codicon";

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

  const openSessionInFocus = useStore((state) => state.openSessionInFocus);
  const setViewMode = useStore((state) => state.setViewMode);
  const setDiffRepoPath = useStore((state) => state.setDiffRepoPath);
  const [isRestoringCheckpoint, setIsRestoringCheckpoint] = useState(false);
  const displayColor = getAgentAccentColor(
    session?.agentId || nodeData.agentId,
    session?.customColor || session?.color || nodeData.color,
  );
  const displayName = session?.customName || session?.agentName || nodeData.label || "Agent";

  const handleDoubleClick = useCallback(() => {
    openSessionInFocus(id);
  }, [id, openSessionInFocus]);

  const handleRestoreLaunchCheckpoint = useCallback(async () => {
    const checkpoint = session?.launchCheckpoint;
    if (!checkpoint || isRestoringCheckpoint) return;

    const confirmed = window.confirm(
      `Restore ${displayName} to its start checkpoint? Current uncommitted changes in that repo will be discarded.`,
    );
    if (!confirmed) return;

    setIsRestoringCheckpoint(true);
    try {
      const res = await fetch(`/api/checkpoints/${encodeURIComponent(checkpoint.id)}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: checkpoint.repoRoot || session?.cwd }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to restore checkpoint");
      }
      setDiffRepoPath(checkpoint.repoRoot || session?.cwd || null);
      setViewMode("diff");
    } catch (error: any) {
      window.alert(error?.message || "Failed to restore checkpoint");
    } finally {
      setIsRestoringCheckpoint(false);
    }
  }, [displayName, isRestoringCheckpoint, session?.cwd, session?.launchCheckpoint, setDiffRepoPath, setViewMode]);

  const handleReviewChanges = useCallback(() => {
    const repo = session?.changeSummary?.repoRoot || session?.cwd;
    if (!repo) return;
    setDiffRepoPath(repo);
    setViewMode("diff");
  }, [session?.changeSummary?.repoRoot, session?.cwd, setDiffRepoPath, setViewMode]);

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
          agentId={nodeData.agentId}
          status={status}
          currentTool={currentTool}
          createdAt={session?.createdAt}
          cwd={session?.cwd}
          originalCwd={session?.originalCwd}
          gitBranch={session?.gitBranch}
          ticketId={session?.ticketId}
          ticketTitle={session?.ticketTitle}
          worktreePaths={session?.worktreePaths}
          launchCheckpoint={session?.launchCheckpoint}
          changeSummary={session?.changeSummary}
          isRestoringCheckpoint={isRestoringCheckpoint}
          onRestoreLaunchCheckpoint={handleRestoreLaunchCheckpoint}
          onReviewChanges={handleReviewChanges}
        />

        {isDraggingFile && (
          <div className="absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-blue-500/15 border-2 border-dashed border-blue-400/70 backdrop-blur-[1px] pointer-events-none">
            <div className="px-2 text-center">
              <Codicon name="cloud-upload" size={22} className="mb-1 text-blue-300" />
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
              <Codicon name="loading" size={12} className="codicon-modifier-spin flex-shrink-0" />
            ) : (
              <Codicon name="cloud-upload" size={12} className="flex-shrink-0" />
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
