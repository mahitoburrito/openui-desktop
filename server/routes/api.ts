import { Hono } from "hono";
import * as pty from "node-pty";
import { readdirSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import type { Agent } from "../types";
import { sessions, createSession, deleteSession, injectPluginDir, scanReposInDirectory } from "../services/sessionManager";
import { loadState, saveState, savePositions, getDataDir } from "../services/persistence";
import {
  loadConfig,
  saveConfig,
  fetchTeams,
  fetchMyTickets,
  searchTickets,
  fetchTicketByIdentifier,
  validateApiKey,
  getCurrentUser,
} from "../services/linear";
import {
  fetchGitHubIssues,
  fetchGitHubIssue,
  searchGitHubIssues,
  parseGitHubUrl,
} from "../services/github";

function getLaunchCwd(): string {
  return process.env.LAUNCH_CWD || homedir();
}
const QUIET = !!process.env.OPENUI_QUIET;
const log = QUIET ? (..._args: any[]) => {} : console.log.bind(console);
const logError = QUIET ? (..._args: any[]) => {} : console.error.bind(console);

export const apiRoutes = new Hono();

apiRoutes.get("/config", (c) => {
  return c.json({ launchCwd: getLaunchCwd(), dataDir: getDataDir() });
});

// Browse directories for file picker
apiRoutes.get("/browse", (c) => {
  let path = c.req.query("path") || getLaunchCwd();

  if (path.startsWith("~")) {
    path = path.replace("~", homedir());
  }

  path = resolve(path);

  try {
    const entries = readdirSync(path, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({
        name: entry.name,
        path: join(path, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parentPath = resolve(path, "..");

    return c.json({
      current: path,
      parent: parentPath !== path ? parentPath : null,
      directories,
    });
  } catch (e: any) {
    return c.json({ error: e.message, current: path }, 400);
  }
});

// Scan a directory for child git repositories
apiRoutes.get("/scan-repos", (c) => {
  let path = c.req.query("path") || getLaunchCwd();

  if (path.startsWith("~")) {
    path = path.replace("~", homedir());
  }

  path = resolve(path);

  try {
    const repos = scanReposInDirectory(path);
    return c.json({ repos });
  } catch (e: any) {
    return c.json({ error: e.message, repos: [] }, 400);
  }
});

apiRoutes.get("/agents", (c) => {
  const agents: Agent[] = [
    {
      id: "claude",
      name: "Claude Code",
      command: "claude",
      description: "Anthropic's official CLI for Claude",
      color: "#F97316",
      icon: "sparkles",
    },
    {
      id: "opencode",
      name: "OpenCode",
      command: "opencode",
      description: "Open source AI coding assistant",
      color: "#22C55E",
      icon: "code",
    },
    {
      id: "ralph",
      name: "Ralph",
      command: "",
      description: "Autonomous dev loop (ralph, ralph-setup, ralph-import)",
      color: "#8B5CF6",
      icon: "brain",
    },
    {
      id: "codex",
      name: "Codex",
      command: "codex",
      description: "OpenAI's coding agent CLI",
      color: "#10A37F",
      icon: "terminal",
    },
  ];
  return c.json(agents);
});

apiRoutes.get("/sessions", (c) => {
  const sessionList = Array.from(sessions.entries()).filter(([, session]) => !session.pendingDelete).map(([id, session]) => ({
    sessionId: id,
    nodeId: session.nodeId,
    agentId: session.agentId,
    agentName: session.agentName,
    command: session.command,
    createdAt: session.createdAt,
    cwd: session.cwd,
    originalCwd: session.originalCwd,
    gitBranch: session.gitBranch,
    status: session.status,
    customName: session.customName,
    customColor: session.customColor,
    notes: session.notes,
    isRestored: session.isRestored,
    ticketId: session.ticketId,
    ticketTitle: session.ticketTitle,
    worktreePaths: session.worktreePaths,
  }));
  return c.json(sessionList);
});

apiRoutes.get("/sessions/:sessionId/status", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json({ status: session.status, isRestored: session.isRestored });
});

apiRoutes.get("/state", (c) => {
  const state = loadState();
  const nodes = state.nodes.map(node => {
    const session = sessions.get(node.sessionId);
    return {
      ...node,
      status: session?.status || "disconnected",
      isAlive: !!session,
      isRestored: session?.isRestored,
    };
  }).filter(n => n.isAlive);
  return c.json({ nodes });
});

apiRoutes.post("/state/positions", async (c) => {
  const { positions } = await c.req.json();

  for (const [nodeId, pos] of Object.entries(positions)) {
    for (const [, session] of sessions) {
      if (session.nodeId === nodeId) {
        session.position = pos as { x: number; y: number };
        break;
      }
    }
  }

  savePositions(positions);
  return c.json({ success: true });
});

apiRoutes.post("/sessions", async (c) => {
  const body = await c.req.json();
  const {
    agentId, agentName, command, cwd, nodeId, customName, customColor,
    ticketId, ticketTitle, ticketUrl, branchName, baseBranch,
    createWorktree: createWorktreeFlag,
    multiRepoMode,
    additionalRepos,
  } = body;

  const sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const workingDir = cwd || getLaunchCwd();

  const linearConfig = loadConfig();
  const ticketPromptTemplate = linearConfig.ticketPromptTemplate;

  const result = createSession({
    sessionId, agentId, agentName, command, cwd: workingDir, nodeId,
    customName, customColor, ticketId, ticketTitle, ticketUrl,
    branchName, baseBranch, createWorktreeFlag, ticketPromptTemplate,
    multiRepoMode, additionalRepos,
  });

  saveState(sessions);
  return c.json({
    sessionId, nodeId,
    cwd: result.cwd,
    gitBranch: result.gitBranch,
  });
});

apiRoutes.post("/sessions/:sessionId/restart", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  if (session.pty) return c.json({ error: "Session already running" }, 400);

  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/bash";

  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cwd: session.cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      OPENUI_SESSION_ID: sessionId,
    } as Record<string, string>,
    cols: 120,
    rows: 30,
  });

  session.pty = ptyProcess;
  session.isRestored = false;
  session.status = "running";
  session.lastOutputTime = Date.now();

  const resetInterval = setInterval(() => {
    if (!sessions.has(sessionId) || !session.pty) {
      clearInterval(resetInterval);
      return;
    }
    session.recentOutputSize = Math.max(0, session.recentOutputSize - 50);
  }, 500);

  ptyProcess.onData((data: string) => {
    session.outputBuffer.push(data);
    if (session.outputBuffer.length > 1000) {
      session.outputBuffer.shift();
    }

    session.lastOutputTime = Date.now();
    session.recentOutputSize += data.length;

    for (const client of session.clients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "output", data }));
      }
    }
  });

  const finalCommand = injectPluginDir(session.command, session.agentId);
  setTimeout(() => {
    ptyProcess.write(`${finalCommand}\r`);
  }, 300);

  log(`[session] Restarted ${sessionId}`);
  return c.json({ success: true });
});

