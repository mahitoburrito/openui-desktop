import { exec as execCb } from "child_process";
import { promisify } from "util";
import * as pty from "node-pty";
import { existsSync, mkdirSync, readdirSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import type { Session, DetectedRepo } from "../types";
import { loadBuffer, loadState } from "./persistence";

const execAsync = promisify(execCb);

const QUIET = !!process.env.OPENUI_QUIET;
const log = QUIET ? (..._args: any[]) => {} : console.log.bind(console);
const logError = QUIET ? (..._args: any[]) => {} : console.error.bind(console);

export const DEFAULT_PTY_COLS = 80;
export const DEFAULT_PTY_ROWS = 24;

// Get the OpenUI plugin directory path
function getPluginDir(): string | null {
  const homePluginDir = join(homedir(), ".openui", "claude-code-plugin");
  const homePluginJson = join(homePluginDir, ".claude-plugin", "plugin.json");
  if (existsSync(homePluginJson)) {
    return homePluginDir;
  }

  // Packaged Electron app: extraResources copies plugin to process.resourcesPath
  try {
    const resourcesPlugin = join(process.resourcesPath, "claude-code-plugin");
    const resourcesPluginJson = join(resourcesPlugin, ".claude-plugin", "plugin.json");
    if (existsSync(resourcesPluginJson)) {
      return resourcesPlugin;
    }
  } catch {
    // process.resourcesPath may not exist outside Electron
  }

  // Dev mode / npm package: walk up from compiled output to find project root
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    dir = join(dir, "..");
    const candidate = join(dir, "claude-code-plugin", ".claude-plugin", "plugin.json");
    if (existsSync(candidate)) {
      return join(dir, "claude-code-plugin");
    }
  }

  return null;
}

// Inject --plugin-dir flag for Claude commands if plugin is available
export function injectPluginDir(command: string, agentId: string): string {
  if (agentId !== "claude") return command;

  const pluginDir = getPluginDir();
  if (!pluginDir) return command;

  if (command.includes("--plugin-dir")) return command;

  const parts = command.split(/\s+/);
  if (parts[0] === "claude") {
    parts.splice(1, 0, `--plugin-dir`, pluginDir);
    const finalCmd = parts.join(" ");
    log(`[plugin] Injecting plugin-dir: ${pluginDir}`);
    return finalCmd;
  }

  return command;
}

// Get git branch for a directory
async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

// Get git root directory
async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git rev-parse --show-toplevel", { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

// Get the main worktree (mother repo) path
async function getMainWorktree(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git worktree list --porcelain", { cwd });
    const match = stdout.match(/^worktree (.+)$/m);
    if (match) {
      return match[1];
    }
  } catch {
    // Not a git repo
  }
  return null;
}

// Create a git worktree for a branch
export async function createWorktree(params: {
  cwd: string;
  branchName: string;
  baseBranch: string;
}): Promise<{ success: boolean; worktreePath?: string; error?: string }> {
  const { cwd, branchName, baseBranch } = params;
  const gitRoot = await getGitRoot(cwd);

  if (!gitRoot) {
    return { success: false, error: "Not a git repository" };
  }

  const repoName = basename(gitRoot);
  const worktreesDir = join(gitRoot, "..", `${repoName}-worktrees`);

  if (!existsSync(worktreesDir)) {
    mkdirSync(worktreesDir, { recursive: true });
  }

  const dirName = branchName.replace(/\//g, "-");
  const worktreePath = join(worktreesDir, dirName);

  if (existsSync(worktreePath)) {
    try {
      const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: worktreePath });
      const currentBranch = stdout.trim();
      if (currentBranch === branchName) {
        return { success: true, worktreePath };
      }
      return { success: false, error: `Worktree directory already exists at ${worktreePath} but is on branch '${currentBranch}', not '${branchName}'` };
    } catch {
      return { success: false, error: `Worktree directory exists at ${worktreePath} but is not a valid git worktree` };
    }
  }

  try {
    await execAsync("git fetch origin", { cwd: gitRoot });
  } catch {
    // Ignore fetch errors
  }

  try {
    // Try local branch first
    try {
      await execAsync(`git rev-parse --verify ${branchName}`, { cwd: gitRoot });
      await execAsync(`git worktree add "${worktreePath}" ${branchName}`, { cwd: gitRoot });
    } catch {
      // Try remote branch
      try {
        await execAsync(`git rev-parse --verify origin/${branchName}`, { cwd: gitRoot });
        await execAsync(`git worktree add --track -b ${branchName} "${worktreePath}" origin/${branchName}`, { cwd: gitRoot });
      } catch {
        // Create new branch from base
        await execAsync(`git worktree add -b ${branchName} "${worktreePath}" origin/${baseBranch}`, { cwd: gitRoot });
      }
    }

    return { success: true, worktreePath };
  } catch (e: any) {
    // Probe Agent Error Log Trigger
    logError("[PRBE_ERROR_EgPYEx] [worktree] Failed:", e.message);
    return { success: false, error: e.message };
  }
}

