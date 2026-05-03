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
import { sessions, restoreSessions, setServerPort } from "./services/sessionManager";
import { saveState } from "./services/persistence";

const PREFERRED_PORT = Number(process.env.PORT) || 6968;
const QUIET = !!process.env.OPENUI_QUIET;
const log = QUIET ? (..._args: any[]) => {} : console.log.bind(console);

// Hono app for HTTP routes
const app = new Hono();
app.use("*", cors());
app.route("/api", apiRoutes);
app.route("/api/prbe", prbeRoutes);

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
  restoreSessions();

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
            case "input":
              if (session.pty) {
                session.pty.write(msg.data);
                session.lastInputTime = Date.now();

                // Auto-generate session name from first query
                if (!session.nameGenerated && !session.customName) {
                  if (session.firstInputBuffer === undefined) {
                    session.firstInputBuffer = "";
                  }
                  if (msg.data.includes("\r") || msg.data.includes("\n")) {
                    const remaining = msg.data.split(/[\r\n]/)[0];
                    session.firstInputBuffer += remaining;
                    const query = session.firstInputBuffer.trim();
                    if (query.length > 0) {
                      let name = query.length <= 40
                        ? query
                        : query.slice(0, 40).replace(/\s+\S*$/, "").trim() + "\u2026";
                      name = name.charAt(0).toUpperCase() + name.slice(1);
                      session.customName = name;
                      session.nameGenerated = true;
                      saveState(sessions);
                      for (const client of session.clients) {
                        if (client.readyState === WebSocket.OPEN) {
                          client.send(JSON.stringify({ type: "nameGenerated", name }));
                        }
                      }
                    }
                    session.firstInputBuffer = undefined;
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
              }
              break;
            case "resize":
              if (session.pty) {
                session.pty.resize(msg.cols, msg.rows);
              }
              break;
          }
        } catch (e) {
          if (!QUIET) console.error("Error processing message:", e);
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
      process.exit(0);
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