apiRoutes.patch("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const updates = await c.req.json();
  if (updates.customName !== undefined) session.customName = updates.customName;
  if (updates.customColor !== undefined) session.customColor = updates.customColor;
  if (updates.notes !== undefined) session.notes = updates.notes;

  saveState(sessions);
  return c.json({ success: true });
});

apiRoutes.delete("/sessions/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  const success = deleteSession(sessionId);

  if (success) {
    saveState(sessions);
    return c.json({ success: true });
  }
  return c.json({ error: "Session not found" }, 404);
});

// Soft delete - marks session for deletion, actual delete after timeout
apiRoutes.post("/sessions/:sessionId/soft-delete", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  session.pendingDelete = true;

  if (session.deleteTimeout) {
    clearTimeout(session.deleteTimeout);
  }

  session.deleteTimeout = setTimeout(() => {
    const s = sessions.get(sessionId);
    if (s && s.pendingDelete) {
      if (s.pty) s.pty.kill();
      if (s.stateTrackerPty) s.stateTrackerPty.kill();
      sessions.delete(sessionId);
      saveState(sessions);
      log(`[session] Hard-deleted ${sessionId} after timeout`);
    }
  }, 5000);

  saveState(sessions);
  return c.json({ success: true });
});

// Undo soft delete - restores a pending-delete session
apiRoutes.post("/sessions/:sessionId/undo-delete", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  if (session.deleteTimeout) {
    clearTimeout(session.deleteTimeout);
    session.deleteTimeout = undefined;
  }
  session.pendingDelete = false;

  saveState(sessions);
  log(`[session] Restored ${sessionId} from soft-delete`);
  return c.json({ success: true });
});

