import { Hono } from "hono";
import * as pty from "node-pty";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join, relative, resolve } from "path";
import { homedir, tmpdir } from "os";
import { exec as execCb, execFile as execFileCb, spawn } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execCb);
const execGitAsync = promisify(execFileCb);
import type { Agent, AgentChangeSummary, CheckpointSummary, Session } from "../types";
import {
  sessions,
  createSession,
  deleteSession,
  isAgentInputPromptReady,
  injectPluginDir,
  scanReposInDirectory,
  getServerPort,
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  scheduleSessionTitleGeneration,
} from "../services/sessionManager";
import { loadState, saveState, savePositions, getDataDir } from "../services/persistence";
import {
  loadConfig,
  saveConfig,
  fetchTeams,
  fetchMyTickets,
  searchTickets,
  fetchTicketByIdentifier,
  validateApiKey,
  getCurrentUser,
} from "../services/linear";
import {
  fetchGitHubIssues,
  fetchGitHubIssue,
  searchGitHubIssues,
  parseGitHubUrl,
} from "../services/github";
import {
  loadTitleGenerationConfig,
  saveTitleGenerationApiKey,
  generateTitleSortGroups,
  type TitleSortGroup,
  type TitleSortInput,
} from "../services/titleGenerator";

function getLaunchCwd(): string {
  return process.env.LAUNCH_CWD || homedir();
}
const QUIET = !!process.env.OPENUI_QUIET;
const log = QUIET ? (..._args: any[]) => {} : console.log.bind(console);
const logError = QUIET ? (..._args: any[]) => {} : console.error.bind(console);

export const apiRoutes = new Hono();

const AGENT_RULES_MAX_CHARS = 12000;
const CLAUDE_TRANSCRIPT_ROOT = join(homedir(), ".claude", "projects");
const CODEX_TRANSCRIPT_ROOT = join(homedir(), ".codex", "sessions");
const CLAUDE_TRANSCRIPT_TAIL_BYTES = 2_000_000;
const claudeTranscriptCache = new Map<string, string>();
const codexTranscriptCache = new Map<string, string>();

type ClaudeChatEntry = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text?: string;
  toolName?: string;
  toolSummary?: string;
  toolInput?: string;
  toolOutput?: string;
  toolStatus?: "running" | "complete" | "error";
  startup?: {
    agentName?: string;
    version?: string;
    model?: string;
    effort?: string;
    cwd?: string;
    permissionMode?: string;
    notices: string[];
  };
  timestamp?: string;
};

type StartupPrompt = {
  id: string;
  title: string;
  detail: string;
  confirmLabel: string;
  cancelLabel: string;
};

function detectStartupPrompt(session: Session): StartupPrompt | null {
  if (session.claudeSessionId) return null;
  const tail = session.outputBuffer
    .join("")
    .slice(-12_000)
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/\r/g, "\n");

  if (
    /Loading\s*development\s*channels/i.test(tail) &&
    /I\s*am\s*using\s*this\s*for\s*local\s*development/i.test(tail) &&
    /Enter\s*to\s*confirm/i.test(tail)
  ) {
    return {
      id: "claude-development-channels",
      title: "Use local development channels?",
      detail: "Claude Code needs one confirmation before this local channel can start.",
      confirmLabel: "Use locally",
      cancelLabel: "Exit",
    };
  }

  return null;
}

function findClaudeTranscriptFile(claudeSessionId: string): string | null {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(claudeSessionId)) return null;

  const cached = claudeTranscriptCache.get(claudeSessionId);
  if (cached && existsSync(cached)) return cached;
  if (!existsSync(CLAUDE_TRANSCRIPT_ROOT)) return null;

  for (const project of readdirSync(CLAUDE_TRANSCRIPT_ROOT, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const candidate = join(CLAUDE_TRANSCRIPT_ROOT, project.name, `${claudeSessionId}.jsonl`);
    if (!existsSync(candidate)) continue;
    claudeTranscriptCache.set(claudeSessionId, candidate);
    return candidate;
  }

  return null;
}

function recoverClaudeTranscriptId(session: Session): string | null {
  if (!session.cwd || !session.createdAt || !existsSync(CLAUDE_TRANSCRIPT_ROOT)) return null;

  const projectSlug = session.cwd.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const projectDir = join(CLAUDE_TRANSCRIPT_ROOT, projectSlug);
  if (!existsSync(projectDir)) return null;

  const createdAt = Date.parse(session.createdAt);
  if (!Number.isFinite(createdAt)) return null;

  const claimedIds = new Set(
    Array.from(sessions.values())
      .map((candidate) => candidate.claudeSessionId)
      .filter((value): value is string => Boolean(value)),
  );
  let best: { id: string; distance: number } | null = null;

  for (const file of readdirSync(projectDir, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
    const transcriptId = file.name.slice(0, -".jsonl".length);
    if (claimedIds.has(transcriptId)) continue;

    const path = join(projectDir, file.name);
    let prefix = "";
    try {
      const size = Math.min(statSync(path).size, 128_000);
      const buffer = Buffer.alloc(size);
      const descriptor = openSync(path, "r");
      try {
        readSync(descriptor, buffer, 0, size, 0);
      } finally {
        closeSync(descriptor);
      }
      prefix = buffer.toString("utf8");
    } catch {
      continue;
    }

    let firstTimestamp: number | null = null;
    let transcriptCwd: string | null = null;
    for (const line of prefix.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (!transcriptCwd && typeof record?.cwd === "string") transcriptCwd = record.cwd;
        if (!firstTimestamp && typeof record?.timestamp === "string") {
          const parsed = Date.parse(record.timestamp);
          if (Number.isFinite(parsed)) firstTimestamp = parsed;
        }
        if (transcriptCwd && firstTimestamp) break;
      } catch {
        continue;
      }
    }

    if (!firstTimestamp || !transcriptCwd || resolve(transcriptCwd) !== resolve(session.cwd)) continue;
    const delta = firstTimestamp - createdAt;
    if (delta < -5_000 || delta > 3 * 60 * 1000) continue;
    const distance = Math.abs(delta);
    if (!best || distance < best.distance) best = { id: transcriptId, distance };
  }

  return best?.id || null;
}

function listCodexTranscriptFiles(directory = CODEX_TRANSCRIPT_ROOT, depth = 0): string[] {
  if (depth > 4 || !existsSync(directory)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listCodexTranscriptFiles(path, depth + 1));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

function findCodexTranscriptFile(codexSessionId: string): string | null {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(codexSessionId)) return null;

  const cached = codexTranscriptCache.get(codexSessionId);
  if (cached && existsSync(cached)) return cached;

  const suffix = `${codexSessionId}.jsonl`;
  const match = listCodexTranscriptFiles().find((file) => file.endsWith(suffix));
  if (!match) return null;
  codexTranscriptCache.set(codexSessionId, match);
  return match;
}

function readFilePrefix(file: string, maxBytes = 128_000): string {
  const size = Math.min(statSync(file).size, maxBytes);
  if (size <= 0) return "";

  const buffer = Buffer.alloc(size);
  const descriptor = openSync(file, "r");
  try {
    readSync(descriptor, buffer, 0, size, 0);
  } finally {
    closeSync(descriptor);
  }
  return buffer.toString("utf8");
}

function recoverCodexTranscriptId(session: Session): string | null {
  if (!session.cwd || !session.createdAt || !existsSync(CODEX_TRANSCRIPT_ROOT)) return null;

  const createdAt = Date.parse(session.createdAt);
  if (!Number.isFinite(createdAt)) return null;

  const claimedIds = new Set(
    Array.from(sessions.values())
      .map((candidate) => candidate.codexSessionId)
      .filter((value): value is string => Boolean(value)),
  );
  let best: { id: string; path: string; distance: number } | null = null;

  for (const path of listCodexTranscriptFiles()) {
    const prefix = readFilePrefix(path);
    let transcriptId: string | null = null;
    let transcriptCwd: string | null = null;
    let firstTimestamp: number | null = null;

    for (const line of prefix.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record?.type !== "session_meta") continue;
        const payload = record.payload || {};
        transcriptId = typeof payload.id === "string"
          ? payload.id
          : typeof payload.session_id === "string"
            ? payload.session_id
            : null;
        transcriptCwd = typeof payload.cwd === "string" ? payload.cwd : null;
        const parsedTimestamp = Date.parse(record.timestamp || payload.timestamp || "");
        firstTimestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : null;
        break;
      } catch {
        continue;
      }
    }

    if (
      !transcriptId ||
      claimedIds.has(transcriptId) ||
      !transcriptCwd ||
      !firstTimestamp ||
      resolve(transcriptCwd) !== resolve(session.cwd)
    ) {
      continue;
    }

    const delta = firstTimestamp - createdAt;
    if (delta < -5_000 || delta > 3 * 60 * 1000) continue;
    const distance = Math.abs(delta);
    if (!best || distance < best.distance) best = { id: transcriptId, path, distance };
  }

  if (!best) return null;
  codexTranscriptCache.set(best.id, best.path);
  return best.id;
}

function readFileTail(file: string, maxBytes = CLAUDE_TRANSCRIPT_TAIL_BYTES): string {
  const size = statSync(file).size;
  const length = Math.min(size, maxBytes);
  if (length <= 0) return "";

  const buffer = Buffer.alloc(length);
  const descriptor = openSync(file, "r");
  try {
    readSync(descriptor, buffer, 0, length, size - length);
  } finally {
    closeSync(descriptor);
  }

  const text = buffer.toString("utf8");
  if (size <= maxBytes) return text;
  const firstLineBreak = text.indexOf("\n");
  return firstLineBreak >= 0 ? text.slice(firstLineBreak + 1) : "";
}

function readTranscriptWindow(file: string): string {
  const size = statSync(file).size;
  if (size <= CLAUDE_TRANSCRIPT_TAIL_BYTES) return readFileSync(file, "utf8");
  return `${readFilePrefix(file)}\n${readFileTail(file)}`;
}

function trimChatText(value: unknown, maxLength = 24_000): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/g, "\n").trim().slice(0, maxLength);
}

function cleanClaudeUserText(value: unknown): string {
  let text = trimChatText(value);
  if (!text) return "";

  const commandName = text.match(/<command-name>(.*?)<\/command-name>/s)?.[1]?.trim();
  if (commandName) return commandName.startsWith("/") ? commandName : `/${commandName}`;

  if (
    text.startsWith("Base directory for this skill:") ||
    text.startsWith("<local-command-stdout>") ||
    text.startsWith("<local-command-caveat>")
  ) {
    return "";
  }

  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  return text;
}

