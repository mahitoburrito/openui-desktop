import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useStore, AgentStatus } from "../stores/useStore";

interface TerminalProps {
  sessionId: string;
  color: string;
  nodeId: string;
  cwd?: string;
  onOpenFile?: (absPath: string) => void;
  onReady?: (sendInput: (text: string) => void) => void;
}

// Quote a path for shell pasting if it contains characters that would break tokenization.
function shellQuote(p: string): string {
  if (/^[A-Za-z0-9_\-./~@+:=]+$/.test(p)) return p;
  return `'${p.replace(/'/g, "'\\''")}'`;
}

// File path detection. Matches:
//   - absolute POSIX paths:   /Users/foo/bar.md
//   - home-relative:          ~/notes/x.md
//   - relative dir paths:     docs/notes.md, ./README.md, ../foo.mdx
//   - bare filenames with a markdown extension: README.md, NOTES.mdx
// We accept a leading delimiter (start-of-line, whitespace, quote, paren, etc.)
// and capture the longest path-shaped run after it. The activate() handler only
// fires for runs that actually look like markdown files, so non-markdown matches
// are filtered out cheaply later.
const FILE_PATH_RE =
  /(?:^|[\s"'`(<\[])((?:~|\.{1,2})?\/[^\s"'`)<>\]]+|[A-Za-z0-9_.-]+\/[^\s"'`)<>\]]+|[A-Za-z0-9_-]+\.[A-Za-z0-9]+)/g;

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);

function stripTrailingPunct(s: string): string {
  // Remove trailing punctuation that's almost certainly not part of the path.
  return s.replace(/[.,;:!?)\]'"`>]+$/, "");
}

function isMarkdownPath(p: string): boolean {
  const ext = p.includes(".") ? p.split(".").pop()!.toLowerCase() : "";
  return MARKDOWN_EXTS.has(ext);
}

function resolvePath(raw: string, cwd: string | undefined): string {
  let p = raw;
  if (p.startsWith("~/")) {
    // We don't know the homedir client-side; let server's expandPath handle it.
    return p;
  }
  if (p.startsWith("/")) return p;
  if (!cwd) return p;
  // Strip leading "./"
  if (p.startsWith("./")) p = p.slice(2);
  // Naive join; server resolves and validates.
  return cwd.replace(/\/$/, "") + "/" + p;
}

