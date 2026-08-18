import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useReactFlow } from "@xyflow/react";
import { useStore } from "../stores/useStore";
import { Codicon } from "./Codicon";
import {
  buildTitleClusterCanvasLayout,
  fetchTitleClusterPlan,
  persistAgentPositions,
} from "../utils/canvasLayout";

interface Command {
  id: string;
  title: string;
  hint: string;
  icon: string;
  surface?: boolean;
  keepOpen?: boolean;
  keywords?: string;
  run: () => void | Promise<void>;
}

interface PackageScriptTask {
  name: string;
  command: string;
  runCommand: string;
  description: string;
}

interface PackageScriptsResponse {
  root: string;
  packageJsonPath: string | null;
  packageManager: string;
  scripts: PackageScriptTask[];
}

function normalize(value: string): string {
  return value.toLowerCase().trim();
}

const TASK_NODE_WIDTH = 220;
const TASK_NODE_HEIGHT = 140;
const TASK_NODE_SPACING = 32;
const PROBE_TRACKING_URL = "https://research.prbe.ai/experiments";

function findTaskPosition(
  nodes: { position?: { x: number; y: number } }[],
  reactFlow: { getViewport: () => { x: number; y: number; zoom: number } },
): { x: number; y: number } {
  const viewport = reactFlow.getViewport();
  const viewportBounds = document.querySelector(".react-flow")?.getBoundingClientRect();
  const viewportWidth = viewportBounds?.width || window.innerWidth;
  const viewportHeight = viewportBounds?.height || window.innerHeight;
  const centerX = (-viewport.x + viewportWidth / 2) / viewport.zoom;
  const centerY = (-viewport.y + viewportHeight / 2) / viewport.zoom;

  const existingPositions = nodes
    .map((node) => node.position)
    .filter((position): position is { x: number; y: number } => Boolean(position));
  const collides = (x: number, y: number) =>
    existingPositions.some((position) => {
      const overlapX = Math.abs(x - position.x) < TASK_NODE_WIDTH + TASK_NODE_SPACING;
      const overlapY = Math.abs(y - position.y) < TASK_NODE_HEIGHT + TASK_NODE_SPACING;
      return overlapX && overlapY;
    });

  const startX = Math.round(centerX / TASK_NODE_SPACING) * TASK_NODE_SPACING;
  const startY = Math.round(centerY / TASK_NODE_SPACING) * TASK_NODE_SPACING;
  for (let radius = 0; radius <= 8; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const x = startX + dx * (TASK_NODE_WIDTH + TASK_NODE_SPACING);
        const y = startY + dy * (TASK_NODE_HEIGHT + TASK_NODE_SPACING);
        if (!collides(x, y)) return { x, y };
      }
    }
  }

  return {
    x: startX + (nodes.length % 8) * TASK_NODE_SPACING,
    y: startY + (nodes.length % 8) * TASK_NODE_SPACING,
  };
}

