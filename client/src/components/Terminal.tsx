import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ImageAddon } from "@xterm/addon-image";
import "@xterm/xterm/css/xterm.css";
import { useStore, AgentStatus, type TerminalOsc52ClipboardAccess } from "../stores/useStore";
import {
  clampTerminalFontSize,
  getTerminalFontFamily,
  getTerminalTheme,
  type TerminalThemeId,
} from "../theme/appearance";
import { extractLocalPreviewUrls, stripAnsiForUrlScan } from "../utils/localPreview";
import {
  encodeKittyKeyboardEvent,
  KittyKeyboardProtocol,
} from "../../../resources/terminal-protocol/kittyKeyboard.mjs";
import {
  InlineTerminalInput,
  type InlineTerminalInputSnapshot,
} from "../../../resources/terminal-protocol/inlineInput.mjs";
import {
  applyTerminalSuggestion,
  inlineSuggestionKinds,
  nextTerminalSuggestionComponent,
  terminalSuggestionSuffix,
  type TerminalSuggestion,
} from "./terminalSuggestions";

interface TerminalProps {
  sessionId: string;
  color: string;
  nodeId: string;
  cwd?: string;
  onOpenFile?: (absPath: string) => void;
  onReady?: (sendInput: (text: string) => void) => void;
  onPromptInputChange?: (sessionId: string, state: TerminalInputSyncState) => void;
  onUserInput?: (sessionId: string, data: string) => boolean;
  synchronizedPreview?: {
    sourceName: string;
    text: string;
  };
  workbench?: boolean;
}

export interface TerminalInputSyncState extends InlineTerminalInputSnapshot {
  connected: boolean;
  editorIdentity?: string;
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
const OSC52_MAX_ENCODED_CHARS = 60 * 1024;
const OSC52_MAX_READ_BYTES = 32 * 1024;

type ClipboardUploadState = {
  phase: "idle" | "uploading" | "done" | "error";
  message?: string;
};

type InlineInputState = InlineTerminalInputSnapshot;

type InlineSuggestionAnchor = {
  left: number;
  menuLeft: number;
  menuWidth: number;
  top: number;
  placeAbove: boolean;
};

const EMPTY_INLINE_INPUT: InlineInputState = new InlineTerminalInput().snapshot();
const INLINE_KIND_LABELS: Partial<Record<TerminalSuggestion["kind"], string>> = {
  history: "History",
  file: "Path",
  command: "Command",
  subcommand: "Subcommand",
  option: "Option",
  argument: "Argument",
  variable: "Variable",
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

interface NativeClipboardImage {
  mimeType: string;
  base64: string;
  byteLength: number;
}

async function nativeClipboardImageFile(): Promise<File | null> {
  if (!window.electronAPI?.isElectron) return null;
  const image = await window.electronAPI.invoke("clipboard:read-image") as NativeClipboardImage | null;
  if (!image || image.mimeType !== "image/png" || !image.base64 || image.byteLength <= 0) return null;
  const binary = atob(image.base64);
  if (binary.length !== image.byteLength) throw new Error("Clipboard image was truncated");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], `clipboard-image-${Date.now()}.png`, {
    type: "image/png",
    lastModified: Date.now(),
  });
}

function decodeOsc52Text(encoded: string): string | null {
  if (encoded.length > OSC52_MAX_ENCODED_CHARS ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return null;
  }
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function encodeOsc52Text(value: string): string | null {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > OSC52_MAX_READ_BYTES) return null;
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8_192));
  }
  return btoa(binary);
}

async function handleOsc52Clipboard(
  data: string,
  access: TerminalOsc52ClipboardAccess,
  sendResponse: (data: string) => void,
): Promise<boolean> {
  const separator = data.indexOf(";");
  if (separator < 0) return true;
  const selection = data.slice(0, separator);
  const payload = data.slice(separator + 1);
  if (!/^[cps]$/.test(selection)) return true;

  if (payload === "?") {
    if (access !== "read_write" || !navigator.clipboard?.readText) return true;
    try {
      const encoded = encodeOsc52Text(await navigator.clipboard.readText());
      if (encoded !== null) sendResponse(`\x1b]52;${selection};${encoded}\x07`);
    } catch {
      // Clipboard permission failures are a fail-closed read.
    }
    return true;
  }

  if (access === "deny" || !navigator.clipboard?.writeText) return true;
  const decoded = decodeOsc52Text(payload);
  if (decoded === null) return true;
  try {
    await navigator.clipboard.writeText(decoded);
  } catch {
    // Clipboard permission failures are a fail-closed write.
  }
  return true;
}

interface CachedTerminal {
  sessionId: string;
  term: XTerm;
  fitAddon: FitAddon;
  wrapperDiv: HTMLDivElement;
  // Every pane that currently renders this session, least recently attached first.
  // The DOM only lets `wrapperDiv` live in one of them, so the LAST entry owns it
  // and the rest wait their turn. Never appendChild/removeChild wrapperDiv directly:
  // go through attachTerminal/detachTerminal/reclaimTerminal or the stack and the
  // DOM drift apart, which is what leaves a pane permanently black.
  mounts: HTMLDivElement[];
  fitFrame?: number;
  // Set by xterm just before it hands us a typed chunk; see watchUserInput.
  userInputTracked: boolean;
  sawUserInput: boolean;
  ws: WebSocket | null;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  reconnectAttempt: number;
  kittyKeyboard: KittyKeyboardProtocol;
  previewScanBuffer: string;
  pendingPreviewUrl: string | null;
  lastUserInputAt: number;
  alive: boolean;
  nodeId: string;
  updateSession: (nodeId: string, update: Record<string, unknown>) => void;
  cwd: string | undefined;
  onOpenFile: ((absPath: string) => void) | undefined;
  inlineTracker: InlineTerminalInput;
  editorIdentity?: string;
  onInlineInputChange?: (state: InlineInputState) => void;
  onPromptInputChange?: (sessionId: string, state: TerminalInputSyncState) => void;
  onUserInput?: (sessionId: string, data: string) => boolean;
  inlineKeyHandler?: (event: KeyboardEvent) => boolean;
  onCursorUpdate?: () => void;
}

