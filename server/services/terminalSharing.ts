import type { TerminalCommandBlock } from "../types";
import { redactTerminalText } from "./terminalRedaction";

export type TerminalShareFormat = "markdown" | "text" | "json";
export type TerminalShareOutputMode = "plain" | "ansi";

export interface TerminalShareSession {
  sessionId: string;
  nodeId: string;
  name: string;
  agentName: string;
  cwd: string;
  createdAt: string;
}

export interface TerminalShareOptions {
  format?: TerminalShareFormat;
  outputMode?: TerminalShareOutputMode;
  includeOutput?: boolean;
  generatedAt?: number;
}

export interface TerminalSharePayload {
  version: 1;
  generatedAt: number;
  scope: "block" | "session";
  format: TerminalShareFormat;
  outputMode: TerminalShareOutputMode;
  contentType: string;
  filename: string;
  content: string;
  blockCount: number;
  redactionApplied: boolean;
  sensitive: boolean;
  truncated: boolean;
}

interface SharedBlock extends Omit<TerminalCommandBlock, "output"> {
  output: string;
  shareOutputTruncated: boolean;
  shareMetadataTruncated: boolean;
}

const MAX_BLOCK_SHARE_OUTPUT_CHARS = 100_000;
const MAX_SESSION_SHARE_OUTPUT_CHARS = 1_000_000;
const MAX_SHARE_CONTENT_CHARS = 4_000_000;
const MAX_SHARED_COMMAND_CHARS = 4_096;
const MAX_SHARED_CWD_CHARS = 1_024;
const MAX_SHARED_NOTE_CHARS = 2_048;
const TRUNCATION_MARKER = "\n… [OpenUI share output truncated] …\n";

function contentType(format: TerminalShareFormat): string {
  if (format === "json") return "application/json; charset=utf-8";
  if (format === "text") return "text/plain; charset=utf-8";
  return "text/markdown; charset=utf-8";
}

function extension(format: TerminalShareFormat): string {
  if (format === "json") return "json";
  if (format === "text") return "txt";
  return "md";
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "terminal";
}

/**
 * Removes every terminal control except SGR color/style sequences when ANSI
 * output was explicitly requested. OSC/DCS/APC sequences are never shareable:
 * among other things they can contain clipboard writes and hyperlinks.
 */
export function stripUnsafeTerminalControls(value: string, keepSgr = false): string {
  let result = "";
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const family = value[index + 1];
      if (family === "[") {
        let end = index + 2;
        while (end < value.length && !/[\x40-\x7e]/.test(value[end])) end++;
        if (end >= value.length) break;
        const sequence = value.slice(index, end + 1);
        if (keepSgr && value[end] === "m" && /^\x1b\[[0-9;:?]*m$/.test(sequence)) {
          result += sequence;
        }
        index = end + 1;
        continue;
      }
      if (family === "]" || family === "P" || family === "_" || family === "^" || family === "X") {
        index += 2;
        while (index < value.length) {
          if (value.charCodeAt(index) === 0x07) {
            index++;
            break;
          }
          if (value.charCodeAt(index) === 0x1b && value[index + 1] === "\\") {
            index += 2;
            break;
          }
          index++;
        }
        continue;
      }
      // Fe/charset/two-byte escape.
      index += Math.min(2, value.length - index);
      continue;
    }
    if (code === 0x9b) {
      let end = index + 1;
      while (end < value.length && !/[\x40-\x7e]/.test(value[end])) end++;
      if (end >= value.length) break;
      const sequence = value.slice(index, end + 1);
      if (keepSgr && value[end] === "m" && /^\x9b[0-9;:?]*m$/.test(sequence)) result += sequence;
      index = end + 1;
      continue;
    }
    if (code < 0x20 && code !== 0x08 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      index++;
      continue;
    }
    if (code === 0x7f) {
      index++;
      continue;
    }
    result += value[index];
    index++;
  }
  return result;
}

/**
 * Active CLI agents commonly redraw a primary-screen frame with CSI 2 J.
 * For those explicitly marked blocks, bytes before the last complete full
 * erase are an obsolete frame rather than history. Ordinary shell output does
 * not opt in and therefore keeps its existing clear/scrollback semantics.
 */
