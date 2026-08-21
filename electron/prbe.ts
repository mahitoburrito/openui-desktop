import { BrowserWindow, ipcMain, app } from "electron";
import {
  PRBEAgent,
  PRBEAgentConfigKey,
  PRBEStateEvent,
  ToolParamType,
  serializePRBEState,
} from "@prbe.ai/electron-sdk";
import type {
  InteractionPayload,
  InteractionResponse,
} from "@prbe.ai/electron-sdk";
import { loadPRBEConfig } from "../server/services/prbe";

let agent: PRBEAgent | null = null;
let mainWindowRef: BrowserWindow | null = null;
let serverPortRef: number = 6968;

const COORDINATOR_PREAMBLE = `You are the OpenUI workspace Coordinator. Monitor coding-agent sessions and help the user keep their work consistent. Inspect current coordination state before acting. Use exact session IDs for every mutation. Record durable decisions when multiple agents need the same conclusion. Send concise directives only when they are necessary, and explain queued or unconfirmed delivery honestly. Never infer that terminal submission means an agent understood the directive. Do not answer permission prompts, perform destructive lifecycle actions, ship, deploy, merge, or broaden scope without the user's explicit instruction.`;

// Pending interaction resolvers (interaction id → resolve function)
const pendingInteractions = new Map<string, (response: InteractionResponse) => void>();

function send(channel: string, ...args: any[]) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, ...args);
  }
}

