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

// Pending interaction resolvers (interaction id → resolve function)
const pendingInteractions = new Map<string, (response: InteractionResponse) => void>();

function send(channel: string, ...args: any[]) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, ...args);
  }
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
      agent.investigate(query).catch((err) => {
        // Probe Agent Error Log Trigger
        console.error("[PRBE_ERROR_piQHkh] [prbe] Investigation error:", err);
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