const cache = new Map<string, CachedTerminal>();

// A pane narrower or shorter than this is collapsed, animating open, or hidden.
// FitAddon has no such notion: it happily proposes its 2x1 floor for a zero-sized
// box, which reflows the scrollback and makes the PTY repaint a full-screen TUI
// into two columns. Below the threshold we keep the last known-good size.
const MIN_FITTABLE_PX = 24;

// Image budgets are PER TERMINAL and this app keeps one alive per opened session,
// so the addon defaults (128MB store, 4096x4096 decode) multiply badly: a handful of
// sessions would outweigh the whole renderer. The decode limit also has to stay under
// the store limit, because the storage evictor inserts an over-sized image anyway
// once it has nothing left to evict — a larger pixelLimit quietly uncaps the store.
const IMAGE_STORAGE_LIMIT_MB = 8;
const IMAGE_PIXEL_LIMIT = 2048 * 2048;
const IMAGE_SEQUENCE_LIMIT_BYTES = 4_000_000;

function safeFit(entry: CachedTerminal) {
  const wrapper = entry.wrapperDiv;
  if (!entry.alive || !wrapper.isConnected || !wrapper.parentElement) return;
  const rect = wrapper.getBoundingClientRect();
  if (rect.width < MIN_FITTABLE_PX || rect.height < MIN_FITTABLE_PX) return;
  try {
    entry.fitAddon.fit();
  } catch {
    // The renderer can be torn down between the schedule and the callback.
  }
}

function scheduleFit(entry: CachedTerminal) {
  if (entry.fitFrame !== undefined) return;
  entry.fitFrame = window.requestAnimationFrame(() => {
    entry.fitFrame = undefined;
    safeFit(entry);
  });
}

function sendResize(entry: CachedTerminal, cols: number, rows: number) {
  if (entry.ws?.readyState !== WebSocket.OPEN) return;
  entry.ws.send(JSON.stringify({ type: "resize", cols, rows }));
}

// Give the terminal to the newest pane that is still on screen. Without this a
// pane that unmounts while another one is also showing the session strands
// wrapperDiv outside the document and every remaining pane renders black.
function reclaimTerminal(entry: CachedTerminal) {
  while (entry.mounts.length > 0) {
    const next = entry.mounts[entry.mounts.length - 1];
    if (!next.isConnected) {
      entry.mounts.pop();
      continue;
    }
    if (entry.wrapperDiv.parentNode !== next) {
      next.appendChild(entry.wrapperDiv);
      scheduleFit(entry);
    }
    return;
  }
}

function attachTerminal(entry: CachedTerminal, container: HTMLDivElement) {
  const index = entry.mounts.indexOf(container);
  if (index !== -1) entry.mounts.splice(index, 1);
  entry.mounts.push(container);
  if (entry.wrapperDiv.parentNode !== container) container.appendChild(entry.wrapperDiv);
}

function detachTerminal(entry: CachedTerminal, container: HTMLDivElement) {
  const index = entry.mounts.indexOf(container);
  if (index !== -1) entry.mounts.splice(index, 1);
  if (entry.wrapperDiv.parentNode === container) container.removeChild(entry.wrapperDiv);
  reclaimTerminal(entry);
}

// Everything the emulator answers a program with arrives on onData looking exactly
// like typing: DSR/CPR, DA1/2/3, DECRQM, the XTSMGRAPHICS and CSI 14/16/18 t
// replies the image addon adds. Attributing those to the user is wrong three times
// over — they get broadcast to synchronized panes, folded into the prompt buffer
// behind inline completion, and land on the server's user-input path, where
// lastInputTime cancels a pending agent fallback chain.
//
// xterm fires coreService.onUserInput immediately before onData and only for real
// typing, so provenance settles it for every reply family at once, including ones a
// future addon introduces. It is an internal handle, hence the feature check.
function watchUserInput(entry: CachedTerminal): boolean {
  const core = (entry.term as unknown as {
    _core?: { coreService?: { onUserInput?: (listener: () => void) => unknown } };
  })._core;
  const coreService = core?.coreService;
  if (typeof coreService?.onUserInput !== "function") return false;
  coreService.onUserInput(() => {
    entry.sawUserInput = true;
  });
  return true;
}