export function CommandPalette() {
  const reactFlow = useReactFlow();
  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    setAddAgentModalOpen,
    setSessionListOpen,
    setStatusFilter,
    setSearchQuery,
    setViewMode,
    selectedNodeId,
    setSelectedNodeId,
    setSidebarOpen,
    viewMode,
    addFocusedSession,
    focusedSessionIds,
    nodes,
    sessions,
    setNodes,
    addNode,
    addSession,
    updateSession,
    launchCwd,
    diffRepoPath,
    browserUrl,
    setBrowserUrl,
    browserPanelOpen,
    setBrowserPanelOpen,
    openMarkdownFiles,
    setActivityCenterOpen,
    canvasLayoutSnapshots,
    saveCanvasLayoutSnapshot,
    restoreCanvasLayoutSnapshot,
  } = useStore();

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [projectTasks, setProjectTasks] = useState<PackageScriptsResponse | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const taskRoot = useMemo(() => {
    const selectedSession = selectedNodeId ? sessions.get(selectedNodeId) : undefined;
    return selectedSession?.originalCwd || selectedSession?.cwd || diffRepoPath || launchCwd;
  }, [diffRepoPath, launchCwd, selectedNodeId, sessions]);

  useEffect(() => {
    if (!commandPaletteOpen) return;
    setQuery("");
    const timeout = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timeout);
  }, [commandPaletteOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (!commandPaletteOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCommandPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [commandPaletteOpen, setCommandPaletteOpen]);

  useEffect(() => {
    if (!commandPaletteOpen || !taskRoot) {
      setProjectTasks(null);
      return;
    }

    const controller = new AbortController();
    fetch(`/api/tasks/scripts?path=${encodeURIComponent(taskRoot)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || "Failed to load project tasks");
        return data as PackageScriptsResponse;
      })
      .then((data) => setProjectTasks(data))
      .catch((error) => {
        if (error.name !== "AbortError") setProjectTasks(null);
      });

    return () => controller.abort();
  }, [commandPaletteOpen, taskRoot]);

  const commands = useMemo<Command[]>(() => {
    const cleanCanvas = async () => {
      const plan = await fetchTitleClusterPlan(nodes, sessions).catch(() => null);
      const nextNodes = buildTitleClusterCanvasLayout(nodes, sessions, plan);
      setNodes(nextNodes);
      // Let React Flow apply the new positions before framing them, else
      // fitView measures stale coords and the tidied grid lands off-screen.
      requestAnimationFrame(() =>
        reactFlow.fitView({ padding: 0.2, duration: 400 }),
      );
      await persistAgentPositions(nextNodes).catch(console.error);
    };

    const openSession = (nodeId: string) => {
      useStore.getState().openSessionInFocus(nodeId);

      const node = nodes.find((n) => n.id === nodeId);
      if (node) {
        reactFlow.setCenter(node.position.x + 110, node.position.y + 60, {
          zoom: 1.2,
          duration: 350,
        });
      }
    };

    const launchProjectTask = async (task: PackageScriptTask) => {
      const root = projectTasks?.root || taskRoot || launchCwd;
      if (!root) return;

      const slug = task.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "script";
      const nodeId = `task-${Date.now()}-${slug}`;
      const placeholderSessionId = `pending-${nodeId}`;
      const position = findTaskPosition(nodes, reactFlow);
      const displayName = `Task: ${task.name}`;
      const color = "#38bdf8";

      addNode({
        id: nodeId,
        type: "agent",
        position,
        data: {
          label: displayName,
          agentId: "task",
          color,
          icon: "terminal",
          sessionId: placeholderSessionId,
        },
      });

      addSession(nodeId, {
        id: nodeId,
        sessionId: placeholderSessionId,
        agentId: "task",
        agentName: "Task",
        command: task.runCommand,
        color,
        createdAt: new Date().toISOString(),
        cwd: root,
        status: "creating",
        customName: displayName,
      });

      useStore.getState().openSessionInFocus(nodeId);

      try {
        const response = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: "task",
            agentName: "Task",
            command: task.runCommand,
            cwd: root,
            nodeId,
            customName: displayName,
            customColor: color,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Failed to launch task");
        updateSession(nodeId, {
          sessionId: data.sessionId,
          cwd: data.cwd || root,
          gitBranch: data.gitBranch,
          launchCheckpoint: data.launchCheckpoint,
          status: "idle",
        });
      } catch (error) {
        console.error("Failed to launch task:", error);
        updateSession(nodeId, { status: "error" });
      }
    };

    const base: Command[] = [
      {
        id: "new-agent",
        title: "New agent",
        hint: "Start a Codex or Claude session",
        icon: "add",
        surface: true,
        run: () => setAddAgentModalOpen(true),
      },
      {
        id: "go-to-session",
        title: "Go to session",
        hint: "Jump to an active session",
        icon: "go-to-file",
        surface: true,
        keepOpen: true,
        keywords: "session agent jump open",
        run: () => setQuery("session "),
      },
      {
        id: "filter-sessions",
        title: "Filter sessions",
        hint: "Show all, running, waiting, idle, or error sessions",
        icon: "filter",
        surface: true,
        keepOpen: true,
        keywords: "filter status sessions",
        run: () => setQuery("filter "),
      },
      {
        id: "sort-canvas",
        title: "Sort canvas",
        hint: "Auto-arrange or restore canvas layouts",
        icon: "layout",
        surface: true,
        keepOpen: true,
        keywords: "sort arrange layout canvas",
        run: () => setQuery("sort "),
      },
      {
        id: "clean-canvas",
        title: "Sort: Title blast radius",
        hint: "Cluster sessions by title using Gemini when available, with local fallback",
        icon: "type-hierarchy-super",
        keywords: "sort arrange layout canvas title blast radius llm judge",
        run: cleanCanvas,
      },
      {
        id: "save-canvas-layout",
        title: "Sort: Save current canvas layout",
        hint: "Store the current agent card positions for later",
        icon: "save",
        keywords: "sort layout save canvas",
        run: () => saveCanvasLayoutSnapshot(),
      },
      {
        id: "sessions",
        title: "Show sessions",
        hint: "Pin and jump between subagents",
        icon: "list-tree",
        keywords: "session sidebar rail",
        run: () => setSessionListOpen(true),
      },
      {
        id: "model-training-tracking",
        title: "Open model training tracking",
        hint: "Probe Research experiments and runs",
        icon: "graph-line",
        surface: true,
        keywords: "probe research model training experiments runs metrics tracking",
        run: () => {
          setBrowserUrl(PROBE_TRACKING_URL);
          setBrowserPanelOpen(true);
        },
      },
      {
        id: "activity-center",
        title: "Show agent activity",
        hint: "Open the inbox for finished agents, errors, and input requests",
        icon: "bell",
        keywords: "activity notifications inbox agents",
        run: () => setActivityCenterOpen(true),
      },
      {
        id: "diff",
        title: "Review code changes",
        hint: "Open the diff review view",
        icon: "git-compare",
        surface: Boolean(diffRepoPath || selectedNodeId),
        keywords: "diff review changes git",
        run: () => setViewMode("diff"),
      },
      {
        id: "markdown",
        title: "Open markdown viewer",
        hint:
          openMarkdownFiles.length > 0
            ? `${openMarkdownFiles.length} markdown file${openMarkdownFiles.length === 1 ? "" : "s"} open`
            : "Show the markdown viewer",
        icon: "preview",
        surface: openMarkdownFiles.length > 0,
        keywords: "markdown md file viewer",
        run: () => setViewMode("markdown"),
      },
      {
        id: "browser",
        title: viewMode === "focus" ? "Open web preview" : "Open web preview in focus mode",
        hint:
          viewMode === "focus"
            ? "Preview a localhost URL or website in an embedded browser"
            : focusedSessionIds.length > 0
              ? "Switch to focus mode and open the embedded browser"
              : "Pin a session to focus mode first",
        icon: "globe",
        surface: Boolean(browserUrl || browserPanelOpen),
        keywords: "browser preview headless web localhost",
        run: () => {
          if (viewMode !== "focus") {
            if (selectedNodeId && sessions.has(selectedNodeId)) {
              addFocusedSession(selectedNodeId);
            } else if (focusedSessionIds.length === 0) {
              return;
            }
            setSidebarOpen(false);
            setViewMode("focus");
          }
          setBrowserPanelOpen(true);
        },
      },
      {
        id: "focus",
        title: "Open focus mode",
        hint:
          focusedSessionIds.length > 0
            ? `${focusedSessionIds.length} pinned session${focusedSessionIds.length === 1 ? "" : "s"}`
            : "Pin a session first",
        icon: "screen-full",
        surface: focusedSessionIds.length > 0,
        keywords: "focus terminal view",
        run: () => {
          if (focusedSessionIds.length > 0) setViewMode("focus");
        },
      },
      {
        id: "focus-chat",
        title: "Focus: Chat",
        hint: "Open the readable agent conversation",
        icon: "comment-discussion",
        surface: viewMode === "focus",
        keywords: "chat conversation claude cursor focus view",
        run: () => {
          if (viewMode !== "focus") {
            if (selectedNodeId && sessions.has(selectedNodeId)) {
              addFocusedSession(selectedNodeId);
            } else if (focusedSessionIds.length === 0) {
              return;
            }
            setSidebarOpen(false);
            setViewMode("focus");
          }
          window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent("openui:workspace-view", { detail: "chat" }));
          }, 40);
        },
      },
      {
        id: "focus-terminal",
        title: "Focus: Terminal",
        hint: "Open the raw live terminal",
        icon: "terminal",
        surface: viewMode === "focus",
        keywords: "terminal cli raw focus view",
        run: () => {
          if (viewMode !== "focus") {
            if (selectedNodeId && sessions.has(selectedNodeId)) {
              addFocusedSession(selectedNodeId);
            } else if (focusedSessionIds.length === 0) {
              return;
            }
            setSidebarOpen(false);
            setViewMode("focus");
          }
          window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent("openui:workspace-view", { detail: "terminal" }));
          }, 40);
        },
      },
      {
        id: "focus-split",
        title: "Focus: Chat and Terminal",
        hint: "Show the friendly chat beside the terminal truth",
        icon: "split-horizontal",
        surface: viewMode === "focus",
        keywords: "split chat terminal cursor focus view",
        run: () => {
          if (viewMode !== "focus") {
            if (selectedNodeId && sessions.has(selectedNodeId)) {
              addFocusedSession(selectedNodeId);
            } else if (focusedSessionIds.length === 0) {
              return;
            }
            setSidebarOpen(false);
            setViewMode("focus");
          }
          window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent("openui:workspace-view", { detail: "split" }));
          }, 40);
        },
      },
    ];

    const filterCommands: Command[] = [
      ["all", "All sessions"],
      ["running", "Running sessions"],
      ["waiting_input", "Waiting for input"],
      ["idle", "Idle sessions"],
      ["error", "Error sessions"],
    ].map(([filter, label]) => ({
      id: `filter-${filter}`,
      title: `Filter: ${label}`,
      hint: "Apply to the session rail",
      icon: "filter",
      keywords: "filter status sessions",
      run: () => {
        setStatusFilter(filter as Parameters<typeof setStatusFilter>[0]);
        setSearchQuery("");
        setSessionListOpen(true);
      },
    }));

    const sessionCommands = Array.from(sessions.entries()).map(([nodeId, session]) => {
      const name = session.customName || session.agentName;
      const dir = session.cwd?.split("/").pop() || session.cwd || "";
      return {
        id: `session-${nodeId}`,
        title: `Go to session: ${name}`,
        hint: [session.status, dir, session.gitBranch].filter(Boolean).join(" · "),
        icon: "arrow-right",
        keywords: "session agent jump open",
        run: () => openSession(nodeId),
      };
    });

    const focusCommands = Array.from(sessions.entries()).map(([nodeId, session]) => {
      const name = session.customName || session.agentName;
      return {
        id: `focus-session-${nodeId}`,
        title: `Focus session: ${name}`,
        hint: "Pin this agent and open focus mode",
        icon: "screen-full",
        keywords: "focus session terminal",
        run: () => {
          addFocusedSession(nodeId);
          setViewMode("focus");
        },
      };
    });

    const layoutCommands = canvasLayoutSnapshots.map((snapshot) => ({
      id: `restore-layout-${snapshot.id}`,
      title: `Sort: Restore canvas layout: ${snapshot.name}`,
      hint: new Date(snapshot.createdAt).toLocaleString(),
      icon: "history",
      keywords: "sort layout restore canvas",
      run: () => {
        restoreCanvasLayoutSnapshot(snapshot.id);
        setTimeout(() => {
          void persistAgentPositions(useStore.getState().nodes).catch(console.error);
        }, 0);
      },
    }));

    const repoCommands = Array.from(sessions.values())
      .filter((session) => session.originalCwd || session.cwd)
      .map((session) => {
        const repo = session.originalCwd || session.cwd;
        return {
          id: `review-${session.sessionId}`,
          title: `Review changes: ${repo.split("/").pop() || repo}`,
          hint: repo,
          icon: "git-branch-compact",
          keywords: "diff review changes git",
          run: () => {
            useStore.getState().setDiffRepoPath(repo);
            setViewMode("diff");
          },
      };
    });

    const taskCommands = (projectTasks?.scripts || []).slice(0, 24).map((task) => ({
      id: `project-task-${projectTasks?.root || taskRoot}-${task.name}`,
      title: `Run task: ${task.name}`,
      hint: `${task.runCommand} - ${task.command}`,
      icon: "play",
      keywords: "task script package run",
      run: () => launchProjectTask(task),
    }));

    return [
      ...base,
      ...filterCommands,
      ...taskCommands,
      ...sessionCommands,
      ...focusCommands,
      ...repoCommands,
      ...layoutCommands,
    ];
  }, [
    addFocusedSession,
    addNode,
    addSession,
    browserPanelOpen,
    browserUrl,
    canvasLayoutSnapshots,
    diffRepoPath,
    focusedSessionIds.length,
    launchCwd,
    nodes,
    openMarkdownFiles.length,
    projectTasks,
    reactFlow,
    restoreCanvasLayoutSnapshot,
    saveCanvasLayoutSnapshot,
    sessions,
    setAddAgentModalOpen,
    setBrowserPanelOpen,
    setBrowserUrl,
    setNodes,
    setActivityCenterOpen,
    setSearchQuery,
    setSelectedNodeId,
    setSidebarOpen,
    setSessionListOpen,
    setStatusFilter,
    setViewMode,
    taskRoot,
    updateSession,
    viewMode,
  ]);

  const filtered = useMemo(() => {
    const q = normalize(query);
    if (!q) return commands.filter((command) => command.surface);
    return commands.filter((command) =>
      normalize(`${command.title} ${command.hint} ${command.keywords || ""}`).includes(q),
    );
  }, [commands, query]);

  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIndex]);

  useEffect(() => {
    if (!commandPaletteOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((index) =>
          filtered.length === 0 ? 0 : Math.min(filtered.length - 1, index + 1),
        );
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((index) => Math.max(0, index - 1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const command = filtered[selectedIndex];
        if (command) void runCommand(command);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [commandPaletteOpen, filtered, selectedIndex]);

  const runCommand = async (command: Command) => {
    await command.run();
    if (command.keepOpen) {
      setTimeout(() => inputRef.current?.focus(), 0);
      return;
    }
    setCommandPaletteOpen(false);
  };

  return createPortal(
    <AnimatePresence>
      {commandPaletteOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="fixed inset-0 z-[90] bg-zinc-950/42 backdrop-blur-[2px]"
            onClick={() => setCommandPaletteOpen(false)}
          />
          <motion.div
            initial={{ opacity: 0, x: "-50%", y: -12, scale: 0.98 }}
            animate={{ opacity: 1, x: "-50%", y: 0, scale: 1 }}
            exit={{ opacity: 0, x: "-50%", y: -8, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="workspace-glass-strong command-palette-surface fixed left-1/2 top-24 z-[91] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl"
          >
            <div className="flex items-center gap-3 border-b border-white/[0.065] px-4 py-3">
              <Codicon name="search" size={15} className="text-zinc-500" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="New agent, sessions, filter, sort..."
                className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none"
              />
              <span className="text-[10px] text-zinc-600">Esc</span>
            </div>
            <div className="max-h-[420px] overflow-y-auto py-1.5">
              {filtered.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-zinc-600">
                  No commands found
                </div>
              ) : (
                filtered.map((command, index) => {
                  const selected = index === selectedIndex;
                  return (
                    <button
                      key={command.id}
                      type="button"
                      onClick={() => void runCommand(command)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      className={`w-full px-3 py-2.5 flex items-center gap-3 text-left transition-colors ${
                        selected ? "bg-surface-active" : "hover:bg-surface-active/70"
                      }`}
                    >
                      <div className="flex h-7 w-7 items-center justify-center text-zinc-400">
                        <Codicon name={command.icon} size={14} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-zinc-100 truncate">{command.title}</div>
                        <div className="text-xs text-zinc-600 truncate">{command.hint}</div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
