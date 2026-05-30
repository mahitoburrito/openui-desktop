import { create } from "zustand";
import { Node } from "@xyflow/react";

// localStorage keys for crash-resilient UI state
const STORAGE_KEY = "openui-desktop-ui-state";

export interface Agent {
  id: string;
  name: string;
  command: string;
  description: string;
  color: string;
  icon: string;
}

export type AgentStatus = "running" | "waiting_input" | "tool_calling" | "idle" | "disconnected" | "error" | "creating";

export interface AgentSession {
  id: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  command: string;
  color: string;
  createdAt: string;
  cwd: string;
  originalCwd?: string; // Mother repo path when using worktrees
  gitBranch?: string;
  status: AgentStatus;
  customName?: string;
  customColor?: string;
  notes?: string;
  isRestored?: boolean;
  // Linear ticket info
  ticketId?: string;
  ticketTitle?: string;
  // Current tool being used (from plugin)
  currentTool?: string;
  // Multi-repo worktree paths
  worktreePaths?: Record<string, string>;
}

export interface DeleteToast {
  sessionId: string;
  nodeId: string;
  sessionName: string;
  timeout: ReturnType<typeof setTimeout>;
}

export type ViewMode = "canvas" | "focus" | "markdown" | "diff" | "browser";
export type StatusFilter = AgentStatus | "all";

// Diff viewer presentation preferences
export type DiffLayout = "unified" | "split";
export type DiffTheme =
  | "github-dark"
  | "github-light"
  | "one-dark-pro"
  | "dracula"
  | "nord"
  | "vitesse-dark";
export const DIFF_THEMES: DiffTheme[] = [
  "github-dark",
  "github-light",
  "one-dark-pro",
  "dracula",
  "nord",
  "vitesse-dark",
];

interface AppState {
  // Config
  launchCwd: string;
  setLaunchCwd: (cwd: string) => void;

  // Agents
  agents: Agent[];
  setAgents: (agents: Agent[]) => void;

  // Sessions / Nodes
  sessions: Map<string, AgentSession>;
  addSession: (nodeId: string, session: AgentSession) => void;
  updateSession: (nodeId: string, updates: Partial<AgentSession>) => void;
  removeSession: (nodeId: string) => void;

  // Canvas
  nodes: Node[];
  setNodes: (nodes: Node[]) => void;
  addNode: (node: Node) => void;
  updateNode: (nodeId: string, updates: Partial<Node>) => void;
  removeNode: (nodeId: string) => void;

  // UI State
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  addAgentModalOpen: boolean;
  setAddAgentModalOpen: (open: boolean) => void;
  newSessionModalOpen: boolean;
  setNewSessionModalOpen: (open: boolean) => void;
  newSessionForNodeId: string | null;
  setNewSessionForNodeId: (nodeId: string | null) => void;
  todosPanelOpen: boolean;
  setTodosPanelOpen: (open: boolean) => void;

  // Session List Panel
  sessionListOpen: boolean;
  setSessionListOpen: (open: boolean) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (filter: StatusFilter) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;

  // Focus Mode (multi-terminal view)
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  focusedSessionIds: string[]; // nodeIds pinned in focus mode
  addFocusedSession: (nodeId: string) => void;
  removeFocusedSession: (nodeId: string) => void;
  setFocusedSessions: (nodeIds: string[]) => void;
  // Per-layout pane size ratios for resizable splitter (sum to 1)
  splitRatios: Record<string, number[]>;
  setSplitRatios: (key: string, ratios: number[]) => void;

  // Markdown viewer
  openMarkdownFiles: string[]; // absolute file paths
  addMarkdownFile: (path: string) => void;
  removeMarkdownFile: (path: string) => void;
  setMarkdownFiles: (paths: string[]) => void;

  // Diff viewer — repo whose working-tree diff is being reviewed
  diffRepoPath: string | null;
  setDiffRepoPath: (path: string | null) => void;
  // Auto-open the diff viewer when an agent finishes with uncommitted changes.
  diffAutoOpen: boolean;
  setDiffAutoOpen: (on: boolean) => void;
  // Diff viewer presentation preferences
  diffLayout: DiffLayout;
  setDiffLayout: (layout: DiffLayout) => void;
  diffWrap: boolean;
  setDiffWrap: (wrap: boolean) => void;
  diffTheme: DiffTheme;
  setDiffTheme: (theme: DiffTheme) => void;

  // Embedded browser preview
  browserUrl: string;
  setBrowserUrl: (url: string) => void;

  // Delete toast
  deleteToast: DeleteToast | null;
  setDeleteToast: (toast: DeleteToast | null) => void;
}

// Load persisted UI state from localStorage
function loadPersistedUIState(): Partial<AppState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        sessionListOpen: parsed.sessionListOpen ?? true,
        viewMode: parsed.viewMode ?? "canvas",
        focusedSessionIds: parsed.focusedSessionIds ?? [],
        splitRatios: parsed.splitRatios ?? {},
        openMarkdownFiles: parsed.openMarkdownFiles ?? [],
        diffRepoPath: parsed.diffRepoPath ?? null,
        diffAutoOpen: parsed.diffAutoOpen ?? true,
        diffLayout: parsed.diffLayout ?? "unified",
        diffWrap: parsed.diffWrap ?? false,
        diffTheme: parsed.diffTheme ?? "github-dark",
        browserUrl: parsed.browserUrl ?? "",
      };
    }
  } catch {
    // Corrupted localStorage — ignore
  }
  return {};
}

const MAX_FOCUSED_SESSIONS = 16;

