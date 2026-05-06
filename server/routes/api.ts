import { Hono } from "hono";
import * as pty from "node-pty";
import { readdirSync, statSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { homedir, tmpdir } from "os";
import type { Agent } from "../types";
import { sessions, createSession, deleteSession, injectPluginDir, scanReposInDirectory, getServerPort, DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS } from "../services/sessionManager";
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
apiRoutes.get("/scan-repos", async (c) => {
  let path = c.req.query("path") || getLaunchCwd();

  if (path.startsWith("~")) {
    path = path.replace("~", homedir());
  }

  path = resolve(path);

  try {
    const repos = await scanReposInDirectory(path);
    return c.json({ repos });
  } catch (e: any) {
    return c.json({ error: e.message, repos: [] }, 400);
  }
});

// Markdown file discovery and reading
const MD_EXTS = new Set(["md", "markdown", "mdx"]);
const MD_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const MD_MAX_DEPTH = 4;
const MD_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo",
  "coverage", "__pycache__", ".cache", "release", ".venv", "venv",
]);

function expandPath(p: string): string {
  if (p.startsWith("~")) p = p.replace("~", homedir());
  return resolve(p);
}

function isMarkdownPath(p: string): boolean {
  const ext = p.includes(".") ? p.split(".").pop()!.toLowerCase() : "";
  return MD_EXTS.has(ext);
}

function walkMarkdown(
  root: string,
  results: { name: string; path: string; size: number; modified: number }[],
  depth: number,
): void {
  if (depth > MD_MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (MD_SKIP_DIRS.has(entry.name)) continue;
      walkMarkdown(full, results, depth + 1);
    } else if (entry.isFile() && isMarkdownPath(entry.name)) {
      try {
        const st = statSync(full);
        results.push({
          name: entry.name,
          path: full,
          size: st.size,
          modified: st.mtimeMs,
        });
      } catch {
        // skip unreadable files
      }
    }
  }
}

apiRoutes.get("/files/list", (c) => {
  const queryPath = c.req.query("path") || getLaunchCwd();
  const root = expandPath(queryPath);

  if (!existsSync(root)) {
    return c.json({ error: "Path not found", root }, 404);
  }

  const stat = statSync(root);
  if (!stat.isDirectory()) {
    return c.json({ error: "Not a directory", root }, 400);
  }

  const files: { name: string; path: string; size: number; modified: number }[] = [];
  walkMarkdown(root, files, 0);
  files.sort((a, b) => b.modified - a.modified);

  return c.json({ root, files });
});

apiRoutes.get("/files/read", (c) => {
  const queryPath = c.req.query("path");
  if (!queryPath) return c.json({ error: "path required" }, 400);

  const filePath = expandPath(queryPath);

  if (!isMarkdownPath(filePath)) {
    return c.json({ error: "Only markdown files are readable" }, 400);
  }

  if (!existsSync(filePath)) {
    return c.json({ error: "File not found", path: filePath }, 404);
  }

  const stat = statSync(filePath);
  if (!stat.isFile()) {
    return c.json({ error: "Not a file" }, 400);
  }
  if (stat.size > MD_MAX_BYTES) {
    return c.json({ error: `File too large (>${MD_MAX_BYTES} bytes)` }, 400);
  }

  try {
    const content = readFileSync(filePath, "utf8");
    return c.json({
      path: filePath,
      name: filePath.split("/").pop() || filePath,
      size: stat.size,
      modified: stat.mtimeMs,
      content,
    });
  } catch (e: any) {
    return c.json({ error: e.message || "Read failed" }, 500);
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
  const autoCareful = linearConfig.autoCareful;

  let result;
  try {
    result = await createSession({
      sessionId, agentId, agentName, command, cwd: workingDir, nodeId,
      customName, customColor, ticketId, ticketTitle, ticketUrl,
      branchName, baseBranch, createWorktreeFlag, ticketPromptTemplate,
      autoCareful, multiRepoMode, additionalRepos,
    });
  } catch (e: any) {
    // Probe Agent Error Log Trigger
    logError(`[PRBE_ERROR_acHsml] [api] Failed to create session: ${e.message}`);
    return c.json({ error: e.message }, 500);
  }

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

  const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/zsh";
  const cwd = existsSync(session.cwd) ? session.cwd : homedir();

  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(shell, ["--login"], {
      name: "xterm-256color",
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        OPENUI_SESSION_ID: sessionId,
        OPENUI_PORT: String(getServerPort()),
      } as Record<string, string>,
      cols: DEFAULT_PTY_COLS,
      rows: DEFAULT_PTY_ROWS,
    });
  } catch (e: any) {
    // Probe Agent Error Log Trigger
    logError(`[PRBE_ERROR_4hw6OQ] [session] Failed to restart PTY (shell=${shell}, cwd=${cwd}): ${e.message}`);
    return c.json({ error: `Failed to spawn terminal: ${e.message}` }, 500);
  }

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

  // Reset plugin status tracking for fresh session
  session.pluginReportedStatus = false;

  // PTY exit handler for restarted sessions
  ptyProcess.onExit(({ exitCode, signal }) => {
    log(`[session] Restarted PTY exited for ${sessionId} (code=${exitCode}, signal=${signal})`);
    session.status = "disconnected";
    session.pty = null;

    for (const client of session.clients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "exit", exitCode, signal }));
      }
    }
  });

  ptyProcess.onData((data: string) => {
    session.outputBuffer.push(data);
    if (session.outputBuffer.length > 1000) {
      session.outputBuffer.shift();
    }

    session.lastOutputTime = Date.now();
    session.recentOutputSize += data.length;

    // Auto-detect running status from PTY output when plugin hasn't reported yet
    if (session.status === "idle" && !session.pluginReportedStatus) {
      session.status = "running";
      for (const client of session.clients) {
        if (client.readyState === 1) {
          client.send(JSON.stringify({
            type: "status",
            status: "running",
            isRestored: session.isRestored,
          }));
        }
      }
    }

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
        // Only force waiting_input if we're still in a state where it makes sense
        // (pre_tool was set and status hasn't already moved past it)
        if (session!.preToolTime && (session!.status === "running" || session!.status === "tool_calling")) {
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
      }, 3500); // Increased from 2.5s to 3.5s — gives tools more time before flagging as stuck
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
    session.lastPluginStatusTime = Date.now();
    session.lastHookEvent = hookEvent;
    // Keep pluginReportedStatus true while plugin is actively reporting
    // but reset it on terminal states so auto-detect can recover if plugin dies
    if (effectiveStatus === "idle" || effectiveStatus === "disconnected" || effectiveStatus === "error") {
      session.pluginReportedStatus = false;
    } else {
      session.pluginReportedStatus = true;
    }

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

// Image upload endpoint - saves image to temp dir and returns the path
apiRoutes.post("/sessions/:sessionId/upload-image", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.parseBody();
  const file = body["image"];

  if (!file || !(file instanceof File)) {
    return c.json({ error: "No image file provided" }, 400);
  }

  const allowedTypes = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"];
  if (!allowedTypes.includes(file.type)) {
    return c.json({ error: "Unsupported image type" }, 400);
  }

  // Save to a session-specific temp directory
  const uploadDir = join(tmpdir(), "openui-uploads", sessionId);
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true });
  }

  const ext = file.name.split(".").pop() || "png";
  const safeName = `image-${Date.now()}.${ext}`;
  const filePath = join(uploadDir, safeName);

  const arrayBuffer = await file.arrayBuffer();
  writeFileSync(filePath, Buffer.from(arrayBuffer));

  log(`[upload] Saved image for ${sessionId}: ${filePath}`);
  return c.json({ success: true, filePath });
});