function summarizeClaudeTool(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const values = input as Record<string, unknown>;
  const preferredKeys =
    toolName === "Bash"
      ? ["description", "command"]
      : ["file_path", "path", "pattern", "query", "url", "description", "command"];

  for (const key of preferredKeys) {
    const value = values[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const firstLine = value.trim().split("\n")[0];
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
  }

  return "";
}

function formatClaudeToolDetail(value: unknown, maxLength = 48_000): string {
  if (typeof value === "string") return trimChatText(value, maxLength);
  if (value == null) return "";

  try {
    const rendered = JSON.stringify(value, null, 2);
    return rendered.length > maxLength ? `${rendered.slice(0, maxLength)}\n…` : rendered;
  } catch {
    return trimChatText(String(value), maxLength);
  }
}

function parseClaudeConversation(raw: string): ClaudeChatEntry[] {
  const entries: ClaudeChatEntry[] = [];
  const toolIndexes = new Map<string, number>();
  const seenMessageIds = new Set<string>();
  const startup = {
    version: undefined as string | undefined,
    model: undefined as string | undefined,
    effort: undefined as string | undefined,
    cwd: undefined as string | undefined,
    permissionMode: undefined as string | undefined,
    notices: [] as string[],
    timestamp: undefined as string | undefined,
  };
  const startupNotices = new Set<string>();

  const addTextEntry = (
    role: "user" | "assistant",
    text: string,
    id: string,
    timestamp?: string,
  ) => {
    if (!text || seenMessageIds.has(id)) return;
    seenMessageIds.add(id);
    const previous = entries[entries.length - 1];
    if (role === "assistant" && previous?.role === "assistant") {
      previous.text = [previous.text, text].filter(Boolean).join("\n\n");
      previous.timestamp = timestamp || previous.timestamp;
      return;
    }
    entries.push({ id, role, text, timestamp });
  };

  raw.split("\n").forEach((line, lineIndex) => {
    if (!line.trim()) return;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }

    if (!startup.version && typeof record?.version === "string") startup.version = record.version;
    if (!startup.cwd && typeof record?.cwd === "string") startup.cwd = record.cwd;
    if (!startup.effort && typeof record?.effort === "string") startup.effort = record.effort;
    if (!startup.timestamp && typeof record?.timestamp === "string") startup.timestamp = record.timestamp;
    if (!startup.permissionMode && record?.type === "permission-mode" && typeof record.permissionMode === "string") {
      startup.permissionMode = record.permissionMode;
    }
    if (!startup.model && record?.type === "assistant" && typeof record?.message?.model === "string") {
      startup.model = record.message.model;
    }
    if (
      record?.type === "attachment" &&
      record?.attachment?.type === "hook_system_message" &&
      record?.attachment?.hookEvent === "SessionStart"
    ) {
      const notice = trimChatText(record.attachment.content, 2_000);
      if (notice && !startupNotices.has(notice)) {
        startupNotices.add(notice);
        startup.notices.push(notice);
      }
    }

    if (record?.type !== "user" && record?.type !== "assistant") return;
    const message = record.message;
    const messageId = typeof record.uuid === "string" ? record.uuid : `line-${lineIndex}`;
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
    const content = message?.content;

    if (record.type === "user" && typeof content === "string") {
      addTextEntry("user", cleanClaudeUserText(content), messageId, timestamp);
      return;
    }

    if (!Array.isArray(content)) return;
    const userText: string[] = [];
    const assistantText: string[] = [];

    content.forEach((block: any, blockIndex: number) => {
      if (record.type === "user" && block?.type === "text") {
        const text = cleanClaudeUserText(block.text);
        if (text) userText.push(text);
        return;
      }

      if (record.type === "assistant" && block?.type === "text") {
        const text = trimChatText(block.text);
        if (text) assistantText.push(text);
        return;
      }

      if (record.type === "assistant" && block?.type === "tool_use") {
        const toolId = typeof block.id === "string" ? block.id : `${messageId}-tool-${blockIndex}`;
        if (toolIndexes.has(toolId)) return;
        const toolName = typeof block.name === "string" ? block.name : "Tool";
        toolIndexes.set(toolId, entries.length);
        entries.push({
          id: toolId,
          role: "tool",
          toolName,
          toolSummary: summarizeClaudeTool(toolName, block.input),
          toolInput: formatClaudeToolDetail(block.input),
          toolStatus: "running",
          timestamp,
        });
        return;
      }

      if (record.type === "user" && block?.type === "tool_result") {
        const toolId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const toolIndex = toolIndexes.get(toolId);
        if (toolIndex === undefined) return;
        entries[toolIndex].toolStatus = block.is_error ? "error" : "complete";
        entries[toolIndex].toolOutput = formatClaudeToolDetail(block.content);
      }
    });

    if (userText.length > 0) {
      addTextEntry("user", userText.join("\n\n"), messageId, timestamp);
    }
    if (assistantText.length > 0) {
      addTextEntry("assistant", assistantText.join("\n\n"), messageId, timestamp);
    }
  });

  const hasStartup = Boolean(
    startup.version ||
    startup.model ||
    startup.cwd ||
    startup.permissionMode ||
    startup.notices.length > 0,
  );
  const conversation = entries.slice(hasStartup ? -119 : -120);
  if (!hasStartup) return conversation;

  return [
    {
      id: "claude-session-startup",
      role: "system",
      startup: {
        agentName: "Claude Code",
        version: startup.version,
        model: startup.model,
        effort: startup.effort,
        cwd: startup.cwd,
        permissionMode: startup.permissionMode,
        notices: startup.notices,
      },
      timestamp: startup.timestamp,
    },
    ...conversation,
  ];
}

function extractCodexMessageText(content: unknown): string {
  if (typeof content === "string") return trimChatText(content);
  if (!Array.isArray(content)) return "";

  return trimChatText(
    content
      .map((block: any) => {
        if (!block || typeof block !== "object") return "";
        if (!["input_text", "output_text", "text"].includes(block.type)) return "";
        return typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("\n\n"),
  );
}

function cleanCodexUserText(content: unknown): string {
  const text = extractCodexMessageText(content);
  if (!text) return "";
  if (
    text.startsWith("# AGENTS.md instructions") ||
    text.startsWith("<skills_instructions>") ||
    text.startsWith("<environment_context>") ||
    text.startsWith("<permissions instructions>")
  ) {
    return "";
  }
  return text;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseCodexConversation(raw: string): { messages: ClaudeChatEntry[]; working: boolean } {
  const entries: ClaudeChatEntry[] = [];
  const toolIndexes = new Map<string, number>();
  const seenMessageIds = new Set<string>();
  const startup = {
    version: undefined as string | undefined,
    model: undefined as string | undefined,
    effort: undefined as string | undefined,
    cwd: undefined as string | undefined,
    permissionMode: undefined as string | undefined,
    timestamp: undefined as string | undefined,
  };
  let working = false;

  const addTextEntry = (
    role: "user" | "assistant",
    text: string,
    id: string,
    timestamp?: string,
  ) => {
    if (!text || seenMessageIds.has(id)) return;
    seenMessageIds.add(id);
    const previous = entries[entries.length - 1];
    if (role === "assistant" && previous?.role === "assistant") {
      previous.text = [previous.text, text].filter(Boolean).join("\n\n");
      previous.timestamp = timestamp || previous.timestamp;
      return;
    }
    entries.push({ id, role, text, timestamp });
  };

  raw.split("\n").forEach((line, lineIndex) => {
    if (!line.trim()) return;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }

    const payload = record?.payload || {};
    const timestamp = typeof record?.timestamp === "string" ? record.timestamp : undefined;

    if (record?.type === "session_meta") {
      if (!startup.version && typeof payload.cli_version === "string") startup.version = payload.cli_version;
      if (!startup.cwd && typeof payload.cwd === "string") startup.cwd = payload.cwd;
      if (!startup.timestamp && timestamp) startup.timestamp = timestamp;
    }
    if (record?.type === "turn_context") {
      if (typeof payload.model === "string") startup.model = payload.model;
      if (typeof payload.effort === "string") startup.effort = payload.effort;
      if (typeof payload.approval_policy === "string") startup.permissionMode = payload.approval_policy;
    }
    if (record?.type === "event_msg") {
      if (payload.type === "task_started") working = true;
      if (payload.type === "task_complete" || payload.type === "turn_aborted") working = false;
      return;
    }
    if (record?.type !== "response_item") return;

    const itemId = typeof payload.id === "string" ? payload.id : `codex-line-${lineIndex}`;
    if (payload.type === "message") {
      if (payload.role === "user") {
        addTextEntry("user", cleanCodexUserText(payload.content), itemId, timestamp);
      } else if (payload.role === "assistant") {
        addTextEntry("assistant", extractCodexMessageText(payload.content), itemId, timestamp);
      }
      return;
    }

    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const toolId = typeof payload.call_id === "string" ? payload.call_id : itemId;
      if (toolIndexes.has(toolId)) return;
      const toolName = typeof payload.name === "string" ? payload.name : "Tool";
      const input = parseJsonValue(payload.arguments ?? payload.input);
      toolIndexes.set(toolId, entries.length);
      entries.push({
        id: toolId,
        role: "tool",
        toolName,
        toolSummary: summarizeClaudeTool(toolName, input),
        toolInput: formatClaudeToolDetail(input),
        toolStatus: payload.status === "failed" ? "error" : "running",
        timestamp,
      });
      return;
    }

    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const toolId = typeof payload.call_id === "string" ? payload.call_id : "";
      const toolIndex = toolIndexes.get(toolId);
      if (toolIndex === undefined) return;
      const output = parseJsonValue(payload.output);
      entries[toolIndex].toolOutput = formatClaudeToolDetail(output);
      entries[toolIndex].toolStatus =
        typeof payload.output === "string" && /(^|\n)(error|failed):/i.test(payload.output)
          ? "error"
          : "complete";
    }
  });

  const hasStartup = Boolean(
    startup.version || startup.model || startup.cwd || startup.permissionMode,
  );
  const conversation = entries.slice(hasStartup ? -119 : -120);
  if (!hasStartup) return { messages: conversation, working };

  return {
    working,
    messages: [
      {
        id: "codex-session-startup",
        role: "system",
        startup: {
          agentName: "OpenAI Codex",
          version: startup.version,
          model: startup.model,
          effort: startup.effort,
          cwd: startup.cwd,
          permissionMode: startup.permissionMode,
          notices: [],
        },
        timestamp: startup.timestamp,
      },
      ...conversation,
    ],
  };
}

function getAgentRulesFile(): string {
  return join(getDataDir(), "agent-rules.json");
}

function loadAgentRules(): string {
  try {
    const file = getAgentRulesFile();
    if (!existsSync(file)) return "";
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed.rules === "string" ? parsed.rules.slice(0, AGENT_RULES_MAX_CHARS) : "";
  } catch {
    return "";
  }
}

function saveAgentRules(rules: string): string {
  const cleanRules = rules.slice(0, AGENT_RULES_MAX_CHARS);
  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(
    getAgentRulesFile(),
    JSON.stringify({ rules: cleanRules, updatedAt: Date.now() }, null, 2),
  );
  return cleanRules;
}

