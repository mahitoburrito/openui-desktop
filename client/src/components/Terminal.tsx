import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useStore, AgentStatus } from "../stores/useStore";
import {
  clampTerminalFontSize,
  getTerminalFontFamily,
  getTerminalTheme,
  type TerminalThemeId,
} from "../theme/appearance";
import { extractLocalPreviewUrls, stripAnsiForUrlScan } from "../utils/localPreview";

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
const FILE_PATH_RE =
  /(?:^|[\s"'`(<\[])((?:~|\.{1,2})?\/[^\s"'`)<>\]]+|[A-Za-z0-9_.-]+\/[^\s"'`)<>\]]+|[A-Za-z0-9_-]+\.[A-Za-z0-9]+)/g;

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);
const CLIPBOARD_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

type ClipboardUploadState = {
  phase: "idle" | "uploading" | "done" | "error";
  message?: string;
};

function stripTrailingPunct(s: string): string {
  return s.replace(/[.,;:!?)\]'"`>]+$/, "");
}

function isMarkdownPath(p: string): boolean {
  const ext = p.includes(".") ? p.split(".").pop()!.toLowerCase() : "";
  return MARKDOWN_EXTS.has(ext);
}

function resolvePath(raw: string, cwd: string | undefined): string {
  let p = raw;
  if (p.startsWith("~/")) {
    return p;
  }
  if (p.startsWith("/")) return p;
  if (!cwd) return p;
  if (p.startsWith("./")) p = p.slice(2);
  return cwd.replace(/\/$/, "") + "/" + p;
}

function imageExtensionForType(type: string): string {
  switch (type) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/png":
    default:
      return "png";
  }
}

function namedClipboardImage(file: File, index: number): File {
  if (file.name && file.name.trim()) return file;
  const ext = imageExtensionForType(file.type || "image/png");
  return new File([file], `clipboard-image-${Date.now()}-${index + 1}.${ext}`, {
    type: file.type || "image/png",
    lastModified: Date.now(),
  });
}

function clipboardImageFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files)
    .filter((file) => CLIPBOARD_IMAGE_TYPES.has(file.type))
    .map(namedClipboardImage);

  if (files.length > 0) return files;

  return Array.from(data.items)
    .filter((item) => item.kind === "file" && CLIPBOARD_IMAGE_TYPES.has(item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))
    .map(namedClipboardImage);
}

interface CachedTerminal {
  term: XTerm;
  fitAddon: FitAddon;
  wrapperDiv: HTMLDivElement;
  ws: WebSocket | null;
  kittyModeStack: number[];
  previewScanBuffer: string;
  alive: boolean;
  nodeId: string;
  updateSession: (nodeId: string, update: Record<string, unknown>) => void;
  cwd: string | undefined;
  onOpenFile: ((absPath: string) => void) | undefined;
}

const cache = new Map<string, CachedTerminal>();
const recentAutoPreviewOpens = new Map<string, number>();
const AUTO_PREVIEW_SCAN_LIMIT = 1200;
const AUTO_PREVIEW_COOLDOWN_MS = 45_000;

export function destroyCachedTerminal(sessionId: string) {
  const entry = cache.get(sessionId);
  if (!entry) return;
  entry.alive = false;
  entry.ws?.close();
  entry.term.dispose();
  cache.delete(sessionId);
}

