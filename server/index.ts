import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createServer, IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { parse as parseUrl } from "url";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { apiRoutes } from "./routes/api";
import { prbeRoutes } from "./routes/prbe";
import { probeResearchRoutes } from "./routes/probeResearch";
import {
  sessions,
  restoreSessions,
  isAgentInputPromptReady,
  scheduleSessionTitleGeneration,
  setServerPort,
} from "./services/sessionManager";
import { saveState } from "./services/persistence";

const PREFERRED_PORT = Number(process.env.PORT) || 6968;
const QUIET = !!process.env.OPENUI_QUIET;
const log = QUIET ? (..._args: any[]) => {} : console.log.bind(console);

// Hono app for HTTP routes
const app = new Hono();
app.use("*", cors());
app.route("/api", apiRoutes);
app.route("/api/prbe", prbeRoutes);
app.route("/api/probe-research", probeResearchRoutes);

// Serve static files from client/dist in standalone (non-Electron) mode
const CLIENT_DIST = join(__dirname, "..", "..", "..", "client", "dist");
if (existsSync(CLIENT_DIST)) {
  app.get("/*", (c) => {
    const reqPath = c.req.path === "/" ? "/index.html" : c.req.path;
    const filePath = join(CLIENT_DIST, reqPath);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath);
      const ext = filePath.split(".").pop() || "";
      const mimeTypes: Record<string, string> = {
        html: "text/html",
        js: "application/javascript",
        css: "text/css",
        svg: "image/svg+xml",
        png: "image/png",
        ico: "image/x-icon",
        json: "application/json",
      };
      return new Response(content, {
        headers: { "Content-Type": mimeTypes[ext] || "application/octet-stream" },
      });
    }
    // SPA fallback — serve index.html for client-side routes
    const indexPath = join(CLIENT_DIST, "index.html");
    if (existsSync(indexPath)) {
      return new Response(readFileSync(indexPath), {
        headers: { "Content-Type": "text/html" },
      });
    }
    return c.notFound();
  });
}

// Try to listen on a port, resolve with the port number or reject
function tryListen(app: Hono, port: number): Promise<{ server: any; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve({
      fetch: app.fetch,
      port,
    }, (info) => {
      resolve({ server, port: info.port });
    });

    const httpServer = (server as any).server || server;
    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        httpServer.close();
        reject(err);
      } else {
        reject(err);
      }
    });
  });
}