export function compactTerminalFrameRedraws(value: string): string {
  let lastClearEnd = 0;
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    const csiLength = code === 0x9b ? 1 : code === 0x1b && value[index + 1] === "[" ? 2 : 0;
    if (!csiLength) {
      index++;
      continue;
    }
    const parameterStart = index + csiLength;
    let end = parameterStart;
    while (end < value.length && !/[\x40-\x7e]/.test(value[end])) end++;
    if (end >= value.length) break;
    if (value[end] === "J") {
      const parameters = value.slice(parameterStart, end).replace(/^[?>!]+/, "");
      const mode = parameters.split(";", 1)[0] || "0";
      if (mode === "2") lastClearEnd = end + 1;
    }
    index = end + 1;
  }
  return lastClearEnd > 0 ? value.slice(lastClearEnd) : value;
}

/**
 * Applies the terminal's most important destructive text controls so progress
 * redraws and backspaces become readable instead of leaking cursor artifacts.
 */
export function terminalOutputToPlainText(
  value: string,
  options: { frameRedrawsInPlace?: boolean } = {},
): string {
  const source = options.frameRedrawsInPlace ? compactTerminalFrameRedraws(value) : value;
  const input = stripUnsafeTerminalControls(source, false);
  const lines: string[] = [];
  let line: string[] = [];
  let cursor = 0;
  let lastWasCarriageReturn = false;

  const finishLine = () => {
    lines.push(line.join("").replace(/\s+$/g, ""));
    line = [];
    cursor = 0;
  };

  for (const character of input) {
    if (character === "\r") {
      cursor = 0;
      lastWasCarriageReturn = true;
      continue;
    }
    if (character === "\n") {
      finishLine();
      lastWasCarriageReturn = false;
      continue;
    }
    lastWasCarriageReturn = false;
    if (character === "\b") {
      cursor = Math.max(0, cursor - 1);
      continue;
    }
    if (character === "\t") {
      const spaces = 8 - (cursor % 8);
      for (let offset = 0; offset < spaces; offset++) line[cursor++] = " ";
      continue;
    }
    line[cursor++] = character;
  }
  if (line.length || lastWasCarriageReturn) finishLine();

  while (lines[0] === "") lines.shift();
  while (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function safeAnsiOutput(value: string): string {
  return stripUnsafeTerminalControls(value, true)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\x08/g, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactSafeAnsiText(
  value: string,
  knownSecrets: readonly string[],
): ReturnType<typeof redactTerminalText> {
  const plain = stripUnsafeTerminalControls(value, false);
  const detected = redactTerminalText(plain, knownSecrets);
  let text = value;
  const sgrGap = String.raw`(?:(?:\x1b\[[0-9;:?]*m)|(?:\x9b[0-9;:?]*m))*`;
  for (const secret of detected.secrets) {
    if (secret.length < 4) continue;
    const pattern = [...secret].map((character) => escapeRegex(character)).join(sgrGap);
    text = text.replace(new RegExp(pattern, "gu"), "[REDACTED]");
  }
  const final = redactTerminalText(text, [...knownSecrets, ...detected.secrets]);
  return {
    text: final.text,
    sensitive: detected.sensitive || final.sensitive,
    secrets: [...new Set([...detected.secrets, ...final.secrets])].slice(0, 50),
  };
}

function truncateMiddle(value: string, limit: number): { value: string; truncated: boolean } {
  if (value.length <= limit) return { value, truncated: false };
  const available = Math.max(0, limit - TRUNCATION_MARKER.length);
  const before = Math.ceil(available / 2);
  const after = Math.floor(available / 2);
  return {
    value: `${value.slice(0, before)}${TRUNCATION_MARKER}${value.slice(value.length - after)}`,
    truncated: true,
  };
}

function redactBlock(
  block: TerminalCommandBlock,
  outputMode: TerminalShareOutputMode,
  includeOutput: boolean,
  outputLimit: number,
): { block: SharedBlock; redactionApplied: boolean; consumed: number } {
  const commandSource = terminalOutputToPlainText(block.command);
  const command = redactTerminalText(commandSource);
  const cwdSource = terminalOutputToPlainText(block.cwd);
  const cwd = redactTerminalText(cwdSource, command.secrets);
  const noteSource = terminalOutputToPlainText(block.note || "");
  const note = redactTerminalText(noteSource, [...command.secrets, ...cwd.secrets]);
  const outputSource = outputMode === "ansi"
    ? safeAnsiOutput(includeOutput ? block.output : "")
    : terminalOutputToPlainText(includeOutput ? block.output : "");
  const output = outputMode === "ansi"
    ? redactSafeAnsiText(outputSource, [...command.secrets, ...cwd.secrets, ...note.secrets])
    : redactTerminalText(outputSource, [...command.secrets, ...cwd.secrets, ...note.secrets]);
  const limited = truncateMiddle(output.text, Math.max(0, outputLimit));
  const safeCommand = truncateMiddle(command.text, MAX_SHARED_COMMAND_CHARS);
  const safeCwd = truncateMiddle(cwd.text, MAX_SHARED_CWD_CHARS);
  const safeNote = truncateMiddle(note.text, MAX_SHARED_NOTE_CHARS);
  const redactionApplied = command.text !== block.command ||
    cwd.text !== block.cwd ||
    note.text !== (block.note || "") ||
    output.text !== (includeOutput ? block.output : "") ||
    command.sensitive || cwd.sensitive || note.sensitive || output.sensitive;

  return {
    block: {
      ...block,
      command: safeCommand.value,
      cwd: safeCwd.value,
      note: block.note ? safeNote.value : undefined,
      output: limited.value,
      shareOutputTruncated: block.outputTruncated || limited.truncated,
      shareMetadataTruncated: safeCommand.truncated || safeCwd.truncated || safeNote.truncated,
    },
    redactionApplied,
    consumed: limited.value.length,
  };
}

function inlineCode(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(1, longest + 1));
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

function markdownText(value: string): string {
  return value.replace(/[\\*_<>\[\]#]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

function codeFence(value: string, language = ""): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

function duration(block: SharedBlock): string | undefined {
  if (!block.completedAt) return undefined;
  const milliseconds = Math.max(0, block.completedAt - block.startedAt);
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(2).replace(/\.00$/, "")}s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1_000)}s`;
}

function failureKindLabel(block: SharedBlock): string | undefined {
  if (block.failureKind === "command_not_found") return "command not found";
  if (block.failureKind === "not_executable") return "not executable";
  if (block.failureKind === "exit_error") return "command exited with an error";
  return undefined;
}

function markdownBlock(block: SharedBlock, index?: number): string {
  const heading = index === undefined ? "## Terminal command" : `## Command ${index + 1}`;
  const status = block.exitCode === undefined ? block.status : `${block.status} (exit ${block.exitCode})`;
  const metadata = [
    `- Status: **${markdownText(status)}**`,
    failureKindLabel(block) ? `- Failure: **${failureKindLabel(block)}**` : undefined,
    `- Directory: ${inlineCode(block.cwd)}`,
    `- Started: ${new Date(block.startedAt).toISOString()}`,
    duration(block) ? `- Duration: ${duration(block)}` : undefined,
    block.note ? `- Note: ${markdownText(block.note)}` : undefined,
    block.shareOutputTruncated ? "- Output: **truncated**" : undefined,
    block.shareMetadataTruncated ? "- Metadata: **truncated**" : undefined,
  ].filter(Boolean).join("\n");
  const body = [`$ ${block.command}`, block.output].filter((value) => value.length > 0).join("\n");
  return `${heading}\n\n${metadata}\n\n${codeFence(body, "console")}`;
}

function textBlock(block: SharedBlock, index?: number): string {
  const label = index === undefined ? "Terminal command" : `Command ${index + 1}`;
  const fields = [
    label,
    `Status: ${block.exitCode === undefined ? block.status : `${block.status} (exit ${block.exitCode})`}`,
    failureKindLabel(block) ? `Failure: ${failureKindLabel(block)}` : undefined,
    `Directory: ${block.cwd}`,
    `Started: ${new Date(block.startedAt).toISOString()}`,
    duration(block) ? `Duration: ${duration(block)}` : undefined,
    block.note ? `Note: ${block.note}` : undefined,
    block.shareOutputTruncated ? "Output: truncated" : undefined,
    block.shareMetadataTruncated ? "Metadata: truncated" : undefined,
    "",
    `$ ${block.command}`,
    block.output,
  ].filter((value) => value !== undefined);
  return fields.join("\n").replace(/\n+$/g, "");
}

function render(
  scope: "block" | "session",
  session: TerminalShareSession,
  blocks: SharedBlock[],
  format: TerminalShareFormat,
  generatedAt: number,
): string {
  if (format === "json") {
    return JSON.stringify({ version: 1, generatedAt, scope, session, blocks }, null, 2);
  }
  const header = format === "markdown"
    ? `# ${markdownText(session.name)}\n\n- Agent: ${markdownText(session.agentName)}\n- Working directory: ${inlineCode(session.cwd)}\n- Shared: ${new Date(generatedAt).toISOString()}`
    : `${session.name}\nAgent: ${session.agentName}\nWorking directory: ${session.cwd}\nShared: ${new Date(generatedAt).toISOString()}`;
  const renderedBlocks = blocks.map((block, index) => format === "markdown"
    ? markdownBlock(block, scope === "block" ? undefined : index)
    : textBlock(block, scope === "block" ? undefined : index));
  return [header, ...renderedBlocks].join(format === "markdown" ? "\n\n" : "\n\n---\n\n");
}

function createShare(
  scope: "block" | "session",
  session: TerminalShareSession,
  sourceBlocks: TerminalCommandBlock[],
  options: TerminalShareOptions,
): TerminalSharePayload {
  const format = options.format || "markdown";
  const outputMode = options.outputMode || "plain";
  const includeOutput = options.includeOutput !== false;
  const generatedAt = options.generatedAt || Date.now();
  let remaining = scope === "block" ? MAX_BLOCK_SHARE_OUTPUT_CHARS : MAX_SESSION_SHARE_OUTPUT_CHARS;
  let redactionApplied = false;
  const blocks = sourceBlocks.map((source) => {
    const result = redactBlock(
      source,
      outputMode,
      includeOutput,
      Math.min(MAX_BLOCK_SHARE_OUTPUT_CHARS, remaining),
    );
    remaining = Math.max(0, remaining - result.consumed);
    redactionApplied ||= result.redactionApplied;
    return result.block;
  });
  const rendered = render(scope, session, blocks, format, generatedAt);
  let content = rendered;
  let contentTruncated = false;
  if (rendered.length > MAX_SHARE_CONTENT_CHARS) {
    contentTruncated = true;
    if (format === "json") {
      // Middle-truncating serialized JSON would make it unparsable. Drop only
      // output in this exceptional fallback and keep every block's metadata.
      const summarized = blocks.map((block) => ({
        ...block,
        output: block.output ? TRUNCATION_MARKER.trim() : "",
        shareOutputTruncated: block.shareOutputTruncated || block.output.length > 0,
      }));
      content = render(scope, session, summarized, format, generatedAt);
    } else {
      content = truncateMiddle(rendered, MAX_SHARE_CONTENT_CHARS).value;
    }
  }
  const truncated = contentTruncated || blocks.some((block) =>
    block.shareOutputTruncated || block.shareMetadataTruncated
  );

  return {
    version: 1,
    generatedAt,
    scope,
    format,
    outputMode,
    contentType: contentType(format),
    filename: `openui-${slug(session.name)}-${scope}.${extension(format)}`,
    content,
    blockCount: blocks.length,
    redactionApplied,
    sensitive: sourceBlocks.some((block) => block.sensitive),
    truncated,
  };
}

export function createTerminalBlockShare(
  session: TerminalShareSession,
  block: TerminalCommandBlock,
  options: TerminalShareOptions = {},
): TerminalSharePayload {
  return createShare("block", session, [block], options);
}

export function createTerminalSessionShare(
  session: TerminalShareSession,
  blocks: TerminalCommandBlock[],
  options: TerminalShareOptions = {},
): TerminalSharePayload {
  return createShare("session", session, blocks, options);
}