// Status update endpoint for Claude Code plugin
apiRoutes.post("/status-update", async (c) => {
  const body = await c.req.json();
  const { status, openuiSessionId, claudeSessionId, hookEvent, toolName } = body;

  log(`[plugin-hook] ${hookEvent || "unknown"}: status=${status} tool=${toolName || "none"} openui=${openuiSessionId || "none"}`);

  if (!status) {
    return c.json({ error: "status is required" }, 400);
  }

  let session = null;

  if (openuiSessionId) {
    session = sessions.get(openuiSessionId);
  }

  if (!session && claudeSessionId) {
    for (const [, s] of sessions) {
      if (s.claudeSessionId === claudeSessionId) {
        session = s;
        break;
      }
    }
  }

  if (session) {
    if (claudeSessionId && !session.claudeSessionId) {
      session.claudeSessionId = claudeSessionId;
    }

    let effectiveStatus = status;

    if (status === "pre_tool") {
      effectiveStatus = "running";
      session.currentTool = toolName;
      session.preToolTime = Date.now();

      if (session.permissionTimeout) {
        clearTimeout(session.permissionTimeout);
      }

      session.permissionTimeout = setTimeout(() => {
        if (session!.preToolTime) {
          session!.status = "waiting_input";
          for (const client of session!.clients) {
            if (client.readyState === 1) {
              client.send(JSON.stringify({
                type: "status",
                status: "waiting_input",
                isRestored: session!.isRestored,
                currentTool: session!.currentTool,
                hookEvent: "permission_timeout",
              }));
            }
          }
        }
      }, 2500);
    } else if (status === "post_tool") {
      effectiveStatus = "running";
      session.preToolTime = undefined;
      if (session.permissionTimeout) {
        clearTimeout(session.permissionTimeout);
        session.permissionTimeout = undefined;
      }
    } else {
      if (status !== "tool_calling" && status !== "running") {
        session.currentTool = undefined;
      }
      session.preToolTime = undefined;
      if (session.permissionTimeout) {
        clearTimeout(session.permissionTimeout);
        session.permissionTimeout = undefined;
      }
    }

    session.status = effectiveStatus;
    session.pluginReportedStatus = true;
    session.lastPluginStatusTime = Date.now();
    session.lastHookEvent = hookEvent;

    for (const client of session.clients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({
          type: "status",
          status: session.status,
          isRestored: session.isRestored,
          currentTool: session.currentTool,
          hookEvent,
        }));
      }
    }

    return c.json({ success: true });
  }

  return c.json({ success: true, warning: "No matching session found" });
});

// Categories
apiRoutes.get("/categories", (c) => {
  const state = loadState();
  return c.json(state.categories || []);
});

apiRoutes.post("/categories", async (c) => {
  const state = loadState();
  const category = await c.req.json();

  if (!state.categories) state.categories = [];
  state.categories.push(category);

  writeFileSync(join(getDataDir(), "state.json"), JSON.stringify(state, null, 2));

  return c.json({ success: true });
});

apiRoutes.patch("/categories/:categoryId", async (c) => {
  const categoryId = c.req.param("categoryId");
  const updates = await c.req.json();
  const state = loadState();

  if (!state.categories) return c.json({ error: "Category not found" }, 404);

  const category = state.categories.find(cat => cat.id === categoryId);
  if (!category) return c.json({ error: "Category not found" }, 404);

  Object.assign(category, updates);

  writeFileSync(join(getDataDir(), "state.json"), JSON.stringify(state, null, 2));

  return c.json({ success: true });
});

apiRoutes.delete("/categories/:categoryId", (c) => {
  const categoryId = c.req.param("categoryId");
  const state = loadState();

  if (!state.categories) return c.json({ error: "Category not found" }, 404);

  const index = state.categories.findIndex(cat => cat.id === categoryId);
  if (index === -1) return c.json({ error: "Category not found" }, 404);

  state.categories.splice(index, 1);

  writeFileSync(join(getDataDir(), "state.json"), JSON.stringify(state, null, 2));

  return c.json({ success: true });
});

// ============ Linear Integration ============

const DEFAULT_TICKET_PROMPT = "Here is the ticket for this session: {{url}}\n\nPlease use the Linear MCP tool or fetch the URL to read the full ticket details before starting work.";

apiRoutes.get("/linear/config", (c) => {
  const config = loadConfig();
  return c.json({
    hasApiKey: !!config.apiKey,
    defaultTeamId: config.defaultTeamId,
    defaultBaseBranch: config.defaultBaseBranch || "main",
    createWorktree: config.createWorktree ?? true,
    ticketPromptTemplate: config.ticketPromptTemplate || DEFAULT_TICKET_PROMPT,
  });
});

