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

export function Terminal({ sessionId, color, nodeId }: TerminalProps) {
  const updateSession = useStore((state) => state.updateSession);
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!terminalRef.current || !sessionId) return;

    // Prevent double mount in strict mode
    if (mountedRef.current) return;
    mountedRef.current = true;

    // Clear container completely
    while (terminalRef.current.firstChild) {
      terminalRef.current.removeChild(terminalRef.current.firstChild);
    }

    // Create terminal
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 12,
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, monospace',
      fontWeight: "400",
      lineHeight: 1.4,
      letterSpacing: 0,
      theme: {
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
      },
      allowProposedApi: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(terminalRef.current);
    
    // Reset all terminal attributes before receiving buffered content
    term.write("\x1b[0m\x1b[?25h");
    
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Fit after the sidebar spring animation has settled (~250ms)
    // and re-fit shortly after to catch any remaining layout shifts
    const fit1 = setTimeout(() => fitAddon.fit(), 250);
    const fit2 = setTimeout(() => fitAddon.fit(), 500);

    // Connect WebSocket with small delay to allow session to be ready
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws?sessionId=${sessionId}`;

    let ws: WebSocket | null = null;
    let isFirstMessage = true;

    // Kitty keyboard protocol: apps (e.g. Claude Code) push/pop/query
    // enhanced keyboard modes via escape sequences in their output.
    // We track the mode stack and respond to queries so the app knows
    // we support CSI u key encoding (needed for Shift+Enter, etc.).
    const kittyModeStack: number[] = [0];

    const sendInput = (data: string) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    };

    const processOutput = (data: string): string => {
      let result = data;

      // Query (\x1b[?u) — respond with current flags
      if (result.includes("\x1b[?u")) {
        result = result.split("\x1b[?u").join("");
        const flags = kittyModeStack[kittyModeStack.length - 1] || 0;
        sendInput(`\x1b[?${flags}u`);
      }

      // Push mode (\x1b[>Xu)
      result = result.replace(/\x1b\[>(\d+)u/g, (_, f) => {
        kittyModeStack.push(parseInt(f, 10));
        return "";
      });

      // Pop mode (\x1b[<u or \x1b[<Nu)
      result = result.replace(/\x1b\[<(\d*)u/g, (_, n) => {
        const count = n ? parseInt(n, 10) : 1;
        for (let i = 0; i < count && kittyModeStack.length > 1; i++) {
          kittyModeStack.pop();
        }
        return "";
      });

      return result;
    };

    const connectWs = () => {
      if (!mountedRef.current) return;

      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (xtermRef.current) {
          ws?.send(JSON.stringify({ type: "resize", cols: xtermRef.current.cols, rows: xtermRef.current.rows }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "output") {
            const output = processOutput(msg.data);
            if (isFirstMessage) {
              isFirstMessage = false;
              term.write("\x1b[2J\x1b[H\x1b[0m");
            }
            term.write(output);
          } else if (msg.type === "status") {
            updateSession(nodeId, {
              status: msg.status as AgentStatus,
              isRestored: msg.isRestored,
              currentTool: msg.currentTool,
            });
          } else if (msg.type === "nameGenerated") {
            updateSession(nodeId, { customName: msg.name });
          }
        } catch (e) {
          term.write(event.data);
        }
      };

      ws.onerror = () => {};
      ws.onclose = () => {};
    };

    // Small delay to let server session be ready
    const connectTimeout = setTimeout(connectWs, 100);

    // Shift+Enter: insert a newline via bracketed paste so the app
    // treats it as literal text, not as a key press.  This mirrors how
    // Warp handles multi-line input and works in every input mode
    // (initial prompt, edit-previous-message, etc.).
    // Other modifier+Enter combos use CSI u encoding.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || e.key !== "Enter") return true;

      if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        sendInput("\x1b[200~\n\x1b[201~");
        return false;
      }
      if (e.ctrlKey || e.altKey) {
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

    let resizeTimer: ReturnType<typeof setTimeout>;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (fitAddonRef.current) {
          fitAddonRef.current.fit();
        }
        if (ws?.readyState === WebSocket.OPEN && xtermRef.current) {
          ws.send(JSON.stringify({
            type: "resize",
            cols: xtermRef.current.cols,
            rows: xtermRef.current.rows
          }));
        }
      }, 100);
    });

    resizeObserver.observe(terminalRef.current);

    return () => {
      mountedRef.current = false;
      clearTimeout(connectTimeout);
      clearTimeout(fit1);
      clearTimeout(fit2);
      clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      ws?.close();
      term.dispose();
    };
  }, [sessionId, color, nodeId, updateSession]);

  return (
    <div
      ref={terminalRef}
      className="w-full h-full"
      style={{ 
        padding: "12px", 
        backgroundColor: "#0d0d0d",
        minHeight: "200px"
      }}
    />
  );
}
