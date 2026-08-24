import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-flash";
const TITLE_MAX_INPUT_CHARS = 5000;
const TITLE_MAX_WORDS = 8;
const TITLE_MAX_CHARS = 80;
const inFlightSessionTitleRequests = new Map<string, Promise<string>>();
const GEMINI_TITLE_SYSTEM_PROMPT = [
  "Name an OpenUI desktop agent session from the user's prompt history over time.",
  "Return only a useful descriptive session title, ideally 4-8 words and always under 80 characters.",
  "Prefer a concrete product plus feature, bug plus surface, or objective plus repo.",
  "Do not simply summarize the latest prompt. Infer the durable work thread from the whole prompt history.",
  "Treat short follow-ups, status checks, confirmations, and meta questions as weak signal unless they introduce a concrete new product, feature, bug, repo, or workflow.",
  "If the user truly pivots, update the title only when later prompts establish a concrete new work thread.",
  "Preserve exact repo, product, ticket, feature, bug, local URL, or file names when they are the clearest signal.",
  "Prompts starting with / are IDE slash commands. Title those by the higher-level task being performed, never by the raw command arguments, flags, or model ids.",
  "Ignore assistant-routing phrasing such as please, can you, use Codex, use Claude, or use Gemini.",
  "Do not mention the agent name unless the user's task is specifically about that agent.",
  "Avoid generic standalone labels: Session, Task, Work, Help, Fix, Update, Coding, Investigation.",
  "No quotes, emoji, markdown, full sentences, trailing punctuation, or extra explanation.",
  "Use title case unless preserving a user-provided identifier or casing.",
  "Examples:",
  "Prompts: make openui automatically show localhost in the side browser panel -> OpenUI Localhost Browser Dock",
  "Prompts: review PRB-17 Linear enrichment bug -> PRB-17 Linear Enrichment Review",
  "Prompts: fix Stripe checkout loading spinner, then test web checkout -> Stripe Checkout Loading State",
  "Prompts: /model, /model claude-fable-5, /effort -> Model Selection",
].join("\n");
const GEMINI_SORT_SYSTEM_PROMPT = [
  "You are sorting OpenUI desktop agent cards by the durable work intent behind each task.",
  "Work intent means the shared objective, product area, user workflow, bug class, repo surface, or business job being pursued.",
  "Use title plus recent prompt history as primary evidence. Use repo, branch, ticket, status, and recency only to break ties.",
  "Cluster sessions that are the same kind of work even when they mention different channels, tools, or sources.",
  "Treat channel/source words such as LinkedIn, Bookface, email, Slack, X/Twitter, YC, GitHub, Linear, or Notion as modifiers, not as separate groups, unless the requested work is specifically about that integration itself.",
  "Example: outbound/prospecting tasks for LinkedIn, Bookface, email, or founder lists belong together as one Outbound or Founder Outreach group when the objective is reaching prospects.",
  "Example: anything about tweaking the IDE itself — session titles, sidebar, sorting, notifications, browser dock, terminal panes, themes — is one IDE Tweaks group, not one group per surface.",
  "Example: sessions about setting up, running, or managing experiments and evals are one Experiments group.",
  "Keep unrelated sessions separate. Do not invent missing work.",
  "Order groups by operational importance: waiting/error/running sessions first, then larger or riskier blast radius, then recent work.",
  "Return strict JSON only with this shape: {\"groups\":[{\"label\":\"2-6 word intent label\",\"reason\":\"short reason\",\"nodeIds\":[\"node-id\"]}]}",
  "Every input nodeId must appear exactly once. Do not include markdown or commentary.",
].join("\n");

export interface TitleSortInput {
  nodeId: string;
  title: string;
  agentName?: string;
  status?: string;
  repo?: string;
  branch?: string;
  ticketTitle?: string;
  promptHistory?: string[];
  createdAt?: string;
}

export interface TitleSortGroup {
  label: string;
  reason?: string;
  nodeIds: string[];
}

function getLaunchCwd(): string {
  return process.env.LAUNCH_CWD || homedir();
}

function getEnvFile(): string {
  return join(getLaunchCwd(), ".openui-desktop", ".env");
}

function getHomeEnvFile(): string {
  return join(homedir(), ".openui-desktop", ".env");
}

function loadEnvFile(): Record<string, string> {
  const files = Array.from(new Set([getHomeEnvFile(), getEnvFile()]));
  const vars: Record<string, string> = {};
  try {
    for (const file of files) {
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const [key, ...valueParts] = trimmed.split("=");
        if (!key || valueParts.length === 0) continue;
        let value = valueParts.join("=");
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        vars[key.trim()] = value;
      }
    }
    return vars;
  } catch {
    return vars;
  }
}

