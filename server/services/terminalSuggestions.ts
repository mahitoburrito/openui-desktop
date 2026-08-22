import { accessSync, constants as fsConstants, existsSync, readdirSync, statSync } from "fs";
import { basename, delimiter, dirname, extname, isAbsolute, relative, resolve, sep } from "path";
import type {
  Session,
  TerminalCommandBlock,
  TerminalShellCapabilities,
  TerminalSuggestion,
  TerminalSuggestionKind,
  TerminalShellCompletionEntry,
  TerminalWorkflow,
} from "../types";
import { sessionDisplayTitle } from "../../shared/sessionTitle";
import {
  getTerminalSignatureSuggestions,
  getTerminalSignatureSuggestionsAsync,
} from "./terminalSignatures";
import { resolveTopLevelAutocdDirectories } from "./terminalArgumentResolvers";
import type {
  TerminalArgumentValueResolver,
  TerminalResolvedArgumentValue,
} from "./terminalArgumentResolvers";
import type { TerminalResourceCommandRunner } from "./terminalResourceResolvers";

const ACTIONS: Array<Omit<TerminalSuggestion, "score">> = [
  { id: "action:new-session", kind: "action", title: "New session", description: "Start another agent or shell session", value: "new-session" },
  { id: "action:search-history", kind: "action", title: "Search command history", description: "Find commands across every OpenUI session", value: "search-history" },
  { id: "action:open-workflows", kind: "action", title: "Manage saved commands", description: "Create, edit, import, or export reusable commands", value: "open-workflows" },
  { id: "action:open-launch-configurations", kind: "action", title: "Open saved layouts", description: "Browse, edit, or launch saved terminal pane layouts", value: "open-launch-configurations" },
  { id: "action:save-launch-configuration", kind: "action", title: "Save launch configuration", description: "Save the current workspace and focus layout", value: "save-launch-configuration" },
  { id: "action:synchronize-current-tab", kind: "action", title: "Synchronize inputs in current tab", description: "Mirror one command across every ready pane in this tab", value: "synchronize-current-tab" },
  { id: "action:synchronize-all-tabs", kind: "action", title: "Synchronize inputs in all tabs", description: "Mirror one command across every ready workspace tab", value: "synchronize-all-tabs" },
  { id: "action:stop-synchronizing", kind: "action", title: "Stop synchronizing inputs", description: "Return every terminal pane to independent input", value: "stop-synchronizing" },
  { id: "action:open-settings", kind: "action", title: "Open settings", description: "Change terminal, appearance, and integration settings", value: "open-settings" },
  { id: "action:toggle-focus", kind: "action", title: "Toggle focus mode", description: "Switch between canvas and focused sessions", value: "toggle-focus" },
];

const PREFIXES: Array<{ prefixes: string[]; kind: TerminalSuggestionKind }> = [
  { prefixes: ["commands:", "command:", "cmd:"], kind: "command" },
  { prefixes: ["variables:", "variable:", "env:", "v:"], kind: "variable" },
  { prefixes: ["saved:", "workflows:", "workflow:", "w:"], kind: "workflow" },
  { prefixes: ["history:", "h:"], kind: "history" },
  { prefixes: ["sessions:", "session:", "s:"], kind: "session" },
  { prefixes: ["files:", "file:", "f:"], kind: "file" },
  { prefixes: ["actions:", "action:", "a:"], kind: "action" },
];

const COMMAND_CACHE_TTL_MS = 5_000;
const MAX_COMMAND_CACHE_ENTRIES = 8;
const MAX_PATH_DIRECTORIES = 64;
const MAX_PATH_DIRECTORY_ENTRIES = 5_000;
const MAX_PATH_COMMANDS = 10_000;
const MAX_ENVIRONMENT_VARIABLES = 2_048;

const POSIX_BUILTINS = [
  "alias", "bg", "cd", "command", "echo", "eval", "exec", "exit", "export", "false",
  "fc", "fg", "getopts", "hash", "history", "jobs", "kill", "printf", "pwd", "read",
  "readonly", "return", "set", "shift", "source", "test", "times", "trap", "true", "type",
  "typeset", "ulimit", "umask", "unalias", "unset", "wait",
] as const;