// Start server, auto-resolving port conflicts
export async function startServer(): Promise<number> {
  await restoreSessions();

  const MAX_ATTEMPTS = 10;
  let server: any;
  let actualPort: number = PREFERRED_PORT;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const port = PREFERRED_PORT + i;
    try {
      const result = await tryListen(app, port);
      server = result.server;
      actualPort = result.port;
      if (i > 0) {
        log(`[server] Port ${PREFERRED_PORT} was in use, using ${actualPort} instead`);
      }
      break;
    } catch (err: any) {
      if (err.code === "EADDRINUSE" && i < MAX_ATTEMPTS - 1) {
        continue;
      }
      throw err;
    }
  }

  setServerPort(actualPort);
  log(`[server] Running on http://localhost:${actualPort}`);
  log(`[server] Launch directory: ${process.env.LAUNCH_CWD || process.cwd()}`);

  return new Promise((resolve) => {
    // Attach WebSocket server to the same HTTP server
    const httpServer = (server as any).server || server;
    const wss = new WebSocketServer({ server: httpServer });

    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const parsedUrl = parseUrl(req.url || "", true);
      const sessionId = parsedUrl.query.sessionId as string;

      if (!sessionId) {
        ws.close(1008, "Session ID required");
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        ws.close(1008, "Session not found");
        return;
      }

      log(`[ws] Connected to ${sessionId}`);
      session.clients.add(ws);

      // Send buffered output or restoration message
      if (session.outputBuffer.length > 0 && !session.isRestored && session.pty) {
        const history = session.outputBuffer.join("");
        ws.send(JSON.stringify({ type: "output", data: history }));
      } else if (session.isRestored || !session.pty) {
        ws.send(JSON.stringify({
          type: "output",
          data: "\x1b[38;5;245mSession was disconnected.\r\nClick \"Spawn Fresh\" to start a new session.\x1b[0m\r\n"
        }));
      }

      ws.send(JSON.stringify({
        type: "status",
        status: session.status,
        isRestored: session.isRestored,
      }));

      ws.on("message", (message: Buffer) => {
        try {
          const msg = JSON.parse(message.toString());
          switch (msg.type) {
            case "chat-input": {
              const text = typeof msg.data === "string"
                ? msg.data.replace(/\r\n?/g, "\n").replace(/\0/g, "").trim().slice(0, 12_000)
                : "";
              const agentId = session.agentId.toLowerCase();
              const transcriptReady = agentId.includes("codex")
                ? Boolean(session.codexSessionId)
                : agentId.includes("claude")
                  ? Boolean(session.claudeSessionId)
                  : true;
              // A brand-new agent does not always create its transcript until
              // the first prompt is submitted. Once the PTY has gone idle, its
              // input prompt is ready even when there is no transcript yet.
              const promptReady = transcriptReady || isAgentInputPromptReady(session);

              if (!text || !session.pty || !promptReady) {
                ws.send(JSON.stringify({
                  type: "chat-input-error",
                  message: !promptReady ? "Agent is still starting" : "Session is unavailable",
                }));
                break;
              }

              const targetPty = session.pty;
              const terminalText = text.includes("\n")
                ? `\x1b[200~${text}\x1b[201~`
                : text;
              targetPty.write(terminalText);
              session.lastInputTime = Date.now();

              // Keep Return separate from the text. Sending both in one PTY
              // packet makes Codex and Claude treat the message as a paste with
              // a trailing newline instead of a submitted prompt.
              setTimeout(() => {
                if (session.pty !== targetPty) return;
                targetPty.write("\r");
                scheduleSessionTitleGeneration(sessionId, text);
                if (ws.readyState === 1) {
                  ws.send(JSON.stringify({ type: "chat-input-accepted" }));
                }
              }, 80);
              break;
            }
            case "input":
              if (session.pty) {
                session.pty.write(msg.data);
                session.lastInputTime = Date.now();

                // Keep auto-generated titles fresh from submitted terminal prompts.
                // Claude's UserPromptSubmit hook is better structured; this is the
                // fallback for agents or shells without that hook.
                if (session.firstInputBuffer === undefined) {
                  session.firstInputBuffer = "";
                }
                if (msg.data.includes("\r") || msg.data.includes("\n")) {
                  const remaining = msg.data.split(/[\r\n]/)[0];
                  session.firstInputBuffer += remaining;
                  const query = session.firstInputBuffer.trim();
                  if (query.length > 0) {
                    scheduleSessionTitleGeneration(sessionId, query);
                  }
                  session.firstInputBuffer = "";
                } else {
                  if (msg.data === "\x7f" || msg.data === "\b") {
                    session.firstInputBuffer = session.firstInputBuffer.slice(0, -1);
                  } else if (msg.data.length === 1 && msg.data.charCodeAt(0) >= 32) {
                    session.firstInputBuffer += msg.data;
                  } else if (msg.data.length > 1 && !msg.data.startsWith("\x1b")) {
                    session.firstInputBuffer += msg.data;
                  }
                }
              }
              break;
            case "resize":
              if (session.pty) {
                session.pty.resize(msg.cols, msg.rows);
              }
              break;
          }
        } catch (e) {
          // Probe Agent Error Log Trigger
          if (!QUIET) console.error("[PRBE_ERROR_vbFKwR] Error processing message:", e);
        }
      });

      ws.on("close", () => {
        session.clients.delete(ws);
        log(`[ws] Disconnected from ${sessionId}`);
      });
    });

    // Periodic state save — every 10s for crash resilience
    setInterval(() => {
      saveState(sessions);
    }, 10000);

    // Cleanup helper
    const emergencySave = () => {
      try {
        saveState(sessions);
      } catch (e) {
        console.error("[server] Emergency save failed:", e);
      }
    };

    // Cleanup on exit
    process.on("SIGINT", () => {
      log("[server] Saving state before exit...");
      emergencySave();
      for (const [, session] of sessions) {
        if (session.pty) session.pty.kill();
        if (session.stateTrackerPty) session.stateTrackerPty.kill();
      }
      // Only call process.exit when running standalone (not embedded in Electron).
      // When embedded, Electron manages the process lifecycle — calling process.exit()
      // here kills the process before electron-updater can install and relaunch.
      if (require.main === module) {
        process.exit(0);
      }
    });

    // Crash-resilient: save on SIGTERM, uncaughtException, unhandledRejection
    process.on("SIGTERM", () => {
      log("[server] SIGTERM received, saving state...");
      emergencySave();
      process.exit(0);
    });

    process.on("SIGHUP", () => {
      log("[server] SIGHUP received, saving state...");
      emergencySave();
    });

    process.on("uncaughtException", (err) => {
      console.error("[server] Uncaught exception, saving state:", err);
      emergencySave();
      process.exit(1);
    });

    process.on("unhandledRejection", (reason) => {
      console.error("[server] Unhandled rejection, saving state:", reason);
      emergencySave();
    });

    resolve(actualPort);
  });
}

// If run directly (not imported by Electron main)
if (require.main === module) {
  startServer();
}