// Preserve working state by stashing uncommitted changes
async function preserveWorkingState(gitRoot: string): Promise<{ method: 'stash' | 'commit' | 'clean'; stashRef?: string }> {
  try {
    const { stdout } = await execAsync("git status --porcelain", { cwd: gitRoot });
    const statusOutput = stdout.trim();

    if (!statusOutput) {
      return { method: 'clean' };
    }

    const stashMsg = `openui-preserve-${Date.now()}`;
    try {
      await execAsync(`git stash push -m "${stashMsg}" --include-untracked`, { cwd: gitRoot });
      log(`[worktree] Stashed changes in ${gitRoot}: ${stashMsg}`);
      return { method: 'stash', stashRef: stashMsg };
    } catch {
      try {
        await execAsync('git add -A', { cwd: gitRoot });
        await execAsync('git commit -am "openui: preserve WIP [skip ci]"', { cwd: gitRoot });
        log(`[worktree] Auto-committed changes in ${gitRoot}`);
        return { method: 'commit' };
      } catch {
        // Probe Agent Error Log Trigger
        logError(`[PRBE_ERROR_jT5sFi] [worktree] Failed to preserve state in ${gitRoot}`);
        return { method: 'clean' };
      }
    }
  } catch {
    return { method: 'clean' };
  }
}

// Scan a directory for child git repositories
export async function scanReposInDirectory(dirPath: string): Promise<DetectedRepo[]> {
  const repos: DetectedRepo[] = [];

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const entryPath = join(dirPath, entry.name);
      const gitPath = join(entryPath, ".git");

      if (!existsSync(gitPath)) continue;

      const name = entry.name;
      const branch = (await getGitBranch(entryPath)) || "unknown";

      let dirty = false;
      try {
        const { stdout } = await execAsync("git status --porcelain", { cwd: entryPath });
        dirty = stdout.trim().length > 0;
      } catch {}

      let defaultBranch = "main";
      try {
        const { stdout } = await execAsync("git symbolic-ref refs/remotes/origin/HEAD", { cwd: entryPath });
        defaultBranch = stdout.trim().replace("refs/remotes/origin/", "");
      } catch {}

      repos.push({ name, path: entryPath, branch, dirty, defaultBranch });
    }
  } catch (e) {
    // Probe Agent Error Log Trigger
    logError(`[PRBE_ERROR_qf7a3F] [scan] Failed to scan ${dirPath}:`, e);
  }

  return repos;
}