const SHELL_BUILTINS: Record<string, readonly string[]> = {
  bash: ["bind", "builtin", "caller", "compgen", "complete", "declare", "dirs", "disown", "enable", "help", "let", "local", "logout", "mapfile", "popd", "pushd", "shopt", "suspend"],
  zsh: ["autoload", "bindkey", "disable", "emulate", "functions", "limit", "print", "setopt", "unfunction", "unhash", "unlimit", "unsetopt", "vared", "whence", "zcompile", "zmodload", "zparseopts", "zstyle"],
  fish: ["abbr", "alias", "and", "begin", "bg", "bind", "block", "break", "breakpoint", "builtin", "case", "cd", "command", "contains", "continue", "count", "dirh", "echo", "emit", "end", "eval", "exec", "exit", "fg", "for", "function", "functions", "if", "jobs", "math", "nextd", "not", "or", "prevd", "pwd", "random", "read", "return", "set", "set_color", "source", "status", "string", "switch", "test", "trap", "type", "ulimit", "umask", "wait", "while"],
  pwsh: ["cd", "echo", "exit", "history", "pwd"],
  powershell: ["cd", "echo", "exit", "history", "pwd"],
};

export interface TerminalPathCommand {
  name: string;
  path: string;
  directory: string;
  pathIndex: number;
}

interface CommandScanOptions {
  pathValue: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  pathExt?: string;
  maxDirectories?: number;
  maxEntriesPerDirectory?: number;
  maxCommands?: number;
}

const commandDiscoveryCache = new Map<string, { expiresAt: number; commands: TerminalPathCommand[] }>();

export function scanTerminalPathCommands(options: CommandScanOptions): TerminalPathCommand[] {
  const platform = options.platform || process.platform;
  const separator = platform === "win32" ? ";" : delimiter;
  const maxDirectories = Math.max(1, Math.min(MAX_PATH_DIRECTORIES, options.maxDirectories || MAX_PATH_DIRECTORIES));
  const maxEntries = Math.max(1, Math.min(MAX_PATH_DIRECTORY_ENTRIES, options.maxEntriesPerDirectory || MAX_PATH_DIRECTORY_ENTRIES));
  const maxCommands = Math.max(1, Math.min(MAX_PATH_COMMANDS, options.maxCommands || MAX_PATH_COMMANDS));
  const pathExtensions = new Set(
    (options.pathExt || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const seen = new Set<string>();
  const seenDirectories = new Set<string>();
  const commands: TerminalPathCommand[] = [];
  const cwd = resolve(options.cwd || process.cwd());
  const directories = options.pathValue.split(separator).slice(0, maxDirectories);

  for (const [pathIndex, rawDirectory] of directories.entries()) {
    const directory = rawDirectory
      ? (isAbsolute(rawDirectory) ? resolve(rawDirectory) : resolve(cwd, rawDirectory))
      : cwd;
    const directoryIdentity = platform === "win32" ? directory.toLowerCase() : directory;
    if (seenDirectories.has(directoryIdentity)) continue;
    seenDirectories.add(directoryIdentity);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, maxEntries);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const candidate = resolve(directory, entry.name);
      let name = entry.name;
      if (platform === "win32") {
        const extension = extname(entry.name).toLowerCase();
        if (!pathExtensions.has(extension)) continue;
        name = entry.name.slice(0, -extension.length);
      } else {
        try {
          accessSync(candidate, fsConstants.X_OK);
          if (!statSync(candidate).isFile()) continue;
        } catch {
          continue;
        }
      }
      if (!name) continue;
      const identity = platform === "win32" ? name.toLowerCase() : name;
      if (seen.has(identity)) continue;
      seen.add(identity);
      commands.push({ name, path: candidate, directory, pathIndex });
      if (commands.length >= maxCommands) return commands;
    }
  }
  return commands;
}

export function clearTerminalCommandDiscoveryCache() {
  commandDiscoveryCache.clear();
}

function cachedPathCommands(
  environment: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  cwd: string,
): TerminalPathCommand[] {
  const pathValue = environment.PATH ?? environment.Path ?? "";
  const pathExt = environment.PATHEXT ?? "";
  const key = `${platform}\0${resolve(cwd)}\0${pathValue}\0${pathExt}`;
  const now = Date.now();
  const cached = commandDiscoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.commands;
  const commands = scanTerminalPathCommands({ pathValue, pathExt, platform, cwd });
  commandDiscoveryCache.delete(key);
  commandDiscoveryCache.set(key, { expiresAt: now + COMMAND_CACHE_TTL_MS, commands });
  while (commandDiscoveryCache.size > MAX_COMMAND_CACHE_ENTRIES) {
    const oldest = commandDiscoveryCache.keys().next().value;
    if (oldest === undefined) break;
    commandDiscoveryCache.delete(oldest);
  }
  return commands;
}