function buildTheme(color: string, themeId: TerminalThemeId) {
  const theme = getTerminalTheme(themeId);
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: color,
    cursorAccent: theme.cursorAccent,
    selectionBackground: theme.selection,
    selectionForeground: theme.foreground,
    black: theme.ansi.black,
    red: theme.ansi.red,
    green: theme.ansi.green,
    yellow: theme.ansi.yellow,
    blue: theme.ansi.blue,
    magenta: theme.ansi.magenta,
    cyan: theme.ansi.cyan,
    white: theme.ansi.white,
    brightBlack: theme.ansi.brightBlack,
    brightRed: theme.ansi.brightRed,
    brightGreen: theme.ansi.brightGreen,
    brightYellow: theme.ansi.brightYellow,
    brightBlue: theme.ansi.brightBlue,
    brightMagenta: theme.ansi.brightMagenta,
    brightCyan: theme.ansi.brightCyan,
    brightWhite: theme.ansi.brightWhite,
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

function isCurrentOpenUiUrl(url: string): boolean {
  try {
    const current = new URL(window.location.href);
    const preview = new URL(url);
    return current.protocol === preview.protocol && current.host === preview.host;
  } catch {
    return false;
  }
}

function maybeAutoOpenLocalPreview(entry: CachedTerminal, output: string) {
  if (!output) return;

  const scanText = stripAnsiForUrlScan(`${entry.previewScanBuffer || ""}${output}`);
  entry.previewScanBuffer = scanText.slice(-AUTO_PREVIEW_SCAN_LIMIT);

  const urls = extractLocalPreviewUrls(scanText);
  if (urls.length === 0) return;

  const url = urls[urls.length - 1];
  if (!url || isCurrentOpenUiUrl(url)) return;

  const store = useStore.getState();
  if (store.viewMode === "browser" && store.browserUrl === url) return;

  const key = `${entry.nodeId}:${url}`;
  const now = Date.now();
  const lastOpenedAt = recentAutoPreviewOpens.get(key) || 0;
  if (now - lastOpenedAt < AUTO_PREVIEW_COOLDOWN_MS) return;
  recentAutoPreviewOpens.set(key, now);

  store.setBrowserUrl(url);
  store.setViewMode("browser");
}

function connectWs(
  entry: CachedTerminal,
  sessionId: string,
  sendInput: (data: string) => void,
  onReady?: (sendInput: (text: string) => void) => void,
) {
  if (!entry.alive) return;

  // Buffer for escape sequences split across WebSocket messages
  let partialBuf = "";

  // Single-pass left-to-right processing of kitty keyboard protocol escapes.
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
        const output = processOutput(msg.data);
        if (isFirstMessage) {
          isFirstMessage = false;
          entry.term.write("\x1b[2J\x1b[H\x1b[0m");
        }
        maybeAutoOpenLocalPreview(entry, output);
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
      if (typeof event.data === "string") {
        maybeAutoOpenLocalPreview(entry, event.data);
      }
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

export function Terminal({
  sessionId,
  color,
  nodeId,
  cwd,
  onOpenFile,
  onReady,
}: TerminalProps) {
  const updateSession = useStore((state) => state.updateSession);
  const terminalThemeId = useStore((state) => state.terminalTheme);
  const terminalFontFamilyId = useStore((state) => state.terminalFontFamily);
  const terminalFontSize = useStore((state) => state.terminalFontSize);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [clipboardUpload, setClipboardUpload] = useState<ClipboardUploadState>({
    phase: "idle",
  });
  const terminalTheme = getTerminalTheme(terminalThemeId);
  const terminalFont = getTerminalFontFamily(terminalFontFamilyId);
  const clampedFontSize = clampTerminalFontSize(terminalFontSize);

  // Keep mutable bindings current on every render
  useEffect(() => {
    const entry = cache.get(sessionId);
    if (entry) {
      entry.nodeId = nodeId;
      entry.updateSession = updateSession;
      entry.cwd = cwd;
      entry.onOpenFile = onOpenFile;
    }
  });

  // Sync presentation without remounting or dropping the PTY connection.
  useEffect(() => {
    const entry = cache.get(sessionId);
    if (entry) {
      entry.term.options.theme = buildTheme(color, terminalThemeId);
      entry.term.options.fontFamily = terminalFont.stack;
      entry.term.options.fontSize = clampedFontSize;
      entry.term.options.lineHeight = 1.42;
      entry.wrapperDiv.style.backgroundColor = terminalTheme.background;
      entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
      const fitTimer = setTimeout(() => entry.fitAddon.fit(), 0);
      return () => clearTimeout(fitTimer);
    }
  }, [
    sessionId,
    color,
    terminalThemeId,
    terminalTheme.background,
    terminalFont.stack,
    clampedFontSize,
  ]);

  useEffect(() => {
    if (!containerRef.current || !sessionId) return;

    const existing = cache.get(sessionId);

    if (existing?.alive) {
      // --- Reattach cached terminal ---
      existing.nodeId = nodeId;
      existing.updateSession = updateSession;
      existing.cwd = cwd;
      existing.onOpenFile = onOpenFile;

      containerRef.current.appendChild(existing.wrapperDiv);

      const f1 = setTimeout(() => existing.fitAddon.fit(), 50);
      const f2 = setTimeout(() => existing.fitAddon.fit(), 300);

      if (!existing.ws || existing.ws.readyState >= WebSocket.CLOSING) {
        const sendInput = createSendInput(sessionId);
        connectWs(existing, sessionId, sendInput, onReady);
      } else if (onReady) {
        // Already connected — give the new caller the input fn immediately
        onReady(createSendInput(sessionId));
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
    wrapperDiv.style.backgroundColor = terminalTheme.background;

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: clampedFontSize,
      fontFamily: terminalFont.stack,
      fontWeight: "400",
      lineHeight: 1.42,
      letterSpacing: 0,
      theme: buildTheme(color, terminalThemeId),
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
      previewScanBuffer: "",
      alive: true,
      nodeId,
      updateSession,
      cwd,
      onOpenFile,
    };
    cache.set(sessionId, entry);

    // Custom link provider — finds file paths on each visible line and makes
    // markdown ones clickable to open in an in-pane viewer.
    term.registerLinkProvider({
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

          const groupOffset = match[0].indexOf(captured);
          const startCol = match.index + groupOffset;
          const endCol = startCol + cleaned.length;

          links.push({
            range: {
              start: { x: startCol + 1, y: bufferLineNumber },
              end: { x: endCol, y: bufferLineNumber },
            },
            text: cleaned,
            decorations: { underline: true, pointerCursor: true },
            activate: (event, txt) => {
              event.preventDefault();
              const handler = entry.onOpenFile;
              if (!handler) return;
              const abs = resolvePath(txt, entry.cwd);
              handler(abs);
            },
          });
        }

        callback(links.length > 0 ? links : undefined);
      },
    });

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
      () => connectWs(entry, sessionId, sendInput, onReady),
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

    const entry = cache.get(sessionId);
    if (entry?.ws?.readyState === WebSocket.OPEN) {
      entry.ws.send(JSON.stringify({ type: "input", data: insertion }));
    }
    entry?.term.focus();
  };

  const uploadClipboardImages = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      setClipboardUpload({
        phase: "uploading",
        message: `Attaching ${files.length} image${files.length === 1 ? "" : "s"}...`,
      });

      try {
        const formData = new FormData();
        files.forEach((file) => formData.append("files", file));

        const res = await fetch(`/api/sessions/${sessionId}/upload`, {
          method: "POST",
          body: formData,
        });
        const body = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(body.error || `Upload failed (${res.status})`);
        }

        const saved = Array.isArray(body.saved) ? body.saved.length : 0;
        const skipped = Array.isArray(body.skipped) ? body.skipped.length : 0;

        if (saved === 0) {
          throw new Error(skipped > 0 ? "Image type was skipped" : "No image was saved");
        }

        setClipboardUpload({
          phase: "done",
          message:
            skipped > 0
              ? `Attached ${saved}, skipped ${skipped}`
              : `Attached ${saved} image${saved === 1 ? "" : "s"}`,
        });
        setTimeout(() => {
          setClipboardUpload((state) =>
            state.phase === "done" ? { phase: "idle" } : state,
          );
        }, 1800);
      } catch (error) {
        setClipboardUpload({
          phase: "error",
          message: error instanceof Error ? error.message : "Image upload failed",
        });
        setTimeout(() => {
          setClipboardUpload((state) =>
            state.phase === "error" ? { phase: "idle" } : state,
          );
        }, 2800);
      } finally {
        cache.get(sessionId)?.term.focus();
      }
    },
    [sessionId],
  );

  const handlePasteCapture = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      const images = clipboardImageFiles(e.clipboardData);
      if (images.length === 0) return;

      e.preventDefault();
      e.stopPropagation();
      void uploadClipboardImages(images);
    },
    [uploadClipboardImages],
  );

  return (
    <div
      onPasteCapture={handlePasteCapture}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative w-full h-full"
      style={{
        minHeight: "200px",
        backgroundColor: terminalTheme.surface,
      }}
    >
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{
          padding: "14px",
          backgroundColor: terminalTheme.background,
          border: `1px solid ${terminalTheme.border}`,
          boxShadow: `inset 0 1px 0 ${terminalTheme.foreground}0f`,
          minHeight: "200px",
          overflow: "hidden",
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
      {clipboardUpload.phase !== "idle" && clipboardUpload.message && (
        <div
          className="pointer-events-none absolute bottom-3 right-3 rounded-md border px-2.5 py-1.5 text-[11px] shadow-lg"
          style={{
            backgroundColor: terminalTheme.surface,
            borderColor:
              clipboardUpload.phase === "error"
                ? "#EF444466"
                : terminalTheme.border,
            color:
              clipboardUpload.phase === "error"
                ? "#FCA5A5"
                : terminalTheme.foreground,
          }}
        >
          <span
            className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
            style={{
              backgroundColor:
                clipboardUpload.phase === "uploading"
                  ? color
                  : clipboardUpload.phase === "error"
                    ? "#EF4444"
                    : "#22C55E",
            }}
          />
          {clipboardUpload.message}
        </div>
      )}
    </div>
  );
}