async function coordinatorRequest(path: string, init?: RequestInit): Promise<string> {
  const response = await fetch(`http://localhost:${serverPortRef}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const body: any = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return JSON.stringify(body, null, 2);
}

function createAgent(apiKey: string): PRBEAgent {
  // Dispose previous agent
  if (agent) {
    agent.cancel();
  }

  const newAgent = new PRBEAgent({
    [PRBEAgentConfigKey.API_KEY]: apiKey,
    [PRBEAgentConfigKey.AUTO_APPROVED_DIRS]: [
      app.getPath("userData"),
      app.getAppPath(),
    ],
    [PRBEAgentConfigKey.CAPTURE_CONSOLE]: true,
    [PRBEAgentConfigKey.IPC_MAIN]: ipcMain,
    [PRBEAgentConfigKey.BACKGROUND_POLLING]: false,
    [PRBEAgentConfigKey.INTERACTION_HANDLER]: {
      async handleInteraction(payload: InteractionPayload): Promise<InteractionResponse> {
        send("prbe:interaction-request", payload);
        return new Promise<InteractionResponse>((resolve) => {
          pendingInteractions.set(payload.interactionId, resolve);
        });
      },
    },
  });

  // Forward state events to renderer
  newAgent.state.on(PRBEStateEvent.STATUS, () => {
    send("prbe:state-update", serializePRBEState(newAgent.state));
  });

  newAgent.state.on(PRBEStateEvent.COMPLETE, () => {
    send("prbe:complete", {
      report: newAgent.state.report,
      summary: newAgent.state.summary,
    });
  });

  newAgent.state.on(PRBEStateEvent.ERROR, (payload: { message: string }) => {
    send("prbe:error", payload);
  });

  newAgent.state.on(PRBEStateEvent.AGENT_MESSAGE, (payload: { message: string }) => {
    send("prbe:agent-message", payload);
  });

  // Register OpenUI-specific custom tools
  registerCustomTools(newAgent);

  console.log("[prbe] Agent initialized");
  return newAgent;
}

function registerCustomTools(agent: PRBEAgent) {
  agent.registerTool(
    "list_active_sessions",
    "List all active OpenUI agent sessions with their status, agent type, working directory, and branch",
    [],
    async () => {
      try {
        const res = await fetch(`http://localhost:${serverPortRef}/api/sessions`);
        const sessions = await res.json();
        return JSON.stringify(sessions, null, 2);
      } catch (e: any) {
        return `Error fetching sessions: ${e.message}`;
      }
    },
  );

  agent.registerTool(
    "get_session_status",
    "Get detailed status of a specific OpenUI agent session including current tool and hook event",
    [
      {
        name: "sessionId",
        type: ToolParamType.STRING,
        description: "The session ID to check status for",
        required: true,
      },
    ],
    async (args) => {
      try {
        const sessionId = args.sessionId as string;
        const res = await fetch(`http://localhost:${serverPortRef}/api/sessions/${sessionId}/status`);
        const status = await res.json();
        return JSON.stringify(status, null, 2);
      } catch (e: any) {
        return `Error fetching session status: ${e.message}`;
      }
    },
  );

  agent.registerTool(
    "read_session_output",
    "Read the terminal output buffer of a specific OpenUI agent session to see what the agent has been doing",
    [
      {
        name: "sessionId",
        type: ToolParamType.STRING,
        description: "The session ID to read output from",
        required: true,
      },
    ],
    async (args) => {
      try {
        const sessionId = args.sessionId as string;
        // Read from the persisted buffer file
        const { join } = await import("path");
        const { existsSync, readFileSync } = await import("fs");
        const { homedir } = await import("os");

        const launchCwd = process.env.LAUNCH_CWD || homedir();
        const bufferFile = join(launchCwd, ".openui-desktop", "buffers", `${sessionId}.txt`);

        if (existsSync(bufferFile)) {
          const content = readFileSync(bufferFile, "utf-8");
          // Return last 5000 chars to avoid overwhelming the agent
          if (content.length > 5000) {
            return `[truncated to last 5000 chars]\n${content.slice(-5000)}`;
          }
          return content || "(empty output buffer)";
        }
        return "(no output buffer found for this session)";
      } catch (e: any) {
        return `Error reading session output: ${e.message}`;
      }
    },
  );

  agent.registerTool(
    "get_session_activity",
    "Read recent structured command activity for one exact OpenUI session. Prefer this over raw terminal output when coordinating work.",
    [
      {
        name: "sessionId",
        type: ToolParamType.STRING,
        description: "Exact session ID returned by list_active_sessions",
        required: true,
      },
    ],
    async (args) => {
      try {
        const sessionId = encodeURIComponent(args.sessionId as string);
        return await coordinatorRequest(`/api/sessions/${sessionId}/blocks?limit=12`);
      } catch (e: any) {
        return `Error reading session activity: ${e.message}`;
      }
    },
  );

  agent.registerTool(
    "get_coordination_state",
    "Get the authoritative Coordinator snapshot: session readiness, active decisions, directive queues, and recent coordination events.",
    [],
    async () => {
      try {
        return await coordinatorRequest("/api/coordinator/snapshot");
      } catch (e: any) {
        return `Error fetching coordination state: ${e.message}`;
      }
    },
  );

  agent.registerTool(
    "record_decision",
    "Record a durable, versioned decision shared across the workspace. If the topic already has an active decision, pass its exact ID as supersedes.",
    [
      { name: "topic", type: ToolParamType.STRING, description: "Stable decision topic", required: true },
      { name: "choice", type: ToolParamType.STRING, description: "The chosen direction", required: true },
      { name: "rationale", type: ToolParamType.STRING, description: "Why this choice was made", required: true },
      { name: "sessionIds", type: ToolParamType.STRING, description: "Optional comma-separated exact session IDs; omit for workspace scope", required: false },
      { name: "supersedes", type: ToolParamType.STRING, description: "Exact active decision ID this replaces", required: false },
    ],
    async (args) => {
      try {
        const sessionIds = typeof args.sessionIds === "string"
          ? args.sessionIds.split(",").map((item) => item.trim()).filter(Boolean)
          : [];
        return await coordinatorRequest("/api/coordinator/decisions", {
          method: "POST",
          body: JSON.stringify({
            topic: args.topic,
            choice: args.choice,
            rationale: args.rationale,
            scope: sessionIds.length > 0 ? { kind: "sessions", sessionIds } : { kind: "workspace" },
            supersedes: args.supersedes || undefined,
            author: "coordinator",
          }),
        });
      } catch (e: any) {
        return `Decision was not recorded: ${e.message}`;
      }
    },
  );

  agent.registerTool(
    "send_directive",
    "Queue a directive for one exact OpenUI session. Delivery is idle-only and remains unconfirmed until acknowledged. Never use a display title as the target.",
    [
      { name: "sessionId", type: ToolParamType.STRING, description: "Exact target session ID", required: true },
      { name: "text", type: ToolParamType.STRING, description: "Concise directive for the worker agent", required: true },
      { name: "decisionId", type: ToolParamType.STRING, description: "Optional active decision ID supporting the directive", required: false },
      { name: "clientRequestId", type: ToolParamType.STRING, description: "Optional stable idempotency key for retry safety", required: false },
    ],
    async (args) => {
      try {
        return await coordinatorRequest("/api/coordinator/directives", {
          method: "POST",
          body: JSON.stringify({
            sessionId: args.sessionId,
            text: args.text,
            decisionId: args.decisionId || undefined,
            clientRequestId: args.clientRequestId || undefined,
            author: "coordinator",
          }),
        });
      } catch (e: any) {
        return `Directive was not queued: ${e.message}`;
      }
    },
  );

  agent.registerTool(
    "acknowledge_directive",
    "Explicitly acknowledge a submitted directive after its target agent has confirmed incorporating it. Do not call this from terminal submission alone.",
    [
      { name: "directiveId", type: ToolParamType.STRING, description: "Exact directive ID", required: true },
    ],
    async (args) => {
      try {
        const directiveId = encodeURIComponent(args.directiveId as string);
        return await coordinatorRequest(`/api/coordinator/directives/${directiveId}/acknowledge`, {
          method: "POST",
          body: "{}",
        });
      } catch (e: any) {
        return `Directive was not acknowledged: ${e.message}`;
      }
    },
  );
}