apiRoutes.post("/linear/config", async (c) => {
  const body = await c.req.json();
  const config = loadConfig();

  if (body.apiKey !== undefined) config.apiKey = body.apiKey;
  if (body.defaultTeamId !== undefined) config.defaultTeamId = body.defaultTeamId;
  if (body.defaultBaseBranch !== undefined) config.defaultBaseBranch = body.defaultBaseBranch;
  if (body.createWorktree !== undefined) config.createWorktree = body.createWorktree;
  if (body.ticketPromptTemplate !== undefined) config.ticketPromptTemplate = body.ticketPromptTemplate;

  saveConfig(config);
  return c.json({ success: true });
});

apiRoutes.post("/linear/validate", async (c) => {
  const { apiKey } = await c.req.json();
  if (!apiKey) return c.json({ valid: false, error: "No API key provided" });

  try {
    const valid = await validateApiKey(apiKey);
    if (valid) {
      const user = await getCurrentUser(apiKey);
      return c.json({ valid: true, user });
    }
    return c.json({ valid: false, error: "Invalid API key" });
  } catch (e: any) {
    return c.json({ valid: false, error: e.message });
  }
});

apiRoutes.get("/linear/teams", async (c) => {
  const config = loadConfig();
  if (!config.apiKey) return c.json({ error: "Linear not configured" }, 400);

  try {
    const teams = await fetchTeams(config.apiKey);
    return c.json(teams);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

apiRoutes.get("/linear/tickets", async (c) => {
  const config = loadConfig();
  if (!config.apiKey) return c.json({ error: "Linear not configured" }, 400);

  const teamId = c.req.query("teamId") || config.defaultTeamId;

  try {
    const tickets = await fetchMyTickets(config.apiKey, teamId);
    return c.json(tickets);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

apiRoutes.get("/linear/search", async (c) => {
  const config = loadConfig();
  if (!config.apiKey) return c.json({ error: "Linear not configured" }, 400);

  const query = c.req.query("q");
  if (!query) return c.json({ error: "Search query required" }, 400);

  const teamId = c.req.query("teamId") || config.defaultTeamId;

  try {
    const tickets = await searchTickets(config.apiKey, query, teamId);
    return c.json(tickets);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

apiRoutes.get("/linear/ticket/:identifier", async (c) => {
  const config = loadConfig();
  if (!config.apiKey) return c.json({ error: "Linear not configured" }, 400);

  const identifier = c.req.param("identifier");

  try {
    const ticket = await fetchTicketByIdentifier(config.apiKey, identifier);
    if (!ticket) return c.json({ error: "Ticket not found" }, 404);
    return c.json(ticket);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ============ GitHub Integration ============

apiRoutes.get("/github/issues", async (c) => {
  const owner = c.req.query("owner");
  const repo = c.req.query("repo");
  const repoUrl = c.req.query("repoUrl");

  let resolvedOwner = owner;
  let resolvedRepo = repo;

  if (repoUrl && !owner && !repo) {
    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) return c.json({ error: "Invalid GitHub URL" }, 400);
    resolvedOwner = parsed.owner;
    resolvedRepo = parsed.repo;
  }

  if (!resolvedOwner || !resolvedRepo) {
    return c.json({ error: "owner and repo are required (or provide repoUrl)" }, 400);
  }

  try {
    const issues = await fetchGitHubIssues(resolvedOwner, resolvedRepo);
    return c.json(issues);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

apiRoutes.get("/github/search", async (c) => {
  const owner = c.req.query("owner");
  const repo = c.req.query("repo");
  const q = c.req.query("q");

  if (!owner || !repo) return c.json({ error: "owner and repo are required" }, 400);
  if (!q) return c.json({ error: "Search query (q) is required" }, 400);

  try {
    const issues = await searchGitHubIssues(owner, repo, q);
    return c.json(issues);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

apiRoutes.get("/github/issue/:owner/:repo/:number", async (c) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const number = parseInt(c.req.param("number"), 10);

  if (isNaN(number)) return c.json({ error: "Invalid issue number" }, 400);

  try {
    const issue = await fetchGitHubIssue(owner, repo, number);
    if (!issue) return c.json({ error: "Issue not found" }, 404);
    return c.json(issue);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