function parseQuery(raw: string): { query: string; kind?: TerminalSuggestionKind } {
  const trimmed = raw.trimStart();
  const lower = trimmed.toLowerCase();
  for (const entry of PREFIXES) {
    const prefix = entry.prefixes.find((candidate) => lower.startsWith(candidate));
    if (prefix) return { query: trimmed.slice(prefix.length).trimStart(), kind: entry.kind };
  }
  return { query: trimmed };
}

function fuzzyScore(query: string, ...fields: string[]): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 100;
  let best = -1;
  for (const [fieldIndex, rawField] of fields.entries()) {
    const field = rawField.toLowerCase();
    if (!field) continue;
    let score = -1;
    if (field === needle) score = 1000;
    else if (field.startsWith(needle)) score = 850 - Math.min(200, field.length - needle.length);
    else {
      const index = field.indexOf(needle);
      if (index >= 0) score = 650 - Math.min(300, index * 4);
      else {
        let cursor = 0;
        let gap = 0;
        for (const char of needle) {
          const found = field.indexOf(char, cursor);
          if (found < 0) {
            cursor = -1;
            break;
          }
          gap += found - cursor;
          cursor = found + 1;
        }
        if (cursor >= 0) score = 350 - Math.min(300, gap * 3);
      }
    }
    if (score >= 0) best = Math.max(best, score - fieldIndex * 25);
  }
  return best;
}

function workflowSuggestions(query: string, workflows: TerminalWorkflow[]): TerminalSuggestion[] {
  return workflows.flatMap((workflow) => {
    const score = fuzzyScore(query, workflow.name, workflow.description, workflow.tags.join(" "), workflow.command);
    if (score < 0) return [];
    return [{
      id: workflow.id,
      kind: "workflow" as const,
      title: workflow.name,
      description: workflow.description || workflow.command,
      value: workflow.id,
      score: score + 30,
      metadata: {
        parameterCount: workflow.parameters.length,
        scope: workflow.scope,
      },
    }];
  });
}

function historySuggestions(
  query: string,
  blocks: Array<{ sessionId: string; sessionName: string; block: TerminalCommandBlock }>,
): TerminalSuggestion[] {
  const seen = new Set<string>();
  const suggestions: TerminalSuggestion[] = [];
  for (const { sessionId, sessionName, block } of blocks) {
    if (block.sensitive || seen.has(block.command)) continue;
    const score = fuzzyScore(query, block.command, block.note || "", block.cwd, sessionName);
    if (score < 0) continue;
    seen.add(block.command);
    suggestions.push({
      id: `history:${sessionId}:${block.id}`,
      kind: "history",
      title: block.command,
      description: `${sessionName} · ${block.cwd}`,
      value: block.command,
      score: score + (block.bookmarked ? 80 : 0),
      metadata: {
        sessionId,
        blockId: block.id,
        status: block.status,
        bookmarked: Boolean(block.bookmarked),
      },
    });
  }
  return suggestions;
}

function sessionSuggestions(query: string, sessions: Array<[string, Session]>): TerminalSuggestion[] {
  return sessions.flatMap(([sessionId, session]) => {
    if (session.pendingDelete) return [];
    const title = sessionDisplayTitle(session);
    const score = fuzzyScore(query, title, session.cwd, session.gitBranch || "", session.agentName);
    if (score < 0) return [];
    return [{
      id: `session:${sessionId}`,
      kind: "session" as const,
      title,
      description: `${session.agentName} · ${session.cwd}`,
      value: session.nodeId,
      score,
      metadata: { sessionId, nodeId: session.nodeId, status: session.status },
    }];
  });
}

function actionSuggestions(query: string): TerminalSuggestion[] {
  return ACTIONS.flatMap((action) => {
    const score = fuzzyScore(query, action.title, action.description);
    return score < 0 ? [] : [{ ...action, score }];
  });
}

function shellBuiltinNames(shell: string | undefined): string[] {
  const shellName = basename(shell || "").toLowerCase().replace(/\.exe$/, "");
  const shellSpecific = SHELL_BUILTINS[shellName] || [];
  const posixFamily = ["bash", "zsh", "sh", "dash", "ksh"].includes(shellName);
  return [...new Set([...(posixFamily ? POSIX_BUILTINS : []), ...shellSpecific])]
    .sort((a, b) => a.localeCompare(b));
}

