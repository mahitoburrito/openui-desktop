import type { AgentProfileConfig } from "../types";

const TOOL_ALIASES: Record<string, string> = {
  bash: "bash",
  edit: "edit",
  glob: "glob",
  grep: "grep",
  read: "read",
  task: "task",
  webfetch: "webfetch",
  web_fetch: "webfetch",
  websearch: "websearch",
  web_search: "websearch",
  write: "write",
};

const READ_ONLY_TOOLS = new Set([
  "askuserquestion",
  "glob",
  "grep",
  "ls",
  "read",
  "task",
  "todoread",
  "webfetch",
  "websearch",
]);

const CLAUDE_TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  read: "Read",
  task: "Task",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  write: "Write",
};

function normalizedToolName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return TOOL_ALIASES[normalized] || normalized;
}

function quoteShellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hasFlag(command: string, flag: string): boolean {
  return new RegExp(`(?:^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:=|\\s|$)`).test(command);
}

export function adaptAgentProfileCommand(
  command: string,
  config: AgentProfileConfig,
  runtimeFiles: { promptPath?: string; mcpConfigPath?: string } = {},
): string {
  // Provider adapters are deliberately conservative. A custom wrapper may
  // interpret its arguments differently. Codex is adapted only when the
  // profile command is exactly its interactive executable; flags below are
  // verified against the installed Codex CLI rather than inferred.
  if (command.trim() === "codex") {
    let adapted = "codex";
    if (config.model) adapted += ` --model ${quoteShellArgument(config.model)}`;
    if (config.permissionPolicy === "read-only") {
      adapted += " --sandbox read-only --ask-for-approval on-request";
    } else if (config.permissionPolicy === "allow-edits") {
      adapted += " --sandbox workspace-write --ask-for-approval on-request";
    } else {
      adapted += " --ask-for-approval on-request";
    }
    return adapted;
  }

  // Claude flags are from its public CLI reference and work in interactive
  // mode. Other commands receive only the provider-neutral runtime manifest.
  if (!/^\s*claude(?:\s|$)/.test(command)) return command;
  let adapted = command.trim();
  if (config.model && !hasFlag(adapted, "--model")) {
    adapted += ` --model ${quoteShellArgument(config.model)}`;
  }
  if (!hasFlag(adapted, "--permission-mode")) {
    if (config.permissionPolicy === "read-only") adapted += " --permission-mode plan";
    if (config.permissionPolicy === "allow-edits") adapted += " --permission-mode acceptEdits";
  }
  if (runtimeFiles.promptPath && !hasFlag(adapted, "--append-system-prompt-file")) {
    adapted += ` --append-system-prompt-file ${quoteShellArgument(runtimeFiles.promptPath)}`;
  }
  if (config.tools.length && !hasFlag(adapted, "--tools")) {
    const builtInTools = config.tools
      .map(normalizedToolName)
      .filter((tool) => !tool.startsWith("mcp__"))
      .map((tool) => CLAUDE_TOOL_NAMES[tool] || tool);
    if (builtInTools.length) adapted += ` --tools ${quoteShellArgument(builtInTools.join(","))}`;
  }
  if (runtimeFiles.mcpConfigPath && !hasFlag(adapted, "--mcp-config")) {
    adapted += ` --strict-mcp-config --mcp-config ${quoteShellArgument(runtimeFiles.mcpConfigPath)}`;
  }
  return adapted;
}

export function buildAgentProfileRuntimePrompt(
  profileId: string,
  version: number,
  config: AgentProfileConfig,
): string | undefined {
  const sections = [
    `OpenUI agent profile ${profileId} version ${version}.`,
    config.systemPrompt ? `Profile system instructions:\n${config.systemPrompt}` : "",
    config.tools.length ? `Configured tool allowlist: ${config.tools.join(", ")}.` : "",
    config.skills.length ? `Configured skills: ${config.skills.join(", ")}.` : "",
    config.mcpServers.length
      ? `Configured MCP servers: ${config.mcpServers.map((server) => server.name).join(", ")}.`
      : "",
    config.permissionPolicy === "read-only"
      ? "OpenUI permission policy is read-only. Do not modify files or run mutating tools."
      : config.permissionPolicy === "allow-edits"
        ? "OpenUI permission policy allows file edits; other tool permissions still follow the provider's normal prompts."
        : "OpenUI permission policy requires the provider's normal approval flow.",
  ].filter(Boolean);
  return sections.length > 1 ? sections.join("\n\n") : undefined;
}

export function evaluateAgentProfileToolPermission(
  policy: AgentProfileConfig["permissionPolicy"],
  configuredTools: string[],
  toolName: string,
): { permissionDecision: "deny"; reason: string } | null {
  const normalized = normalizedToolName(toolName);
  if (normalized === "askuserquestion") return null;

  if (configuredTools.length) {
    const allowed = new Set(configuredTools.map(normalizedToolName));
    const mcpServer = /^mcp__(.+?)__/.exec(toolName.toLowerCase())?.[1];
    const explicitlyAllowed = allowed.has(normalized) || Boolean(mcpServer && allowed.has(`mcp__${mcpServer}`));
    if (!explicitlyAllowed) {
      return {
        permissionDecision: "deny",
        reason: `Tool ${toolName} is not in the pinned OpenUI profile tool allowlist`,
      };
    }
  }

  if (policy === "read-only" && !READ_ONLY_TOOLS.has(normalized)) {
    return {
      permissionDecision: "deny",
      reason: `Tool ${toolName} is blocked by the pinned OpenUI read-only profile`,
    };
  }
  return null;
}

export function profileRuntimeManifest(
  profileId: string,
  version: number,
  config: AgentProfileConfig,
): Record<string, unknown> {
  return {
    version: 1,
    profileId,
    profileVersion: version,
    name: config.name,
    model: config.model,
    permissionPolicy: config.permissionPolicy,
    tools: config.tools,
    skills: config.skills,
    mcpServers: config.mcpServers.map((server) => ({
      name: server.name,
      transport: server.url ? "url" : "command",
    })),
    metadata: config.metadata,
  };
}
