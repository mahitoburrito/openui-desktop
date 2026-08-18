import type {
  TerminalBlockSource,
  TerminalCommandBlock,
  TerminalLifecyclePhase,
  TerminalLifecycleSnapshot,
  TerminalModeSnapshot,
  TerminalShellCompletionEntry,
  TerminalShellCompletionKind,
  TerminalShellCapabilities,
  TerminalShellCapabilityKey,
  TerminalShellEnvironment,
  TerminalShellEnvironmentKey,
} from "../types";
import { classifyTerminalExitCode, classifyTerminalFailureKind } from "./terminalExit";
import {
  TerminalOutputPolicy,
  terminalOsc52ClipboardAccess,
  type TerminalOsc52ClipboardAccess,
} from "./terminalOutputPolicy";
import { redactTerminalText } from "./terminalRedaction";
import { compactTerminalFrameRedraws, stripUnsafeTerminalControls } from "./terminalSharing";

export { classifyTerminalExitCode, classifyTerminalFailureKind } from "./terminalExit";

const MAX_OSC_SEQUENCE_CHARS = 64 * 1024;
const MAX_BLOCKS_PER_SESSION = 250;
const MAX_BLOCK_OUTPUT_CHARS = 200_000;
const MAX_TRACKED_INPUT_CHARS = 64_000;
const MAX_SHELL_EPOCH_DEPTH = 16;
const MAX_CSI_PARAMETER_CHARS = 128;

type TerminalLifecycleEvent =
  | { type: "prompt-start"; epochId?: string }
  | { type: "prompt-end"; epochId?: string }
  | { type: "command-line"; command: string }
  | { type: "command-start"; epochId?: string }
  | { type: "command-finished"; exitCode?: number; epochId?: string }
  | { type: "cwd"; cwd: string; epochId?: string }
  | { type: "integration-ready"; shell?: string; epochId?: string }
  | { type: "completion-context"; epochId: string; kind: TerminalShellCompletionKind; names: string[] }
  | { type: "shell-environment"; epochId: string; key: TerminalShellEnvironmentKey; value: string }
  | { type: "shell-capability"; epochId: string; key: TerminalShellCapabilityKey; enabled: boolean }
  | { type: "continuation-prompt"; epochId?: string }
  | { type: "remote-control"; payload: string }
  | { type: "shell-exit"; exitCode?: number; epochId?: string };

type ParsedSegment =
  | { type: "data"; data: string }
  | { type: "event"; event: TerminalLifecycleEvent };

type TerminalPrivateModeChange = { mode: number; enabled: boolean };
type TerminalModeParserState =
  | "ground"
  | "escape"
  | "csi"
  | "csi-ignore"
  | "control-string"
  | "control-string-escape";

function defaultTerminalModes(): TerminalModeSnapshot {
  return {
    applicationCursorKeys: false,
    mouseTracking: "none",
    focusReporting: false,
    mouseEncoding: "default",
    alternateScroll: false,
    synchronizedOutput: false,
  };
}

/**
 * Bounded VT parser for DEC private mode set/reset controls. Regex scanning is
 * insufficient here: CSI may be split or use its C1 form, several parameters
 * may share one final byte, and CSI-looking bytes inside OSC/DCS/APC strings
 * are payload rather than terminal mode changes.
 */
class TerminalPrivateModeParser {
  private state: TerminalModeParserState = "ground";
  private csiParameters = "";
  private csiHasIntermediate = false;
  private controlStringAllowsBel = false;

  feed(chunk: string): TerminalPrivateModeChange[] {
    const changes: TerminalPrivateModeChange[] = [];
    for (const char of chunk) {
      const code = char.charCodeAt(0);
      switch (this.state) {
        case "ground":
          if (char === "\x1b") this.state = "escape";
          else if (code === 0x9b) this.startCsi();
          else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
            this.startControlString(code === 0x9d);
          }
          break;
        case "escape":
          if (char === "[") this.startCsi();
          else if (char === "]") this.startControlString(true);
          else if (["P", "X", "^", "_"].includes(char)) this.startControlString(false);
          else if (char !== "\x1b") this.state = "ground";
          break;
        case "csi":
          if (char === "\x1b") {
            this.state = "escape";
          } else if (code === 0x18 || code === 0x1a) {
            this.state = "ground";
          } else if (code >= 0x30 && code <= 0x3f) {
            if (this.csiParameters.length >= MAX_CSI_PARAMETER_CHARS) {
              this.state = "csi-ignore";
            } else {
              this.csiParameters += char;
            }
          } else if (code >= 0x20 && code <= 0x2f) {
            this.csiHasIntermediate = true;
          } else if (code >= 0x40 && code <= 0x7e) {
            if (!this.csiHasIntermediate && (char === "h" || char === "l")) {
              this.appendPrivateModeChanges(changes, char === "h");
            }
            this.state = "ground";
          } else if (code >= 0x20 && code !== 0x7f) {
            this.state = "ground";
          }
          break;
        case "csi-ignore":
          if (char === "\x1b") this.state = "escape";
          else if (code === 0x18 || code === 0x1a || (code >= 0x40 && code <= 0x7e)) {
            this.state = "ground";
          }
          break;
        case "control-string":
          if (code === 0x9c || (this.controlStringAllowsBel && char === "\x07")) {
            this.state = "ground";
          } else if (char === "\x1b") {
            this.state = "control-string-escape";
          }
          break;
        case "control-string-escape":
          if (char === "\\" || code === 0x9c ||
            (this.controlStringAllowsBel && char === "\x07")) {
            this.state = "ground";
          } else if (char !== "\x1b") {
            this.state = "control-string";
          }
          break;
      }
    }
    return changes;
  }

  reset() {
    this.state = "ground";
    this.csiParameters = "";
    this.csiHasIntermediate = false;
    this.controlStringAllowsBel = false;
  }

  private startCsi() {
    this.state = "csi";
    this.csiParameters = "";
    this.csiHasIntermediate = false;
  }

  private startControlString(allowsBel: boolean) {
    this.state = "control-string";
    this.controlStringAllowsBel = allowsBel;
  }

  private appendPrivateModeChanges(changes: TerminalPrivateModeChange[], enabled: boolean) {
    if (!this.csiParameters.startsWith("?")) return;
    for (const raw of this.csiParameters.slice(1).split(";")) {
      if (!/^\d{1,5}$/.test(raw)) continue;
      const mode = Number(raw);
      if (mode > 0 && mode <= 65_535) changes.push({ mode, enabled });
    }
  }
}