// General file upload — saves any file type into the session's cwd under
// .openui-uploads/, then types the resulting paths into the PTY so the agent
// can reference them. Accepts one or more files under the field name "files".
const UPLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50MB per file
const UPLOAD_MAX_FILES = 20;
const UPLOAD_BLOCKED_EXTS = new Set(["exe", "dmg", "app", "pkg", "msi"]);

apiRoutes.post("/sessions/:sessionId/upload", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.parseBody({ all: true });
  const raw = body["files"];
  const files: File[] = Array.isArray(raw)
    ? raw.filter((f): f is File => f instanceof File)
    : raw instanceof File
      ? [raw]
      : [];

  if (files.length === 0) {
    return c.json({ error: "No files provided" }, 400);
  }
  if (files.length > UPLOAD_MAX_FILES) {
    return c.json({ error: `Too many files (max ${UPLOAD_MAX_FILES})` }, 400);
  }

  const uploadDir = join(session.cwd, ".openui-uploads");
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true });
  }

  const saved: string[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const file of files) {
    if (file.size > UPLOAD_MAX_BYTES) {
      skipped.push({ name: file.name, reason: "too large (>50MB)" });
      continue;
    }

    const rawName = file.name || `file-${Date.now()}`;
    const ext = rawName.includes(".") ? rawName.split(".").pop()!.toLowerCase() : "";
    if (ext && UPLOAD_BLOCKED_EXTS.has(ext)) {
      skipped.push({ name: rawName, reason: `blocked type (.${ext})` });
      continue;
    }

    // Sanitize: strip path components and collapse anything that isn't safe.
    // Collision-proof by prefixing a short timestamp.
    const basename = rawName.replace(/^.*[\\/]/, "").replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
    const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${basename}`;
    const filePath = join(uploadDir, safeName);

    try {
      const arrayBuffer = await file.arrayBuffer();
      writeFileSync(filePath, Buffer.from(arrayBuffer));
      saved.push(filePath);
    } catch (e: any) {
      skipped.push({ name: rawName, reason: e.message || "write failed" });
    }
  }

  // Inject the saved paths into the PTY so the agent sees them as an attachment.
  // No trailing Enter — the user types their question and submits themselves.
  if (saved.length > 0 && session.pty) {
    const injection = saved.map((p) => `${p} `).join("");
    session.pty.write(injection);
    session.lastInputTime = Date.now();
  }

  log(`[upload] Saved ${saved.length}/${files.length} files for ${sessionId} in ${uploadDir}`);
  return c.json({
    success: saved.length > 0,
    saved,
    skipped,
    uploadDir,
  });
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
    autoCareful: config.autoCareful ?? true,
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
  if (body.autoCareful !== undefined) config.autoCareful = body.autoCareful;
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
