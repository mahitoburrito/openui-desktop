import type { IPty } from "node-pty";
import type WebSocket from "ws";

export type AgentStatus = "running" | "waiting_input" | "tool_calling" | "idle" | "disconnected" | "error";

export interface Session {
  pty: IPty | null;
  agentId: string;
  agentName: string;
  command: string;
  cwd: string;
  originalCwd?: string;
  gitBranch?: string;
  worktreePath?: string;
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
}

export interface PersistedNode {
  nodeId: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  command: string;
  cwd: string;
  createdAt: string;
  customName?: string;
  customColor?: string;
  notes?: string;
  icon?: string;
  position: { x: number; y: number };
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
