import type { IPty } from "node-pty";
import type WebSocket from "ws";

export type AgentStatus = "running" | "waiting_input" | "tool_calling" | "idle" | "disconnected" | "error";

export interface CheckpointSummary {
  id: string;
  repoRoot: string;
  name: string;
  createdAt: number;
  files: { path: string; exists: boolean }[];
  source?: "manual" | "session-launch";
  sessionId?: string;
  nodeId?: string;
}

export interface AgentChangeSummary {
  sessionId: string;
  nodeId: string;
  repoRoot: string;
  changedFileCount: number;
  added: number;
  removed: number;
  summary: string;
  files: {
    path: string;
    status: string;
    added: number;
    removed: number;
    untracked: boolean;
  }[];
}

export interface Session {
  pty: IPty | null;
  agentId: string;
  agentName: string;
  command: string;
  cwd: string;
  originalCwd?: string;
  gitBranch?: string;
  worktreePath?: string;
  worktreePaths?: Record<string, string>;   // repo name → worktree path (multi-repo)
  worktreeMode?: 'current' | 'main';
  stashRefs?: Record<string, string>;       // repo name → stash ref
  createdAt: string;
  clients: Set<WebSocket>;
  outputBuffer: string[];
  status: AgentStatus;
  lastOutputTime: number;
  lastInputTime: number;
  recentOutputSize: number;
  customName?: string;
  customColor?: string;
  notes?: string;
  icon?: string;
  nodeId: string;
  isRestored?: boolean;
  position?: { x: number; y: number };
  // Linear ticket info
  ticketId?: string;
  ticketTitle?: string;
  ticketUrl?: string;
  launchCheckpoint?: CheckpointSummary;
  // Plugin-reported status
  pluginReportedStatus?: boolean;
  lastPluginStatusTime?: number;
  claudeSessionId?: string;
  currentTool?: string;
  lastHookEvent?: string;
  // Permission detection
  preToolTime?: number;
  permissionTimeout?: ReturnType<typeof setTimeout>;
  // State tracker PTY (for output parsing fallback)
  stateTrackerPty?: IPty | null;
  // Auto-naming from first query
  firstInputBuffer?: string;
  nameGenerated?: boolean;
  generatedTitle?: string;
  titlePromptHistory?: string[];
  // Soft delete
  pendingDelete?: boolean;
  deleteTimeout?: ReturnType<typeof setTimeout>;
}

export interface LinearTicket {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { name: string; color: string };
  priority: number;
  assignee?: { name: string };
  team?: { name: string; key: string };
}

export interface LinearConfig {
  apiKey?: string;
  defaultTeamId?: string;
  defaultBaseBranch?: string;
  createWorktree?: boolean;
  ticketPromptTemplate?: string;
  initialPrompt?: string;
  autoCareful?: boolean;
}

export interface PersistedNode {
  nodeId: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  command: string;
  cwd: string;
  originalCwd?: string;
  createdAt: string;
  customName?: string;
  generatedTitle?: string;
  titlePromptHistory?: string[];
  customColor?: string;
  notes?: string;
  icon?: string;
  position: { x: number; y: number };
  worktreePaths?: Record<string, string>;
  launchCheckpoint?: CheckpointSummary;
}

export interface PersistedCategory {
  id: string;
  label: string;
  color: string;
  position: { x: number; y: number };
  width: number;
  height: number;
}

export interface PersistedState {
  nodes: PersistedNode[];
  categories?: PersistedCategory[];
}

export interface Agent {
  id: string;
  name: string;
  command: string;
  description: string;
  color: string;
  icon: string;
}

export interface WebSocketData {
  sessionId: string;
}

export interface DetectedRepo {
  name: string;
  path: string;
  branch: string;
  dirty: boolean;
  defaultBranch: string;
}
