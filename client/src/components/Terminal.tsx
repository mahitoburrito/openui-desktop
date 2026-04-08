import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useStore, AgentStatus } from "../stores/useStore";

interface TerminalProps {
  sessionId: string;
  color: string;
  nodeId: string;
}

interface CachedTerminal {
  term: XTerm;
  fitAddon: FitAddon;
  wrapperDiv: HTMLDivElement;
  ws: WebSocket | null;
  kittyModeStack: number[];
  alive: boolean;
  nodeId: string;
  updateSession: (nodeId: string, update: Record<string, unknown>) => void;
}

const cache = new Map<string, CachedTerminal>();

export function destroyCachedTerminal(sessionId: string) {
  const entry = cache.get(sessionId);
  if (!entry) return;
  entry.alive = false;
  entry.ws?.close();
  entry.term.dispose();
  cache.delete(sessionId);
}

function buildTheme(color: string) {
  return {
    background: "#0d0d0d",
    foreground: "#d4d4d4",
    cursor: color,
    cursorAccent: "#0d0d0d",
    selectionBackground: "#3b3b3b",
    selectionForeground: "#ffffff",
    black: "#1a1a1a",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#fbbf24",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#d4d4d4",
    brightBlack: "#525252",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fcd34d",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#ffffff",
  };
}

function createSendInput(sessionId: string) {
  return (data: string) => {
    const e = cache.get(sessionId);
    if (e?.ws?.readyState === WebSocket.OPEN) {
      e.ws.send(JSON.stringify({ type: "input", data }));
    }
  };
}