function commandSuggestions(
  query: string,
  cwd: string,
  environment: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  shell: string | undefined,
  shellCompletions: TerminalShellCompletionEntry[],
  shellCapabilities: TerminalShellCapabilities,
  pathCommands?: TerminalPathCommand[],
  disableLocalFilesystem = false,
  autocdDirectories?: TerminalResolvedArgumentValue[],
): TerminalSuggestion[] {
  const fragment = query.trim();
  if (!fragment || /\s/.test(fragment) || fragment.includes("/") || fragment.includes("\\")) return [];
  const seen = new Set<string>();
  const suggestions: TerminalSuggestion[] = [];
  const caseKey = (value: string) => platform === "win32" ? value.toLowerCase() : value;

  const shellKindDescriptions: Record<string, string> = {
    alias: "Shell alias",
    function: "Shell function",
    builtin: "Shell builtin",
    keyword: "Shell keyword",
    abbreviation: "Shell abbreviation",
  };
  for (const entry of shellCompletions) {
    if (entry.kind === "variable") continue;
    const identity = caseKey(entry.name);
    if (seen.has(identity)) continue;
    const score = fuzzyScore(fragment, entry.name);
    if (score < 0) continue;
    seen.add(identity);
    suggestions.push({
      id: `command:shell:${entry.kind}:${entry.name}`,
      kind: "command",
      title: entry.name,
      description: shellKindDescriptions[entry.kind] || "Shell command",
      value: entry.name,
      score: score + 20,
      metadata: { source: "shell", shellKind: entry.kind, shell: basename(shell || "") || undefined },
    });
  }

  for (const name of shellBuiltinNames(shell)) {
    const score = fuzzyScore(fragment, name);
    if (score < 0) continue;
    seen.add(caseKey(name));
    suggestions.push({
      id: `command:builtin:${name}`,
      kind: "command",
      title: name,
      description: "Shell builtin",
      value: name,
      score: score + 10,
      metadata: { source: "builtin", shell: basename(shell || "") || undefined },
    });
  }

  for (const command of pathCommands || cachedPathCommands(environment, platform, cwd)) {
    const identity = caseKey(command.name);
    if (seen.has(identity)) continue;
    const score = fuzzyScore(fragment, command.name);
    if (score < 0) continue;
    seen.add(identity);
    suggestions.push({
      id: `command:path:${command.path}`,
      kind: "command",
      title: command.name,
      description: `Executable · ${command.directory}`,
      value: command.name,
      score,
      metadata: {
        source: "path",
        executablePath: command.path,
        pathIndex: command.pathIndex,
      },
    });
  }
  if (shellCapabilities.autocd && !disableLocalFilesystem) {
    for (const directory of autocdDirectories || resolveTopLevelAutocdDirectories(cwd)) {
      const title = directory.title || directory.value;
      const score = fuzzyScore(fragment, title);
      if (score < 0) continue;
      suggestions.push({
        id: `command:autocd:${directory.description}`,
        kind: "command",
        title,
        description: directory.description,
        value: directory.value,
        // Warp appends autocd directories after every matching command. Keep
        // that provider ordering even when a directory is an exact match and
        // a command is only a fuzzy match.
        score: score - 2_000,
        metadata: {
          source: "autocd",
          absolutePath: directory.description,
          directory: true,
          needsShellQuoting: directory.needsShellQuoting,
        },
      });
    }
  } else if (shellCapabilities.autocd && autocdDirectories) {
    for (const directory of autocdDirectories) {
      const title = directory.title || directory.value;
      const score = fuzzyScore(fragment, title);
      if (score < 0) continue;
      suggestions.push({
        id: `command:autocd:${directory.description}`,
        kind: "command",
        title,
        description: directory.description,
        value: directory.value.replace(/^\.\//, ""),
        score: score - 2_000,
        metadata: {
          source: "autocd",
          absolutePath: directory.description,
          directory: true,
          needsShellQuoting: directory.needsShellQuoting,
        },
      });
    }
  }
  return suggestions;
}

function variableSuggestions(
  query: string,
  environment: Record<string, string | undefined>,
  shellCompletions: TerminalShellCompletionEntry[],
): TerminalSuggestion[] {
  const trimmed = query.trim();
  const braced = trimmed.startsWith("${");
  const fragment = (braced ? trimmed.slice(2) : trimmed.replace(/^\$/, "")).replace(/\}$/, "");
  const sources = new Map<string, "environment" | "shell">();
  for (const name of Object.keys(environment)) sources.set(name, "environment");
  for (const entry of shellCompletions) {
    if (entry.kind === "variable" && !sources.has(entry.name)) sources.set(entry.name, "shell");
  }
  return [...sources.entries()]
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, MAX_ENVIRONMENT_VARIABLES)
    .flatMap(([name, source]) => {
      const score = fuzzyScore(fragment, name);
      if (score < 0) return [];
      const value = braced ? `\${${name}}` : `$${name}`;
      return [{
        id: `variable:${name}`,
        kind: "variable" as const,
        title: value,
        description: source === "shell" ? "Shell variable" : "Environment variable",
        value,
        score,
        metadata: { source, name },
      }];
    });
}