// Create worktrees across multiple repos
export async function createMultiRepoWorktrees(params: {
  repos: { name: string; path: string; defaultBranch?: string }[];
  branchName: string;
  mode: 'current' | 'main';
  baseBranch: string;
}): Promise<{
  worktreePaths: Record<string, string>;
  stashRefs: Record<string, string>;
  errors: Record<string, string>;
}> {
  const { repos, branchName, mode, baseBranch } = params;
  const worktreePaths: Record<string, string> = {};
  const stashRefs: Record<string, string> = {};
  const errors: Record<string, string> = {};

  for (const repo of repos) {
    const preserveResult = await preserveWorkingState(repo.path);
    if (preserveResult.stashRef) {
      stashRefs[repo.name] = preserveResult.stashRef;
    }

    let repoBaseBranch: string;
    if (mode === 'current') {
      repoBaseBranch = (await getGitBranch(repo.path)) || baseBranch;
    } else {
      repoBaseBranch = repo.defaultBranch || baseBranch;
    }

    const result = await createWorktree({
      cwd: repo.path,
      branchName,
      baseBranch: repoBaseBranch,
    });

    if (result.success && result.worktreePath) {
      worktreePaths[repo.name] = result.worktreePath;
      log(`[multi-worktree] Created worktree for ${repo.name}: ${result.worktreePath}`);
    } else {
      errors[repo.name] = result.error || "Unknown error";
      // Probe Agent Error Log Trigger
      logError(`[PRBE_ERROR_DaKFLF] [multi-worktree] Failed for ${repo.name}: ${result.error}`);
    }
  }

  return { worktreePaths, stashRefs, errors };
}

const MAX_BUFFER_SIZE = 5000;

export const sessions = new Map<string, Session>();

// Actual port the server is listening on — set by setServerPort() after bind
let serverPort: number = 6968;
export function setServerPort(port: number) { serverPort = port; }
export function getServerPort(): number { return serverPort; }

export function getActiveSessionCount(): number {
  let count = 0;
  for (const [, session] of sessions) {
    if (session.pty) count++;
  }
  return count;
}

