import { useEffect, useCallback, useRef, useState, type CSSProperties } from "react";
import {
  ReactFlow,
  useNodesState,
  ReactFlowProvider,
  NodeChange,
  applyNodeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useStore, type AgentSession } from "./stores/useStore";
import { getWorkspaceBackground } from "./theme/appearance";
import { AgentNode } from "./components/AgentNode/index";
import { CategoryNode } from "./components/CategoryNode";
import { Sidebar } from "./components/Sidebar";
import { SessionListPanel } from "./components/SessionListPanel";
import { FocusMode } from "./components/FocusMode";
import { MarkdownView } from "./components/MarkdownView";
import { DiffView } from "./components/DiffView";
import { BrowserView } from "./components/BrowserView";
import { ResearchView } from "./components/ResearchView";
import { NewSessionModal } from "./components/NewSessionModal";
import { Header } from "./components/Header";
import { UndoDeleteToast } from "./components/UndoDeleteToast";
import { AgentActivityCenter } from "./components/AgentActivityCenter";
import { CommandPalette } from "./components/CommandPalette";
import { getAgentAccentColor } from "./components/AgentIcon";
import { PRBEPanel } from "./components/PRBEPanel";
import { PRBEInteractionDialog } from "./components/PRBEInteractionDialog";
import { usePRBEIPC } from "./hooks/usePRBEIPC";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useDesktopNotifications } from "./hooks/useDesktopNotifications";
import { destroyCachedTerminal } from "./components/Terminal";
import { Codicon } from "./components/Codicon";

const nodeTypes = {
  agent: AgentNode,
  category: CategoryNode,
};

// Remember the last repo we auto-opened so a single finish event doesn't keep
// re-triggering while the user is already looking at that repo's diff.
let lastAutoOpenedRepo: string | null = null;