function updateEnvValue(key: string, value: string): void {
  const dir = join(getLaunchCwd(), ".openui-desktop");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const file = getEnvFile();
  const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const lines = existing
    .split("\n")
    .filter((line) => !line.trim().startsWith(`${key}=`));

  let next = lines.join("\n").trimEnd();
  if (value) {
    if (next) next += "\n";
    next += `${key}="${value.replace(/"/g, '\\"')}"`;
  }
  writeFileSync(file, next ? `${next}\n` : "");
}

export function loadTitleGenerationConfig(): {
  hasApiKey: boolean;
  model: string;
} {
  const env = loadEnvFile();
  const apiKey =
    env.GEMINI_API_KEY ||
    env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;
  return {
    hasApiKey: !!apiKey,
    model: env.GEMINI_TITLE_MODEL || process.env.GEMINI_TITLE_MODEL || DEFAULT_MODEL,
  };
}

export function saveTitleGenerationApiKey(apiKey: string): void {
  updateEnvValue("GEMINI_API_KEY", apiKey.trim());
}

function getGeminiApiKey(): string | undefined {
  const env = loadEnvFile();
  return (
    env.GEMINI_API_KEY ||
    env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY
  );
}

function getGeminiModel(): string {
  const env = loadEnvFile();
  return env.GEMINI_TITLE_MODEL || process.env.GEMINI_TITLE_MODEL || DEFAULT_MODEL;
}

function isBearerCredential(value: string): boolean {
  return value.startsWith("ya29.") || value.startsWith("AQ.");
}

function stripAnsi(value: string): string {
  return value
    // OSC sequences (window titles, hyperlinks): ESC ] ... BEL or ESC \
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    // CSI sequences (colors, cursor movement): ESC [ ... final byte
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // Two-character escapes (ESC M, ESC =, ESC >, ...)
    .replace(/\x1b[@-Z\\-_=>]/g, "");
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(AQ\.[A-Za-z0-9_-]{20,})\b/g, "[redacted-key]")
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "[redacted-key]")
    .replace(
      /\b(api[_-]?key|token|secret|password|passwd|pwd)\b\s*[:=]\s*["']?[^"'\s]{8,}/gi,
      "$1=[redacted]",
    )
    .replace(/\b[A-Za-z0-9_-]{72,}\b/g, "[redacted-token]");
}

export function sanitizeTitlePrompt(input: string): string {
  return redactSecrets(stripAnsi(input))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_MAX_INPUT_CHARS);
}

const cleanPrompt = sanitizeTitlePrompt;