export async function createSession(params: {
  sessionId: string;
  agentId: string;
  agentName: string;
  command: string;
  cwd: string;
  nodeId: string;
  customName?: string;
  customColor?: string;
  ticketId?: string;
  ticketTitle?: string;
  ticketUrl?: string;
  branchName?: string;
  baseBranch?: string;
  createWorktreeFlag?: boolean;
  ticketPromptTemplate?: string;
  autoCareful?: boolean;
  multiRepoMode?: 'current' | 'main';
  additionalRepos?: { name: string; path: string; defaultBranch?: string }[];
}): Promise<{ session: Session; cwd: string; gitBranch?: string }> {
  const {
    sessionId,
    agentId,
    agentName,
    command,
    cwd: originalCwd,
    nodeId,
    customName,
    customColor,
    ticketId,
    ticketTitle,
    ticketUrl,
    branchName,
    baseBranch,
    createWorktreeFlag,
    ticketPromptTemplate,
    autoCareful,
    multiRepoMode,
    additionalRepos,
  } = params;

  let workingDir = originalCwd;
  let worktreePath: string | undefined;
  let mainRepoPath: string | undefined;
  let gitBranch: string | null = null;
  let worktreePaths: Record<string, string> | undefined;
  let stashRefs: Record<string, string> | undefined;
  let worktreeMode: 'current' | 'main' | undefined;

  if (createWorktreeFlag && branchName && baseBranch) {
    if (additionalRepos && additionalRepos.length > 0 && multiRepoMode) {
      const multiResult = await createMultiRepoWorktrees({
        repos: additionalRepos,
        branchName,
        mode: multiRepoMode,
        baseBranch,
      });

      worktreePaths = multiResult.worktreePaths;
      stashRefs = Object.keys(multiResult.stashRefs).length > 0 ? multiResult.stashRefs : undefined;
      worktreeMode = multiRepoMode;
      gitBranch = branchName;

      log(`[session] Multi-repo worktrees created: ${Object.keys(worktreePaths).join(', ')}`);

      for (const [repoName, error] of Object.entries(multiResult.errors)) {
        // Probe Agent Error Log Trigger
        logError(`[PRBE_ERROR_H1Xq5O] [session] Worktree failed for ${repoName}: ${error}`);
      }
    } else {
      const result = await createWorktree({ cwd: originalCwd, branchName, baseBranch });
      if (result.success && result.worktreePath) {
        workingDir = result.worktreePath;
        worktreePath = result.worktreePath;
        mainRepoPath = originalCwd;
        gitBranch = branchName;
      }
    }
  }

  if (!mainRepoPath) {
    const detectedMainRepo = await getMainWorktree(workingDir);
    if (detectedMainRepo && detectedMainRepo !== workingDir) {
      mainRepoPath = detectedMainRepo;
    }
  }

  if (!gitBranch) {
    gitBranch = await getGitBranch(workingDir);
  }

  // Validate working directory exists before spawning
  if (!existsSync(workingDir)) {
    log(`[session] Working directory does not exist: ${workingDir}, falling back to home`);
    workingDir = homedir();
  }

  // Use the user's default shell and spawn as login shell to source their profile
  const shell = process.platform === "win32"
    ? "powershell.exe"
    : process.env.SHELL || "/bin/zsh";

  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(shell, ["--login"], {
      name: "xterm-256color",
      cwd: workingDir,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        OPENUI_SESSION_ID: sessionId,
        OPENUI_PORT: String(serverPort),
      } as Record<string, string>,
      cols: DEFAULT_PTY_COLS,
      rows: DEFAULT_PTY_ROWS,
    });
  } catch (e: any) {
    // Probe Agent Error Log Trigger
    logError(`[PRBE_ERROR_nsfUhY] [session] Failed to spawn PTY (shell=${shell}, cwd=${workingDir}): ${e.message}`);
    throw new Error(`Failed to spawn terminal: ${e.message}. Shell: ${shell}, CWD: ${workingDir}`);
  }

  const now = Date.now();
  const session: Session = {
    pty: ptyProcess,
    agentId,
    agentName,
    command,
    cwd: workingDir,
    originalCwd: mainRepoPath,
    gitBranch: gitBranch || undefined,
    worktreePath,
    worktreePaths,
    worktreeMode,
    stashRefs,
    createdAt: new Date().toISOString(),
    clients: new Set(),
    outputBuffer: [],
    status: "idle",
    lastOutputTime: now,
    lastInputTime: 0,
    recentOutputSize: 0,
    customName,
    customColor,
    nodeId,
    isRestored: false,
    ticketId,
    ticketTitle,
    ticketUrl,
  };

  sessions.set(sessionId, session);

  // Output decay + stale status watchdog
  const resetInterval = setInterval(() => {
    if (!sessions.has(sessionId) || !session.pty) {
      clearInterval(resetInterval);
      return;
    }
    session.recentOutputSize = Math.max(0, session.recentOutputSize - 50);

    // Watchdog: if plugin hasn't reported in 30s and session looks stuck, reset the lock
    // so PTY-based auto-detect can kick back in
    const now = Date.now();
    if (session.pluginReportedStatus && session.lastPluginStatusTime) {
      const silentFor = now - session.lastPluginStatusTime;
      if (silentFor > 30000) {
        log(`[watchdog] Plugin silent for ${Math.round(silentFor / 1000)}s on ${sessionId}, resetting pluginReportedStatus`);
        session.pluginReportedStatus = false;
      }
    }

    // Watchdog: if status is "running" or "tool_calling" but no PTY output for 60s,
    // transition to "idle" so the UI doesn't look frozen
    if ((session.status === "running" || session.status === "tool_calling") && session.lastOutputTime) {
      const outputSilent = now - session.lastOutputTime;
      if (outputSilent > 60000) {
        log(`[watchdog] No output for ${Math.round(outputSilent / 1000)}s on ${sessionId}, transitioning to idle`);
        session.status = "idle";
        session.currentTool = undefined;
        for (const client of session.clients) {
          if (client.readyState === 1) {
            client.send(JSON.stringify({
              type: "status",
              status: "idle",
              isRestored: session.isRestored,
            }));
          }
        }
      }
    }
  }, 500);

  // PTY exit handler — detect when Claude goes offline
  ptyProcess.onExit(({ exitCode, signal }) => {
    log(`[session] PTY exited for ${sessionId} (code=${exitCode}, signal=${signal})`);
    session.status = "disconnected";
    session.pty = null;

    for (const client of session.clients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "exit", exitCode, signal }));
      }
    }
  });

  // PTY output handler
  ptyProcess.onData((data: string) => {
    session.outputBuffer.push(data);
    if (session.outputBuffer.length > MAX_BUFFER_SIZE) {
      session.outputBuffer.shift();
    }

    session.lastOutputTime = Date.now();
    session.recentOutputSize += data.length;

    // Auto-detect running status from PTY output
    // Works when plugin hasn't reported yet OR when plugin has gone silent
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

  // Run the command
  const finalCommand = injectPluginDir(command, agentId);
  log(`[pty-write] Writing command: ${finalCommand}`);
  setTimeout(() => {
    ptyProcess.write(`${finalCommand}\r`);

    // Enable /careful for Claude Code sessions on startup (if enabled in settings)
    if (agentId === "claude" && autoCareful !== false) {
      setTimeout(() => {
        ptyProcess.write("/careful\r");
      }, 2000);
    }

    if (ticketUrl) {
      const ticketDelay = agentId === "claude" ? 4000 : 2000;
      setTimeout(() => {
        const defaultTemplate = "Here is the ticket for this session: {{url}}\n\nPlease use the Linear MCP tool or fetch the URL to read the full ticket details before starting work.";
        const template = ticketPromptTemplate || defaultTemplate;
        const ticketPrompt = template
          .replace(/\{\{url\}\}/g, ticketUrl)
          .replace(/\{\{id\}\}/g, ticketId || "")
          .replace(/\{\{title\}\}/g, ticketTitle || "");
        ptyProcess.write(ticketPrompt + "\r");
      }, ticketDelay);
    }

    // If multi-repo worktrees were created, inject context
    if (worktreePaths && Object.keys(worktreePaths).length > 1) {
      const baseDelay = agentId === "claude" ? 4000 : 2000;
      const delay = ticketUrl ? baseDelay + 2000 : baseDelay;
      setTimeout(() => {
        const repoLines = Object.entries(worktreePaths!)
          .map(([name, path]) => `- ${name}: ${path}`)
          .join("\n");
        const contextPrompt = `This session has worktrees across multiple repos:\n${repoLines}\n\nAll repos are on branch: ${branchName}\nCoordinate changes across all repos as needed.`;
        ptyProcess.write(contextPrompt + "\r");
      }, delay);
    }
  }, 300);

  log(`[session] Created ${sessionId} for ${agentName}${ticketId ? ` (ticket: ${ticketId})` : ""}`);
  return { session, cwd: workingDir, gitBranch: gitBranch || undefined };
}

export function deleteSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  if (session.pty) session.pty.kill();
  if (session.stateTrackerPty) session.stateTrackerPty.kill();

  sessions.delete(sessionId);
  log(`[session] Killed ${sessionId}`);
  return true;
}

export async function restoreSessions() {
  const state = loadState();

  log(`[restore] Found ${state.nodes.length} saved sessions`);

  for (const node of state.nodes) {
    const buffer = loadBuffer(node.sessionId);
    const gitBranch = await getGitBranch(node.cwd);

    const session: Session = {
      pty: null,
      agentId: node.agentId,
      agentName: node.agentName,
      command: node.command,
      cwd: node.cwd,
      originalCwd: node.originalCwd,
      gitBranch: gitBranch || undefined,
      createdAt: node.createdAt,
      clients: new Set(),
      outputBuffer: buffer,
      status: "disconnected",
      lastOutputTime: 0,
      lastInputTime: 0,
      recentOutputSize: 0,
      customName: node.customName,
      customColor: node.customColor,
      notes: node.notes,
      nodeId: node.nodeId,
      isRestored: true,
      worktreePaths: node.worktreePaths,
    };

    sessions.set(node.sessionId, session);
    log(`[restore] Restored ${node.sessionId} (${node.agentName}) branch: ${gitBranch || "none"}`);
  }
}
