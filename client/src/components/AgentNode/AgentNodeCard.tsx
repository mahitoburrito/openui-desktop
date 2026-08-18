import { AgentStatus, type AgentChangeSummary, type CheckpointSummary } from "../../stores/useStore";
import { AgentIcon } from "../AgentIcon";
import { Codicon } from "../Codicon";

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
  createdAt?: string;
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
  createdAt,
  cwd,
  originalCwd,
  gitBranch,
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
  const directory = (originalCwd || cwd || "")
    .split("/")
    .filter(Boolean)
    .pop();
  const locationLabel = [directory, gitBranch].filter(Boolean).join(" · ");
  const age = formatAge(createdAt);

  return (
    <div
      className={`agent-node-card group relative w-[224px] cursor-pointer overflow-hidden rounded-[9px] border transition-[transform,border-color,box-shadow,background-color] duration-150 hover:-translate-y-px ${
        selected ? "is-selected" : ""
      }`}
      style={{
        borderColor: needsAttention
          ? `${statusInfo.color}78`
          : selected
            ? "oklch(61% 0.025 255 / 0.68)"
            : isActive
              ? `${statusInfo.color}3d`
              : undefined,
      }}
    >
      <div className="px-3 py-2.5">
        <div className="flex min-h-10 items-start gap-2.5">
          <div
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-white/[0.045]"
            style={{ backgroundColor: `${displayColor}12` }}
          >
            <AgentIcon agentId={agentId} className="h-4 w-4" style={{ color: displayColor }} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="line-clamp-2 min-w-0 text-[12px] font-medium leading-[1.35] tracking-[-0.01em] text-zinc-100">
              {displayName}
            </h3>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[9.5px] text-zinc-500">
              {status === "creating" && (
                <Codicon name="loading" size={11} className="codicon-modifier-spin" />
              )}
              {status !== "creating" && (
                <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
                  {isActive && (
                    <span
                      className="absolute inset-0 rounded-full opacity-40 motion-safe:animate-ping"
                      style={{ backgroundColor: statusInfo.color, animationDuration: "1.8s" }}
                    />
                  )}
                  <span
                    className="relative h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: statusInfo.color }}
                  />
                </span>
              )}
              <span className="min-w-0 truncate">
                {statusInfo.label}
                {isToolCalling && toolDisplay ? ` · ${toolDisplay}` : ""}
              </span>
              {(locationLabel || age) && <span className="text-zinc-700">·</span>}
              {locationLabel && (
                <span className="max-w-[96px] truncate" title={[originalCwd || cwd, gitBranch].filter(Boolean).join(" · ")}>
                  {locationLabel}
                </span>
              )}
              {age && <span className="ml-auto flex-shrink-0 text-zinc-600">{age}</span>}
            </div>
          </div>
        </div>

        {ticketId && (
          <div className="mt-2 flex min-w-0 items-center gap-1.5 border-t border-white/[0.045] pt-2 text-[9px] text-zinc-600">
            <Codicon name="issues" size={11} />
            <span className="flex-shrink-0 font-mono text-zinc-500">{ticketId}</span>
            {ticketTitle && <span className="truncate">{ticketTitle}</span>}
          </div>
        )}

        {(changedFileCount > 0 || launchCheckpoint) && (
          <div className="mt-2 flex items-center gap-1.5 border-t border-white/[0.045] pt-2">
            {changedFileCount > 0 && changeSummary && onReviewChanges && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onReviewChanges();
                }}
                className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-[9px] text-zinc-500 transition-colors hover:bg-white/[0.055] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                title={changeSummary.files.map((file) => file.path).join("\n")}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <Codicon name="git-compare" size={11} />
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
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-zinc-600 transition-colors hover:bg-white/[0.055] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
                title="Restore the repo to the checkpoint saved before this session started"
              >
                {isRestoringCheckpoint ? (
                  <Codicon name="loading" size={11} className="codicon-modifier-spin" />
                ) : (
                  <Codicon name="history" size={11} />
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatAge(createdAt?: string) {
  if (!createdAt) return "";
  const elapsed = Date.now() - Date.parse(createdAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