export function Terminal({
  sessionId,
  color,
  nodeId,
  cwd,
  onOpenFile,
  onReady,
}: TerminalProps) {
  // Stable refs so the link provider closure picks up latest values
  // without forcing the terminal to be recreated on prop changes.
  const cwdRef = useRef(cwd);
  const onOpenFileRef = useRef(onOpenFile);
  cwdRef.current = cwd;
  onOpenFileRef.current = onOpenFile;
  const updateSession = useStore((state) => state.updateSession);
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const mountedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

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

    // Custom link provider — finds file paths on each visible line and makes
    // markdown ones clickable to open in an in-pane viewer.
    const linkProviderDisposable = term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const buffer = term.buffer.active;
        const line = buffer.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = line.translateToString(true);
        if (!text) {
          callback(undefined);
          return;
        }

        const links: import("@xterm/xterm").ILink[] = [];
        FILE_PATH_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = FILE_PATH_RE.exec(text)) !== null) {
          const captured = match[1];
          if (!captured) continue;
          const cleaned = stripTrailingPunct(captured);
          if (!cleaned || !isMarkdownPath(cleaned)) continue;

          // Find the captured group's start within the matched text
          const groupOffset = match[0].indexOf(captured);
          const startCol = match.index + groupOffset; // 0-based
          const endCol = startCol + cleaned.length; // exclusive

          links.push({
            range: {
              start: { x: startCol + 1, y: bufferLineNumber },
              end: { x: endCol, y: bufferLineNumber },
            },
            text: cleaned,
            decorations: { underline: true, pointerCursor: true },
            activate: (event, txt) => {
              event.preventDefault();
              const handler = onOpenFileRef.current;
              if (!handler) return;
              const abs = resolvePath(txt, cwdRef.current);
              handler(abs);
            },
          });
        }

        callback(links.length > 0 ? links : undefined);
      },
    });

    // Reset all terminal attributes before receiving buffered content
    term.write("\x1b[0m\x1b[?25h");

    setTimeout(() => fitAddon.fit(), 50);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // WebSocket connection with reconnection
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws?sessionId=${sessionId}`;

    let isFirstMessage = true;

    const connectWs = () => {
      if (!mountedRef.current) return;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptRef.current = 0; // Reset backoff on success
        if (xtermRef.current) {
          ws.send(JSON.stringify({ type: "resize", cols: xtermRef.current.cols, rows: xtermRef.current.rows }));
        }
        onReady?.((text: string) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "input", data: text }));
          }
        });
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "output") {
            // On first message (buffered history), reset terminal state first
            if (isFirstMessage) {
              isFirstMessage = false;
              // Clear screen, reset attributes, move cursor home
              term.write("\x1b[2J\x1b[H\x1b[0m");
            }
            term.write(msg.data);
          } else if (msg.type === "status") {
            // Handle status updates from plugin hooks
            updateSession(nodeId, {
              status: msg.status as AgentStatus,
              isRestored: msg.isRestored,
              currentTool: msg.currentTool,
            });
          } else if (msg.type === "nameGenerated") {
            // Auto-name session from first query
            updateSession(nodeId, { customName: msg.name });
          }
        } catch (e) {
          term.write(event.data);
        }
      };

      ws.onerror = () => {
        // Will trigger onclose — reconnection handled there
      };

      ws.onclose = () => {
        wsRef.current = null;
        // Reconnect with exponential backoff if component is still mounted
        if (mountedRef.current) {
          const attempt = reconnectAttemptRef.current;
          // Backoff: 1s, 2s, 4s, 8s, cap at 15s
          const delay = Math.min(1000 * Math.pow(2, attempt), 15000);
          reconnectAttemptRef.current = attempt + 1;

          reconnectTimerRef.current = setTimeout(() => {
            if (mountedRef.current) {
              isFirstMessage = true;
              connectWs();
            }
          }, delay);
        }
      };
    };

    // Small delay to let server session be ready
    const connectTimeout = setTimeout(connectWs, 100);

    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "input", data }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (fitAddonRef.current) {
          fitAddonRef.current.fit();
        }
        if (wsRef.current?.readyState === WebSocket.OPEN && xtermRef.current) {
          wsRef.current.send(JSON.stringify({
            type: "resize",
            cols: xtermRef.current.cols,
            rows: xtermRef.current.rows
          }));
        }
      });
    });

    resizeObserver.observe(terminalRef.current);

    return () => {
      mountedRef.current = false;
      clearTimeout(connectTimeout);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      resizeObserver.disconnect();
      linkProviderDisposable.dispose();
      wsRef.current?.close();
      term.dispose();
    };
  }, [sessionId, color, nodeId, updateSession]);

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      if (!isDragOver) setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget === e.target) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    // Electron exposes the absolute filesystem path on File objects.
    // Browser-only fallback: just use the file name (caller can re-target).
    const tokens: string[] = [];
    for (const f of files) {
      const path = (f as File & { path?: string }).path || f.name;
      tokens.push(shellQuote(path));
    }
    const insertion = tokens.join(" ") + " ";

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input", data: insertion }));
    }
    xtermRef.current?.focus();
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative w-full h-full"
      style={{ minHeight: "200px" }}
    >
      <div
        ref={terminalRef}
        className="w-full h-full"
        style={{
          padding: "12px",
          backgroundColor: "#0d0d0d",
          minHeight: "200px",
        }}
      />
      {isDragOver && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          style={{
            backgroundColor: `${color}10`,
            outline: `2px dashed ${color}`,
            outlineOffset: "-6px",
          }}
        >
          <div
            className="px-3 py-1.5 rounded-md text-xs font-medium"
            style={{
              backgroundColor: `${color}20`,
              color,
              border: `1px solid ${color}40`,
            }}
          >
            Drop to insert path
          </div>
        </div>
      )}
    </div>
  );
}
