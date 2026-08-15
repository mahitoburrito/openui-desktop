import { Loader2, RotateCcw, FileDiff, ArrowRight } from "lucide-react";
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
  ticketId,
  ticketTitle,
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

  // Get display name for current tool
  const toolDisplay = currentTool ? (toolDisplayNames[currentTool] || currentTool) : null;
  const changedFileCount = changeSummary?.changedFileCount ?? 0;

  return (
    <div
      className={`group relative w-[220px] rounded-lg border transition-all duration-150 cursor-pointer hover:-translate-y-0.5 ${
        selected ? "ring-1 ring-zinc-200/25" : ""
      }`}
      style={{
        backgroundColor: "oklch(17.6% 0.008 255)",
        borderColor: needsAttention
          ? `${statusInfo.color}99`
          : selected
            ? "oklch(42% 0.012 255)"
            : isActive
              ? `${statusInfo.color}4d`
              : "oklch(30% 0.008 255 / 0.45)",
        boxShadow: selected ? "0 8px 22px rgba(0, 0, 0, 0.3)" : "0 8px 24px rgba(0, 0, 0, 0.12)",
      }}
    >
      <ArrowRight className="pointer-events-none absolute bottom-2.5 right-2.5 h-3.5 w-3.5 text-accent opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
      <div className="p-3">
        <div className="flex items-start gap-2.5">
          <div
            className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: `${displayColor}16` }}
          >
            <AgentIcon agentId={agentId} className="h-4 w-4" style={{ color: displayColor }} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="min-w-0 pr-5 text-xs font-medium leading-snug text-zinc-100 line-clamp-2">
              {displayName}
            </h3>
            <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[10px] text-zinc-500">
              {status === "creating" && (
                <Loader2 className="w-3 h-3 animate-spin" style={{ color: statusInfo.color }} />
              )}
              <span
                className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                style={{ backgroundColor: statusInfo.color }}
              />
              <span className="truncate">
                {statusInfo.label}
                {isToolCalling && toolDisplay ? ` · ${toolDisplay}` : ""}
              </span>
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