function buildInitialPrompt(initialPrompt: unknown): string | undefined {
  const rules = loadAgentRules().trim();
  const starterPrompt =
    typeof initialPrompt === "string" ? initialPrompt.trim().slice(0, AGENT_RULES_MAX_CHARS) : "";
  const parts = [
    rules ? `Persistent OpenUI agent rules:\n${rules}` : "",
    starterPrompt,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n").slice(0, AGENT_RULES_MAX_CHARS) : undefined;
}

function buildTitlePrompt(initialPrompt: unknown): string | undefined {
  const starterPrompt =
    typeof initialPrompt === "string" ? initialPrompt.trim().slice(0, AGENT_RULES_MAX_CHARS) : "";
  return starterPrompt || undefined;
}

const SORT_STATUS_PRIORITY: Record<string, number> = {
  waiting_input: 0,
  error: 1,
  running: 2,
  tool_calling: 3,
  creating: 4,
  idle: 5,
  disconnected: 6,
};

const TITLE_SORT_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "auto",
  "build",
  "can",
  "code",
  "coding",
  "do",
  "fix",
  "for",
  "help",
  "in",
  "investigation",
  "make",
  "of",
  "on",
  "please",
  "review",
  "session",
  "task",
  "the",
  "to",
  "update",
  "work",
]);

const TITLE_SORT_CHANNEL_TOKENS = new Set([
  "bookface",
  "email",
  "emails",
  "github",
  "linear",
  "linkedin",
  "notion",
  "slack",
  "twitter",
  "x",
  "yc",
]);

const TITLE_SORT_OUTBOUND_DIRECT_TOKENS = new Set([
  "lead",
  "leads",
  "outbound",
  "outreach",
  "prospect",
  "prospecting",
  "prospects",
  "reachout",
  "sales",
]);

const TITLE_SORT_OUTBOUND_CONTEXT_TOKENS = new Set([
  "batchmate",
  "batchmates",
  "companies",
  "company",
  "contact",
  "contacts",
  "customer",
  "customers",
  "dm",
  "dms",
  "founder",
  "founders",
  "intro",
  "intros",
  "list",
  "lists",
  "message",
  "messages",
  "messaging",
  "partner",
  "partners",
]);

// Any one of these alone marks a session as IDE/OpenUI work.
const TITLE_SORT_IDE_DIRECT_TOKENS = new Set([
  "ide",
  "openui",
  "openui-desktop",
  "sidebar",
  "keybinding",
  "keybindings",
  "statusline",
]);

// IDE surfaces that need a companion tweak-verb to count (too generic alone).
const TITLE_SORT_IDE_SURFACE_TOKENS = new Set([
  "browser",
  "canvas",
  "dock",
  "editor",
  "notification",
  "notifications",
  "pane",
  "panel",
  "sessions",
  "terminal",
  "title",
  "titles",
  "toolbar",
]);

const TITLE_SORT_IDE_TWEAK_TOKENS = new Set([
  "clean",
  "cleanup",
  "cluster",
  "clusters",
  "clustering",
  "dock",
  "flow",
  "flows",
  "group",
  "grouped",
  "grouping",
  "layout",
  "parse",
  "parsed",
  "parsing",
  "polish",
  "polishing",
  "rename",
  "renaming",
  "sort",
  "sorted",
  "sorting",
  "theme",
  "titling",
  "tweak",
  "tweaking",
  "tweaks",
  "ui",
  "ux",
]);

const TITLE_SORT_EXPERIMENT_TOKENS = new Set([
  "ab-test",
  "ab-tests",
  "eval",
  "evals",
  "experiment",
  "experimentation",
  "experimentations",
  "experiments",
]);

function titleSortPriority(item: TitleSortInput): number {
  return SORT_STATUS_PRIORITY[item.status || ""] ?? 99;
}

function titleTokens(value: string): string[] {
  const ticket = value.match(/\b[A-Z][A-Z0-9]+-\d+\b/);
  const words = value
    .toLowerCase()
    .replace(/\bhttps?:\/\/[^\s]+/g, " local-url ")
    .replace(/\breach\s+out\b/g, " reachout ")
    .replace(/[^a-z0-9-]+/g, " ")
    .split(/\s+/)
    .filter((word) => word && word.length > 1 && !TITLE_SORT_STOP_WORDS.has(word));
  return ticket ? [ticket[0].toLowerCase(), ...words] : words;
}

function allTitleSortText(item: TitleSortInput): string {
  return [
    item.title,
    item.ticketTitle,
    ...(item.promptHistory || []),
  ]
    .filter(Boolean)
    .join(" ");
}

function titleCaseSortToken(token: string): string {
  const acronym = {
    api: "API",
    cli: "CLI",
    pr: "PR",
    sdk: "SDK",
    ui: "UI",
    yc: "YC",
  }[token];
  if (acronym) return acronym;
  return /^[a-z]+-\d+$/i.test(token)
    ? token.toUpperCase()
    : token.charAt(0).toUpperCase() + token.slice(1);
}

function labelFromTokens(tokens: string[], fallback: string): string {
  const label = tokens
    .slice(0, 3)
    .map(titleCaseSortToken)
    .join(" ");
  return label || fallback || "Related Work";
}

function hasAny(tokenSet: Set<string>, wanted: Set<string>): boolean {
  for (const token of wanted) if (tokenSet.has(token)) return true;
  return false;
}

// Local (no-LLM) intent grouping for session cards. Sessions cluster by the
// content of the work — the durable intent — not by whichever words happen to
// lead their titles. Each rule below is a content signature: either a direct
// token that alone claims the session, or a surface+verb pair for tokens too
// generic on their own. Rules are checked in order; first match wins. Sessions
// matching no rule fall through to ticket-id / repo+token keying.
// NOTE: TITLE_SORT_STOP_WORDS are stripped before matching — rules must not
// rely on filtered words like "fix", "session", "app", or "review".
function semanticTitleSortGroup(tokens: string[]): { key: string; label: string; reason: string } | null {
  const tokenSet = new Set(tokens);

  // Outbound: prospecting/outreach work belongs together regardless of the
  // channel (LinkedIn, Bookface, email, ...) it flows through.
  const hasDirectOutbound = hasAny(tokenSet, TITLE_SORT_OUTBOUND_DIRECT_TOKENS);
  const hasChannel = hasAny(tokenSet, TITLE_SORT_CHANNEL_TOKENS);
  const hasOutboundContext = hasAny(tokenSet, TITLE_SORT_OUTBOUND_CONTEXT_TOKENS);
  if (hasDirectOutbound || (hasChannel && hasOutboundContext)) {
    return {
      key: "intent:outbound",
      label: tokenSet.has("founder") || tokenSet.has("founders") || tokenSet.has("batchmate") || tokenSet.has("batchmates")
        ? "Founder Outreach"
        : "Outbound",
      reason: "Local intent fallback grouped outbound work across channels",
    };
  }

  // Experiments: setting up, running, or managing experimentation/evals.
  if (hasAny(tokenSet, TITLE_SORT_EXPERIMENT_TOKENS)) {
    return {
      key: "intent:experiments",
      label: "Experiments",
      reason: "Local intent fallback grouped experimentation work",
    };
  }

  // IDE tweaks: anything about tweaking OpenUI itself — sidebar, session
  // titles/grouping, notifications, browser dock, terminal, themes. One
  // group whether the session says "ide" outright or pairs an IDE surface
  // with a tweak verb ("session titles sorting", "notification parsing").
  const hasDirectIde = hasAny(tokenSet, TITLE_SORT_IDE_DIRECT_TOKENS);
  const hasIdeSurface = hasAny(tokenSet, TITLE_SORT_IDE_SURFACE_TOKENS);
  const hasIdeTweak = hasAny(tokenSet, TITLE_SORT_IDE_TWEAK_TOKENS);
  if (hasDirectIde || (hasIdeSurface && hasIdeTweak)) {
    return {
      key: "intent:ide-tweaks",
      label: "IDE Tweaks",
      reason: "Local intent fallback grouped IDE/OpenUI tweaking work",
    };
  }

  return null;
}

function fallbackTitleSortGroups(items: TitleSortInput[]): TitleSortGroup[] {
  const sorted = [...items].sort((a, b) => {
    const priority = titleSortPriority(a) - titleSortPriority(b);
    if (priority !== 0) return priority;
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });

  const groups = new Map<string, TitleSortGroup>();
  for (const item of sorted) {
    const tokens = titleTokens(allTitleSortText(item));
    const repoToken = (item.repo || "").split("/").filter(Boolean).pop()?.toLowerCase();
    const semanticGroup = semanticTitleSortGroup(tokens);
    const keyTokens = tokens.filter((token) => !TITLE_SORT_CHANNEL_TOKENS.has(token));
    const key =
      semanticGroup?.key ||
      tokens.find((token) => /^[a-z]+-\d+$/i.test(token)) ||
      (repoToken && keyTokens[0] ? `${repoToken}:${keyTokens[0]}` : keyTokens.slice(0, 2).join(":")) ||
      item.nodeId;
    const existing = groups.get(key);
    if (existing) {
      existing.nodeIds.push(item.nodeId);
    } else {
      groups.set(key, {
        label: semanticGroup?.label || labelFromTokens(keyTokens.length > 0 ? keyTokens : tokens, item.title),
        reason: semanticGroup?.reason || "Local title-token intent fallback",
        nodeIds: [item.nodeId],
      });
    }
  }

  return Array.from(groups.values());
}

function validateTitleSortGroups(
  groups: TitleSortGroup[] | null,
  items: TitleSortInput[],
): TitleSortGroup[] | null {
  if (!groups || groups.length === 0) return null;
  const allowedIds = new Set(items.map((item) => item.nodeId));
  const seen = new Set<string>();
  const cleaned: TitleSortGroup[] = [];

  for (const group of groups) {
    const nodeIds = group.nodeIds.filter((id) => allowedIds.has(id) && !seen.has(id));
    if (nodeIds.length === 0) continue;
    nodeIds.forEach((id) => seen.add(id));
    cleaned.push({
      label: group.label?.trim() || "Related Work",
      reason: group.reason,
      nodeIds,
    });
  }

  for (const item of items) {
    if (!seen.has(item.nodeId)) {
      cleaned.push({ label: item.title || "Related Work", nodeIds: [item.nodeId] });
    }
  }

  return cleaned.length > 0 ? cleaned : null;
}

apiRoutes.get("/config", (c) => {
  return c.json({ launchCwd: getLaunchCwd(), dataDir: getDataDir() });
});

apiRoutes.get("/agent-rules", (c) => {
  return c.json({ rules: loadAgentRules(), maxChars: AGENT_RULES_MAX_CHARS });
});

apiRoutes.post("/agent-rules", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const rules = saveAgentRules(typeof body.rules === "string" ? body.rules : "");
  return c.json({ rules, maxChars: AGENT_RULES_MAX_CHARS });
});

apiRoutes.get("/title-generation/config", (c) => {
  return c.json(loadTitleGenerationConfig());
});

apiRoutes.post("/title-generation/config", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.apiKey !== undefined) {
    saveTitleGenerationApiKey(typeof body.apiKey === "string" ? body.apiKey : "");
  }
  return c.json(loadTitleGenerationConfig());
});