function inferredExclusiveKind(query: string): TerminalSuggestionKind | undefined {
  const token = query.trim();
  if (!token || /\s/.test(token)) return undefined;
  if (token.startsWith("$")) return "variable";
  if (
    token.includes("/") ||
    token.includes("\\") ||
    token.startsWith(".") ||
    token.startsWith("~")
  ) return "file";
  return undefined;
}

function isPlainTopLevelCommandQuery(query: string): boolean {
  const token = query.trim();
  return Boolean(token) && !/\s/.test(token) && !token.startsWith("$") &&
    !token.includes("/") && !token.includes("\\") && !token.startsWith(".") && !token.startsWith("~");
}

function fileSuggestions(
  query: string,
  cwd: string,
  resolvedValues?: TerminalResolvedArgumentValue[],
): TerminalSuggestion[] {
  if (resolvedValues) {
    return resolvedValues.map((value) => ({
      id: `file:${value.description}`,
      kind: "file" as const,
      title: value.title || value.value,
      description: value.description,
      value: value.value,
      score: fuzzyScore(query, value.title || value.value) + (value.value.endsWith("/") ? 15 : 0),
      metadata: {
        absolutePath: value.description,
        directory: value.value.endsWith("/"),
        needsShellQuoting: value.needsShellQuoting,
        source: value.source,
      },
    })).filter((suggestion) => suggestion.score >= 0);
  }
  if (!cwd || !existsSync(cwd)) return [];
  const token = query.split(/\s/).pop() || "";
  const expanded = token.startsWith("~/")
    ? resolve(process.env.HOME || cwd, token.slice(2))
    : isAbsolute(token)
      ? token
      : resolve(cwd, token || ".");
  const directory = token.endsWith("/") || token === "" ? expanded : dirname(expanded);
  const fragment = token.endsWith("/") || token === "" ? "" : basename(expanded).toLowerCase();
  if (!existsSync(directory)) return [];

  try {
    return readdirSync(directory, { withFileTypes: true }).slice(0, 500).flatMap((entry) => {
      if (!fragment.startsWith(".") && entry.name.startsWith(".")) return [];
      const score = fuzzyScore(fragment, entry.name);
      if (score < 0) return [];
      const absolutePath = resolve(directory, entry.name);
      let displayPath = relative(cwd, absolutePath) || entry.name;
      if (!displayPath.startsWith("..") && !isAbsolute(displayPath)) displayPath = `.${sep}${displayPath}`;
      if (entry.isDirectory()) displayPath += sep;
      return [{
        id: `file:${absolutePath}`,
        kind: "file" as const,
        title: entry.name + (entry.isDirectory() ? sep : ""),
        description: absolutePath,
        value: displayPath,
        score: score + (entry.isDirectory() ? 15 : 0),
        metadata: { absolutePath, directory: entry.isDirectory() },
      }];
    });
  } catch {
    return [];
  }
}

export interface TerminalSuggestionsInput {
  query: string;
  cwd: string;
  workflows: TerminalWorkflow[];
  sessions: Array<[string, Session]>;
  blocks: Array<{ sessionId: string; sessionName: string; block: TerminalCommandBlock }>;
  limit: number;
  environment?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  shell?: string;
  shellCompletions?: TerminalShellCompletionEntry[];
  shellCapabilities?: TerminalShellCapabilities;
  resourceRunner?: TerminalResourceCommandRunner;
  resourceTimeoutMs?: number;
  signatureSuggestions?: TerminalSuggestion[];
  pathCommands?: TerminalPathCommand[];
  disableLocalFilesystem?: boolean;
  argumentResolver?: TerminalArgumentValueResolver;
  resolvedFileValues?: TerminalResolvedArgumentValue[];
  resolvedAutocdValues?: TerminalResolvedArgumentValue[];
}