// Replies carry digits, separators and a known final — never a newline and never
// program-chosen text, which is what makes forwarding them to the PTY safe. Must stay
// in step with the allowlist in server/services/terminalTransport.ts: anything outside
// the shape is dropped here rather than sent, so an unrecognized sequence can never
// trip that allowlist and close the socket.
const TERMINAL_REPLY_RE = /^\x1b\[[?>]?[0-9;:]{0,64}(?:[cnRSt]|\$y)$/;

function sendTerminalReply(entry: CachedTerminal, data: string) {
  if (!TERMINAL_REPLY_RE.test(data)) return;
  if (entry.ws?.readyState !== WebSocket.OPEN) return;
  entry.ws.send(JSON.stringify({ type: "terminalResponse", data }));
}

// Reads and clears the flag xterm set just before handing us this chunk. Without the
// internal hook, fall back to shape: treat a bare complete CSI sequence as a reply.
function chunkWasTyped(entry: CachedTerminal, data: string): boolean {
  if (!entry.userInputTracked) return !TERMINAL_REPLY_RE.test(data);
  const typed = entry.sawUserInput;
  entry.sawUserInput = false;
  return typed;
}

const recentAutoPreviewOpens = new Map<string, number>();
const AUTO_PREVIEW_SCAN_LIMIT = 1200;
const AUTO_PREVIEW_COOLDOWN_MS = 45_000;
// Echo of the user's own typing repaints the TUI frame; skip URL scanning
// for this long after any keystroke so half-typed prompts never get glued
// onto a previously printed URL.
const TYPING_SUPPRESS_MS = 2000;
// Statuses that mean "the run is over" — the only moment auto-preview is
// allowed to navigate the browser dock.
const RUN_DONE_STATUSES: ReadonlySet<AgentStatus> = new Set([
  "idle",
  "waiting_input",
]);

function trackInlineInput(entry: CachedTerminal, data: string) {
  const before = entry.inlineTracker.snapshot().revision;
  const next = entry.inlineTracker.note(data);
  if (next.revision !== before) {
    entry.onInlineInputChange?.(next);
    entry.onPromptInputChange?.(entry.sessionId, terminalInputSyncState(entry));
  }
}

function terminalProgramIdentity(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const tokens = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index].replace(/^['"]|['"]$/g, "");
    if (["command", "exec", "nohup", "sudo"].includes(token)) {
      index++;
      continue;
    }
    if (token === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index++;
      continue;
    }
    return token.split(/[\\/]/).pop()?.toLowerCase();
  }
  return undefined;
}

function terminalInputSyncState(entry: CachedTerminal): TerminalInputSyncState {
  return {
    ...entry.inlineTracker.snapshot(),
    connected: entry.ws?.readyState === WebSocket.OPEN,
    editorIdentity: entry.editorIdentity,
  };
}

export function getTerminalInputSyncState(sessionId: string): TerminalInputSyncState | null {
  const entry = cache.get(sessionId);
  return entry ? terminalInputSyncState(entry) : null;
}

export function destroyCachedTerminal(sessionId: string) {
  const entry = cache.get(sessionId);
  if (!entry) return;
  entry.alive = false;
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  if (entry.fitFrame !== undefined) window.cancelAnimationFrame(entry.fitFrame);
  entry.mounts.length = 0;
  entry.ws?.close();
  entry.wrapperDiv.remove();
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

export function sendTerminalInputDirect(sessionId: string, data: string, focus = true): boolean {
  const entry = cache.get(sessionId);
  if (!entry || entry.ws?.readyState !== WebSocket.OPEN) return false;
  trackInlineInput(entry, data);
  entry.lastUserInputAt = Date.now();
  entry.ws.send(JSON.stringify({ type: "input", data }));
  if (focus) entry.term.focus();
  return true;
}

function createSendInput(sessionId: string) {
  return (data: string) => {
    const entry = cache.get(sessionId);
    if (!entry) return;
    if (entry.onUserInput?.(sessionId, data)) {
      entry.term.focus();
      return;
    }
    sendTerminalInputDirect(sessionId, data);
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

// Scan output for local preview URLs but DON'T navigate yet — just remember
// the latest candidate. Navigation only happens at end-of-run (see
// flushPendingLocalPreview), so the browser dock never changes mid-stream or
// while the user is typing a prompt.
function capturePendingLocalPreview(entry: CachedTerminal, output: string) {
  if (!output) return;

  // TUI repaints triggered by the user's own keystrokes glue typed text onto
  // previously printed URLs ("simple.html" + half a prompt). Drop the scan
  // buffer and skip entirely while typing.
  if (Date.now() - (entry.lastUserInputAt || 0) < TYPING_SUPPRESS_MS) {
    entry.previewScanBuffer = "";
    return;
  }

  const scanText = stripAnsiForUrlScan(`${entry.previewScanBuffer || ""}${output}`);
  entry.previewScanBuffer = scanText.slice(-AUTO_PREVIEW_SCAN_LIMIT);

  const urls = extractLocalPreviewUrls(scanText);
  if (urls.length === 0) return;

  const url = urls[urls.length - 1];
  if (!url || isCurrentOpenUiUrl(url)) return;

  entry.pendingPreviewUrl = url;
}

// Apply the captured preview URL once the agent's run is over.
function flushPendingLocalPreview(entry: CachedTerminal) {
  const url = entry.pendingPreviewUrl;
  if (!url) return;
  entry.pendingPreviewUrl = null;

  const store = useStore.getState();
  const isFocusedSession =
    store.viewMode === "focus" && store.focusedSessionIds.includes(entry.nodeId);
  if (isFocusedSession && store.browserPanelOpen && store.browserUrl === url) return;

  const key = `${entry.nodeId}:${url}`;
  const now = Date.now();
  const lastOpenedAt = recentAutoPreviewOpens.get(key) || 0;
  if (now - lastOpenedAt < AUTO_PREVIEW_COOLDOWN_MS) return;
  recentAutoPreviewOpens.set(key, now);

  store.setBrowserUrl(url);
  if (isFocusedSession) {
    store.setBrowserPanelOpen(true);
  }
}

function connectWs(
  entry: CachedTerminal,
  sessionId: string,
  sendInput: (data: string) => void,
  onReady?: (sendInput: (text: string) => void) => void,
) {
  if (!entry.alive) return;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws?sessionId=${sessionId}`;
  const ws = new WebSocket(wsUrl);
  const processOutput = (data: string) => entry.kittyKeyboard.processOutput(data, (response) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "terminalResponse", data: response }));
    }
  });
  entry.ws = ws;
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = undefined;
  }

  ws.onopen = () => {
    entry.reconnectAttempt = 0;
    // The server replays its whole scrollback on every connect, so the old
    // viewport-only clear (CSI 2J) left the previous copy sitting in scrollback
    // and stacked a new one under it every reconnect. CSI 3J drops the
    // scrollback too. Deliberately not term.reset(): that would also clear DEC
    // modes the running program set — bracketed paste, mouse reporting,
    // application cursor keys — and a replay cannot put them back. Doing it on
    // open rather than on the first output frame also stops a late clear from
    // wiping the first live frame of a session with an empty buffer.
    entry.kittyKeyboard.reset();
    entry.term.write("\x1b[H\x1b[2J\x1b[3J\x1b[0m");
    sendResize(entry, entry.term.cols, entry.term.rows);
    entry.onPromptInputChange?.(sessionId, terminalInputSyncState(entry));
    onReady?.(sendInput);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "output") {
        const output = processOutput(msg.data);
        capturePendingLocalPreview(entry, output);
        entry.term.write(output, () => entry.onCursorUpdate?.());
      } else if (msg.type === "status") {
        entry.updateSession(entry.nodeId, {
          status: msg.status as AgentStatus,
          isRestored: msg.isRestored,
          currentTool: msg.currentTool,
        });
        // Only navigate the browser dock once the run has finished.
        if (RUN_DONE_STATUSES.has(msg.status as AgentStatus)) {
          flushPendingLocalPreview(entry);
        }
      } else if (msg.type === "terminalState") {
        const activeBlock = Array.isArray(msg.blocks)
          ? msg.blocks.find((block: any) => block?.id === msg.activeBlockId)
          : undefined;
        entry.editorIdentity = msg.alternateScreen
          ? terminalProgramIdentity(activeBlock?.command)
          : undefined;
        const before = entry.inlineTracker.snapshot().revision;
        const next = entry.inlineTracker.updateLifecycle(msg.phase, msg.alternateScreen);
        if (next.revision !== before) entry.onInlineInputChange?.(next);
        entry.onPromptInputChange?.(sessionId, terminalInputSyncState(entry));
      } else if (msg.type === "nameGenerated") {
        entry.updateSession(entry.nodeId, { customName: msg.name });
      }
    } catch {
      if (typeof event.data === "string") {
        capturePendingLocalPreview(entry, event.data);
      }
      entry.term.write(event.data, () => entry.onCursorUpdate?.());
    }
  };

  ws.onerror = () => {};
  ws.onclose = (event) => {
    if (entry.ws === ws) {
      entry.ws = null;
      entry.onPromptInputChange?.(sessionId, terminalInputSyncState(entry));
      if (entry.alive && ![1003, 1007, 1008, 1009].includes(event.code)) {
        const attempt = entry.reconnectAttempt || 0;
        entry.reconnectAttempt = attempt + 1;
        const delay = Math.min(5_000, 250 * (2 ** Math.min(attempt, 5)));
        entry.reconnectTimer = setTimeout(() => {
          entry.reconnectTimer = undefined;
          if (entry.alive && (!entry.ws || entry.ws.readyState >= WebSocket.CLOSING)) {
            connectWs(entry, sessionId, sendInput, onReady);
          }
        }, delay);
      }
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
  onPromptInputChange,
  onUserInput,
  synchronizedPreview,
  workbench = false,
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
  const [inlineInput, setInlineInput] = useState<InlineInputState>(EMPTY_INLINE_INPUT);
  const [inlineSuggestions, setInlineSuggestions] = useState<TerminalSuggestion[]>([]);
  const [inlineLoading, setInlineLoading] = useState(false);
  const [inlineMenuOpen, setInlineMenuOpen] = useState(false);
  const [inlineSelectedIndex, setInlineSelectedIndex] = useState(0);
  const [dismissedInlineBuffer, setDismissedInlineBuffer] = useState<string | null>(null);
  const [inlineAnchor, setInlineAnchor] = useState<InlineSuggestionAnchor | null>(null);
  const inlineUiRef = useRef({
    suggestions: [] as TerminalSuggestion[],
    menuOpen: false,
    selectedIndex: 0,
    dismissedBuffer: null as string | null,
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
      entry.onInlineInputChange = setInlineInput;
      entry.onPromptInputChange = onPromptInputChange;
      entry.onUserInput = onUserInput;
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
      // A font change moves the cell size, so the column count moves with it —
      // term.onResize forwards the new geometry to the PTY.
      const fitTimer = setTimeout(() => safeFit(entry), 0);
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

    // Captured so cleanups only detach the terminal from THIS container.
    // Another mount point (canvas card / focus pane / sidebar) may have
    // adopted the wrapperDiv by the time our cleanup runs — removing it
    // from its new parent leaves that pane black.
    const container = containerRef.current;

    const existing = cache.get(sessionId);

    if (existing?.alive) {
      // --- Reattach cached terminal ---
      existing.nodeId = nodeId;
      existing.updateSession = updateSession;
      existing.cwd = cwd;
      existing.onOpenFile = onOpenFile;
      existing.onInlineInputChange = setInlineInput;
      existing.onPromptInputChange = onPromptInputChange;
      existing.onUserInput = onUserInput;
      setInlineInput(existing.inlineTracker.snapshot());
      onPromptInputChange?.(sessionId, terminalInputSyncState(existing));

      attachTerminal(existing, container);

      const f1 = setTimeout(() => safeFit(existing), 50);
      const f2 = setTimeout(() => safeFit(existing), 300);

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
        resizeTimer = setTimeout(() => safeFit(existing), 100);
      });
      ro.observe(container);

      return () => {
        clearTimeout(f1);
        clearTimeout(f2);
        clearTimeout(resizeTimer);
        ro.disconnect();
        detachTerminal(existing, container);
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
    // SIXEL + iTerm2 inline images. Loaded before open() so its parser hooks and
    // CSI 14/16/18 t size reports are in place for the first byte of output.
    term.loadAddon(new ImageAddon({
      storageLimit: IMAGE_STORAGE_LIMIT_MB,
      pixelLimit: IMAGE_PIXEL_LIMIT,
      sixelSizeLimit: IMAGE_SEQUENCE_LIMIT_BYTES,
      iipSizeLimit: IMAGE_SEQUENCE_LIMIT_BYTES,
    }));

    // Attach first: xterm starts its visibility observer during open(), and an
    // element that is measured while detached spends its first frames paused.
    container.appendChild(wrapperDiv);
    term.open(wrapperDiv);
    term.write("\x1b[0m\x1b[?25h");

    const entry: CachedTerminal = {
      sessionId,
      term,
      fitAddon,
      wrapperDiv,
      mounts: [],
      userInputTracked: false,
      sawUserInput: false,
      ws: null,
      reconnectAttempt: 0,
      kittyKeyboard: new KittyKeyboardProtocol(!/^Win/.test(navigator.platform)),
      previewScanBuffer: "",
      pendingPreviewUrl: null,
      lastUserInputAt: 0,
      alive: true,
      nodeId,
      updateSession,
      cwd,
      onOpenFile,
      inlineTracker: new InlineTerminalInput(),
      onInlineInputChange: setInlineInput,
      onPromptInputChange,
      onUserInput,
    };
    cache.set(sessionId, entry);
    entry.userInputTracked = watchUserInput(entry);
    // wrapperDiv is already inside `container` (open() needs it attached), so this
    // only registers the ownership claim — but it keeps every mount path on one
    // function, which is the invariant that stops panes stranding each other.
    attachTerminal(entry, container);

    // Every path that changes the grid (fit, font size, manual resize) lands here,
    // so the terminal and the PTY cannot drift. ws.onopen additionally re-sends the
    // current geometry on each (re)connect, since a new socket knows nothing.
    term.onResize(({ cols, rows }) => sendResize(entry, cols, rows));

    const sendTerminalResponse = (data: string) => {
      const current = cache.get(sessionId);
      if (current?.ws?.readyState === WebSocket.OPEN) {
        current.ws.send(JSON.stringify({ type: "terminalResponse", data }));
      }
    };
    term.parser.registerOscHandler(52, (data) => handleOsc52Clipboard(
      data,
      useStore.getState().terminalOsc52ClipboardAccess,
      sendTerminalResponse,
    ));

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
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

    term.attachCustomKeyEventHandler((e) => {
      if (entry.inlineKeyHandler?.(e)) return false;
      const kittySequence = encodeKittyKeyboardEvent(e, entry.kittyKeyboard.flags, isMac);
      if (kittySequence !== null) {
        sendInput(kittySequence);
        return false;
      }
      if (e.type !== "keydown" || e.key !== "Enter") return true;

      if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        sendInput("\x1b[200~\n\x1b[201~");
        return false;
      }
      return true;
    });

    // The only call site that can carry emulator replies. Every other caller
    // (typing through the kitty encoder, paste, drag-drop, completions,
    // synchronized input) is user input by construction.
    term.onData((data) => {
      if (chunkWasTyped(entry, data)) sendInput(data);
      else sendTerminalReply(entry, data);
    });

    const connectTimeout = setTimeout(
      () => connectWs(entry, sessionId, sendInput, onReady),
      100,
    );

    const fit1 = setTimeout(() => safeFit(entry), 250);
    const fit2 = setTimeout(() => safeFit(entry), 500);

    let resizeTimer: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => safeFit(entry), 100);
    });
    ro.observe(container);

    return () => {
      clearTimeout(connectTimeout);
      clearTimeout(fit1);
      clearTimeout(fit2);
      clearTimeout(resizeTimer);
      ro.disconnect();
      // Detach from the DOM but keep the terminal alive in cache, handing it to
      // whichever pane is still showing this session.
      detachTerminal(entry, container);
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
    createSendInput(sessionId)(insertion);
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
        const injected = body.injected === true;

        if (saved === 0) {
          throw new Error(skipped > 0 ? "Image type was skipped" : "No image was saved");
        }

        setClipboardUpload({
          phase: "done",
          message:
            !injected
              ? `Saved ${saved} image${saved === 1 ? "" : "s"}; terminal is offline`
              : skipped > 0
                ? `Attached ${saved}, skipped ${skipped}; path inserted`
                : `Attached ${saved} image${saved === 1 ? "" : "s"}; path inserted`,
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
      if (images.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        void uploadClipboardImages(images);
        return;
      }

      const rendererAdvertisesImage = Array.from(e.clipboardData.types)
        .some((type) => CLIPBOARD_IMAGE_TYPES.has(type));
      const text = e.clipboardData.getData("text/plain");
      if (!window.electronAPI?.isElectron || (text && !rendererAdvertisesImage)) return;

      // macOS screenshots can exist only in Electron's native clipboard as
      // TIFF/PNG and arrive in Chromium without a File item. Prevent xterm
      // from swallowing that paste while the main process materializes it.
      e.preventDefault();
      e.stopPropagation();
      void nativeClipboardImageFile()
        .then((image) => image ? uploadClipboardImages([image]) : undefined)
        .catch((error) => {
          setClipboardUpload({
            phase: "error",
            message: error instanceof Error ? error.message : "Clipboard image could not be read",
          });
          window.setTimeout(() => setClipboardUpload({ phase: "idle" }), 2_800);
        });
    },
    [uploadClipboardImages],
  );

  const inlineEligible = inlineInput.phase === "at_prompt" &&
    inlineInput.certain && !inlineInput.alternateScreen;
  const visibleInlineSuggestions = inlineSuggestions.filter((suggestion) =>
    inlineSuggestionKinds.has(suggestion.kind),
  );
  const ghostSuggestion = dismissedInlineBuffer === inlineInput.buffer
    ? undefined
    : visibleInlineSuggestions.find((suggestion) =>
        terminalSuggestionSuffix(inlineInput.buffer, suggestion) !== null,
      );
  const ghostSuffix = ghostSuggestion
    ? terminalSuggestionSuffix(inlineInput.buffer, ghostSuggestion)
    : null;
  const synchronizedPreviewText = synchronizedPreview?.text || "";

  useEffect(() => {
    setInlineSuggestions([]);
    setInlineLoading(false);
    setInlineMenuOpen(false);
    setInlineSelectedIndex(0);
    setDismissedInlineBuffer(null);
    const entry = cache.get(sessionId);
    setInlineInput(entry ? entry.inlineTracker.snapshot() : { ...EMPTY_INLINE_INPUT });
  }, [sessionId]);

  useEffect(() => {
    if (!inlineEligible || (!inlineInput.buffer && !inlineMenuOpen)) {
      setInlineSuggestions([]);
      setInlineLoading(false);
      if (!inlineEligible) setInlineMenuOpen(false);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setInlineLoading(true);
      try {
        const params = new URLSearchParams({
          query: inlineInput.buffer,
          sessionId,
          cwd: cwd || "",
          limit: "12",
        });
        const response = await fetch(`/api/terminal/suggestions?${params}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Inline completions are unavailable");
        const seen = new Set<string>();
        const items = (Array.isArray(body.suggestions) ? body.suggestions as TerminalSuggestion[] : [])
          .filter((suggestion) => inlineSuggestionKinds.has(suggestion.kind))
          .filter((suggestion) => {
            const completed = applyTerminalSuggestion(inlineInput.buffer, suggestion);
            if (!completed.trim() || seen.has(completed)) return false;
            seen.add(completed);
            return true;
          })
          .slice(0, 8);
        setInlineSuggestions(items);
        setInlineSelectedIndex((current) => Math.min(current, Math.max(0, items.length - 1)));
      } catch (error) {
        if ((error as Error).name !== "AbortError") setInlineSuggestions([]);
      } finally {
        if (!controller.signal.aborted) setInlineLoading(false);
      }
    }, 85);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [cwd, inlineEligible, inlineInput.buffer, inlineMenuOpen, sessionId]);

  // Safety net: detach hands the terminal back, but a container that React swaps
  // out underneath a live mount (a pane re-keyed mid-animation) changes ownership
  // without either helper running, leaving the node parented to a container that is
  // no longer in the document. Deliberately unconditional rather than keyed on
  // deps — the trigger is a DOM identity change, which no dependency list can name.
  // reclaimTerminal is a no-op once the node sits with its owner, so the steady
  // state costs a Map lookup and two reference compares.
  useEffect(() => {
    const entry = cache.get(sessionId);
    if (!entry?.alive || !containerRef.current) return;
    if (entry.wrapperDiv.isConnected) return;
    reclaimTerminal(entry);
  });

  const updateInlineAnchor = useCallback(() => {
    const root = containerRef.current;
    const entry = cache.get(sessionId);
    const screen = entry?.wrapperDiv.querySelector<HTMLElement>(".xterm-screen");
    // Another pane may own the terminal right now; its rects say nothing about
    // where our cursor is, so anchor nothing rather than something wrong.
    if (entry && root && !root.contains(entry.wrapperDiv)) {
      setInlineAnchor(null);
      return;
    }
    if (!root || !entry || !screen || entry.term.cols < 1 || entry.term.rows < 1) {
      setInlineAnchor(null);
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const cellWidth = screenRect.width / entry.term.cols;
    const cellHeight = screenRect.height / entry.term.rows;
    const buffer = entry.term.buffer.active;
    const left = Math.max(12, Math.min(
      rootRect.width - 30,
      screenRect.left - rootRect.left + buffer.cursorX * cellWidth,
    ));
    const top = Math.max(8, Math.min(
      rootRect.height - 18,
      screenRect.top - rootRect.top + buffer.cursorY * cellHeight,
    ));
    const menuWidth = Math.min(410, Math.max(0, rootRect.width - 24));
    const menuLeft = Math.max(12, Math.min(left, rootRect.width - menuWidth - 12));
    setInlineAnchor({ left, menuLeft, menuWidth, top, placeAbove: top > rootRect.height * 0.55 });
  }, [sessionId]);

  useEffect(() => {
    if ((!inlineEligible || (!ghostSuffix && !inlineMenuOpen)) && !synchronizedPreviewText) {
      setInlineAnchor(null);
      return;
    }
    const frame = window.requestAnimationFrame(updateInlineAnchor);
    const root = containerRef.current;
    const observer = root ? new ResizeObserver(updateInlineAnchor) : null;
    if (root && observer) observer.observe(root);
    window.addEventListener("resize", updateInlineAnchor);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", updateInlineAnchor);
    };
  }, [ghostSuffix, inlineEligible, inlineInput.revision, inlineMenuOpen, synchronizedPreviewText, updateInlineAnchor]);

  const acceptInlineSuggestion = useCallback((suggestion: TerminalSuggestion, partial = false) => {
    const entry = cache.get(sessionId);
    const tracked = entry?.inlineTracker.snapshot();
    if (!entry || !tracked || tracked.phase !== "at_prompt" || !tracked.certain || tracked.alternateScreen) {
      return;
    }
    const current = tracked.buffer;
    const completed = applyTerminalSuggestion(current, suggestion);
    const suffix = completed.startsWith(current) ? completed.slice(current.length) : null;
    const insertion = partial && suffix
      ? nextTerminalSuggestionComponent(suffix)
      : suffix ?? `\x15${completed}`;
    if (!insertion) return;
    setInlineMenuOpen(false);
    setDismissedInlineBuffer(null);
    createSendInput(sessionId)(insertion);
    window.setTimeout(() => cache.get(sessionId)?.term.focus(), 0);
  }, [sessionId]);

  useEffect(() => {
    inlineUiRef.current = {
      suggestions: visibleInlineSuggestions,
      menuOpen: inlineMenuOpen,
      selectedIndex: inlineSelectedIndex,
      dismissedBuffer: dismissedInlineBuffer,
    };
  }, [dismissedInlineBuffer, inlineMenuOpen, inlineSelectedIndex, visibleInlineSuggestions]);

  const handleInlineKey = useCallback((event: KeyboardEvent): boolean => {
    if (event.type !== "keydown") return false;
    const entry = cache.get(sessionId);
    const tracked = entry?.inlineTracker.snapshot();
    if (!entry || !tracked || tracked.phase !== "at_prompt" || !tracked.certain || tracked.alternateScreen) {
      return false;
    }
    const ui = inlineUiRef.current;
    const items = ui.suggestions;
    const selected = items[Math.min(ui.selectedIndex, Math.max(0, items.length - 1))];
    const prefixSuggestion = ui.dismissedBuffer === tracked.buffer
      ? undefined
      : items.find((suggestion) => terminalSuggestionSuffix(tracked.buffer, suggestion) !== null);

    if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === "Space") {
      setInlineMenuOpen(true);
      setInlineSelectedIndex(0);
      setDismissedInlineBuffer(null);
      return true;
    }
    if (event.key === "Escape" && (ui.menuOpen || prefixSuggestion)) {
      setInlineMenuOpen(false);
      setDismissedInlineBuffer(tracked.buffer);
      return true;
    }
    if (ui.menuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (items.length) {
          const delta = event.key === "ArrowDown" ? 1 : -1;
          setInlineSelectedIndex((current) => (current + delta + items.length) % items.length);
        }
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        if (selected) acceptInlineSuggestion(selected);
        return true;
      }
    }
    if (!prefixSuggestion) return false;
    if (event.key === "ArrowRight" && event.ctrlKey && !event.metaKey && !event.altKey) {
      acceptInlineSuggestion(prefixSuggestion, true);
      return true;
    }
    if (
      (event.key === "ArrowRight" && !event.ctrlKey && !event.metaKey && !event.altKey) ||
      (event.ctrlKey && !event.metaKey && !event.altKey && ["f", "e"].includes(event.key.toLowerCase()))
    ) {
      acceptInlineSuggestion(prefixSuggestion);
      return true;
    }
    return false;
  }, [acceptInlineSuggestion, sessionId]);

  useEffect(() => {
    const entry = cache.get(sessionId);
    if (!entry) return;
    entry.inlineKeyHandler = handleInlineKey;
    entry.onInlineInputChange = setInlineInput;
    entry.onPromptInputChange = onPromptInputChange;
    entry.onUserInput = onUserInput;
    entry.onCursorUpdate = updateInlineAnchor;
    onPromptInputChange?.(sessionId, terminalInputSyncState(entry));
    return () => {
      if (entry.inlineKeyHandler === handleInlineKey) entry.inlineKeyHandler = undefined;
      if (entry.onInlineInputChange === setInlineInput) entry.onInlineInputChange = undefined;
      if (entry.onPromptInputChange === onPromptInputChange) entry.onPromptInputChange = undefined;
      if (entry.onUserInput === onUserInput) entry.onUserInput = undefined;
      if (entry.onCursorUpdate === updateInlineAnchor) entry.onCursorUpdate = undefined;
    };
  }, [handleInlineKey, onPromptInputChange, onUserInput, sessionId, updateInlineAnchor]);

  const handleInlineKeyCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!handleInlineKey(event.nativeEvent)) return;
    event.preventDefault();
    event.stopPropagation();
  }, [handleInlineKey]);

  return (
    <div
      onKeyDownCapture={handleInlineKeyCapture}
      onPasteCapture={handlePasteCapture}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative w-full h-full"
      style={{
        minHeight: "200px",
        backgroundColor: workbench ? terminalTheme.background : terminalTheme.surface,
      }}
    >
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{
          padding: workbench ? "16px 18px 20px" : "14px",
          backgroundColor: terminalTheme.background,
          border: workbench ? "none" : `1px solid ${terminalTheme.border}`,
          boxShadow: workbench ? "none" : `inset 0 1px 0 ${terminalTheme.foreground}0f`,
          minHeight: "200px",
          overflow: "hidden",
        }}
      />
      {inlineEligible && inlineAnchor && synchronizedPreview && synchronizedPreviewText && (
        <div
          className="pointer-events-none absolute z-30 flex items-baseline overflow-hidden whitespace-pre"
          style={{
            left: inlineAnchor.left,
            top: inlineAnchor.top,
            maxWidth: "calc(100% - 24px)",
            color: "oklch(78% 0.10 48)",
            fontFamily: terminalFont.stack,
            fontSize: clampedFontSize,
            lineHeight: 1.42,
          }}
          role="status"
          aria-label={`Synchronized command from ${synchronizedPreview.sourceName}: ${synchronizedPreviewText}`}
        >
          <span className="truncate">{synchronizedPreviewText}</span>
          <span
            className="ml-2 flex-shrink-0 rounded border px-1 py-0.5 text-[8px] leading-none"
            style={{
              borderColor: "oklch(42% 0.06 48)",
              backgroundColor: "oklch(13% 0.015 48)",
              color: "oklch(74% 0.08 48)",
              fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
            }}
          >
            synced from {synchronizedPreview.sourceName}
          </span>
        </div>
      )}
      {inlineEligible && inlineAnchor && ghostSuffix && !inlineMenuOpen && (
        <div
          className="pointer-events-none absolute z-30 flex items-baseline whitespace-pre"
          style={{
            left: inlineAnchor.left,
            top: inlineAnchor.top,
            color: `color-mix(in oklch, ${terminalTheme.foreground} 34%, transparent)`,
            fontFamily: terminalFont.stack,
            fontSize: clampedFontSize,
            lineHeight: 1.42,
          }}
          aria-hidden="true"
        >
          <span>{ghostSuffix}</span>
          <span
            className="ml-2 rounded border px-1 py-0.5 text-[8px] leading-none"
            style={{
              borderColor: terminalTheme.border,
              backgroundColor: terminalTheme.surface,
              color: `color-mix(in oklch, ${terminalTheme.foreground} 48%, transparent)`,
              fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
            }}
          >
            → accept · ⌃→ word
          </span>
        </div>
      )}
      {inlineEligible && inlineAnchor && inlineMenuOpen && (
        <div
          className="absolute z-40 overflow-hidden rounded-md border shadow-2xl"
          style={{
            left: inlineAnchor.menuLeft,
            top: inlineAnchor.placeAbove ? inlineAnchor.top - 7 : inlineAnchor.top + clampedFontSize * 1.7,
            transform: inlineAnchor.placeAbove ? "translateY(-100%)" : undefined,
            width: inlineAnchor.menuWidth,
            borderColor: terminalTheme.border,
            backgroundColor: terminalTheme.surface,
          }}
          role="listbox"
          aria-label="Terminal completions"
        >
          <div className="flex h-7 items-center justify-between border-b px-2.5 text-[8px] uppercase tracking-[0.12em] text-zinc-600" style={{ borderColor: terminalTheme.border }}>
            <span>Complete at prompt</span>
            <span className="normal-case tracking-normal text-zinc-700">Ctrl Space</span>
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {inlineLoading && visibleInlineSuggestions.length === 0 ? (
              <div className="px-3 py-3 text-[10px] text-zinc-600">Looking for completions…</div>
            ) : visibleInlineSuggestions.length === 0 ? (
              <div className="px-3 py-3 text-[10px] text-zinc-600">No matching commands, flags, paths, or history.</div>
            ) : visibleInlineSuggestions.map((suggestion, index) => {
              const active = index === inlineSelectedIndex;
              const completed = applyTerminalSuggestion(inlineInput.buffer, suggestion);
              return (
                <button
                  key={suggestion.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  tabIndex={-1}
                  onMouseMove={() => setInlineSelectedIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => acceptInlineSuggestion(suggestion)}
                  className={`flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
                    active ? "bg-[oklch(20%_0.018_48)]" : "hover:bg-[oklch(17%_0.007_260)]"
                  }`}
                >
                  <span className={`min-w-0 flex-1 truncate font-mono text-[10px] ${active ? "text-zinc-100" : "text-zinc-300"}`}>
                    {completed}
                  </span>
                  <span className="flex-shrink-0 text-[8px] text-zinc-600">
                    {INLINE_KIND_LABELS[suggestion.kind] || suggestion.kind}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex h-7 items-center gap-3 border-t px-2.5 text-[8px] text-zinc-600" style={{ borderColor: terminalTheme.border }}>
            <span>↑↓ select</span>
            <span>↵ insert</span>
            <span>Esc close</span>
          </div>
        </div>
      )}
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