// Browse directories for file picker
apiRoutes.get("/browse", (c) => {
  let path = c.req.query("path") || getLaunchCwd();

  if (path.startsWith("~")) {
    path = path.replace("~", homedir());
  }

  path = resolve(path);

  try {
    const entries = readdirSync(path, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({
        name: entry.name,
        path: join(path, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parentPath = resolve(path, "..");

    return c.json({
      current: path,
      parent: parentPath !== path ? parentPath : null,
      directories,
    });
  } catch (e: any) {
    return c.json({ error: e.message, current: path }, 400);
  }
});

// Scan a directory for child git repositories
apiRoutes.get("/scan-repos", async (c) => {
  let path = c.req.query("path") || getLaunchCwd();

  if (path.startsWith("~")) {
    path = path.replace("~", homedir());
  }

  path = resolve(path);

  try {
    const repos = await scanReposInDirectory(path);
    return c.json({ repos });
  } catch (e: any) {
    return c.json({ error: e.message, repos: [] }, 400);
  }
});

// Markdown file discovery and reading
const MD_EXTS = new Set(["md", "markdown", "mdx"]);
const MD_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const MD_MAX_DEPTH = 4;
const MD_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo",
  "coverage", "__pycache__", ".cache", "release", ".venv", "venv",
]);

function expandPath(p: string): string {
  if (p.startsWith("~")) p = p.replace("~", homedir());
  return resolve(p);
}

// ============ Project Tasks ============
// IDE-style task discovery for package scripts. Discovery reads package metadata
// only; scripts are run later through the normal terminal/session path.

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const PACKAGE_JSON_MAX_BYTES = 1024 * 1024;
const PACKAGE_SCRIPT_PRIORITY = [
  "dev",
  "start",
  "build",
  "test",
  "lint",
  "typecheck",
  "check",
  "format",
  "preview",
];

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function packageManagerForRoot(root: string): PackageManager {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  return "npm";
}

function packageScriptCommand(manager: PackageManager, scriptName: string): string {
  const script = shellQuote(scriptName);
  if (manager === "npm") return `npm run ${script}`;
  if (manager === "pnpm") return `pnpm run ${script}`;
  if (manager === "yarn") return `yarn run ${script}`;
  return `bun run ${script}`;
}

function describePackageScript(scriptName: string): string {
  const lower = scriptName.toLowerCase();
  if (lower === "dev" || lower.includes("dev")) return "Start the development workflow";
  if (lower === "start") return "Start the project";
  if (lower.includes("build")) return "Build the project";
  if (lower.includes("test")) return "Run tests";
  if (lower.includes("lint")) return "Run lint checks";
  if (lower.includes("type")) return "Run type checking";
  if (lower.includes("format")) return "Format or verify formatting";
  if (lower.includes("preview")) return "Preview the built app";
  return "Run package script";
}

function findPackageRoot(startPath: string): string | null {
  let current = expandPath(startPath || getLaunchCwd());
  if (!existsSync(current)) return null;

  const stat = statSync(current);
  if (!stat.isDirectory()) current = dirname(current);

  for (let depth = 0; depth < 8; depth++) {
    const packageJsonPath = join(current, "package.json");
    if (existsSync(packageJsonPath)) return current;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

apiRoutes.get("/tasks/scripts", (c) => {
  const queryPath = c.req.query("path") || getLaunchCwd();
  const requestedPath = expandPath(queryPath);

  if (!existsSync(requestedPath)) {
    return c.json({ error: "Path not found", root: requestedPath, scripts: [] }, 404);
  }

  const root = findPackageRoot(requestedPath);
  if (!root) {
    return c.json({ root: requestedPath, packageJsonPath: null, packageManager: "npm", scripts: [] });
  }

  const packageJsonPath = join(root, "package.json");
  const packageStat = statSync(packageJsonPath);
  if (!packageStat.isFile()) {
    return c.json({ error: "package.json is not a file", root, packageJsonPath, scripts: [] }, 400);
  }
  if (packageStat.size > PACKAGE_JSON_MAX_BYTES) {
    return c.json({ error: "package.json is too large", root, packageJsonPath, scripts: [] }, 400);
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const scriptsObject = parsed && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
      ? parsed.scripts
      : {};
    const packageManager = packageManagerForRoot(root);
    const scripts = Object.entries(scriptsObject)
      .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
      .map(([name, command]) => ({
        name,
        command,
        runCommand: packageScriptCommand(packageManager, name),
        description: describePackageScript(name),
      }))
      .sort((a, b) => {
        const aPriority = PACKAGE_SCRIPT_PRIORITY.indexOf(a.name);
        const bPriority = PACKAGE_SCRIPT_PRIORITY.indexOf(b.name);
        const aRank = aPriority === -1 ? PACKAGE_SCRIPT_PRIORITY.length : aPriority;
        const bRank = bPriority === -1 ? PACKAGE_SCRIPT_PRIORITY.length : bPriority;
        return aRank === bRank ? a.name.localeCompare(b.name) : aRank - bRank;
      });

    return c.json({
      root,
      packageJsonPath,
      packageManager,
      scripts,
    });
  } catch (e: any) {
    return c.json({ error: e.message || "Failed to parse package.json", root, packageJsonPath, scripts: [] }, 400);
  }
});

function isMarkdownPath(p: string): boolean {
  const ext = p.includes(".") ? p.split(".").pop()!.toLowerCase() : "";
  return MD_EXTS.has(ext);
}

function walkMarkdown(
  root: string,
  results: { name: string; path: string; size: number; modified: number }[],
  depth: number,
): void {
  if (depth > MD_MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (MD_SKIP_DIRS.has(entry.name)) continue;
      walkMarkdown(full, results, depth + 1);
    } else if (entry.isFile() && isMarkdownPath(entry.name)) {
      try {
        const st = statSync(full);
        results.push({
          name: entry.name,
          path: full,
          size: st.size,
          modified: st.mtimeMs,
        });
      } catch {
        // skip unreadable files
      }
    }
  }
}

apiRoutes.get("/files/list", (c) => {
  const queryPath = c.req.query("path") || getLaunchCwd();
  const root = expandPath(queryPath);

  if (!existsSync(root)) {
    return c.json({ error: "Path not found", root }, 404);
  }

  const stat = statSync(root);
  if (!stat.isDirectory()) {
    return c.json({ error: "Not a directory", root }, 400);
  }

  const files: { name: string; path: string; size: number; modified: number }[] = [];
  walkMarkdown(root, files, 0);
  files.sort((a, b) => b.modified - a.modified);

  return c.json({ root, files });
});

apiRoutes.get("/files/read", (c) => {
  const queryPath = c.req.query("path");
  if (!queryPath) return c.json({ error: "path required" }, 400);

  const filePath = expandPath(queryPath);

  if (!isMarkdownPath(filePath)) {
    return c.json({ error: "Only markdown files are readable" }, 400);
  }

  if (!existsSync(filePath)) {
    return c.json({ error: "File not found", path: filePath }, 404);
  }

  const stat = statSync(filePath);
  if (!stat.isFile()) {
    return c.json({ error: "Not a file" }, 400);
  }
  if (stat.size > MD_MAX_BYTES) {
    return c.json({ error: `File too large (>${MD_MAX_BYTES} bytes)` }, 400);
  }

  try {
    const content = readFileSync(filePath, "utf8");
    return c.json({
      path: filePath,
      name: filePath.split("/").pop() || filePath,
      size: stat.size,
      modified: stat.mtimeMs,
      content,
    });
  } catch (e: any) {
    return c.json({ error: e.message || "Read failed" }, 500);
  }
});

// ============ Git Diff ============
// Reviewing what an agent just wrote: `git diff` on a repo, per-file.

const GIT_MAX_BUFFER = 20 * 1024 * 1024; // 20MB — handles large diffs

function execGitWithInput(root: string, args: string[], input: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      rejectPromise(error);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > GIT_MAX_BUFFER) {
        rejectOnce(new Error("git output exceeded the maximum buffer"));
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > GIT_MAX_BUFFER) {
        rejectOnce(new Error("git error output exceeded the maximum buffer"));
      }
    });

    child.on("error", rejectOnce);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      rejectPromise(new Error(stderr.trim() || `git ${args.join(" ")} failed with exit code ${code}`));
    });

    child.stdin.end(input);
  });
}

// Resolve the git repo root for a path. Returns null if not in a repo.
async function gitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git rev-parse --show-toplevel", { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

function resolveGitFile(root: string, file: string): { absPath: string; relPath: string } {
  const absPath = resolve(root, file);
  const relPath = relative(root, absPath);

  if (!relPath || relPath.startsWith("..") || resolve(root, relPath) !== absPath) {
    throw new Error("File must be inside the git repository");
  }

  return { absPath, relPath };
}