// When an agent finishes, surface the diff viewer if its repo has uncommitted
// changes — but never yank the user out of a view they deliberately opened.
async function maybeAutoOpenDiff(repo: string | undefined) {
  if (!repo) return;
  const {
    diffAutoOpen,
    viewMode,
    setDiffRepoPath,
    setViewMode,
  } = useStore.getState();

  if (!diffAutoOpen) return;
  // Only auto-open from the canvas; respect focus/markdown/diff views.
  if (viewMode !== "canvas") return;
  // Already showing this repo — don't re-trigger.
  if (lastAutoOpenedRepo === repo) return;

  try {
    const res = await fetch(`/api/diff/files?path=${encodeURIComponent(repo)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.error || !Array.isArray(data.files) || data.files.length === 0) return;

    // Re-check the view in case the user navigated during the fetch.
    if (useStore.getState().viewMode !== "canvas") return;
    lastAutoOpenedRepo = repo;
    setDiffRepoPath(repo);
    setViewMode("diff");
  } catch {
    // Network/path error — silently skip auto-open.
  }
}

function restoreServerSessionToCanvas(sessionData: any) {
  if (!sessionData?.nodeId || !sessionData?.sessionId) return;

  const {
    sessions,
    nodes,
    agents,
    addSession,
    addNode,
  } = useStore.getState();

  if (sessions.has(sessionData.nodeId)) return;

  const agent = agents.find((item) => item.id === sessionData.agentId);
  const color = getAgentAccentColor(
    sessionData.agentId,
    sessionData.customColor || agent?.color,
  );
  const restoredSession: AgentSession = {
    id: sessionData.nodeId,
    sessionId: sessionData.sessionId,
    agentId: sessionData.agentId,
    agentName: sessionData.agentName,
    command: sessionData.command,
    color,
    createdAt: sessionData.createdAt,
    lastActivityAt: sessionData.lastActivityAt,
    cwd: sessionData.cwd,
    originalCwd: sessionData.originalCwd,
    gitBranch: sessionData.gitBranch,
    status: sessionData.status || "idle",
    customName: sessionData.customName,
    customColor: sessionData.customColor,
    notes: sessionData.notes,
    isRestored: sessionData.isRestored,
    ticketId: sessionData.ticketId,
    ticketTitle: sessionData.ticketTitle,
    worktreePaths: sessionData.worktreePaths,
    launchCheckpoint: sessionData.launchCheckpoint,
    changeSummary: sessionData.changeSummary,
  };

  addSession(sessionData.nodeId, restoredSession);

  if (nodes.some((node) => node.id === sessionData.nodeId)) return;
  const index = nodes.length;
  addNode({
    id: sessionData.nodeId,
    type: "agent",
    position: {
      x: 120 + (index % 5) * 240,
      y: 120 + Math.floor(index / 5) * 160,
    },
    data: {
      label: sessionData.customName || sessionData.agentName,
      agentId: sessionData.agentId,
      color,
      icon: agent?.icon || "cpu",
      sessionId: sessionData.sessionId,
    },
  });
}

function AppContent() {
  const {
    nodes: storeNodes,
    setNodes: setStoreNodes,
    setAgents,
    setLaunchCwd,
    setSelectedNodeId,
    setSidebarOpen,
    updateSession,
    agents,
    addAgentModalOpen,
    setAddAgentModalOpen,
    newSessionModalOpen,
    setNewSessionModalOpen,
    newSessionForNodeId,
    setNewSessionForNodeId,
    sessions,
    sessionListOpen,
    viewMode,
    browserPanelOpen,
    browserPanelWidth,
  } = useStore();

  const [nodes, setNodes, onNodesChange] = useNodesState(storeNodes);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // The canvas is one neutral pane of glass. It should never turn into an
  // opaque theme-colored sheet that hides the macOS window below it.
  const workspace = getWorkspaceBackground("graphite");
  const canvasAtmosphere =
    "linear-gradient(180deg, oklch(98% 0.004 255 / 0.025), oklch(10% 0.006 255 / 0.07))";
  const positionUpdateTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasRestoredRef = useRef(false);
  const browserDockOpen = browserPanelOpen;

  // Initialize PRBE IPC listeners
  usePRBEIPC();

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.isElectron) return;

    const updateFullscreen = (value: boolean) => setIsFullscreen(Boolean(value));
    api.on("window:fullscreen-changed", updateFullscreen);
    void api.invoke("window:is-fullscreen").then(updateFullscreen).catch(() => {});

    return () => api.removeAllListeners("window:fullscreen-changed");
  }, []);

  // Initialize keyboard shortcuts
  useKeyboardShortcuts();

  // Record session status changes for the quiet header activity bell.
  useDesktopNotifications();

  // Sync nodes with store
  useEffect(() => {
    setStoreNodes(nodes);
  }, [nodes, setStoreNodes]);

  useEffect(() => {
    if (storeNodes.length > 0 || hasRestoredRef.current) {
      setNodes(storeNodes);
    }
  }, [storeNodes, setNodes]);

  // Fetch config, agents, and restore state on mount
  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((config) => setLaunchCwd(config.launchCwd))
      .catch(console.error);

    fetch("/api/agents")
      .then((res) => res.json())
      .then((agents) => setAgents(agents))
      .catch(console.error);
  }, [setAgents, setLaunchCwd]);

  // Poll for status updates every second to catch any missed WebSocket messages
  useEffect(() => {
    const pollStatus = async () => {
      try {
        const res = await fetch("/api/sessions");
        if (res.ok) {
          const sessionsData = await res.json();
          const currentSessions = useStore.getState().sessions;
          const serverNodeIds = new Set(
            sessionsData
              .map((sessionData: any) => sessionData.nodeId)
              .filter((nodeId: unknown): nodeId is string => typeof nodeId === "string"),
          );

          if (hasRestoredRef.current) {
            for (const [nodeId, session] of currentSessions) {
              if (serverNodeIds.has(nodeId)) continue;

              const state = useStore.getState();
              destroyCachedTerminal(session.sessionId);
              state.removeSession(nodeId);
              state.removeNode(nodeId);
              if (state.selectedNodeId === nodeId) {
                state.setSelectedNodeId(null);
                state.setSidebarOpen(false);
              }
            }
          }

          for (const sessionData of sessionsData) {
            if (sessionData.nodeId && sessionData.status) {
              const existing = currentSessions.get(sessionData.nodeId);
              if (!existing && hasRestoredRef.current) {
                restoreServerSessionToCanvas(sessionData);
                continue;
              }
              if (existing) {
                const sessionUpdates: Partial<AgentSession> = {};
                if (existing.status !== sessionData.status) {
                  sessionUpdates.status = sessionData.status;
                  console.log(`[poll] Updating ${sessionData.nodeId} status: ${existing.status} -> ${sessionData.status}`);
                }
                if (existing.customName !== sessionData.customName) {
                  sessionUpdates.customName = sessionData.customName;
                  const title = sessionData.customName || existing.agentName;
                  const node = useStore.getState().nodes.find((item) => item.id === sessionData.nodeId);
                  if (node) {
                    useStore.getState().updateNode(sessionData.nodeId, {
                      data: { ...node.data, label: title },
                    });
                  }
                }
                if (existing.lastActivityAt !== sessionData.lastActivityAt) {
                  sessionUpdates.lastActivityAt = sessionData.lastActivityAt;
                }

                if (Object.keys(sessionUpdates).length > 0) {
                  updateSession(sessionData.nodeId, sessionUpdates);
                }

                if (existing.status !== sessionData.status) {
                // An agent just finished working (active -> idle). If its repo
                // has uncommitted changes, surface the diff viewer automatically.
                const wasActive =
                  existing.status === "running" || existing.status === "tool_calling";
                if (wasActive && sessionData.status === "idle") {
                  maybeAutoOpenDiff(existing.originalCwd || existing.cwd);
                }
                }
              }
            }
          }
        }
      } catch (e) {
        // Ignore errors
      }
    };

    // Poll immediately and then every second
    pollStatus();
    const interval = setInterval(pollStatus, 1000);
    return () => clearInterval(interval);
  }, [updateSession]);

  // Poll repo change summaries so each agent card can show a source-control badge.
  useEffect(() => {
    const pollChangeSummaries = async () => {
      const currentSessions = useStore.getState().sessions;
      if (currentSessions.size === 0) return;

      try {
        const res = await fetch("/api/sessions/changes");
        if (!res.ok) return;
        const data = await res.json();
        if (!Array.isArray(data.summaries)) return;

        const summariesByNode = new Map<string, any>(
          data.summaries.map((summary: any) => [summary.nodeId, summary]),
        );
        for (const [nodeId, session] of currentSessions) {
          const nextSummary = summariesByNode.get(nodeId);
          const currentCount = session.changeSummary?.changedFileCount ?? 0;
          const nextCount = nextSummary?.changedFileCount ?? 0;
          const currentShape = `${currentCount}:${session.changeSummary?.added ?? 0}:${session.changeSummary?.removed ?? 0}`;
          const nextShape = `${nextCount}:${nextSummary?.added ?? 0}:${nextSummary?.removed ?? 0}`;

          if (currentShape !== nextShape || session.changeSummary?.repoRoot !== nextSummary?.repoRoot) {
            updateSession(nodeId, { changeSummary: nextSummary });
          }
        }
      } catch {
        // Ignore transient git/server errors.
      }
    };

    pollChangeSummaries();
    const interval = setInterval(pollChangeSummaries, 5000);
    return () => clearInterval(interval);
  }, [sessions.size, updateSession]);

  // Once the user leaves the diff view, clear the auto-open guard so a later
  // agent finish on the same repo can surface the diff again.
  useEffect(() => {
    if (viewMode !== "diff") {
      lastAutoOpenedRepo = null;
    }
  }, [viewMode]);

  // Restore sessions and categories after agents are loaded
  useEffect(() => {
    if (agents.length === 0 || hasRestoredRef.current) return;

    Promise.all([
      fetch("/api/sessions").then((res) => res.json()),
      fetch("/api/state").then((res) => res.json()),
      fetch("/api/categories").then((res) => res.json()),
    ])
      .then(([sessions, { nodes: savedNodes }, categories]) => {
        const restoredNodes: any[] = [];

        // Restore categories first (they should be behind agents)
        categories.forEach((cat: any) => {
          restoredNodes.push({
            id: cat.id,
            type: "category",
            position: cat.position,
            style: { width: cat.width, height: cat.height },
            data: {
              label: cat.label,
              color: cat.color,
            },
            zIndex: -1, // Behind agent nodes
          });
        });

        // Restore agent sessions
        const { addSession: storeAddSession, setNodes: storeSetNodes } = useStore.getState();

        sessions.forEach((session: any, index: number) => {
          const saved = savedNodes?.find((n: any) => n.sessionId === session.sessionId);
          const agent = agents.find((a) => a.id === session.agentId);
          const position = saved?.position?.x
            ? saved.position
            : {
                x: 100 + (index % 5) * 220,
                y: 100 + Math.floor(index / 5) * 150,
              };

          storeAddSession(session.nodeId, {
            id: session.nodeId,
            sessionId: session.sessionId,
            agentId: session.agentId,
            agentName: session.agentName,
            command: session.command,
            color: getAgentAccentColor(session.agentId, session.customColor || agent?.color),
            createdAt: session.createdAt,
            cwd: session.cwd,
            originalCwd: session.originalCwd,
            gitBranch: session.gitBranch,
            status: session.status || "idle",
            customName: session.customName,
            customColor: session.customColor,
            notes: session.notes,
            isRestored: session.isRestored,
            ticketId: session.ticketId,
            ticketTitle: session.ticketTitle,
            worktreePaths: session.worktreePaths,
            launchCheckpoint: session.launchCheckpoint,
            changeSummary: session.changeSummary,
          });

          restoredNodes.push({
            id: session.nodeId,
            type: "agent",
            position,
            data: {
              label: session.customName || session.agentName,
              agentId: session.agentId,
              color: getAgentAccentColor(session.agentId, session.customColor || agent?.color),
              icon: agent?.icon || "cpu",
              sessionId: session.sessionId,
            },
          });
        });

        hasRestoredRef.current = true;
        setNodes(restoredNodes);
        storeSetNodes(restoredNodes);
      })
      .catch(console.error);
  }, [agents]); // eslint-disable-line react-hooks/exhaustive-deps — store functions are stable via getState

  // Helper to save all positions - accepts nodes directly to avoid sync issues
  const saveAllPositions = useCallback((nodesToSave?: typeof nodes) => {
    const currentNodes = nodesToSave || useStore.getState().nodes;
    if (currentNodes.length === 0) return;

    const positions: Record<string, { x: number; y: number }> = {};
    const GRID_SIZE = 24;
    currentNodes.forEach((node) => {
      // Only save agent positions to state/positions
      if (node.type === "agent") {
        positions[node.id] = {
          x: Math.round(node.position.x / GRID_SIZE) * GRID_SIZE,
          y: Math.round(node.position.y / GRID_SIZE) * GRID_SIZE,
        };
      }
      // Save category positions/sizes separately
      if (node.type === "category") {
        // Get dimensions - could be in style, measured, or width/height
        const width = node.measured?.width || node.width || (typeof node.style?.width === 'number' ? node.style.width : parseInt(node.style?.width as string) || 250);
        const height = node.measured?.height || node.height || (typeof node.style?.height === 'number' ? node.style.height : parseInt(node.style?.height as string) || 200);

        fetch(`/api/categories/${node.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            position: {
              x: Math.round(node.position.x / GRID_SIZE) * GRID_SIZE,
              y: Math.round(node.position.y / GRID_SIZE) * GRID_SIZE,
            },
            width,
            height,
          }),
        }).catch(console.error);
      }
    });
    if (Object.keys(positions).length > 0) {
      fetch("/api/state/positions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions }),
      }).catch(console.error);
    }
  }, [nodes]);

  // Save positions on window close/refresh
  useEffect(() => {
    const handleBeforeUnload = () => {
      saveAllPositions();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [saveAllPositions]);

  // Save positions when nodes are moved or resized
  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    // Intercept keyboard delete — confirm before removing, then do proper server cleanup
    const removeChanges = changes.filter((c) => c.type === "remove");
    if (removeChanges.length > 0) {
      const confirmedRemoves: NodeChange[] = [];
      changes = changes.filter((c) => c.type !== "remove");

      for (const change of removeChanges) {
        if ("id" in change) {
          const nodeId = change.id;
          const session = useStore.getState().sessions.get(nodeId);
          const sessionName = session?.customName || session?.agentName || "Session";
          const sessionId = session?.sessionId;

          const confirmed = window.confirm(`Delete "${sessionName}"? You'll have 5 seconds to undo.`);
          if (!confirmed) continue;

          // Let React Flow process this removal
          confirmedRemoves.push(change);

          // Soft-delete on server and clean up cached terminal
          if (sessionId) {
            fetch(`/api/sessions/${sessionId}/soft-delete`, { method: "POST" }).catch(console.error);
            destroyCachedTerminal(sessionId);
          }

          // Clean up store
          const { removeSession, setDeleteToast } = useStore.getState();
          removeSession(nodeId);
          setSelectedNodeId(null);
          setSidebarOpen(false);

          // Show undo toast
          const timeout = setTimeout(() => {
            setDeleteToast(null);
          }, 5000);
          setDeleteToast({
            sessionId: sessionId || "",
            nodeId,
            sessionName,
            timeout,
          });
        }
      }

      // Re-add confirmed removes so React Flow actually removes the nodes
      changes = [...changes, ...confirmedRemoves];
    }

    onNodesChange(changes);

    const positionChanges = changes.filter(
      (c) => c.type === "position" && "dragging" in c && c.dragging === false
    );
    // Check for dimension changes - resizing property might be true, false, or undefined
    const dimensionChanges = changes.filter(
      (c) => c.type === "dimensions" && (!("resizing" in c) || c.resizing === false)
    );

    if (positionChanges.length > 0 || dimensionChanges.length > 0) {
      if (positionUpdateTimeout.current) {
        clearTimeout(positionUpdateTimeout.current);
      }
      // Compute updated nodes immediately to avoid sync delay issues
      const updatedNodes = applyNodeChanges(changes, nodes);
      positionUpdateTimeout.current = setTimeout(() => {
        saveAllPositions(updatedNodes);
      }, 300);
    }
  }, [onNodesChange, saveAllPositions, nodes]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: any) => {
      // First click keeps the canvas visible and opens a lightweight chat
      // preview. Double-click and the preview's expand button enter Focus.
      if (node.type === "agent") {
        setSelectedNodeId(node.id);
        setSidebarOpen(true);
      }
    },
    [setSelectedNodeId, setSidebarOpen]
  );

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
    setSidebarOpen(false);
  }, [setSelectedNodeId, setSidebarOpen]);

  const isEmpty = nodes.length === 0;

  return (
    <div
      className={`workspace-shell relative flex h-screen w-screen flex-col overflow-hidden ${
        isFullscreen ? "workspace-shell-fullscreen" : ""
      }`}
      style={{
        background: canvasAtmosphere,
        "--workspace-bg": workspace.canvas,
        "--workspace-bg-dark": workspace.canvasDark,
        "--workspace-atmosphere": canvasAtmosphere,
        "--workspace-dots": workspace.dots,
        "--workspace-controls": workspace.controls,
        "--workspace-border": workspace.border,
      } as CSSProperties}
    >
      {viewMode !== "focus" && <Header isFullscreen={isFullscreen} />}

      <div className="flex-1 relative min-h-0">
        <div
          className="absolute inset-y-0 left-0 min-w-0 transition-[right] duration-300"
          style={{ right: browserDockOpen ? browserPanelWidth : 0 }}
        >
          {/* Session List Panel (left sidebar) */}
          <SessionListPanel />

          {/* Canvas area — shifts right when session list is open */}
          <div
            className="canvas-atmosphere absolute inset-0 transition-all duration-300"
            style={{ left: sessionListOpen ? 288 : 0 }}
          >
            <ReactFlow
              nodes={nodes}
              edges={[]}
              onNodesChange={handleNodesChange}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
              proOptions={{ hideAttribution: true }}
              minZoom={0.3}
              maxZoom={1.5}
              nodesDraggable
              nodesConnectable={false}
              snapToGrid
              snapGrid={[24, 24]}
              style={{ background: "transparent" }}
            >
            </ReactFlow>

            {/* Empty state */}
            {isEmpty && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="text-center pointer-events-auto">
                  <div className="w-16 h-16 rounded-2xl bg-surface border border-border flex items-center justify-center mx-auto mb-4">
                    <Codicon name="add" size={28} className="text-zinc-600" />
                  </div>
                  <h2 className="text-lg font-medium text-zinc-300 mb-2">No agents yet</h2>
                  <p className="text-sm text-zinc-500 mb-4 max-w-xs">
                    Spawn your first AI agent to get started
                  </p>
                  <button
                    onClick={() => setAddAgentModalOpen(true)}
                    className="px-4 py-2 rounded-lg bg-white text-canvas font-medium text-sm hover:bg-zinc-100 transition-colors"
                  >
                    Create Agent
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Focus Mode overlay */}
          <FocusMode />

          {/* Markdown viewer overlay */}
          <MarkdownView />

          {/* Diff viewer overlay */}
          <DiffView />

          {/* Native Probe Research workspace. The regular browser remains a
              separate dock and can sit beside this view. */}
          <ResearchView />

          <Sidebar />
          <PRBEPanel />
        </div>

        {/* Regular web browser dock. */}
        <BrowserView />
      </div>

      <NewSessionModal
        open={addAgentModalOpen || newSessionModalOpen}
        onClose={() => {
          setAddAgentModalOpen(false);
          setNewSessionModalOpen(false);
          setNewSessionForNodeId(null);
        }}
        existingSession={newSessionForNodeId ? sessions.get(newSessionForNodeId) : undefined}
        existingNodeId={newSessionForNodeId || undefined}
      />

      <UndoDeleteToast />
      <AgentActivityCenter />
      <CommandPalette />
      <PRBEInteractionDialog />
    </div>
  );
}

function App() {
  return (
    <ReactFlowProvider>
      <AppContent />
    </ReactFlowProvider>
  );
}

export default App;