const persisted = loadPersistedUIState();

export const useStore = create<AppState>((set) => ({
  // Config
  launchCwd: "",
  setLaunchCwd: (cwd) => set({ launchCwd: cwd }),

  // Agents
  agents: [],
  setAgents: (agents) => set({ agents }),

  // Sessions
  sessions: new Map(),
  addSession: (nodeId, session) =>
    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.set(nodeId, session);
      return { sessions: newSessions };
    }),
  updateSession: (nodeId, updates) =>
    set((state) => {
      const newSessions = new Map(state.sessions);
      const session = newSessions.get(nodeId);
      if (session) {
        newSessions.set(nodeId, { ...session, ...updates });
      }
      return { sessions: newSessions };
    }),
  removeSession: (nodeId) =>
    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.delete(nodeId);
      return { sessions: newSessions };
    }),

  // Canvas
  nodes: [],
  setNodes: (nodes) => set({ nodes }),
  addNode: (node) => set((state) => ({ nodes: [...state.nodes, node] })),
  updateNode: (nodeId, updates) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, ...updates } : n
      ),
    })),
  removeNode: (nodeId) =>
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== nodeId),
    })),

  // UI State
  selectedNodeId: null,
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),
  sidebarOpen: false,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  addAgentModalOpen: false,
  setAddAgentModalOpen: (open) => set({ addAgentModalOpen: open }),
  newSessionModalOpen: false,
  setNewSessionModalOpen: (open) => set({ newSessionModalOpen: open }),
  newSessionForNodeId: null,
  setNewSessionForNodeId: (nodeId) => set({ newSessionForNodeId: nodeId }),
  todosPanelOpen: false,
  setTodosPanelOpen: (open) => set({ todosPanelOpen: open }),

  // Session List Panel
  sessionListOpen: persisted.sessionListOpen ?? true,
  setSessionListOpen: (open) => set({ sessionListOpen: open }),
  statusFilter: "all",
  setStatusFilter: (filter) => set({ statusFilter: filter }),
  searchQuery: "",
  setSearchQuery: (query) => set({ searchQuery: query }),

  // Focus Mode
  viewMode: (persisted.viewMode as ViewMode) ?? "canvas",
  setViewMode: (mode) => set({ viewMode: mode }),
  focusedSessionIds: persisted.focusedSessionIds ?? [],
  addFocusedSession: (nodeId) =>
    set((state) => ({
      focusedSessionIds: state.focusedSessionIds.includes(nodeId)
        ? state.focusedSessionIds
        : [...state.focusedSessionIds, nodeId].slice(0, MAX_FOCUSED_SESSIONS),
    })),
  removeFocusedSession: (nodeId) =>
    set((state) => ({
      focusedSessionIds: state.focusedSessionIds.filter((id) => id !== nodeId),
    })),
  setFocusedSessions: (nodeIds) =>
    set({ focusedSessionIds: nodeIds.slice(0, MAX_FOCUSED_SESSIONS) }),

  splitRatios: (persisted.splitRatios as Record<string, number[]>) ?? {},
  setSplitRatios: (key, ratios) =>
    set((state) => ({
      splitRatios: { ...state.splitRatios, [key]: ratios },
    })),

  // Markdown viewer
  openMarkdownFiles: (persisted.openMarkdownFiles as string[]) ?? [],
  addMarkdownFile: (path) =>
    set((state) => ({
      openMarkdownFiles: state.openMarkdownFiles.includes(path)
        ? state.openMarkdownFiles
        : [...state.openMarkdownFiles, path],
    })),
  removeMarkdownFile: (path) =>
    set((state) => ({
      openMarkdownFiles: state.openMarkdownFiles.filter((p) => p !== path),
    })),
  setMarkdownFiles: (paths) => set({ openMarkdownFiles: paths }),

  // Diff viewer
  diffRepoPath: (persisted.diffRepoPath as string | null) ?? null,
  setDiffRepoPath: (path) => set({ diffRepoPath: path }),
  diffAutoOpen: (persisted.diffAutoOpen as boolean) ?? true,
  setDiffAutoOpen: (on) => set({ diffAutoOpen: on }),
  diffLayout: (persisted.diffLayout as DiffLayout) ?? "unified",
  setDiffLayout: (layout) => set({ diffLayout: layout }),
  diffWrap: (persisted.diffWrap as boolean) ?? false,
  setDiffWrap: (wrap) => set({ diffWrap: wrap }),
  diffTheme: (persisted.diffTheme as DiffTheme) ?? "github-dark",
  setDiffTheme: (theme) => set({ diffTheme: theme }),

  // Embedded browser preview
  browserUrl: (persisted.browserUrl as string) ?? "",
  setBrowserUrl: (url) => set({ browserUrl: url }),

  // Delete toast
  deleteToast: null,
  setDeleteToast: (toast) => set({ deleteToast: toast }),
}));

// Auto-persist UI state to localStorage on change
useStore.subscribe((state) => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sessionListOpen: state.sessionListOpen,
        viewMode: state.viewMode,
        focusedSessionIds: state.focusedSessionIds,
        splitRatios: state.splitRatios,
        openMarkdownFiles: state.openMarkdownFiles,
        diffRepoPath: state.diffRepoPath,
        diffAutoOpen: state.diffAutoOpen,
        diffLayout: state.diffLayout,
        diffWrap: state.diffWrap,
        diffTheme: state.diffTheme,
        browserUrl: state.browserUrl,
      })
    );
  } catch {
    // localStorage full or unavailable — ignore
  }
});