async function gitHasHead(root: string): Promise<boolean> {
  try {
    await execGitAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

async function gitFileExistsInHead(root: string, relPath: string): Promise<boolean> {
  try {
    await execGitAsync("git", ["cat-file", "-e", `HEAD:${relPath}`], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

async function discardGitFile(root: string, file: string): Promise<void> {
  const { absPath, relPath } = resolveGitFile(root, file);
  const { stdout } = await execGitAsync("git", ["status", "--porcelain", "--", relPath], {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
  });
  const status = stdout.slice(0, 2);

  if (status === "??") {
    rmSync(absPath, { force: true, recursive: true });
    return;
  }

  const hasHead = await gitHasHead(root);
  const existsInHead = hasHead && (await gitFileExistsInHead(root, relPath));

  if (existsInHead) {
    await execGitAsync("git", ["restore", "--source=HEAD", "--staged", "--worktree", "--", relPath], {
      cwd: root,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return;
  }

  await execGitAsync("git", ["reset", "HEAD", "--", relPath], {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
  }).catch(() => undefined);
  rmSync(absPath, { force: true, recursive: true });
}

function extractHunkPatch(diff: string, hunkIndex: number): string | null {
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0) return null;

  const lines = diff.split("\n");
  const header: string[] = [];
  const hunks: string[][] = [];
  let current: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTrailingSplitLine = i === lines.length - 1 && line === "";
    if (isTrailingSplitLine) continue;

    if (line.startsWith("@@")) {
      current = [line];
      hunks.push(current);
      continue;
    }

    if (!current) {
      if (line) header.push(line);
      continue;
    }

    current.push(line);
  }

  const selected = hunks[hunkIndex];
  if (!selected || header.length === 0) return null;
  return `${[...header, ...selected].join("\n")}\n`;
}

async function discardGitHunk(root: string, file: string, hunkIndex: number): Promise<void> {
  const { relPath } = resolveGitFile(root, file);
  const { stdout: statusOut } = await execGitAsync("git", ["status", "--porcelain", "--", relPath], {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
  });

  if (statusOut.slice(0, 2) === "??") {
    throw new Error("Rejecting individual hunks is only available for tracked files");
  }

  const { stdout: diff } = await execGitAsync(
    "git",
    ["diff", "--no-color", "HEAD", "--", relPath],
    { cwd: root, maxBuffer: GIT_MAX_BUFFER },
  );
  const patch = extractHunkPatch(diff, hunkIndex);
  if (!patch) {
    throw new Error("Hunk not found");
  }

  await execGitWithInput(root, ["apply", "--reverse", "--cached", "--whitespace=nowarn"], patch).catch(() => undefined);
  await execGitWithInput(root, ["apply", "--reverse", "--whitespace=nowarn"], patch);
}

interface GitChangedFile {
  path: string;
  status: string;
  added: number;
  removed: number;
  untracked: boolean;
  mtime: number;
}

async function getGitChangedFiles(root: string): Promise<GitChangedFile[]> {
  // `git status --porcelain` gives us status letters incl. untracked (??).
  const { stdout: statusOut } = await execGitAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
  });

  // `git diff --numstat HEAD` gives added/removed counts for tracked changes.
  // (Falls back gracefully on a repo with no commits.)
  const numstat: Record<string, { added: number; removed: number }> = {};
  try {
    const { stdout } = await execGitAsync("git", ["diff", "--numstat", "HEAD"], {
      cwd: root,
      maxBuffer: GIT_MAX_BUFFER,
    });
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const [added, removed, ...rest] = line.split("\t");
      const file = rest.join("\t");
      numstat[file] = {
        added: added === "-" ? 0 : parseInt(added, 10) || 0,
        removed: removed === "-" ? 0 : parseInt(removed, 10) || 0,
      };
    }
  } catch {
    // no HEAD yet — leave counts at 0
  }

  const files: GitChangedFile[] = [];
  for (const line of statusOut.split("\n")) {
    if (!line.trim()) continue;
    // Porcelain: XY<space>path  (path may be quoted / renamed "old -> new")
    const xy = line.slice(0, 2);
    let path = line.slice(3).trim();
    const untracked = xy === "??";
    if (path.includes(" -> ")) path = path.split(" -> ")[1];
    path = path.replace(/^"|"$/g, "");
    const counts = numstat[path] || { added: 0, removed: 0 };
    let mtime = 0;
    try {
      mtime = statSync(join(root, path)).mtimeMs;
    } catch {
      // file no longer on disk (deleted) — leave at 0
    }
    files.push({
      path,
      status: xy.trim() || (untracked ? "?" : "M"),
      added: counts.added,
      removed: counts.removed,
      untracked,
      mtime,
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function buildCommitMessage(files: GitChangedFile[]): { summary: string; commitMessage: string } {
  if (files.length === 0) {
    return {
      summary: "No uncommitted changes.",
      commitMessage: "",
    };
  }

  const added = files.filter((file) => file.untracked || file.status.includes("A")).length;
  const deleted = files.filter((file) => file.status.includes("D")).length;
  const modified = files.length - added - deleted;
  const directories = Array.from(
    new Set(files.map((file) => file.path.split("/")[0]).filter(Boolean)),
  ).slice(0, 3);

  const verb =
    added > 0 && modified === 0 && deleted === 0
      ? "add"
      : deleted > 0 && modified === 0 && added === 0
      ? "remove"
      : "update";
  const scope = directories.length === 1 ? `(${directories[0]})` : "";
  const subject =
    files.length === 1
      ? `${verb}${scope}: ${files[0].path}`
      : `${verb}${scope}: ${files.length} files`;

  const summary = [
    `${files.length} changed file${files.length === 1 ? "" : "s"}`,
    modified > 0 ? `${modified} modified` : "",
    added > 0 ? `${added} added` : "",
    deleted > 0 ? `${deleted} deleted` : "",
  ].filter(Boolean).join(", ");

  const body = files
    .slice(0, 8)
    .map((file) => `- ${file.path}${file.added || file.removed ? ` (+${file.added}/-${file.removed})` : ""}`)
    .join("\n");

  return {
    summary,
    commitMessage: body ? `${subject}\n\n${body}` : subject,
  };
}

interface GitCheckpointFile {
  path: string;
  exists: boolean;
  contentBase64?: string;
}

interface GitCheckpoint {
  id: string;
  repoRoot: string;
  name: string;
  createdAt: number;
  files: GitCheckpointFile[];
  source?: "manual" | "session-launch";
  sessionId?: string;
  nodeId?: string;
}

function getCheckpointsFile(): string {
  return join(getDataDir(), "checkpoints.json");
}

function loadCheckpoints(): GitCheckpoint[] {
  try {
    const file = getCheckpointsFile();
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((checkpoint) => {
      return (
        checkpoint &&
        typeof checkpoint.id === "string" &&
        typeof checkpoint.repoRoot === "string" &&
        typeof checkpoint.name === "string" &&
        typeof checkpoint.createdAt === "number" &&
        Array.isArray(checkpoint.files)
      );
    });
  } catch {
    return [];
  }
}

function saveCheckpoints(checkpoints: GitCheckpoint[]): void {
  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(getCheckpointsFile(), JSON.stringify(checkpoints.slice(0, 100), null, 2));
}

function summarizeCheckpoint(checkpoint: GitCheckpoint): CheckpointSummary {
  return {
    id: checkpoint.id,
    repoRoot: checkpoint.repoRoot,
    name: checkpoint.name,
    createdAt: checkpoint.createdAt,
    files: checkpoint.files.map((file) => ({
      path: file.path,
      exists: file.exists,
    })),
    source: checkpoint.source,
    sessionId: checkpoint.sessionId,
    nodeId: checkpoint.nodeId,
  };
}

async function createGitCheckpoint(
  root: string,
  name?: string,
  metadata: Pick<GitCheckpoint, "source" | "sessionId" | "nodeId"> = {},
): Promise<GitCheckpoint> {
  const changedFiles = await getGitChangedFiles(root);
  const files: GitCheckpointFile[] = [];

  for (const changedFile of changedFiles) {
    const { absPath, relPath } = resolveGitFile(root, changedFile.path);
    const exists = existsSync(absPath);
    if (!exists) {
      files.push({ path: relPath, exists: false });
      continue;
    }

    const stat = statSync(absPath);
    if (!stat.isFile()) {
      files.push({ path: relPath, exists: false });
      continue;
    }

    files.push({
      path: relPath,
      exists: true,
      contentBase64: readFileSync(absPath).toString("base64"),
    });
  }

  const checkpoint: GitCheckpoint = {
    id: `checkpoint-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    repoRoot: root,
    name: name?.trim().slice(0, 80) || `Checkpoint ${new Date().toLocaleString()}`,
    createdAt: Date.now(),
    files,
    ...metadata,
  };

  const existing = loadCheckpoints();
  const rest = existing.filter((item) => item.repoRoot !== root);
  const repoCheckpoints = existing.filter((item) => item.repoRoot === root).slice(0, 19);
  saveCheckpoints([checkpoint, ...repoCheckpoints, ...rest]);
  return checkpoint;
}

async function restoreGitCheckpoint(root: string, checkpointId: string): Promise<GitCheckpoint> {
  const checkpoint = loadCheckpoints().find((item) => item.id === checkpointId && item.repoRoot === root);
  if (!checkpoint) {
    throw new Error("Checkpoint not found for this repository");
  }

  const baselinePaths = new Set(checkpoint.files.map((file) => file.path));
  const currentFiles = await getGitChangedFiles(root);

  for (const currentFile of currentFiles) {
    if (!baselinePaths.has(currentFile.path)) {
      await discardGitFile(root, currentFile.path);
    }
  }

  for (const file of checkpoint.files) {
    const { absPath, relPath } = resolveGitFile(root, file.path);
    await execGitAsync("git", ["reset", "HEAD", "--", relPath], {
      cwd: root,
      maxBuffer: GIT_MAX_BUFFER,
    }).catch(() => undefined);

    if (!file.exists) {
      rmSync(absPath, { force: true, recursive: true });
      continue;
    }

    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, Buffer.from(file.contentBase64 || "", "base64"));
  }

  return checkpoint;
}

apiRoutes.get("/checkpoints", async (c) => {
  const queryPath = c.req.query("path") || getLaunchCwd();
  const cwd = expandPath(queryPath);
  if (!existsSync(cwd)) {
    return c.json({ error: "Path not found", path: cwd }, 404);
  }

  const root = await gitRoot(cwd);
  if (!root) {
    return c.json({ error: "Not a git repository", path: cwd }, 400);
  }

  const checkpoints = loadCheckpoints()
    .filter((checkpoint) => checkpoint.repoRoot === root)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(summarizeCheckpoint);

  return c.json({ root, checkpoints });
});

apiRoutes.post("/checkpoints", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const repoQuery = body.path as string | undefined;
  const name = body.name as string | undefined;

  if (!repoQuery) {
    return c.json({ error: "path (repo) is required" }, 400);
  }

  const root = await gitRoot(expandPath(repoQuery));
  if (!root) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  try {
    const checkpoint = await createGitCheckpoint(root, name);
    return c.json({ root, checkpoint: summarizeCheckpoint(checkpoint) });
  } catch (e: any) {
    logError(`[PRBE_ERROR_checkpointCreate] [api] checkpoint create failed (repo=${root}): ${e.message}`);
    return c.json({ error: e.message || "Failed to create checkpoint" }, 500);
  }
});

apiRoutes.post("/checkpoints/:checkpointId/restore", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const repoQuery = body.path as string | undefined;
  const checkpointId = c.req.param("checkpointId");

  if (!repoQuery) {
    return c.json({ error: "path (repo) is required" }, 400);
  }

  const root = await gitRoot(expandPath(repoQuery));
  if (!root) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  try {
    const checkpoint = await restoreGitCheckpoint(root, checkpointId);
    return c.json({ ok: true, root, checkpoint: summarizeCheckpoint(checkpoint) });
  } catch (e: any) {
    logError(`[PRBE_ERROR_checkpointRestore] [api] checkpoint restore failed (repo=${root}, checkpoint=${checkpointId}): ${e.message}`);
    return c.json({ error: e.message || "Failed to restore checkpoint" }, 500);
  }
});

apiRoutes.delete("/checkpoints/:checkpointId", async (c) => {
  const repoQuery = c.req.query("path");
  const checkpointId = c.req.param("checkpointId");

  if (!repoQuery) {
    return c.json({ error: "path (repo) is required" }, 400);
  }

  const root = await gitRoot(expandPath(repoQuery));
  if (!root) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  const before = loadCheckpoints();
  const after = before.filter((checkpoint) => !(checkpoint.id === checkpointId && checkpoint.repoRoot === root));
  saveCheckpoints(after);
  return c.json({ ok: true, root, deleted: before.length !== after.length });
});

// List changed files in the working tree (unstaged + staged + untracked),
// each annotated with a status letter and added/removed line counts.
apiRoutes.get("/diff/files", async (c) => {
  const queryPath = c.req.query("path") || getLaunchCwd();
  const cwd = expandPath(queryPath);

  if (!existsSync(cwd)) {
    return c.json({ error: "Path not found", path: cwd }, 404);
  }

  const root = await gitRoot(cwd);
  if (!root) {
    return c.json({ error: "Not a git repository", path: cwd }, 400);
  }

  try {
    // Current branch (best-effort).
    let branch = "";
    try {
      const r = await execFileAsync("git rev-parse --abbrev-ref HEAD", { cwd: root });
      branch = r.stdout.trim();
    } catch {
      // detached HEAD or empty repo
    }

    const files = await getGitChangedFiles(root);
    return c.json({ root, branch, files });
  } catch (e: any) {
    logError(`[PRBE_ERROR_diffLs] [api] git diff files failed (cwd=${root}): ${e.message}`);
    return c.json({ error: e.message || "git diff failed" }, 500);
  }
});

apiRoutes.get("/diff/summary", async (c) => {
  const queryPath = c.req.query("path") || getLaunchCwd();
  const cwd = expandPath(queryPath);

  if (!existsSync(cwd)) {
    return c.json({ error: "Path not found", path: cwd }, 404);
  }

  const root = await gitRoot(cwd);
  if (!root) {
    return c.json({ error: "Not a git repository", path: cwd }, 400);
  }

  try {
    const files = await getGitChangedFiles(root);
    return c.json({ root, files, ...buildCommitMessage(files) });
  } catch (e: any) {
    logError(`[PRBE_ERROR_diffSummary] [api] git diff summary failed (cwd=${root}): ${e.message}`);
    return c.json({ error: e.message || "git diff summary failed" }, 500);
  }
});

// Unified diff for a single file. Untracked files are shown as all-added
// (diff against /dev/null) so new files render in the viewer too.
apiRoutes.get("/diff/file", async (c) => {
  const repoQuery = c.req.query("path");
  const fileQuery = c.req.query("file");
  if (!repoQuery || !fileQuery) {
    return c.json({ error: "path (repo) and file are required" }, 400);
  }

  const root = await gitRoot(expandPath(repoQuery));
  if (!root) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  const untracked = c.req.query("untracked") === "1";

  try {
    const { relPath: file } = resolveGitFile(root, fileQuery);
    let diff: string;
    if (untracked) {
      // New file — diff against the empty tree so the whole file shows as added.
      const r = await execGitAsync(
        "git",
        ["diff", "--no-color", "--no-index", "--", "/dev/null", file],
        { cwd: root, maxBuffer: GIT_MAX_BUFFER },
      ).catch((err: any) => {
        // --no-index exits 1 when files differ; that's expected, stdout still holds the diff.
        if (err.stdout) return { stdout: err.stdout as string };
        throw err;
      });
      diff = r.stdout;
    } else {
      const r = await execGitAsync(
        "git",
        ["diff", "--no-color", "HEAD", "--", file],
        { cwd: root, maxBuffer: GIT_MAX_BUFFER },
      );
      diff = r.stdout;
    }
    return c.json({ file, diff });
  } catch (e: any) {
    logError(`[PRBE_ERROR_diffFl] [api] git diff file failed (file=${fileQuery}): ${e.message}`);
    return c.json({ error: e.message || "git diff failed" }, 500);
  }
});

apiRoutes.post("/diff/discard", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const repoQuery = body.path as string | undefined;
  const file = body.file as string | undefined;
  const scope = body.scope === "all" ? "all" : "file";

  if (!repoQuery) {
    return c.json({ error: "path (repo) is required" }, 400);
  }
  if (scope === "file" && !file) {
    return c.json({ error: "file is required when scope is file" }, 400);
  }

  const root = await gitRoot(expandPath(repoQuery));
  if (!root) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  try {
    if (scope === "all") {
      const hasHead = await gitHasHead(root);
      if (hasHead) {
        await execGitAsync("git", ["reset", "--hard", "HEAD"], {
          cwd: root,
          maxBuffer: GIT_MAX_BUFFER,
        });
      }
      await execGitAsync("git", ["clean", "-fd"], {
        cwd: root,
        maxBuffer: GIT_MAX_BUFFER,
      });
      return c.json({ ok: true, root, scope });
    }

    await discardGitFile(root, file!);
    return c.json({ ok: true, root, scope, file });
  } catch (e: any) {
    logError(`[PRBE_ERROR_diffDiscard] [api] git discard failed (repo=${root}, file=${file || "*"}): ${e.message}`);
    return c.json({ error: e.message || "Failed to discard changes" }, 500);
  }
});

apiRoutes.post("/diff/discard-hunk", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const repoQuery = body.path as string | undefined;
  const file = body.file as string | undefined;
  const hunkIndex = Number(body.hunkIndex);

  if (!repoQuery) {
    return c.json({ error: "path (repo) is required" }, 400);
  }
  if (!file) {
    return c.json({ error: "file is required" }, 400);
  }
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0) {
    return c.json({ error: "hunkIndex must be a non-negative integer" }, 400);
  }

  const root = await gitRoot(expandPath(repoQuery));
  if (!root) {
    return c.json({ error: "Not a git repository" }, 400);
  }

  try {
    await discardGitHunk(root, file, hunkIndex);
    return c.json({ ok: true, root, file, hunkIndex });
  } catch (e: any) {
    logError(`[PRBE_ERROR_diffDiscardHunk] [api] git hunk discard failed (repo=${root}, file=${file}, hunk=${hunkIndex}): ${e.message}`);
    return c.json({ error: e.message || "Failed to reject hunk" }, 500);
  }
});

apiRoutes.get("/agents", (c) => {
  const agents: Agent[] = [
    {
      id: "claude",
      name: "Claude Code",
      command: "claude",
      description: "Anthropic's official CLI for Claude",
      color: "#D97757",
      icon: "claude",
    },
    {
      id: "codex",
      name: "Codex",
      command: "codex",
      description: "OpenAI's coding agent CLI",
      color: "#7A9DFF",
      icon: "codex",
    },
  ];
  return c.json(agents);
});

apiRoutes.get("/sessions", (c) => {
  const sessionList = Array.from(sessions.entries()).filter(([, session]) => !session.pendingDelete).map(([id, session]) => ({
    sessionId: id,
    nodeId: session.nodeId,
    agentId: session.agentId,
    agentName: session.agentName,
    command: session.command,
    createdAt: session.createdAt,
    lastActivityAt: Math.max(
      session.lastInputTime || 0,
      session.lastOutputTime || 0,
      Date.parse(session.createdAt) || 0,
    ),
    cwd: session.cwd,
    originalCwd: session.originalCwd,
    gitBranch: session.gitBranch,
    status: session.status,
    customName: session.customName,
    customColor: session.customColor,
    notes: session.notes,
    isRestored: session.isRestored,
    ticketId: session.ticketId,
    ticketTitle: session.ticketTitle,
    worktreePaths: session.worktreePaths,
    launchCheckpoint: session.launchCheckpoint,
  }));
  return c.json(sessionList);
});

apiRoutes.get("/sessions/:sessionId/messages", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  c.header("Cache-Control", "no-store");

  if (!session || session.pendingDelete) {
    return c.json({ error: "Session not found" }, 404);
  }

  const agentId = session.agentId.toLowerCase();
  const waitingForFirstTranscript = () => {
    const startupPrompt = detectStartupPrompt(session);
    const promptReady = isAgentInputPromptReady(session) || Boolean(startupPrompt);
    if (!session.pty || session.isRestored || !promptReady) {
      return c.json({ available: false, state: "connecting", messages: [] });
    }

    const permissionMode = /--yolo|dangerously-skip-permissions/i.test(session.command)
      ? "Full access"
      : undefined;
    return c.json({
      available: true,
      state: "ready",
      messages: [{
        id: `startup-${sessionId}`,
        role: "system",
        startup: {
          agentName: session.agentName,
          cwd: session.cwd,
          permissionMode,
          notices: [],
        },
        timestamp: session.createdAt,
      }],
      startupPrompt,
      working: false,
    });
  };

  if (agentId.includes("codex")) {
    if (!session.codexSessionId) {
      const recoveredId = recoverCodexTranscriptId(session);
      if (recoveredId) {
        session.codexSessionId = recoveredId;
        saveState(sessions);
        log(`[session-chat] Recovered Codex transcript ${recoveredId} for ${sessionId}`);
      } else {
        return waitingForFirstTranscript();
      }
    }

    const transcriptFile = findCodexTranscriptFile(session.codexSessionId);
    if (!transcriptFile) {
      return waitingForFirstTranscript();
    }

    try {
      const transcriptStat = statSync(transcriptFile);
      const parsed = parseCodexConversation(readTranscriptWindow(transcriptFile));
      return c.json({
        available: true,
        state: "ready",
        codexSessionId: session.codexSessionId,
        messages: parsed.messages,
        working: parsed.working,
        updatedAt: transcriptStat.mtimeMs,
      });
    } catch (error: any) {
      logError(`[PRBE_ERROR_sessionMessages] [api] failed to read Codex messages (session=${sessionId}): ${error.message}`);
      return c.json({ available: false, state: "unavailable", messages: [] });
    }
  }

  if (!agentId.includes("claude")) {
    return c.json({ available: false, state: "unsupported", messages: [] });
  }

  if (!session.claudeSessionId) {
    const recoveredId = recoverClaudeTranscriptId(session);
    if (recoveredId) {
      session.claudeSessionId = recoveredId;
      saveState(sessions);
      log(`[session-chat] Recovered Claude transcript ${recoveredId} for ${sessionId}`);
    } else {
      return waitingForFirstTranscript();
    }
  }

  const transcriptFile = findClaudeTranscriptFile(session.claudeSessionId);
  if (!transcriptFile) {
    return waitingForFirstTranscript();
  }

  try {
    const transcriptStat = statSync(transcriptFile);
    const messages = parseClaudeConversation(readTranscriptWindow(transcriptFile));
    return c.json({
      available: true,
      state: "ready",
      claudeSessionId: session.claudeSessionId,
      messages,
      updatedAt: transcriptStat.mtimeMs,
    });
  } catch (error: any) {
    logError(`[PRBE_ERROR_sessionMessages] [api] failed to read Claude messages (session=${sessionId}): ${error.message}`);
    return c.json({ available: false, state: "unavailable", messages: [] });
  }
});

apiRoutes.get("/sessions/changes", async (c) => {
  const rootSummaries = new Map<string, Promise<Omit<AgentChangeSummary, "sessionId" | "nodeId">>>();

  const getRootSummary = (root: string) => {
    const existing = rootSummaries.get(root);
    if (existing) return existing;

    const summaryPromise = getGitChangedFiles(root).then((files) => {
      const commitSummary = buildCommitMessage(files);
      return {
        repoRoot: root,
        changedFileCount: files.length,
        added: files.reduce((total, file) => total + file.added, 0),
        removed: files.reduce((total, file) => total + file.removed, 0),
        summary: commitSummary.summary,
        files: files.slice(0, 12).map((file) => ({
          path: file.path,
          status: file.status,
          added: file.added,
          removed: file.removed,
          untracked: file.untracked,
        })),
      };
    });

    rootSummaries.set(root, summaryPromise);
    return summaryPromise;
  };

  const summaries: AgentChangeSummary[] = [];
  for (const [sessionId, session] of sessions) {
    if (session.pendingDelete || !session.cwd || !existsSync(session.cwd)) continue;
    const root = await gitRoot(session.cwd);
    if (!root) continue;
    try {
      const rootSummary = await getRootSummary(root);
      summaries.push({
        sessionId,
        nodeId: session.nodeId,
        ...rootSummary,
      });
    } catch (e: any) {
      logError(`[PRBE_ERROR_sessionChanges] [api] session changes failed (session=${sessionId}, cwd=${session.cwd}): ${e.message}`);
    }
  }

  return c.json({ summaries });
});

apiRoutes.post("/layout/title-clusters", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const nodeInputs = Array.isArray(body.nodes) ? body.nodes : [];

  const items: TitleSortInput[] = nodeInputs
    .map((node: any): TitleSortInput | null => {
      const nodeId = typeof node?.id === "string" ? node.id : "";
      const session = nodeId ? Array.from(sessions.values()).find((item) => item.nodeId === nodeId) : null;
      if (!nodeId || !session || session.pendingDelete) return null;
      const label = typeof node?.label === "string" ? node.label.trim() : "";
      return {
        nodeId,
        title:
          session.customName ||
          session.ticketTitle ||
          (label && label !== session.agentName && label !== session.agentId ? label : "") ||
          session.agentName,
        agentName: session.agentName,
        status: session.status,
        repo: session.originalCwd || session.cwd,
        branch: session.gitBranch,
        ticketTitle: session.ticketTitle,
        promptHistory: session.titlePromptHistory?.slice(-5),
        createdAt: session.createdAt,
      };
    })
    .filter((item: TitleSortInput | null): item is TitleSortInput => Boolean(item));

  if (items.length === 0) {
    return c.json({ source: "empty", groups: [] });
  }

  const judgedGroups = await generateTitleSortGroups(items).catch(() => null);
  const validJudgedGroups = validateTitleSortGroups(judgedGroups, items);
  if (validJudgedGroups) {
    return c.json({ source: "gemini", groups: validJudgedGroups });
  }

  return c.json({ source: "fallback", groups: fallbackTitleSortGroups(items) });
});

apiRoutes.get("/sessions/:sessionId/status", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json({ status: session.status, isRestored: session.isRestored });
});

apiRoutes.get("/state", (c) => {
  const state = loadState();
  const nodes = state.nodes.map(node => {
    const session = sessions.get(node.sessionId);
    return {
      ...node,
      status: session?.status || "disconnected",
      isAlive: !!session,
      isRestored: session?.isRestored,
    };
  }).filter(n => n.isAlive);
  return c.json({ nodes });
});

apiRoutes.post("/state/positions", async (c) => {
  const { positions } = await c.req.json();

  for (const [nodeId, pos] of Object.entries(positions)) {
    for (const [, session] of sessions) {
      if (session.nodeId === nodeId) {
        session.position = pos as { x: number; y: number };
        break;
      }
    }
  }

  savePositions(positions);
  return c.json({ success: true });
});

apiRoutes.post("/sessions", async (c) => {
  const body = await c.req.json();
  const {
    agentId, agentName, command, cwd, nodeId, customName, customColor,
    ticketId, ticketTitle, ticketUrl, branchName, baseBranch,
    initialPrompt,
    createWorktree: createWorktreeFlag,
    multiRepoMode,
    additionalRepos,
  } = body;

  const sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const workingDir = cwd || getLaunchCwd();
  const starterTitlePrompt = buildTitlePrompt(initialPrompt);

  const linearConfig = loadConfig();
  const ticketPromptTemplate = linearConfig.ticketPromptTemplate;
  const autoCareful = linearConfig.autoCareful;

  let result;
  let launchCheckpoint: CheckpointSummary | undefined;
  try {
    result = await createSession({
      sessionId, agentId, agentName, command, cwd: workingDir, nodeId,
      customName, customColor, ticketId, ticketTitle, ticketUrl,
      branchName, baseBranch, createWorktreeFlag, ticketPromptTemplate,
      initialPrompt: buildInitialPrompt(initialPrompt),
      autoCareful, multiRepoMode, additionalRepos,
      beforeStart: async (finalCwd) => {
        try {
          const root = await gitRoot(finalCwd).catch(() => null);
          if (!root) return;
          const checkpoint = await createGitCheckpoint(
            root,
            `Before ${customName || agentName} session`,
            { source: "session-launch", sessionId, nodeId },
          );
          launchCheckpoint = summarizeCheckpoint(checkpoint);
        } catch (checkpointError: any) {
          logError(`[PRBE_ERROR_launchCheckpoint] [api] launch checkpoint failed (session=${sessionId}): ${checkpointError.message}`);
        }
      },
    });

    if (launchCheckpoint) {
      result.session.launchCheckpoint = launchCheckpoint;
    }
  } catch (e: any) {
    // Probe Agent Error Log Trigger
    logError(`[PRBE_ERROR_acHsml] [api] Failed to create session: ${e.message}`);
    return c.json({ error: e.message }, 500);
  }

  saveState(sessions);
  if (starterTitlePrompt) {
    scheduleSessionTitleGeneration(sessionId, starterTitlePrompt);
  }
  return c.json({
    sessionId, nodeId,
    cwd: result.cwd,
    gitBranch: result.gitBranch,
    launchCheckpoint,
  });
});

apiRoutes.post("/sessions/:sessionId/restart", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  if (session.pty) return c.json({ error: "Session already running" }, 400);

  const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/zsh";
  const cwd = existsSync(session.cwd) ? session.cwd : homedir();

  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(shell, ["--login"], {
      name: "xterm-256color",
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        OPENUI_SESSION_ID: sessionId,
        OPENUI_PORT: String(getServerPort()),
      } as Record<string, string>,
      cols: DEFAULT_PTY_COLS,
      rows: DEFAULT_PTY_ROWS,
    });
  } catch (e: any) {
    // Probe Agent Error Log Trigger
    logError(`[PRBE_ERROR_4hw6OQ] [session] Failed to restart PTY (shell=${shell}, cwd=${cwd}): ${e.message}`);
    return c.json({ error: `Failed to spawn terminal: ${e.message}` }, 500);
  }

  session.pty = ptyProcess;
  session.isRestored = false;
  session.status = "running";
  session.lastOutputTime = Date.now();

  const resetInterval = setInterval(() => {
    if (!sessions.has(sessionId) || !session.pty) {
      clearInterval(resetInterval);
      return;
    }
    session.recentOutputSize = Math.max(0, session.recentOutputSize - 50);
  }, 500);

  // Reset plugin status tracking for fresh session
  session.pluginReportedStatus = false;

  // PTY exit handler for restarted sessions
  ptyProcess.onExit(({ exitCode, signal }) => {
    log(`[session] Restarted PTY exited for ${sessionId} (code=${exitCode}, signal=${signal})`);
    session.status = "disconnected";
    session.pty = null;

    for (const client of session.clients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "exit", exitCode, signal }));
      }
    }
  });

  ptyProcess.onData((data: string) => {
    session.outputBuffer.push(data);
    if (session.outputBuffer.length > 1000) {
      session.outputBuffer.shift();
    }

    session.lastOutputTime = Date.now();
    session.recentOutputSize += data.length;

    // Auto-detect running status from PTY output when plugin hasn't reported yet
    if (session.status === "idle" && !session.pluginReportedStatus) {
      session.status = "running";
      for (const client of session.clients) {
        if (client.readyState === 1) {
          client.send(JSON.stringify({
            type: "status",
            status: "running",
            isRestored: session.isRestored,
          }));
        }
      }
    }

    for (const client of session.clients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "output", data }));
      }
    }
  });

  const finalCommand = injectPluginDir(session.command, session.agentId);
  setTimeout(() => {
    ptyProcess.write(`${finalCommand}\r`);
  }, 300);

  log(`[session] Restarted ${sessionId}`);
  return c.json({ success: true });
});

apiRoutes.patch("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const updates = await c.req.json();
  if (updates.customName !== undefined) {
    session.customName = updates.customName;
    if (!updates.customName) {
      session.generatedTitle = undefined;
      session.nameGenerated = false;
    }
  }
  if (updates.customColor !== undefined) session.customColor = updates.customColor;
  if (updates.notes !== undefined) session.notes = updates.notes;

  saveState(sessions);
  return c.json({ success: true });
});

apiRoutes.delete("/sessions/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  const success = deleteSession(sessionId);

  if (success) {
    saveState(sessions);
    return c.json({ success: true });
  }
  return c.json({ error: "Session not found" }, 404);
});

// Soft delete - marks session for deletion, actual delete after timeout
apiRoutes.post("/sessions/:sessionId/soft-delete", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  session.pendingDelete = true;

  if (session.deleteTimeout) {
    clearTimeout(session.deleteTimeout);
  }

  session.deleteTimeout = setTimeout(() => {
    const s = sessions.get(sessionId);
    if (s && s.pendingDelete) {
      if (s.pty) s.pty.kill();
      if (s.stateTrackerPty) s.stateTrackerPty.kill();
      sessions.delete(sessionId);
      saveState(sessions);
      log(`[session] Hard-deleted ${sessionId} after timeout`);
    }
  }, 5000);

  saveState(sessions);
  return c.json({ success: true });
});

// Undo soft delete - restores a pending-delete session
apiRoutes.post("/sessions/:sessionId/undo-delete", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  if (session.deleteTimeout) {
    clearTimeout(session.deleteTimeout);
    session.deleteTimeout = undefined;
  }
  session.pendingDelete = false;

  saveState(sessions);
  log(`[session] Restored ${sessionId} from soft-delete`);
  return c.json({ success: true });
});

// Status update endpoint for Claude Code plugin
apiRoutes.post("/status-update", async (c) => {
  const body = await c.req.json();
  const { status, openuiSessionId, claudeSessionId, hookEvent, toolName } = body;
  const userPrompt = typeof body.userPrompt === "string" ? body.userPrompt.trim() : "";

  log(`[plugin-hook] ${hookEvent || "unknown"}: status=${status} tool=${toolName || "none"} openui=${openuiSessionId || "none"}`);

  if (!status) {
    return c.json({ error: "status is required" }, 400);
  }

  let session = null;
  let matchedSessionId = typeof openuiSessionId === "string" ? openuiSessionId : "";

  if (openuiSessionId) {
    session = sessions.get(openuiSessionId);
  }

  if (!session && claudeSessionId) {
    for (const [id, s] of sessions) {
      if (s.claudeSessionId === claudeSessionId) {
        session = s;
        matchedSessionId = id;
        break;
      }
    }
  }

  if (session) {
    if (claudeSessionId && !session.claudeSessionId) {
      session.claudeSessionId = claudeSessionId;
    }

    if (userPrompt && matchedSessionId) {
      scheduleSessionTitleGeneration(matchedSessionId, userPrompt);
    }

    let effectiveStatus = status;

    if (status === "pre_tool") {
      effectiveStatus = "running";
      session.currentTool = toolName;
      session.preToolTime = Date.now();

      if (session.permissionTimeout) {
        clearTimeout(session.permissionTimeout);
      }

      session.permissionTimeout = setTimeout(() => {
        // Only force waiting_input if we're still in a state where it makes sense
        // (pre_tool was set and status hasn't already moved past it)
        if (session!.preToolTime && (session!.status === "running" || session!.status === "tool_calling")) {
          session!.status = "waiting_input";
          for (const client of session!.clients) {
            if (client.readyState === 1) {
              client.send(JSON.stringify({
                type: "status",
                status: "waiting_input",
                isRestored: session!.isRestored,
                currentTool: session!.currentTool,
                hookEvent: "permission_timeout",
              }));
            }
          }
        }
      }, 3500); // Increased from 2.5s to 3.5s — gives tools more time before flagging as stuck
    } else if (status === "post_tool") {
      effectiveStatus = "running";
      session.preToolTime = undefined;
      if (session.permissionTimeout) {
        clearTimeout(session.permissionTimeout);
        session.permissionTimeout = undefined;
      }
    } else {
      if (status !== "tool_calling" && status !== "running") {
        session.currentTool = undefined;
      }
      session.preToolTime = undefined;
      if (session.permissionTimeout) {
        clearTimeout(session.permissionTimeout);
        session.permissionTimeout = undefined;
      }
    }

    session.status = effectiveStatus;
    session.lastPluginStatusTime = Date.now();
    session.lastHookEvent = hookEvent;
    // Keep pluginReportedStatus true while plugin is actively reporting
    // but reset it on terminal states so auto-detect can recover if plugin dies
    if (effectiveStatus === "idle" || effectiveStatus === "disconnected" || effectiveStatus === "error") {
      session.pluginReportedStatus = false;
    } else {
      session.pluginReportedStatus = true;
    }

    for (const client of session.clients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({
          type: "status",
          status: session.status,
          isRestored: session.isRestored,
          currentTool: session.currentTool,
          hookEvent,
        }));
      }
    }

    return c.json({ success: true });
  }

  return c.json({ success: true, warning: "No matching session found" });
});

// Image upload endpoint - saves image to temp dir and returns the path
apiRoutes.post("/sessions/:sessionId/upload-image", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.parseBody();
  const file = body["image"];

  if (!file || !(file instanceof File)) {
    return c.json({ error: "No image file provided" }, 400);
  }

  const allowedTypes = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"];
  if (!allowedTypes.includes(file.type)) {
    return c.json({ error: "Unsupported image type" }, 400);
  }

  // Save to a session-specific temp directory
  const uploadDir = join(tmpdir(), "openui-uploads", sessionId);
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true });
  }

  const ext = file.name.split(".").pop() || "png";
  const safeName = `image-${Date.now()}.${ext}`;
  const filePath = join(uploadDir, safeName);

  const arrayBuffer = await file.arrayBuffer();
  writeFileSync(filePath, Buffer.from(arrayBuffer));

  log(`[upload] Saved image for ${sessionId}: ${filePath}`);
  return c.json({ success: true, filePath });
});

// General file upload — saves any file type into the session's cwd under
// .openui-uploads/, then types the resulting paths into the PTY so the agent
// can reference them. Accepts one or more files under the field name "files".
const UPLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50MB per file
const UPLOAD_MAX_FILES = 20;
const UPLOAD_BLOCKED_EXTS = new Set(["exe", "dmg", "app", "pkg", "msi"]);

function quoteUploadPath(path: string): string {
  if (/^[A-Za-z0-9_\-./~@+:=]+$/.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

apiRoutes.post("/sessions/:sessionId/upload", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.parseBody({ all: true });
  const raw = body["files"];
  const files: File[] = Array.isArray(raw)
    ? raw.filter((f): f is File => f instanceof File)
    : raw instanceof File
      ? [raw]
      : [];

  if (files.length === 0) {
    return c.json({ error: "No files provided" }, 400);
  }
  if (files.length > UPLOAD_MAX_FILES) {
    return c.json({ error: `Too many files (max ${UPLOAD_MAX_FILES})` }, 400);
  }

  const uploadDir = join(session.cwd, ".openui-uploads");
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true });
  }

  const saved: string[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const file of files) {
    if (file.size > UPLOAD_MAX_BYTES) {
      skipped.push({ name: file.name, reason: "too large (>50MB)" });
      continue;
    }

    const rawName = file.name || `file-${Date.now()}`;
    const ext = rawName.includes(".") ? rawName.split(".").pop()!.toLowerCase() : "";
    if (ext && UPLOAD_BLOCKED_EXTS.has(ext)) {
      skipped.push({ name: rawName, reason: `blocked type (.${ext})` });
      continue;
    }

    // Sanitize: strip path components and collapse anything that isn't safe.
    // Collision-proof by prefixing a short timestamp.
    const basename = rawName.replace(/^.*[\\/]/, "").replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
    const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${basename}`;
    const filePath = join(uploadDir, safeName);

    try {
      const arrayBuffer = await file.arrayBuffer();
      writeFileSync(filePath, Buffer.from(arrayBuffer));
      saved.push(filePath);
    } catch (e: any) {
      skipped.push({ name: rawName, reason: e.message || "write failed" });
    }
  }

  // Inject the saved paths into the PTY so the agent sees them as an attachment.
  // No trailing Enter — the user types their question and submits themselves.
  if (saved.length > 0 && session.pty) {
    const injection = saved.map((p) => `${quoteUploadPath(p)} `).join("");
    session.pty.write(injection);
    session.lastInputTime = Date.now();
  }

  log(`[upload] Saved ${saved.length}/${files.length} files for ${sessionId} in ${uploadDir}`);
  return c.json({
    success: saved.length > 0,
    saved,
    skipped,
    uploadDir,
  });
});

// Categories
apiRoutes.get("/categories", (c) => {
  const state = loadState();
  return c.json(state.categories || []);
});

apiRoutes.post("/categories", async (c) => {
  const state = loadState();
  const category = await c.req.json();

  if (!state.categories) state.categories = [];
  state.categories.push(category);

  writeFileSync(join(getDataDir(), "state.json"), JSON.stringify(state, null, 2));

  return c.json({ success: true });
});

apiRoutes.patch("/categories/:categoryId", async (c) => {
  const categoryId = c.req.param("categoryId");
  const updates = await c.req.json();
  const state = loadState();

  if (!state.categories) return c.json({ error: "Category not found" }, 404);

  const category = state.categories.find(cat => cat.id === categoryId);
  if (!category) return c.json({ error: "Category not found" }, 404);

  Object.assign(category, updates);

  writeFileSync(join(getDataDir(), "state.json"), JSON.stringify(state, null, 2));

  return c.json({ success: true });
});

apiRoutes.delete("/categories/:categoryId", (c) => {
  const categoryId = c.req.param("categoryId");
  const state = loadState();

  if (!state.categories) return c.json({ error: "Category not found" }, 404);

  const index = state.categories.findIndex(cat => cat.id === categoryId);
  if (index === -1) return c.json({ error: "Category not found" }, 404);

  state.categories.splice(index, 1);

  writeFileSync(join(getDataDir(), "state.json"), JSON.stringify(state, null, 2));

  return c.json({ success: true });
});

// ============ Linear Integration ============

const DEFAULT_TICKET_PROMPT = "Here is the ticket for this session: {{url}}\n\nPlease use the Linear MCP tool or fetch the URL to read the full ticket details before starting work.";

apiRoutes.get("/linear/config", (c) => {
  const config = loadConfig();
  return c.json({
    hasApiKey: !!config.apiKey,
    defaultTeamId: config.defaultTeamId,
    defaultBaseBranch: config.defaultBaseBranch || "main",
    createWorktree: config.createWorktree ?? true,
    autoCareful: config.autoCareful ?? true,
    ticketPromptTemplate: config.ticketPromptTemplate || DEFAULT_TICKET_PROMPT,
  });
});

apiRoutes.post("/linear/config", async (c) => {
  const body = await c.req.json();
  const config = loadConfig();

  if (body.apiKey !== undefined) config.apiKey = body.apiKey;
  if (body.defaultTeamId !== undefined) config.defaultTeamId = body.defaultTeamId;
  if (body.defaultBaseBranch !== undefined) config.defaultBaseBranch = body.defaultBaseBranch;
  if (body.createWorktree !== undefined) config.createWorktree = body.createWorktree;
  if (body.autoCareful !== undefined) config.autoCareful = body.autoCareful;
  if (body.ticketPromptTemplate !== undefined) config.ticketPromptTemplate = body.ticketPromptTemplate;

  saveConfig(config);
  return c.json({ success: true });
});

apiRoutes.post("/linear/validate", async (c) => {
  const { apiKey } = await c.req.json();
  if (!apiKey) return c.json({ valid: false, error: "No API key provided" });

  try {
    const valid = await validateApiKey(apiKey);
    if (valid) {
      const user = await getCurrentUser(apiKey);
      return c.json({ valid: true, user });
    }
    return c.json({ valid: false, error: "Invalid API key" });
  } catch (e: any) {
    return c.json({ valid: false, error: e.message });
  }
});

apiRoutes.get("/linear/teams", async (c) => {
  const config = loadConfig();
  if (!config.apiKey) return c.json({ error: "Linear not configured" }, 400);

  try {
    const teams = await fetchTeams(config.apiKey);
    return c.json(teams);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

apiRoutes.get("/linear/tickets", async (c) => {
  const config = loadConfig();
  if (!config.apiKey) return c.json({ error: "Linear not configured" }, 400);

  const teamId = c.req.query("teamId") || config.defaultTeamId;

  try {
    const tickets = await fetchMyTickets(config.apiKey, teamId);
    return c.json(tickets);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

apiRoutes.get("/linear/search", async (c) => {
  const config = loadConfig();
  if (!config.apiKey) return c.json({ error: "Linear not configured" }, 400);

  const query = c.req.query("q");
  if (!query) return c.json({ error: "Search query required" }, 400);

  const teamId = c.req.query("teamId") || config.defaultTeamId;

  try {
    const tickets = await searchTickets(config.apiKey, query, teamId);
    return c.json(tickets);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

apiRoutes.get("/linear/ticket/:identifier", async (c) => {
  const config = loadConfig();
  if (!config.apiKey) return c.json({ error: "Linear not configured" }, 400);

  const identifier = c.req.param("identifier");

  try {
    const ticket = await fetchTicketByIdentifier(config.apiKey, identifier);
    if (!ticket) return c.json({ error: "Ticket not found" }, 404);
    return c.json(ticket);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ============ GitHub Integration ============

apiRoutes.get("/github/issues", async (c) => {
  const owner = c.req.query("owner");
  const repo = c.req.query("repo");
  const repoUrl = c.req.query("repoUrl");

  let resolvedOwner = owner;
  let resolvedRepo = repo;

  if (repoUrl && !owner && !repo) {
    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) return c.json({ error: "Invalid GitHub URL" }, 400);
    resolvedOwner = parsed.owner;
    resolvedRepo = parsed.repo;
  }

  if (!resolvedOwner || !resolvedRepo) {
    return c.json({ error: "owner and repo are required (or provide repoUrl)" }, 400);
  }

  try {
    const issues = await fetchGitHubIssues(resolvedOwner, resolvedRepo);
    return c.json(issues);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

apiRoutes.get("/github/search", async (c) => {
  const owner = c.req.query("owner");
  const repo = c.req.query("repo");
  const q = c.req.query("q");

  if (!owner || !repo) return c.json({ error: "owner and repo are required" }, 400);
  if (!q) return c.json({ error: "Search query (q) is required" }, 400);

  try {
    const issues = await searchGitHubIssues(owner, repo, q);
    return c.json(issues);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

apiRoutes.get("/github/issue/:owner/:repo/:number", async (c) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const number = parseInt(c.req.param("number"), 10);

  if (isNaN(number)) return c.json({ error: "Invalid issue number" }, 400);

  try {
    const issue = await fetchGitHubIssue(owner, repo, number);
    if (!issue) return c.json({ error: "Issue not found" }, 404);
    return c.json(issue);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
