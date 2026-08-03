import { GitBranch, Folder, Wrench, Layers, Loader2, RotateCcw, FileDiff } from "lucide-react";
import { AgentStatus, type AgentChangeSummary, type CheckpointSummary } from "../../stores/useStore";
import { AgentIcon } from "../AgentIcon";

// Status config with visual priority levels
const statusConfig: Record<AgentStatus, { label: string; color: string; bgColor: string; isActive?: boolean; needsAttention?: boolean }> = {
  creating: { label: "Starting", color: "#8B93FF", bgColor: "#8B93FF12", isActive: true },
  running: { label: "Working", color: "#79C68B", bgColor: "#79C68B12", isActive: true },
  tool_calling: { label: "Working", color: "#79C68B", bgColor: "#79C68B12", isActive: true },
  waiting_input: { label: "Needs input", color: "#D6A64B", bgColor: "#D6A64B14", needsAttention: true },
  idle: { label: "Idle", color: "#8A8F98", bgColor: "#8A8F9812" },
  disconnected: { label: "Offline", color: "#6B7280", bgColor: "#6B728015" },
  error: { label: "Error", color: "#E06464", bgColor: "#E0646414", needsAttention: true },
};

// Tool name display mapping
const toolDisplayNames: Record<string, string> = {
  Read: "Reading",
  Write: "Writing",
  Edit: "Editing",
  Bash: "Running",
  Grep: "Searching",
  Glob: "Finding",
  Task: "Tasking",
  WebFetch: "Fetching",
  WebSearch: "Searching",
  TodoWrite: "Planning",
  AskUserQuestion: "Asking",
};

interface AgentNodeCardProps {
  selected: boolean;
  displayColor: string;
  displayName: string;
  agentId: string;
  status: AgentStatus;
  currentTool?: string;
  cwd?: string;
  originalCwd?: string; // Mother repo path when using worktrees
  gitBranch?: string;
  ticketId?: string;
  ticketTitle?: string;
  worktreePaths?: Record<string, string>;
  launchCheckpoint?: CheckpointSummary;
  changeSummary?: AgentChangeSummary;
  isRestoringCheckpoint?: boolean;
  onRestoreLaunchCheckpoint?: () => void;
  onReviewChanges?: () => void;
}

export function AgentNodeCard({
  selected,
  displayColor,
  displayName,
  agentId,
  status,
  currentTool,
  cwd,
  originalCwd,
  gitBranch,
  ticketId,
  ticketTitle,
  worktreePaths,
  launchCheckpoint,
  changeSummary,
  isRestoringCheckpoint = false,
  onRestoreLaunchCheckpoint,
  onReviewChanges,
}: AgentNodeCardProps) {
  const statusInfo = statusConfig[status] || statusConfig.idle;
  const isActive = statusInfo.isActive;
  const isToolCalling = status === "tool_calling";
  const needsAttention = statusInfo.needsAttention;

  // Extract directory name - use originalCwd (mother repo) if available, otherwise cwd
  const displayCwd = originalCwd || cwd;
  const dirName = displayCwd ? displayCwd.split("/").pop() || displayCwd : null;

  // Get display name for current tool
  const toolDisplay = currentTool ? (toolDisplayNames[currentTool] || currentTool) : null;
  const changedFileCount = changeSummary?.changedFileCount ?? 0;

  return (
    <div
      className={`relative w-[220px] rounded-lg border transition-colors duration-150 cursor-pointer ${
        selected ? "ring-1 ring-zinc-200/25" : ""
      }`}
      style={{
        backgroundColor: "#171818",
        borderColor: needsAttention
          ? `${statusInfo.color}99`
          : selected
            ? "#52525b"
            : isActive
              ? `${statusInfo.color}4d`
              : "#2a2d2c",
        boxShadow: selected ? "0 8px 22px rgba(0, 0, 0, 0.35)" : "0 2px 8px rgba(0, 0, 0, 0.26)",
      }}
    >
      <div className="p-3">
        <div className="flex items-start gap-2.5">
          <div
            className="relative w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: `${displayColor}18` }}
          >
            <AgentIcon agentId={agentId} className="h-[18px] w-[18px]" style={{ color: displayColor }} />
            <span
              className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border border-canvas-dark"
              style={{ backgroundColor: displayColor }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <h3 className="min-w-0 truncate text-sm font-medium leading-tight text-zinc-100">
                {displayName}
              </h3>
              <span className="flex flex-shrink-0 items-center gap-1 text-[10px]" style={{ color: statusInfo.color }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: statusInfo.color }} />
                {statusInfo.label}
              </span>
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-zinc-500">
              {status === "creating" && <Loader2 className="w-3 h-3 animate-spin" style={{ color: statusInfo.color }} />}
              {isToolCalling && toolDisplay ? (
                <>
                  <Wrench className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{toolDisplay}</span>
                </>
              ) : (
                <span className="truncate">{agentId}</span>
              )}
            </div>
          </div>
        </div>

        {/* Ticket info */}
        {ticketId && (
          <div className="mt-2.5 rounded-md border border-zinc-700/70 bg-zinc-900/45 px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono font-semibold text-zinc-300">{ticketId}</span>
            </div>
            {ticketTitle && (
              <p className="text-[10px] text-zinc-500 truncate mt-0.5">{ticketTitle}</p>
            )}
          </div>
        )}

        {/* Repo & Branch */}
        {(dirName || gitBranch || (worktreePaths && Object.keys(worktreePaths).length > 1)) && (
          <div className="mt-2 flex min-w-0 items-center gap-2 text-[10px] text-zinc-500">
            {dirName && (
              <div className="flex min-w-0 items-center gap-1">
                <Folder className="w-3 h-3 flex-shrink-0" />
                <span className="font-mono truncate">{dirName}</span>
              </div>
            )}
            {gitBranch && (
              <div className="flex min-w-0 items-center gap-1">
                <GitBranch className="w-3 h-3 flex-shrink-0" />
                <span className="font-mono truncate">{gitBranch}</span>
              </div>
            )}
            {worktreePaths && Object.keys(worktreePaths).length > 1 && (
              <div className="flex flex-shrink-0 items-center gap-1" title={Object.entries(worktreePaths).map(([n, p]) => `${n}: ${p}`).join('\n')}>
                <Layers className="w-3 h-3 flex-shrink-0" />
                <span>{Object.keys(worktreePaths).length} repos</span>
              </div>
            )}
          </div>
        )}

        {(changedFileCount > 0 || launchCheckpoint) && (
          <div className="mt-2 flex items-center gap-1.5">
            {changedFileCount > 0 && changeSummary && onReviewChanges && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onReviewChanges();
                }}
                className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-zinc-700/80 bg-zinc-900/45 px-2 py-1.5 text-left text-[10px] text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-800"
                title={changeSummary.files.map((file) => file.path).join("\n")}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <FileDiff className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{changedFileCount} changed</span>
                </span>
                <span className="flex flex-shrink-0 items-center gap-1 font-mono text-zinc-500">
                  +{changeSummary.added}/-{changeSummary.removed}
                </span>
              </button>
            )}

            {launchCheckpoint && onRestoreLaunchCheckpoint && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRestoreLaunchCheckpoint();
                }}
                disabled={isRestoringCheckpoint}
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-zinc-700/80 bg-zinc-900/45 text-zinc-500 transition-colors hover:border-zinc-500 hover:text-zinc-200 disabled:opacity-50"
                title="Restore the repo to the checkpoint saved before this session started"
              >
                {isRestoringCheckpoint ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RotateCcw className="w-3 h-3" />
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