export function initPRBE(mainWindow: BrowserWindow, serverPort: number) {
  mainWindowRef = mainWindow;
  serverPortRef = serverPort;

  // Try to auto-initialize if API key exists
  const config = loadPRBEConfig();
  if (config.apiKey) {
    agent = createAgent(config.apiKey);
  }

  // IPC handlers
  ipcMain.handle("prbe:initialize", async () => {
    const config = loadPRBEConfig();
    if (!config.apiKey) {
      return { success: false, error: "No API key configured" };
    }
    agent = createAgent(config.apiKey);
    return { success: true };
  });

  ipcMain.handle("prbe:start-investigation", async (_event, { query }: { query: string }) => {
    if (!agent) {
      return { success: false, error: "PRBE agent not initialized" };
    }
    try {
      // Run investigation (non-blocking — we don't await it)
      agent.investigate(`${COORDINATOR_PREAMBLE}\n\nUser directive:\n${query}`).catch((err) => {
        // Probe Agent Error Log Trigger
        console.error("[PRBE_ERROR_2LceT6] [prbe] Investigation error:", err);
      });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("prbe:stop-investigation", async () => {
    if (agent) {
      agent.cancel();
    }
    return { success: true };
  });

  ipcMain.handle("prbe:respond-interaction", async (_event, { interactionId, response }: { interactionId: string; response: InteractionResponse }) => {
    const resolver = pendingInteractions.get(interactionId);
    if (resolver) {
      resolver(response);
      pendingInteractions.delete(interactionId);
      return { success: true };
    }
    return { success: false, error: "No pending interaction with that ID" };
  });

  ipcMain.handle("prbe:send-message", async (_event, { message }: { message: string }) => {
    if (agent) {
      agent.sendConversationMessage(message);
      return { success: true };
    }
    return { success: false, error: "PRBE agent not initialized" };
  });

  ipcMain.handle("prbe:get-state", async () => {
    if (agent) {
      return serializePRBEState(agent.state);
    }
    return null;
  });

  ipcMain.handle("prbe:is-available", async () => {
    const config = loadPRBEConfig();
    return { hasApiKey: !!config.apiKey, isInitialized: !!agent };
  });

  console.log("[prbe] IPC handlers registered");
}

export function cleanupPRBE() {
  if (agent) {
    agent.cancel();
    agent = null;
  }
  pendingInteractions.clear();
}