export interface TerminalLifecycleFeedResult {
  data: string;
  persistenceData: string;
  changedBlockIds: string[];
  stateChanged: boolean;
  remoteControlPayloads: string[];
  osc52: {
    blockedReads: number;
    blockedWrites: number;
    malformed: number;
    oversized: number;
  };
}

interface SuspendedShellEpoch {
  epochId?: string;
  shellIntegration?: string;
  cwd: string;
  phase: TerminalLifecyclePhase;
  activeBlockId?: string;
  pendingCommand: string;
  shellCompletions: TerminalShellCompletionEntry[];
  shellEnvironment: TerminalShellEnvironment;
  shellCapabilities: TerminalShellCapabilities;
}

const SHELL_COMPLETION_KINDS = new Set<TerminalShellCompletionKind>([
  "alias",
  "function",
  "builtin",
  "keyword",
  "abbreviation",
  "variable",
]);
const MAX_SHELL_COMPLETIONS_PER_KIND = 512;
const MAX_SHELL_COMPLETION_NAME_CHARS = 128;
const SHELL_ENVIRONMENT_KEYS = new Set<TerminalShellEnvironmentKey>(["PATH", "PATHEXT", "CDPATH"]);
const MAX_SHELL_ENVIRONMENT_VALUE_CHARS = 12_000;
const SHELL_CAPABILITY_KEYS = new Set<TerminalShellCapabilityKey>(["autocd"]);

function defaultShellCapabilities(shell: string | undefined): TerminalShellCapabilities {
  switch ((shell || "").toLowerCase()) {
    case "fish":
      return { autocd: true };
    case "bash":
    case "zsh":
    case "pwsh":
    case "powershell":
      return { autocd: false };
    default:
      return {};
  }
}

function parseShellCompletionName(value: string, kind: TerminalShellCompletionKind): string | undefined {
  const name = value.trim();
  if (!name || name.length > MAX_SHELL_COMPLETION_NAME_CHARS) return undefined;
  if (kind === "variable") {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) return undefined;
  } else if (!/^(?:[A-Za-z0-9_][A-Za-z0-9_.:+@%+\-]{0,127}|\[)$/.test(name)) {
    return undefined;
  }
  if (/^__openui_/i.test(name)) return undefined;
  if (kind === "variable" && /^OPENUI_/i.test(name)) return undefined;
  return name;
}