function normalizeTitle(value: string): string {
  const title = value
    .replace(/^(title|session title)\s*[:.-]\s*/i, "")
    .replace(/[*`]+/g, "")
    .replace(/^["']+|["'.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title) return "";
  const withoutPunctuation = title.replace(/^[.!?;:,]+\s*/, "").replace(/[.!?;:]+$/g, "");
  const words = withoutPunctuation
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, TITLE_MAX_WORDS);
  // Slice by code points so a multi-byte character is never split mid-way.
  return Array.from(words.join(" ")).slice(0, TITLE_MAX_CHARS).join("").trim();
}

const FALLBACK_TITLE_STOP_WORDS = new Set([
  "a",
  "about",
  "actually",
  "add",
  "ahead",
  "all",
  "also",
  "an",
  "and",
  "any",
  "anything",
  "are",
  "as",
  "asking",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "can",
  "change",
  "check",
  "code",
  "configured",
  "continue",
  "couple",
  "could",
  "create",
  "directory",
  "did",
  "do",
  "does",
  "done",
  "easiest",
  "else",
  "everything",
  "explain",
  "for",
  "from",
  "get",
  "give",
  "go",
  "good",
  "had",
  "has",
  "have",
  "he",
  "help",
  "her",
  "here",
  "him",
  "his",
  "i",
  "if",
  "im",
  "implement",
  "implementation",
  "include",
  "in",
  "how",
  "into",
  "is",
  "it",
  "its",
  "just",
  "last",
  "less",
  "lets",
  "like",
  "look",
  "looks",
  "make",
  "merge",
  "mean",
  "me",
  "more",
  "much",
  "my",
  "maybe",
  "need",
  "no",
  "noi",
  "not",
  "now",
  "of",
  "on",
  "okay",
  "open",
  "or",
  "our",
  "ours",
  "per",
  "please",
  "proceed",
  "push",
  "ready",
  "restate",
  "right",
  "run",
  "she",
  "show",
  "simple",
  "sounds",
  "something",
  "so",
  "some",
  "start",
  "still",
  "ship",
  "take",
  "tell",
  "test",
  "terms",
  "that",
  "than",
  "the",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "things",
  "through",
  "to",
  "try",
  "understand",
  "update",
  "use",
  "using",
  "was",
  "way",
  "we",
  "were",
  "what",
  "whats",
  "when",
  "where",
  "which",
  "while",
  "why",
  "will",
  "with",
  "work",
  "working",
  "would",
  "you",
  "your",
]);

function titleTokens(value: string): string[] {
  return cleanPrompt(value)
    .toLowerCase()
    .replace(/\bhttps?:\/\/[^\s]+/g, " local-url ")
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !FALLBACK_TITLE_STOP_WORDS.has(word));
}

function titleCaseToken(token: string): string {
  const acronym = {
    a2a: "A2A",
    ai: "AI",
    api: "API",
    cli: "CLI",
    llm: "LLM",
    mcp: "MCP",
    openui: "OpenUI",
    "openui-desktop": "OpenUI Desktop",
    pr: "PR",
    pty: "PTY",
    rl: "RL",
    rls: "RLS",
    sdk: "SDK",
    soc2: "SOC 2",
    ssh: "SSH",
    tui: "TUI",
    ui: "UI",
    ux: "UX",
    yc: "YC",
  }[token];
  if (acronym) return acronym;
  if (/^[A-Z0-9_-]+$/.test(token)) return token;
  if (/^[a-z]+-\d+$/i.test(token)) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

// Slash-command prompts describe an IDE action, not work content. Title them
// by the higher-level task ("Model Selection"), never by raw args or flags —
// "/model claude-fable-5" must not become "Model Claude-fable-5".
const SLASH_COMMAND_INTENTS: { intent: string; commands: string[] }[] = [
  { intent: "Model Selection", commands: ["model", "effort", "fast", "output-style"] },
  { intent: "IDE Settings", commands: ["config", "settings", "theme", "statusline", "terminal-setup", "vim", "keybindings", "update-config"] },
  { intent: "Session Setup", commands: ["init", "clear", "compact", "context", "resume", "rewind", "memory", "add-dir"] },
  { intent: "Account & Login", commands: ["login", "logout", "upgrade"] },
  { intent: "Diagnostics", commands: ["doctor", "status", "health", "bug", "cost"] },
  { intent: "MCP Setup", commands: ["mcp"] },
  { intent: "Permissions Setup", commands: ["permissions", "allowed-tools", "fewer-permission-prompts"] },
  { intent: "Code Review", commands: ["review", "code-review", "security-review"] },
];

function slashCommandName(prompt: string): string | null {
  const match = cleanPrompt(prompt).match(/^\/([a-z][\w:-]*)/i);
  return match ? match[1].toLowerCase() : null;
}

function slashCommandIntent(command: string): string {
  for (const { intent, commands } of SLASH_COMMAND_INTENTS) {
    if (commands.includes(command)) return intent;
  }
  // Unknown command: name the command itself, still never its arguments.
  return `${titleCaseToken(command)} Command`;
}

// Non-null only when every prompt in the session is a slash command; mixed
// sessions fall through so real work prompts drive the title instead.
export function slashCommandSessionTitle(promptHistory: string[]): string | null {
  const prompts = promptHistory.map(cleanPrompt).filter(Boolean);
  if (prompts.length === 0) return null;
  const commands = prompts.map(slashCommandName);
  if (commands.some((command) => command === null)) return null;
  const intents: string[] = [];
  for (const command of commands as string[]) {
    const intent = slashCommandIntent(command);
    if (!intents.includes(intent)) intents.push(intent);
  }
  return normalizeTitle(intents.slice(0, 2).join(" & ")) || null;
}

const LOW_INFORMATION_PROMPT = /^(?:ok(?:ay)?|sure|yes|yep|yeah|sounds good|continue|keep going|go ahead|proceed|do it|ship it|merge it|push it|restate|try again|what(?: else)?(?: is|'s) next|anything else|everything good|are we good|status|any updates?|lmk)[.!?\s]*$/i;
const LOW_INFORMATION_TITLE_START = /^(?:so|is|are|was|were|did|do|does|can|could|would|should|what|why|how|when|where|continue|go ahead|restate)\b/i;

export function isLowInformationTitlePrompt(input: string): boolean {
  const prompt = cleanPrompt(input);
  if (!prompt) return true;
  if (LOW_INFORMATION_PROMPT.test(prompt)) return true;
  const tokens = titleTokens(prompt);
  return tokens.length === 0;
}

export function isUsefulGeneratedTitle(input: string): boolean {
  const title = normalizeTitle(input);
  if (!title || /^untitled session$/i.test(title)) return false;
  if (LOW_INFORMATION_PROMPT.test(title) || LOW_INFORMATION_TITLE_START.test(title)) return false;
  if (/\b(?:and|or|the|a|an|to|for|with|of|in|on)$/i.test(title)) return false;
  return titleTokens(title).length > 0;
}

export function fallbackSessionTitle(input: string): string {
  const prompt = cleanPrompt(input);
  if (!prompt || isLowInformationTitlePrompt(prompt)) return "";
  const commandTitle = slashCommandSessionTitle([prompt]);
  if (commandTitle) return commandTitle;
  return fallbackSessionTitleFromHistory(prompt, [prompt]);
}

export function fallbackSessionTitleFromHistory(input: string, promptHistory?: string[]): string {
  let history = (promptHistory && promptHistory.length > 0 ? promptHistory : [input])
    .map(cleanPrompt)
    .filter(Boolean)
    .slice(-8);
  const commandTitle = slashCommandSessionTitle(history);
  if (commandTitle) return commandTitle;
  // Mixed sessions: slash commands are IDE plumbing, not the work thread.
  const workPrompts = history.filter(
    (prompt) => !slashCommandName(prompt) && !isLowInformationTitlePrompt(prompt),
  );
  if (workPrompts.length > 0) history = workPrompts;
  else return "";

  const tokenStats = new Map<string, { score: number; firstSeen: number }>();
  let recentHistory = history.filter((prompt) => {
    const tokens = titleTokens(prompt);
    const isWeakQuestion = /^(is|are|do|does|did|no|yes)\b/i.test(prompt);
    return tokens.length > 0 && !(isWeakQuestion && tokens.length <= 2);
  });
  if (recentHistory.length === 0) recentHistory = history;

  recentHistory.forEach((prompt, index) => {
    const tokens = Array.from(new Set(titleTokens(prompt))).slice(0, 16);
    const recencyWeight = 1 + index / Math.max(1, recentHistory.length - 1) * 0.2;
    const anchorWeight = index === 0 ? 0.4 : 0;
    tokens.forEach((token, tokenIndex) => {
      const existing = tokenStats.get(token);
      const identifierWeight = token.includes("-") || /\d/.test(token) ? 0.65 : 0;
      const score = recencyWeight + anchorWeight + identifierWeight + Math.max(0, 0.2 - tokenIndex * 0.015);
      if (existing) {
        existing.score += score;
      } else {
        tokenStats.set(token, {
          score,
          firstSeen: index * 100 + tokenIndex,
        });
      }
    });
  });

  const titleWords = Array.from(tokenStats.entries())
    .sort((a, b) => {
      if (b[1].score !== a[1].score) return b[1].score - a[1].score;
      return a[1].firstSeen - b[1].firstSeen;
    })
    .slice(0, 6)
    .sort((a, b) => a[1].firstSeen - b[1].firstSeen)
    .map(([token]) => titleCaseToken(token));

  const title = normalizeTitle(titleWords.join(" "));
  return title;
}

export async function generateSessionTitle({
  prompt,
  promptHistory,
  agentName,
  cwd,
  ticketTitle,
  gitBranch,
}: {
  prompt: string;
  promptHistory?: string[];
  agentName?: string;
  cwd?: string;
  ticketTitle?: string;
  gitBranch?: string;
}): Promise<string> {
  const safePromptHistory = (promptHistory && promptHistory.length > 0 ? promptHistory : [prompt])
    .map(cleanPrompt)
    .filter(Boolean)
    .slice(-8);
  // All-command sessions have a deterministic intent title; skip the LLM call.
  const commandTitle = slashCommandSessionTitle(safePromptHistory);
  if (commandTitle) return commandTitle;
  const fallback = fallbackSessionTitleFromHistory(prompt, safePromptHistory);
  const apiKey = getGeminiApiKey();
  if (!apiKey) return fallback;

  const model = getGeminiModel();
  if (safePromptHistory.length === 0) return fallback;

  // Multi-session launches intentionally share a durable task title and use
  // ordinal suffixes for disambiguation. Collapse equivalent concurrent model
  // requests so a 20-pane launch does not become 20 identical paid calls.
  const requestKey = JSON.stringify({ model, safePromptHistory, agentName, ticketTitle, gitBranch });
  const inFlight = inFlightSessionTitleRequests.get(requestKey);
  if (inFlight) return inFlight;

  const context = [
    agentName ? `Agent: ${agentName}` : "",
    ticketTitle ? `Ticket title: ${cleanPrompt(ticketTitle)}` : "",
    gitBranch ? `Branch: ${cleanPrompt(gitBranch)}` : "",
    cwd ? `Working directory: ${cleanPrompt(cwd).split("/").slice(-3).join("/")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const request = (async () => {
    try {
      const bearer = isBearerCredential(apiKey);
      const res = await fetch(
        `${GEMINI_API}/models/${encodeURIComponent(model)}:generateContent${bearer ? "" : `?key=${encodeURIComponent(apiKey)}`}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(bearer ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text: GEMINI_TITLE_SYSTEM_PROMPT,
                },
              ],
            },
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: [
                      context,
                      "User prompts, oldest to newest:",
                      ...safePromptHistory.map((item, index) => `${index + 1}. ${item}`),
                    ].filter(Boolean).join("\n"),
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 48,
            },
          }),
        },
      );

      if (!res.ok) return fallback;
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const raw =
        data?.candidates?.[0]?.content?.parts
          ?.map((part: { text?: string }) => part.text || "")
          .join(" ") || "";
      const title = normalizeTitle(raw);
      return isUsefulGeneratedTitle(title) ? title : fallback;
    } catch {
      return fallback;
    }
  })();
  inFlightSessionTitleRequests.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (inFlightSessionTitleRequests.get(requestKey) === request) {
      inFlightSessionTitleRequests.delete(requestKey);
    }
  }
}

function parseJsonObject(value: string): any | null {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export async function generateTitleSortGroups(items: TitleSortInput[]): Promise<TitleSortGroup[] | null> {
  const apiKey = getGeminiApiKey();
  if (!apiKey || items.length === 0) return null;

  const model = getGeminiModel();
  const payload = items.map((item) => ({
    nodeId: item.nodeId,
    title: cleanPrompt(item.title).slice(0, 180),
    agentName: item.agentName,
    status: item.status,
    repo: item.repo,
    branch: item.branch,
    ticketTitle: item.ticketTitle ? cleanPrompt(item.ticketTitle).slice(0, 180) : undefined,
    promptHistory: item.promptHistory
      ?.map(cleanPrompt)
      .filter(Boolean)
      .slice(-5)
      .map((prompt) => prompt.slice(0, 240)),
    createdAt: item.createdAt,
  }));

  try {
    const bearer = isBearerCredential(apiKey);
    const res = await fetch(
      `${GEMINI_API}/models/${encodeURIComponent(model)}:generateContent${bearer ? "" : `?key=${encodeURIComponent(apiKey)}`}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(bearer ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: GEMINI_SORT_SYSTEM_PROMPT }],
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `Cluster these sessions by durable work intent:\n${JSON.stringify(payload)}`,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: Math.min(4096, 512 + items.length * 96),
          },
        }),
      },
    );

    if (!res.ok) return null;
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw =
      data?.candidates?.[0]?.content?.parts
        ?.map((part: { text?: string }) => part.text || "")
        .join(" ") || "";
    const parsed = parseJsonObject(raw);
    if (!parsed || !Array.isArray(parsed.groups)) return null;

    const inputIds = new Set(items.map((item) => item.nodeId));
    const seen = new Set<string>();
    const groups: TitleSortGroup[] = [];
    for (const group of parsed.groups) {
      if (!group || !Array.isArray(group.nodeIds)) continue;
      const nodeIds: string[] = group.nodeIds
        .filter((id: unknown): id is string => typeof id === "string" && inputIds.has(id) && !seen.has(id));
      if (nodeIds.length === 0) continue;
      nodeIds.forEach((id: string) => seen.add(id));
      const label = normalizeTitle(String(group.label || "Related Work")) || "Related Work";
      groups.push({
        label,
        reason: typeof group.reason === "string" ? group.reason.slice(0, 180) : undefined,
        nodeIds,
      });
    }

    for (const item of items) {
      if (!seen.has(item.nodeId)) {
        groups.push({ label: normalizeTitle(item.title) || "Related Work", nodeIds: [item.nodeId] });
      }
    }

    return groups.length > 0 ? groups : null;
  } catch {
    return null;
  }
}