export function getTerminalSuggestions(input: TerminalSuggestionsInput): {
  suggestions: TerminalSuggestion[];
  activeKind?: TerminalSuggestionKind;
  query: string;
} {
  const parsed = parseQuery(input.query);
  const inferredKind = parsed.kind ? undefined : inferredExclusiveKind(parsed.query);
  const exclusiveKind = parsed.kind || inferredKind;
  const kinds = exclusiveKind ? new Set<TerminalSuggestionKind>([exclusiveKind]) : null;
  const include = (kind: TerminalSuggestionKind) => !kinds || kinds.has(kind);
  const environment = input.environment || process.env;
  const platform = input.platform || process.platform;
  const shellCompletions = input.shellCompletions || [];
  const includeCommands = include("command") &&
    (parsed.kind === "command" || (!parsed.kind && isPlainTopLevelCommandQuery(parsed.query)));
  const includeSignatures = include("command") && /\s/.test(parsed.query.trimStart()) &&
    !parsed.query.trimStart().startsWith("$");
  const includeVariables = include("variable") &&
    (parsed.kind === "variable" || inferredKind === "variable");
  const suggestions = [
    ...(includeCommands
      ? commandSuggestions(
          parsed.query,
          input.cwd,
          environment,
          platform,
          input.shell,
          shellCompletions,
          input.shellCapabilities || {},
          input.pathCommands,
          input.disableLocalFilesystem,
          input.resolvedAutocdValues,
        )
      : []),
    ...(includeSignatures
      ? input.signatureSuggestions || getTerminalSignatureSuggestions(
          parsed.query,
          { cwd: input.cwd, environment, shell: input.shell },
        )
      : []),
    ...(includeVariables ? variableSuggestions(parsed.query, environment, shellCompletions) : []),
    ...(include("action") ? actionSuggestions(parsed.query) : []),
    ...(include("workflow") ? workflowSuggestions(parsed.query, input.workflows) : []),
    ...(include("history") ? historySuggestions(parsed.query, input.blocks) : []),
    ...(include("session") ? sessionSuggestions(parsed.query, input.sessions) : []),
    ...(include("file") && (!input.disableLocalFilesystem || input.resolvedFileValues)
      ? fileSuggestions(parsed.query, input.cwd, input.resolvedFileValues)
      : []),
  ].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  return {
    suggestions: suggestions.slice(0, Math.max(1, Math.min(100, input.limit))),
    activeKind: exclusiveKind,
    query: parsed.query,
  };
}

export async function getTerminalSuggestionsAsync(input: TerminalSuggestionsInput): Promise<{
  suggestions: TerminalSuggestion[];
  activeKind?: TerminalSuggestionKind;
  query: string;
}> {
  const parsed = parseQuery(input.query);
  const inferredKind = parsed.kind ? undefined : inferredExclusiveKind(parsed.query);
  const exclusiveKind = parsed.kind || inferredKind;
  const includeSignatures = (!exclusiveKind || exclusiveKind === "command") &&
    /\s/.test(parsed.query.trimStart()) && !parsed.query.trimStart().startsWith("$");
  const [signatureSuggestions, resolvedFileValues, resolvedAutocdValues] = await Promise.all([
    includeSignatures
      ? getTerminalSignatureSuggestionsAsync(parsed.query, {
        cwd: input.cwd,
        environment: input.environment,
        shell: input.shell,
        resourceRunner: input.resourceRunner,
        resourceTimeoutMs: input.resourceTimeoutMs,
        argumentResolver: input.argumentResolver,
      })
      : Promise.resolve([]),
    input.argumentResolver && (exclusiveKind === "file")
      ? input.argumentResolver({
          templates: ["files-and-folders"],
          cwd: input.cwd,
          fragment: parsed.query,
          environment: input.environment,
        }).catch(() => [])
      : Promise.resolve(input.resolvedFileValues || []),
    input.argumentResolver && !exclusiveKind && isPlainTopLevelCommandQuery(parsed.query) &&
      input.shellCapabilities?.autocd
      ? input.argumentResolver({
          templates: ["folders"],
          cwd: input.cwd,
          fragment: parsed.query,
          environment: input.environment,
        }).catch(() => [])
      : Promise.resolve(input.resolvedAutocdValues || []),
  ]);
  return getTerminalSuggestions({
    ...input,
    signatureSuggestions,
    resolvedFileValues: input.argumentResolver ? resolvedFileValues : input.resolvedFileValues,
    resolvedAutocdValues: input.argumentResolver ? resolvedAutocdValues : input.resolvedAutocdValues,
  });
}