function parseShellEnvironmentValue(value: string): string | undefined {
  if (value.length > MAX_SHELL_ENVIRONMENT_VALUE_CHARS) return undefined;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return undefined;
  return value;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeCommand(value: string): string {
  return value
    .replace(/\\x3b/gi, ";")
    .replace(/\\x5c/gi, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r");
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function reconcileAuthoritativeCommand(existing: string, authoritative: string): string {
  const candidate = authoritative.trim();
  if (!candidate) return existing;
  const lines = existing.split(/\r?\n/).map(normalizeCommand).filter(Boolean);
  if (
    lines.length > 1 &&
    (normalizeCommand(existing) === normalizeCommand(candidate) ||
      lines.includes(normalizeCommand(candidate)))
  ) {
    // Bash can store a bracketed multiline submission as multiple history
    // entries and expose only its final physical line through `history 1`.
    // The PTY write/input tracker already has the complete command, so a
    // matching fragment is completion evidence, not permission to discard it.
    return existing;
  }
  return candidate;
}

function isKnownCliAgentCommand(command: string): boolean {
  const executable = command.trim().split(/\s+/, 1)[0]?.replace(/^['"]|['"]$/g, "") || "";
  const name = executable.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, "") || "";
  return ["claude", "codex", "gemini", "opencode"].includes(name);
}

function parseExitCode(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function parseEpochId(raw: string | undefined): string | undefined {
  if (!raw || raw.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(raw)) return undefined;
  return raw;
}

function cwdFromFileUrl(value: string): string {
  if (!value.startsWith("file://")) return safeDecodeURIComponent(value);
  try {
    return decodeURIComponent(new URL(value).pathname);
  } catch {
    return safeDecodeURIComponent(value.replace(/^file:\/\/[^/]*/, ""));
  }
}

/**
 * Incrementally extracts FinalTerm/VS Code shell integration events while
 * preserving every unrelated byte. OSC sequences can be split at arbitrary
 * PTY chunk boundaries, so incomplete sequences are retained until the next
 * feed instead of leaking fragments into xterm.
 */
export class ShellIntegrationParser {
  private carry = "";

  feed(chunk: string): ParsedSegment[] {
    const input = this.carry + chunk;
    this.carry = "";
    const segments: ParsedSegment[] = [];
    let cursor = 0;

    const pushData = (data: string) => {
      if (!data) return;
      const previous = segments[segments.length - 1];
      if (previous?.type === "data") previous.data += data;
      else segments.push({ type: "data", data });
    };

    while (cursor < input.length) {
      const escIndex = input.indexOf("\x1b]", cursor);
      const c1Index = input.indexOf("\x9d", cursor);
      let oscIndex = -1;
      let introducerLength = 0;
      if (escIndex >= 0 && (c1Index < 0 || escIndex < c1Index)) {
        oscIndex = escIndex;
        introducerLength = 2;
      } else if (c1Index >= 0) {
        oscIndex = c1Index;
        introducerLength = 1;
      }

      if (oscIndex < 0) {
        // Hold a trailing ESC because it may be the first byte of an OSC
        // introducer split across chunks.
        if (input.endsWith("\x1b")) {
          pushData(input.slice(cursor, -1));
          this.carry = "\x1b";
        } else {
          pushData(input.slice(cursor));
        }
        break;
      }

      pushData(input.slice(cursor, oscIndex));
      const payloadStart = oscIndex + introducerLength;
      const belIndex = input.indexOf("\x07", payloadStart);
      const stIndex = input.indexOf("\x1b\\", payloadStart);
      const c1StIndex = input.indexOf("\x9c", payloadStart);
      let terminatorIndex = -1;
      let terminatorLength = 0;
      for (const candidate of [
        belIndex >= 0 ? { index: belIndex, length: 1 } : null,
        stIndex >= 0 ? { index: stIndex, length: 2 } : null,
        c1StIndex >= 0 ? { index: c1StIndex, length: 1 } : null,
      ].filter((entry): entry is { index: number; length: number } => Boolean(entry))) {
        if (terminatorIndex < 0 || candidate.index < terminatorIndex) {
          terminatorIndex = candidate.index;
          terminatorLength = candidate.length;
        }
      }

      if (terminatorIndex < 0) {
        const pending = input.slice(oscIndex);
        if (pending.length <= MAX_OSC_SEQUENCE_CHARS) {
          this.carry = pending;
          break;
        }
        // A malformed/unbounded OSC must not hold the terminal hostage.
        pushData(input.slice(oscIndex, payloadStart));
        cursor = payloadStart;
        continue;
      }

      const end = terminatorIndex + terminatorLength;
      const payload = input.slice(payloadStart, terminatorIndex);
      const event = this.parsePayload(payload);
      if (event) segments.push({ type: "event", event });
      else pushData(input.slice(oscIndex, end));
      cursor = end;
    }

    return segments;
  }

  flush(): string {
    const pending = this.carry;
    this.carry = "";
    return pending;
  }

  reset() {
    this.carry = "";
  }

  private parsePayload(payload: string): TerminalLifecycleEvent | null {
    // OSC 7 communicates the current working directory as a file URL.
    if (payload.startsWith("7;")) {
      return { type: "cwd", cwd: cwdFromFileUrl(payload.slice(2)) };
    }

    // iTerm2-compatible current-directory property.
    if (payload.startsWith("1337;CurrentDir=")) {
      const value = payload.slice("1337;CurrentDir=".length);
      const separator = value.indexOf(";");
      return {
        type: "cwd",
        cwd: safeDecodeURIComponent(separator >= 0 ? value.slice(separator + 1) : value),
      };
    }

    const match = /^(133|633);([A-Z])(?:;(.*))?$/s.exec(payload);
    if (!match) return null;
    const [, , code, value = ""] = match;

    switch (code) {
      case "A":
        return { type: "prompt-start", epochId: parseEpochId(value.split(";")[0]) };
      case "B":
        return { type: "prompt-end", epochId: parseEpochId(value.split(";")[0]) };
      case "C":
        return { type: "command-start", epochId: parseEpochId(value.split(";")[0]) };
      case "D": {
        const fields = value.split(";");
        return {
          type: "command-finished",
          exitCode: parseExitCode(fields[0]),
          epochId: parseEpochId(fields[1]),
        };
      }
      case "E": {
        // VS Code may append a nonce after the command. OpenUI does not emit a
        // nonce, and preserving semicolons is essential for compound commands,
        // so treat the full remainder as command text. Decoding is deferred
        // until lifecycle state can distinguish VS Code escapes from OpenUI's
        // literal shell-history text.
        return { type: "command-line", command: value };
      }
      case "P":
        if (value.startsWith("Cwd=")) {
          return { type: "cwd", cwd: safeDecodeURIComponent(value.slice(4)) };
        }
        return null;
      case "Q": {
        const separator = value.indexOf(";");
        if (separator < 0) return null;
        const epochId = parseEpochId(value.slice(0, separator));
        if (!epochId) return null;
        return { type: "cwd", cwd: safeDecodeURIComponent(value.slice(separator + 1)), epochId };
      }
      case "I": {
        const [shell, rawEpoch] = value.split(";", 2);
        return {
          type: "integration-ready",
          shell: shell || undefined,
          epochId: parseEpochId(rawEpoch),
        };
      }
      case "J": {
        const firstSeparator = value.indexOf(";");
        const secondSeparator = firstSeparator < 0 ? -1 : value.indexOf(";", firstSeparator + 1);
        if (firstSeparator < 0 || secondSeparator < 0) return null;
        const epochId = parseEpochId(value.slice(0, firstSeparator));
        const kindValue = value.slice(firstSeparator + 1, secondSeparator);
        if (!epochId || !SHELL_COMPLETION_KINDS.has(kindValue as TerminalShellCompletionKind)) return null;
        const kind = kindValue as TerminalShellCompletionKind;
        const seen = new Set<string>();
        const names = value.slice(secondSeparator + 1).split(",").flatMap((raw) => {
          const name = parseShellCompletionName(raw, kind);
          if (!name || seen.has(name)) return [];
          seen.add(name);
          return [name];
        }).slice(0, MAX_SHELL_COMPLETIONS_PER_KIND);
        return { type: "completion-context", epochId, kind, names };
      }
      case "L": {
        const firstSeparator = value.indexOf(";");
        const secondSeparator = firstSeparator < 0 ? -1 : value.indexOf(";", firstSeparator + 1);
        if (firstSeparator < 0 || secondSeparator < 0) return null;
        const epochId = parseEpochId(value.slice(0, firstSeparator));
        const keyValue = value.slice(firstSeparator + 1, secondSeparator);
        const environmentValue = parseShellEnvironmentValue(value.slice(secondSeparator + 1));
        if (
          !epochId ||
          !SHELL_ENVIRONMENT_KEYS.has(keyValue as TerminalShellEnvironmentKey) ||
          environmentValue === undefined
        ) return null;
        return {
          type: "shell-environment",
          epochId,
          key: keyValue as TerminalShellEnvironmentKey,
          value: environmentValue,
        };
      }
      case "M": {
        const firstSeparator = value.indexOf(";");
        const secondSeparator = firstSeparator < 0 ? -1 : value.indexOf(";", firstSeparator + 1);
        if (firstSeparator < 0 || secondSeparator < 0) return null;
        const epochId = parseEpochId(value.slice(0, firstSeparator));
        const keyValue = value.slice(firstSeparator + 1, secondSeparator);
        const rawEnabled = value.slice(secondSeparator + 1);
        if (
          !epochId ||
          !SHELL_CAPABILITY_KEYS.has(keyValue as TerminalShellCapabilityKey) ||
          (rawEnabled !== "0" && rawEnabled !== "1")
        ) return null;
        return {
          type: "shell-capability",
          epochId,
          key: keyValue as TerminalShellCapabilityKey,
          enabled: rawEnabled === "1",
        };
      }
      case "N": {
        const epochId = parseEpochId(value.split(";")[0]);
        return epochId ? { type: "continuation-prompt", epochId } : null;
      }
      case "R":
        return /^[A-Za-z0-9_-]{1,4096}$/.test(value)
          ? { type: "remote-control", payload: value }
          : null;
      case "X": {
        const fields = value.split(";");
        return {
          type: "shell-exit",
          exitCode: parseExitCode(fields[0]),
          epochId: parseEpochId(fields[1]),
        };
      }
      default:
        return null;
    }
  }
}

export class TerminalLifecycle {
  private readonly parser = new ShellIntegrationParser();
  private readonly displayParser = new ShellIntegrationParser();
  private readonly outputPolicy: TerminalOutputPolicy;
  private phase: TerminalLifecyclePhase = "unknown";
  private currentCwd: string;
  private shellIntegration: string | undefined;
  private shellEpochId: string | undefined;
  private shellDepth = 0;
  private readonly suspendedShellEpochs: SuspendedShellEpoch[] = [];
  private activeBlockId: string | undefined;
  private pendingCommand = "";
  private inputBuffer = "";
  private inputControlCarry = "";
  private bracketedPaste = false;
  private continuationPrompt = false;
  private inputUncertain = false;
  private inputLastWasCarriageReturn = false;
  private pasteLastWasCarriageReturn = false;
  private nextSequence: number;
  private alternateScreen = false;
  private bracketedPasteEnabled = false;
  private terminalModes = defaultTerminalModes();
  private readonly terminalModeParser = new TerminalPrivateModeParser();
  private shellCompletions: TerminalShellCompletionEntry[] = [];
  private shellEnvironment: TerminalShellEnvironment = {};
  private shellCapabilities: TerminalShellCapabilities = {};
  private readonly knownSecrets = new Set<string>();
  private readonly replayCommands = new Map<string, string>();

  constructor(
    private readonly sessionId: string,
    private readonly blocks: TerminalCommandBlock[],
    initialCwd: string,
    osc52Access: TerminalOsc52ClipboardAccess = terminalOsc52ClipboardAccess(),
  ) {
    this.outputPolicy = new TerminalOutputPolicy(osc52Access);
    this.currentCwd = initialCwd;
    this.nextSequence = blocks.reduce((max, block) => Math.max(max, block.sequence), 0) + 1;
    for (const unfinished of blocks.filter((block) => block.status === "running")) {
      unfinished.status = "interrupted";
      unfinished.completedAt = Date.now();
    }
  }

  feed(data: string): TerminalLifecycleFeedResult {
    const changed = new Set<string>();
    let stateChanged = false;
    let displayData = "";
    let persistenceData = "";
    const remoteControlPayloads: string[] = [];
    const filtered = this.outputPolicy.feed(data);

    for (const segment of this.displayParser.feed(filtered.displayData)) {
      if (segment.type === "data") displayData += segment.data;
    }

    for (const segment of this.parser.feed(filtered.recordData)) {
      if (segment.type === "data") {
        persistenceData += segment.data;
        this.appendToActiveBlock(segment.data, changed);
        if (this.observeTerminalModes(segment.data)) stateChanged = true;
        continue;
      }
      if (segment.event.type === "remote-control") {
        remoteControlPayloads.push(segment.event.payload);
        continue;
      }
      if (this.applyEvent(segment.event, changed)) stateChanged = true;
    }

    return {
      data: displayData,
      persistenceData,
      changedBlockIds: [...changed],
      stateChanged,
      remoteControlPayloads,
      osc52: {
        blockedReads: filtered.blockedReads,
        blockedWrites: filtered.blockedWrites,
        malformed: filtered.malformed,
        oversized: filtered.oversized,
      },
    };
  }

  noteInput(data: string): TerminalCommandBlock | undefined {
    const activeAtInput = this.getActiveBlock();
    const continuationShell = this.shellIntegration === "bash" ||
      this.shellIntegration === "powershell" || this.shellIntegration === "pwsh";
    const trackingContinuation = this.phase === "executing" && this.continuationPrompt &&
      continuationShell && activeAtInput?.status === "running" &&
      activeAtInput.source === "inferred";
    if (
      !trackingContinuation && this.phase !== "at_prompt" &&
      !(this.phase === "unknown" && !this.activeBlockId)
    ) {
      return undefined;
    }

    const input = this.inputControlCarry + data;
    this.inputControlCarry = "";
    let started: TerminalCommandBlock | undefined;

    for (let index = 0; index < input.length; index++) {
      const char = input[index];

      // Terminal editing keys and bracketed-paste markers are CSI/SS3 byte
      // sequences. They can be split across WebSocket messages, so hold an
      // incomplete suffix rather than treating its printable bytes as part of
      // the command (for example, Left Arrow must not append "[D").
      if (char === "\x1b") {
        if (index + 1 >= input.length) {
          this.inputControlCarry = input.slice(index);
          break;
        }

        const family = input[index + 1];
        if (family === "[") {
          let end = index + 2;
          while (end < input.length && !/[\x40-\x7e]/.test(input[end])) end++;
          if (end >= input.length) {
            this.inputControlCarry = input.slice(index);
            break;
          }
          const sequence = input.slice(index, end + 1);
          if (sequence === "\x1b[200~") {
            this.bracketedPaste = true;
            this.pasteLastWasCarriageReturn = false;
          } else if (sequence === "\x1b[201~") {
            this.bracketedPaste = false;
            this.pasteLastWasCarriageReturn = false;
          } else {
            // Shell-side history navigation, cursor movement, completion, and
            // deletion can change the submitted line in ways raw key bytes do
            // not describe. Preserve the output block, but wait for the shell's
            // authoritative command-line marker before naming it.
            this.inputUncertain = true;
          }
          index = end;
          continue;
        }

        if (family === "O") {
          if (index + 2 >= input.length) {
            this.inputControlCarry = input.slice(index);
            break;
          }
          this.inputUncertain = true;
          index += 2;
          continue;
        }

        // Unknown escape-prefixed input is an editing operation from the
        // tracker's perspective. Skip the introducer and its next byte rather
        // than allowing either to poison inferred history.
        this.inputUncertain = true;
        index += 1;
        continue;
      }

      if (this.bracketedPaste) {
        if (char === "\r") {
          this.appendTrackedInput("\n");
          this.pasteLastWasCarriageReturn = true;
        } else if (char === "\n") {
          if (!this.pasteLastWasCarriageReturn) this.appendTrackedInput("\n");
          this.pasteLastWasCarriageReturn = false;
        } else {
          this.pasteLastWasCarriageReturn = false;
          this.appendTrackedInput(char);
        }
        continue;
      }

      if (char === "\n" && this.inputLastWasCarriageReturn) {
        this.inputLastWasCarriageReturn = false;
        continue;
      }
      if (char === "\r" || char === "\n") {
        this.inputLastWasCarriageReturn = char === "\r";
        const rawInput = this.inputBuffer;
        const command = this.inputBuffer.trim();
        const uncertain = this.inputUncertain;
        this.resetTrackedInput(false);
        if (trackingContinuation) {
          this.continuationPrompt = false;
          this.appendContinuationInput(rawInput, uncertain);
          started = activeAtInput;
          continue;
        }
        if (!command) continue;
        if (this.shellIntegration === "zsh" || this.shellIntegration === "fish") {
          // These adapters emit an authoritative command-line + start pair.
          // Keep clean typed text only as a fallback. If the shell edited the
          // line, an empty fallback is safer than a plausible-but-wrong block.
          this.pendingCommand = uncertain ? "" : command;
          continue;
        }
        started = this.startCommand(uncertain ? "(command unavailable)" : command, "inferred");
        continue;
      }

      this.inputLastWasCarriageReturn = false;
      if (char === "\x7f" || char === "\b") {
        this.inputBuffer = Array.from(this.inputBuffer).slice(0, -1).join("");
      } else if (char === "\x15" || char === "\x03") {
        this.resetTrackedInput(false);
      } else if (char === "\x17") {
        this.inputBuffer = this.inputBuffer.replace(/\s*\S+\s*$/, "");
      } else if (char === "\t" || (char < " " && char !== "\x00")) {
        // Completion and other readline controls can rewrite the buffer.
        this.inputUncertain = true;
      } else if (char >= " " && char !== "\x7f") {
        this.appendTrackedInput(char);
      }
    }
    return started;
  }

  startCommand(
    command: string,
    source: TerminalBlockSource,
    frameRedrawsInPlace = false,
  ): TerminalCommandBlock {
    const redaction = redactTerminalText(command, [...this.knownSecrets]);
    this.rememberSecrets(redaction.secrets);
    const normalized = normalizeCommand(redaction.text);
    const active = this.getActiveBlock();
    if (active?.status === "running" && normalizeCommand(active.command) === normalized) {
      if (source === "shell-integration" && active.source !== source) active.source = source;
      if (redaction.sensitive) {
        active.sensitive = true;
        this.replayCommands.set(active.id, command);
      }
      this.phase = "executing";
      this.pendingCommand = "";
      return active;
    }

    if (active?.status === "running") {
      active.status = "interrupted";
      active.completedAt = Date.now();
    }

    const block: TerminalCommandBlock = {
      id: `${this.sessionId}:block:${this.nextSequence}`,
      sequence: this.nextSequence++,
      command: redaction.text.trim() || "(command unavailable)",
      cwd: this.currentCwd,
      startedAt: Date.now(),
      status: "running",
      source,
      output: "",
      outputTruncated: false,
      sensitive: redaction.sensitive || undefined,
      shellIntegration: this.shellIntegration,
      shellEpochId: this.shellEpochId,
      shellDepth: this.shellDepth,
      frameRedrawsInPlace: frameRedrawsInPlace || isKnownCliAgentCommand(command) || undefined,
    };
    this.blocks.push(block);
    this.activeBlockId = block.id;
    this.phase = "executing";
    this.pendingCommand = "";
    this.resetTrackedInput();
    this.enforceBlockLimit();
    if (redaction.sensitive) this.replayCommands.set(block.id, command);
    return block;
  }

  terminate(exitCode?: number, signal?: number): string[] {
    const changed = new Set<string>();
    const filteredPending = this.outputPolicy.flush();
    for (const segment of this.parser.feed(filteredPending.recordData)) {
      if (segment.type === "data") this.appendToActiveBlock(segment.data, changed);
    }
    this.displayParser.feed(filteredPending.displayData);
    this.displayParser.flush();
    const pending = this.parser.flush();
    if (pending) this.appendToActiveBlock(pending, changed);
    const active = this.getActiveBlock();
    if (active?.status === "running") {
      active.status = exitCode === 0 && !signal ? "succeeded" : "interrupted";
      active.exitCode = exitCode;
      active.completedAt = Date.now();
      changed.add(active.id);
    }
    for (const context of this.suspendedShellEpochs) {
      const suspended = context.activeBlockId
        ? this.blocks.find((block) => block.id === context.activeBlockId)
        : undefined;
      if (!suspended || suspended.status !== "running") continue;
      suspended.status = "interrupted";
      suspended.completedAt = Date.now();
      changed.add(suspended.id);
    }
    this.activeBlockId = undefined;
    this.phase = "terminated";
    this.shellEpochId = undefined;
    this.shellDepth = 0;
    this.suspendedShellEpochs.length = 0;
    this.shellCompletions = [];
    this.shellEnvironment = {};
    this.shellCapabilities = {};
    this.resetTrackedInput();
    this.resetTerminalModes();
    this.parser.reset();
    this.displayParser.reset();
    this.outputPolicy.reset();
    this.discardEphemeralSecrets();
    return [...changed];
  }

  resetForRestart(cwd: string) {
    for (const block of this.blocks) {
      if (block.status !== "running") continue;
      block.status = "interrupted";
      block.completedAt = Date.now();
    }
    this.phase = "unknown";
    this.currentCwd = cwd;
    this.shellIntegration = undefined;
    this.shellEpochId = undefined;
    this.shellDepth = 0;
    this.suspendedShellEpochs.length = 0;
    this.shellCompletions = [];
    this.shellEnvironment = {};
    this.shellCapabilities = {};
    this.activeBlockId = undefined;
    this.pendingCommand = "";
    this.resetTrackedInput();
    this.resetTerminalModes();
    this.parser.reset();
    this.displayParser.reset();
    this.outputPolicy.reset();
    this.discardEphemeralSecrets();
  }

  canAcceptCommand(): boolean {
    return this.phase === "at_prompt" || (this.phase === "unknown" && !this.activeBlockId);
  }

  isBracketedPasteEnabled(): boolean {
    return this.bracketedPasteEnabled;
  }

  getBlock(blockId: string): TerminalCommandBlock | undefined {
    return this.blocks.find((block) => block.id === blockId);
  }

  getShellCompletions(): TerminalShellCompletionEntry[] {
    return this.shellCompletions.map((entry) => ({ ...entry }));
  }

  getShellEnvironment(): TerminalShellEnvironment {
    return { ...this.shellEnvironment };
  }

  getShellCapabilities(): TerminalShellCapabilities {
    return { ...this.shellCapabilities };
  }

  commandForReplay(blockId: string): string | undefined {
    const block = this.getBlock(blockId);
    if (!block) return undefined;
    return this.replayCommands.get(blockId) || (block.sensitive ? undefined : block.command);
  }

  clearHistory(options: { before?: number; includeBookmarked?: boolean } = {}): number {
    const before = Number.isFinite(options.before) ? Number(options.before) : undefined;
    let removed = 0;
    for (let index = this.blocks.length - 1; index >= 0; index--) {
      const block = this.blocks[index];
      if (block.id === this.activeBlockId || block.status === "running") continue;
      if (!options.includeBookmarked && block.bookmarked) continue;
      const timestamp = block.completedAt || block.startedAt;
      if (before !== undefined && timestamp >= before) continue;
      this.blocks.splice(index, 1);
      this.replayCommands.delete(block.id);
      removed++;
    }
    return removed;
  }

  sanitizeForPersistence(data: string): string {
    const initial = redactTerminalText(data, [...this.knownSecrets]);
    const normalizedText = stripUnsafeTerminalControls(initial.text, false);
    const normalized = redactTerminalText(
      normalizedText,
      [...this.knownSecrets, ...initial.secrets],
    );
    this.rememberSecrets([...initial.secrets, ...normalized.secrets]);
    // Preserve harmless ANSI in live block data. If normalization exposed a
    // previously split secret, return the safe normalized form instead.
    return normalized.text === normalizedText ? initial.text : normalized.text;
  }

  sanitizeForSearch(data: string): string {
    const searchable = stripUnsafeTerminalControls(data, false);
    return redactTerminalText(searchable, [...this.knownSecrets]).text;
  }

  snapshot(includeOutput = true): TerminalLifecycleSnapshot {
    return {
      phase: this.phase,
      currentCwd: this.currentCwd,
      shellIntegration: this.shellIntegration,
      shellEpochId: this.shellEpochId,
      shellDepth: this.shellDepth,
      activeBlockId: this.activeBlockId,
      alternateScreen: this.alternateScreen,
      bracketedPasteEnabled: this.bracketedPasteEnabled,
      terminalModes: { ...this.terminalModes },
      blocks: this.blocks.map((block) => ({
        ...block,
        // Redact the complete accumulated value on every outward snapshot as
        // well as per chunk. This catches credentials split across PTY chunks
        // before a periodic persistence pass has had a chance to rewrite them.
        output: includeOutput ? this.sanitizeForPersistence(block.output) : "",
      })),
    };
  }

  rootWorkingDirectory(): string {
    return this.suspendedShellEpochs[0]?.cwd || this.currentCwd;
  }

  private applyEvent(event: TerminalLifecycleEvent, changed: Set<string>): boolean {
    if (event.type === "remote-control") return false;
    if (event.type === "integration-ready") {
      return this.beginShellEpoch(event.shell, event.epochId);
    }
    if (event.type === "shell-exit") {
      return this.endShellEpoch(event.epochId, event.exitCode, changed);
    }

    // Once OpenUI has established an authenticated shell epoch, bare OSC
    // 133/633 prompt markers are ambiguous repaint data. Prompt frameworks
    // and nested shells can emit them asynchronously while a command is
    // running or while the user has typeahead in the editor. Treating those
    // markers as lifecycle barriers would close the active block or erase the
    // tracked input. Current OpenUI adapters always attach their epoch to A/B;
    // legacy integrations without an established epoch retain their original
    // no-epoch behavior.
    if (
      (event.type === "prompt-start" || event.type === "prompt-end") &&
      this.shellEpochId && !event.epochId
    ) return false;

    const epoch = this.ensureEventEpoch("epochId" in event ? event.epochId : undefined, changed);
    if (!epoch.accepted) return epoch.stateChanged;
    const stateChanged = epoch.stateChanged;

    switch (event.type) {
      case "cwd":
        if (event.cwd && event.cwd !== this.currentCwd) {
          this.currentCwd = event.cwd;
          return true;
        }
        return stateChanged;
      case "completion-context":
        {
          const previousNames = this.shellCompletions
            .filter((entry) => entry.kind === event.kind)
            .map((entry) => entry.name);
          if (
            previousNames.length === event.names.length &&
            previousNames.every((name, index) => name === event.names[index])
          ) {
            return stateChanged;
          }
        this.shellCompletions = [
          ...this.shellCompletions.filter((entry) => entry.kind !== event.kind),
          ...event.names.map((name) => ({ name, kind: event.kind })),
        ];
        return true;
        }
      case "shell-environment":
        if (this.shellEnvironment[event.key] === event.value) return stateChanged;
        this.shellEnvironment = { ...this.shellEnvironment, [event.key]: event.value };
        return true;
      case "shell-capability":
        if (this.shellCapabilities[event.key] === event.enabled) return stateChanged;
        this.shellCapabilities = { ...this.shellCapabilities, [event.key]: event.enabled };
        return true;
      case "continuation-prompt": {
        const active = this.getActiveBlock();
        const continuationShell = this.shellIntegration === "bash" ||
          this.shellIntegration === "powershell" || this.shellIntegration === "pwsh";
        if (
          !continuationShell || this.phase !== "executing" ||
          active?.status !== "running" || active.source !== "inferred"
        ) return stateChanged;
        this.resetTrackedInput();
        this.continuationPrompt = true;
        return stateChanged;
      }
      case "prompt-start": {
        this.continuationPrompt = false;
        this.resetTerminalModes();
        const active = this.getActiveBlock();
        // Prompt-ready without completion evidence is a recovery barrier. Keep
        // the output, but never invent a successful exit code.
        if (active?.status === "running") {
          active.status = "unknown";
          active.completedAt = Date.now();
          changed.add(active.id);
          this.activeBlockId = undefined;
        }
        this.phase = "at_prompt";
        this.resetTrackedInput();
        return true;
      }
      case "prompt-end":
        if (this.phase !== "executing") this.phase = "at_prompt";
        return true;
      case "command-line":
        // OpenUI adapters announce their shell with `I` and emit literal
        // history text. Decoding `\n` in commands such as `printf '\n'` would
        // corrupt a backslash into a real line break. Unannounced OSC 633/133
        // producers retain VS Code-compatible escaped-command decoding.
        this.pendingCommand = (
          this.shellIntegration
            ? event.command.replace(/\r\n?/g, "\n")
            : decodeCommand(event.command)
        ).trim();
        return stateChanged;
      case "command-start": {
        const activeAtStart = this.getActiveBlock();
        if (activeAtStart?.status === "running" && !this.pendingCommand && !this.inputBuffer) {
          // A repeated start marker without new command evidence is a duplicate,
          // not a new anonymous command.
          this.phase = "executing";
          return stateChanged;
        }
        const command = this.pendingCommand || this.inputBuffer || "(command unavailable)";
        const previousActive = activeAtStart;
        const block = this.startCommand(command, "shell-integration");
        if (previousActive && previousActive.id !== block.id) changed.add(previousActive.id);
        changed.add(block.id);
        return true;
      }
      case "command-finished": {
        this.continuationPrompt = false;
        const modesChanged = this.resetTerminalModes();
        const active = this.getActiveBlock();
        if (!active || active.status !== "running") {
          this.pendingCommand = "";
          return stateChanged || modesChanged;
        }
        if (this.pendingCommand) {
          // Bash and PowerShell can report the shell's authoritative history
          // line at prompt time even though they cannot emit a reliable
          // pre-exec callback. Correct the inferred command in place so output
          // stays attached to one block.
          const authoritative = this.pendingCommand;
          const redaction = redactTerminalText(authoritative, [...this.knownSecrets]);
          this.rememberSecrets(redaction.secrets);
          active.command = reconcileAuthoritativeCommand(active.command, redaction.text);
          active.source = "shell-integration";
          if (redaction.sensitive) {
            active.sensitive = true;
            this.replayCommands.set(active.id, authoritative);
          }
          this.pendingCommand = "";
        }
        active.exitCode = event.exitCode;
        active.completedAt = Date.now();
        active.status = classifyTerminalExitCode(event.exitCode);
        active.failureKind = classifyTerminalFailureKind(event.exitCode, active.status);
        changed.add(active.id);
        this.activeBlockId = undefined;
        this.phase = "awaiting_prompt";
        return true;
      }
    }
  }

  private beginShellEpoch(shell: string | undefined, epochId: string | undefined): boolean {
    const nextShell = shell || "unknown";
    if (!epochId) {
      const changed = this.shellIntegration !== nextShell;
      if (changed) {
        this.shellCompletions = [];
        this.shellEnvironment = {};
        this.shellCapabilities = defaultShellCapabilities(nextShell);
      }
      const modesChanged = changed ? this.resetTerminalModes() : false;
      this.shellIntegration = nextShell;
      return changed || modesChanged;
    }
    if (epochId === this.shellEpochId) {
      const changed = this.shellIntegration !== nextShell;
      if (changed) this.shellCapabilities = defaultShellCapabilities(nextShell);
      this.shellIntegration = nextShell;
      return changed;
    }
    // An init marker from a suspended parent is stale while its child owns the
    // PTY. Accepting it would let delayed bytes steal the active block.
    if (this.suspendedShellEpochs.some((context) => context.epochId === epochId)) return false;
    if (this.suspendedShellEpochs.length >= MAX_SHELL_EPOCH_DEPTH) return false;

    const active = this.getActiveBlock();
    const hasParent = this.shellEpochId !== undefined ||
      (this.shellIntegration !== undefined && active?.status === "running");
    if (hasParent) {
      this.suspendedShellEpochs.push({
        epochId: this.shellEpochId,
        shellIntegration: this.shellIntegration,
        cwd: this.currentCwd,
        phase: this.phase,
        activeBlockId: this.activeBlockId,
        pendingCommand: this.pendingCommand,
        shellCompletions: this.getShellCompletions(),
        shellEnvironment: this.getShellEnvironment(),
        shellCapabilities: this.getShellCapabilities(),
      });
      this.activeBlockId = undefined;
      this.pendingCommand = "";
      this.phase = "unknown";
      this.resetTrackedInput();
    }

    this.resetTerminalModes();

    this.shellCompletions = [];
    this.shellEnvironment = {};
    this.shellCapabilities = defaultShellCapabilities(nextShell);
    this.shellEpochId = epochId;
    this.shellIntegration = nextShell;
    this.shellDepth = this.suspendedShellEpochs.length;
    return true;
  }

  private endShellEpoch(
    epochId: string | undefined,
    exitCode: number | undefined,
    changed: Set<string>,
  ): boolean {
    if (epochId && this.shellEpochId && epochId !== this.shellEpochId) return false;
    const active = this.getActiveBlock();
    if (active?.status === "running") {
      active.exitCode = exitCode;
      active.status = classifyTerminalExitCode(exitCode);
      active.failureKind = classifyTerminalFailureKind(exitCode, active.status);
      active.completedAt = Date.now();
      changed.add(active.id);
    }
    this.activeBlockId = undefined;
    this.pendingCommand = "";
    this.resetTrackedInput();
    this.resetTerminalModes();

    if (this.restoreParentEpoch()) return true;
    this.shellEpochId = undefined;
    this.shellIntegration = undefined;
    this.shellCompletions = [];
    this.shellEnvironment = {};
    this.shellCapabilities = {};
    this.shellDepth = 0;
    this.phase = "terminated";
    return true;
  }

  private ensureEventEpoch(
    epochId: string | undefined,
    changed: Set<string>,
  ): { accepted: boolean; stateChanged: boolean } {
    if (!epochId) return { accepted: true, stateChanged: false };
    if (!this.shellEpochId) return { accepted: false, stateChanged: false };
    if (epochId === this.shellEpochId) return { accepted: true, stateChanged: false };

    const parent = this.suspendedShellEpochs[this.suspendedShellEpochs.length - 1];
    if (!parent || parent.epochId !== epochId) return { accepted: false, stateChanged: false };

    // A parent event is authoritative evidence that an instrumented child has
    // gone away even if its final X marker was lost (kill -9, transport loss,
    // or version skew). Preserve its output and recover as interrupted.
    const active = this.getActiveBlock();
    if (active?.status === "running") {
      active.status = "interrupted";
      active.completedAt = Date.now();
      changed.add(active.id);
    }
    this.activeBlockId = undefined;
    this.pendingCommand = "";
    this.restoreParentEpoch();
    this.resetTrackedInput();
    this.resetTerminalModes();
    return { accepted: true, stateChanged: true };
  }

  private restoreParentEpoch(): boolean {
    const parent = this.suspendedShellEpochs.pop();
    if (!parent) return false;
    this.shellEpochId = parent.epochId;
    this.shellIntegration = parent.shellIntegration;
    this.currentCwd = parent.cwd;
    this.activeBlockId = parent.activeBlockId;
    this.pendingCommand = parent.pendingCommand;
    this.shellCompletions = parent.shellCompletions.map((entry) => ({ ...entry }));
    this.shellEnvironment = { ...parent.shellEnvironment };
    this.shellCapabilities = { ...parent.shellCapabilities };
    const parentActive = this.getActiveBlock();
    this.phase = parentActive?.status === "running" ? "executing" : parent.phase;
    this.shellDepth = this.suspendedShellEpochs.length;
    return true;
  }

  private getActiveBlock(): TerminalCommandBlock | undefined {
    if (!this.activeBlockId) return undefined;
    return this.blocks.find((block) => block.id === this.activeBlockId);
  }

  private rememberSecrets(secrets: readonly string[]) {
    for (const secret of secrets) {
      if (this.knownSecrets.size >= 50) break;
      this.knownSecrets.add(secret);
    }
  }

  private discardEphemeralSecrets() {
    // A secret may be split across PTY chunks or controls and therefore still
    // exist only in the accumulated raw block. Rewrite every bounded block
    // while the ephemeral known-secret set is still available, then forget it.
    for (const block of this.blocks) {
      block.output = this.sanitizeForPersistence(block.output);
    }
    this.knownSecrets.clear();
    this.replayCommands.clear();
  }

  private appendToActiveBlock(data: string, changed: Set<string>) {
    if (!data) return;
    const active = this.getActiveBlock();
    if (!active || active.status !== "running") return;
    const previousLength = active.output.length;
    active.output += this.sanitizeForPersistence(data);
    if (active.frameRedrawsInPlace) {
      // Only rescan the new bytes plus a bounded split-sequence overlap. Any
      // earlier full erase was compacted when it arrived.
      const scanStart = Math.max(0, previousLength - 64);
      const tail = active.output.slice(scanStart);
      const compacted = compactTerminalFrameRedraws(tail);
      if (compacted !== tail) active.output = compacted;
    }
    if (active.output.length > MAX_BLOCK_OUTPUT_CHARS) {
      active.output = active.output.slice(-MAX_BLOCK_OUTPUT_CHARS);
      active.outputTruncated = true;
    }
    changed.add(active.id);
  }

  private appendTrackedInput(value: string) {
    if (!value) return;
    const remaining = MAX_TRACKED_INPUT_CHARS - this.inputBuffer.length;
    if (remaining <= 0) {
      this.inputUncertain = true;
      return;
    }
    this.inputBuffer += value.slice(0, remaining);
    if (value.length > remaining) this.inputUncertain = true;
  }

  private appendContinuationInput(line: string, uncertain: boolean) {
    const active = this.getActiveBlock();
    if (!active || active.status !== "running") return;
    if (uncertain) {
      active.command = "(command unavailable)";
      this.replayCommands.delete(active.id);
      return;
    }
    const current = this.replayCommands.get(active.id) || active.command;
    if (current.length + line.length + 1 > MAX_TRACKED_INPUT_CHARS) {
      active.command = "(command unavailable)";
      this.replayCommands.delete(active.id);
      return;
    }
    const combined = `${current}\n${line}`;
    const redaction = redactTerminalText(combined, [...this.knownSecrets]);
    this.rememberSecrets(redaction.secrets);
    active.command = redaction.text || "(command unavailable)";
    if (redaction.sensitive) {
      active.sensitive = true;
      this.replayCommands.set(active.id, combined);
    }
  }

  private resetTrackedInput(resetCarriageReturn = true) {
    this.inputBuffer = "";
    this.inputControlCarry = "";
    this.bracketedPaste = false;
    this.inputUncertain = false;
    this.pasteLastWasCarriageReturn = false;
    if (resetCarriageReturn) this.inputLastWasCarriageReturn = false;
  }

  private enforceBlockLimit() {
    while (this.blocks.length > MAX_BLOCKS_PER_SESSION) {
      const removable = this.blocks.findIndex((block) =>
        block.id !== this.activeBlockId && block.status !== "running"
      );
      if (removable < 0) break;
      this.blocks.splice(removable, 1);
    }
  }

  private observeTerminalModes(data: string): boolean {
    let changed = false;
    for (const event of this.terminalModeParser.feed(data)) {
      const { mode, enabled } = event;
      switch (mode) {
        case 1:
          if (this.terminalModes.applicationCursorKeys !== enabled) {
            this.terminalModes.applicationCursorKeys = enabled;
            changed = true;
          }
          break;
        case 47:
        case 1047:
        case 1049:
          if (this.alternateScreen !== enabled) {
            this.alternateScreen = enabled;
            changed = true;
          }
          break;
        case 1000:
        case 1002:
        case 1003: {
          const requested = mode === 1000 ? "click" : mode === 1002 ? "drag" : "motion";
          const next = enabled
            ? requested
            : this.terminalModes.mouseTracking === requested ? "none" : this.terminalModes.mouseTracking;
          if (this.terminalModes.mouseTracking !== next) {
            this.terminalModes.mouseTracking = next;
            changed = true;
          }
          break;
        }
        case 1004:
          if (this.terminalModes.focusReporting !== enabled) {
            this.terminalModes.focusReporting = enabled;
            changed = true;
          }
          break;
        case 1005:
        case 1006: {
          const requested = mode === 1005 ? "utf8" : "sgr";
          const next = enabled
            ? requested
            : this.terminalModes.mouseEncoding === requested ? "default" : this.terminalModes.mouseEncoding;
          if (this.terminalModes.mouseEncoding !== next) {
            this.terminalModes.mouseEncoding = next;
            changed = true;
          }
          break;
        }
        case 1007:
          if (this.terminalModes.alternateScroll !== enabled) {
            this.terminalModes.alternateScroll = enabled;
            changed = true;
          }
          break;
        case 2004:
          if (this.bracketedPasteEnabled !== enabled) {
            this.bracketedPasteEnabled = enabled;
            changed = true;
          }
          break;
        case 2026:
          if (this.terminalModes.synchronizedOutput !== enabled) {
            this.terminalModes.synchronizedOutput = enabled;
            changed = true;
          }
          break;
      }
    }
    return changed;
  }

  private resetTerminalModes(): boolean {
    const changed = this.alternateScreen || this.bracketedPasteEnabled ||
      this.terminalModes.applicationCursorKeys ||
      this.terminalModes.mouseTracking !== "none" ||
      this.terminalModes.focusReporting ||
      this.terminalModes.mouseEncoding !== "default" ||
      this.terminalModes.alternateScroll ||
      this.terminalModes.synchronizedOutput;
    this.alternateScreen = false;
    this.bracketedPasteEnabled = false;
    this.terminalModes = defaultTerminalModes();
    this.terminalModeParser.reset();
    return changed;
  }
}