function connectWs(
  entry: CachedTerminal,
  sessionId: string,
  sendInput: (data: string) => void,
) {
  if (!entry.alive) return;

  // Buffer for escape sequences split across WebSocket messages
  let partialBuf = "";

  // Single-pass left-to-right processing of kitty keyboard protocol escapes.
  // Handles query (\x1b[?u), push (\x1b[>Nu), and pop (\x1b[<Nu / \x1b[<u)
  // in the order they appear, and buffers partial sequences across chunks.
  const kittyRe = /\x1b\[\?u|\x1b\[>(\d+)u|\x1b\[<(\d*)u/g;

  const processOutput = (data: string): string => {
    const input = partialBuf + data;
    partialBuf = "";

    let result = "";
    let lastIndex = 0;
    kittyRe.lastIndex = 0;

    let match;
    while ((match = kittyRe.exec(input)) !== null) {
      result += input.slice(lastIndex, match.index);
      lastIndex = kittyRe.lastIndex;

      if (match[0] === "\x1b[?u") {
        const flags = entry.kittyModeStack[entry.kittyModeStack.length - 1] || 0;
        sendInput(`\x1b[?${flags}u`);
      } else if (match[1] !== undefined) {
        entry.kittyModeStack.push(parseInt(match[1], 10));
      } else {
        const count = match[2] ? parseInt(match[2], 10) : 1;
        for (let i = 0; i < count && entry.kittyModeStack.length > 1; i++) {
          entry.kittyModeStack.pop();
        }
      }
    }

    result += input.slice(lastIndex);

    // Buffer trailing partial kitty escape sequences for next chunk:
    // lone ESC, or ESC[ followed by kitty-specific modifier (?, >, <)
    const trailing = /\x1b$|\x1b\[[?<>]\d*$/.exec(result);
    if (trailing) {
      partialBuf = trailing[0];
      result = result.slice(0, trailing.index);
    }

    return result;
  };

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws?sessionId=${sessionId}`;
  const ws = new WebSocket(wsUrl);
  entry.ws = ws;

  let isFirstMessage = true;

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "resize",
        cols: entry.term.cols,
        rows: entry.term.rows,
      }),
    );
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "output") {
        const output = processOutput(msg.data);
        if (isFirstMessage) {
          isFirstMessage = false;
          entry.term.write("\x1b[2J\x1b[H\x1b[0m");
        }
        entry.term.write(output);
      } else if (msg.type === "status") {
        entry.updateSession(entry.nodeId, {
          status: msg.status as AgentStatus,
          isRestored: msg.isRestored,
          currentTool: msg.currentTool,
        });
      } else if (msg.type === "nameGenerated") {
        entry.updateSession(entry.nodeId, { customName: msg.name });
      }
    } catch {
      entry.term.write(event.data);
    }
  };

  ws.onerror = () => {};
  ws.onclose = () => {
    if (entry.ws === ws) {
      entry.ws = null;
    }
  };
}

export function Terminal({ sessionId, color, nodeId }: TerminalProps) {
  const updateSession = useStore((state) => state.updateSession);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep mutable bindings current on every render
  useEffect(() => {
    const entry = cache.get(sessionId);
    if (entry) {
      entry.nodeId = nodeId;
      entry.updateSession = updateSession;
    }
  });

  // Sync cursor color without remounting
  useEffect(() => {
    const entry = cache.get(sessionId);
    if (entry) {
      entry.term.options.theme = { ...entry.term.options.theme, cursor: color };
    }
  }, [sessionId, color]);

  useEffect(() => {
    if (!containerRef.current || !sessionId) return;

    const existing = cache.get(sessionId);

    if (existing?.alive) {
      // --- Reattach cached terminal ---
      existing.nodeId = nodeId;
      existing.updateSession = updateSession;

      containerRef.current.appendChild(existing.wrapperDiv);

      const f1 = setTimeout(() => existing.fitAddon.fit(), 50);
      const f2 = setTimeout(() => existing.fitAddon.fit(), 300);

      if (!existing.ws || existing.ws.readyState >= WebSocket.CLOSING) {
        const sendInput = createSendInput(sessionId);
        connectWs(existing, sessionId, sendInput);
      }

      let resizeTimer: ReturnType<typeof setTimeout>;
      const ro = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          existing.fitAddon.fit();
          if (existing.ws?.readyState === WebSocket.OPEN) {
            existing.ws.send(
              JSON.stringify({
                type: "resize",
                cols: existing.term.cols,
                rows: existing.term.rows,
              }),
            );
          }
        }, 100);
      });
      ro.observe(containerRef.current);

      return () => {
        clearTimeout(f1);
        clearTimeout(f2);
        clearTimeout(resizeTimer);
        ro.disconnect();
        if (existing.wrapperDiv.parentNode) {
          existing.wrapperDiv.parentNode.removeChild(existing.wrapperDiv);
        }
      };
    }

    // --- Create new terminal instance ---
    const wrapperDiv = document.createElement("div");
    wrapperDiv.style.width = "100%";
    wrapperDiv.style.height = "100%";

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 12,
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, monospace',
      fontWeight: "400",
      lineHeight: 1.4,
      letterSpacing: 0,
      theme: buildTheme(color),
      allowProposedApi: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(wrapperDiv);
    term.write("\x1b[0m\x1b[?25h");

    containerRef.current.appendChild(wrapperDiv);

    const entry: CachedTerminal = {
      term,
      fitAddon,
      wrapperDiv,
      ws: null,
      kittyModeStack: [0],
      alive: true,
      nodeId,
      updateSession,
    };
    cache.set(sessionId, entry);

    const sendInput = createSendInput(sessionId);

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || e.key !== "Enter") return true;

      if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        sendInput("\x1b[200~\n\x1b[201~");
        return false;
      }
      if (e.ctrlKey || e.altKey) {
        const kittyActive = entry.kittyModeStack[entry.kittyModeStack.length - 1] > 0;
        if (!kittyActive) return true;
        let mod = 1;
        if (e.shiftKey) mod += 1;
        if (e.altKey) mod += 2;
        if (e.ctrlKey) mod += 4;
        sendInput(`\x1b[13;${mod}u`);
        return false;
      }
      return true;
    });

    term.onData(sendInput);

    const connectTimeout = setTimeout(
      () => connectWs(entry, sessionId, sendInput),
      100,
    );

    const fit1 = setTimeout(() => fitAddon.fit(), 250);
    const fit2 = setTimeout(() => fitAddon.fit(), 500);

    let resizeTimer: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitAddon.fit();
        const e = cache.get(sessionId);
        if (e?.ws?.readyState === WebSocket.OPEN) {
          e.ws.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            }),
          );
        }
      }, 100);
    });
    ro.observe(containerRef.current);

    return () => {
      clearTimeout(connectTimeout);
      clearTimeout(fit1);
      clearTimeout(fit2);
      clearTimeout(resizeTimer);
      ro.disconnect();
      // Detach from DOM but keep the terminal alive in cache
      if (wrapperDiv.parentNode) {
        wrapperDiv.parentNode.removeChild(wrapperDiv);
      }
    };
  }, [sessionId]); // Only remount when sessionId changes

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{
        padding: "12px",
        backgroundColor: "#0d0d0d",
        minHeight: "200px",
        overflow: "hidden",
      }}
    />
  );
}
