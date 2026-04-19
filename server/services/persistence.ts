import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { PersistedState, Session } from "../types";

// Use local .openui-desktop folder where user ran from
// Resolved lazily so LAUNCH_CWD env var is available after Electron app.whenReady()
import { homedir } from "os";

export function getDataDir(): string {
  const launchCwd = process.env.LAUNCH_CWD || homedir();
  return join(launchCwd, ".openui-desktop");
}

function getStateFile(): string {
  return join(getDataDir(), "state.json");
}

function getBuffersDir(): string {
  return join(getDataDir(), "buffers");
}

function ensureDirs() {
  const dataDir = getDataDir();
  const buffersDir = getBuffersDir();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (!existsSync(buffersDir)) mkdirSync(buffersDir, { recursive: true });
}

export function loadState(): PersistedState {
  ensureDirs();
  try {
    const stateFile = getStateFile();
    if (existsSync(stateFile)) {
      const data = JSON.parse(readFileSync(stateFile, "utf-8"));
      console.log(`[persistence] Loaded state from ${stateFile}`);
      return data;
    }
  } catch (e) {
    console.error("Failed to load state:", e);
  }
  return { nodes: [] };
}

export function saveState(sessions: Map<string, Session>) {
  ensureDirs();
  const savedState = loadState();

  const state: PersistedState = {
    nodes: [],
    categories: savedState.categories || [],
  };

  for (const [sessionId, session] of sessions) {
    const existingNode = savedState.nodes.find(n => n.sessionId === sessionId);

    state.nodes.push({
      nodeId: session.nodeId,
      sessionId,
      agentId: session.agentId,
      agentName: session.agentName,
      command: session.command,
      cwd: session.cwd,
      originalCwd: session.originalCwd,
      createdAt: session.createdAt,
      customName: session.customName,
      customColor: session.customColor,
      notes: session.notes,
      icon: session.icon,
      position: session.position || existingNode?.position || { x: 0, y: 0 },
      worktreePaths: session.worktreePaths,
    });

    saveBuffer(sessionId, session.outputBuffer);
  }

  try {
    writeFileSync(getStateFile(), JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("Failed to save state:", e);
  }
}

export function savePositions(positions: Record<string, { x: number; y: number }>) {
  ensureDirs();
  const state = loadState();

  let updated = 0;
  for (const [nodeId, pos] of Object.entries(positions)) {
    const node = state.nodes.find(n => n.nodeId === nodeId);
    if (node) {
      node.position = pos;
      updated++;
    }
  }

  if (updated > 0) {
    try {
      writeFileSync(getStateFile(), JSON.stringify(state, null, 2));
    } catch (e) {
      // Probe Agent Error Log Trigger
      console.error("[PRBE_ERROR_kq1HPK] Failed to save positions:", e);
    }
  }
}

export function saveBuffer(sessionId: string, buffer: string[]) {
  ensureDirs();
  const bufferFile = join(getBuffersDir(), `${sessionId}.txt`);
  try {
    writeFileSync(bufferFile, buffer.join(""));
  } catch (e) {
    console.error("Failed to save buffer:", e);
  }
}

export function loadBuffer(sessionId: string): string[] {
  ensureDirs();
  const bufferFile = join(getBuffersDir(), `${sessionId}.txt`);
  try {
    if (existsSync(bufferFile)) {
      return [readFileSync(bufferFile, "utf-8")];
    }
  } catch (e) {
    console.error("Failed to load buffer:", e);
  }
  return [];
}

