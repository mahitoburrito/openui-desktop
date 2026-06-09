import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-flash";
const TITLE_MAX_INPUT_CHARS = 5000;
const TITLE_MAX_WORDS = 12;
const TITLE_MAX_CHARS = 140;
const GEMINI_TITLE_SYSTEM_PROMPT = [
  "Name an OpenUI desktop agent session from the user's prompts over time.",
  "Return only a useful descriptive session title. Use as many words as needed, but stay under 12 words and 140 characters.",
  "Prefer a concrete product plus feature, bug plus surface, or objective plus repo.",
  "If later prompts change the actual work, update the title to describe the current session, not just the first prompt.",
  "Preserve exact repo, product, ticket, feature, bug, local URL, or file names when they are the clearest signal.",
  "Ignore assistant-routing phrasing such as please, can you, use Codex, use Claude, or use Gemini.",
  "Do not mention the agent name unless the user's task is specifically about that agent.",
  "Avoid generic standalone labels: Session, Task, Work, Help, Fix, Update, Coding, Investigation.",
  "No quotes, emoji, markdown, full sentences, trailing punctuation, or extra explanation.",
  "Use title case unless preserving a user-provided identifier or casing.",
  "Examples:",
  "Prompts: make openui automatically show localhost in the side browser panel -> OpenUI Localhost Browser Dock",
  "Prompts: review PRB-17 Linear enrichment bug -> PRB-17 Linear Enrichment Review",
  "Prompts: fix Stripe checkout loading spinner, then test web checkout -> Stripe Checkout Loading State",
].join("\n");
const GEMINI_SORT_SYSTEM_PROMPT = [
  "You are sorting OpenUI desktop agent cards by blast radius using their titles.",
  "Blast radius means the likely shared product, repo, feature, bug, user workflow, or code surface impacted by the session.",
  "Use titles as the primary evidence. Use repo, branch, ticket, status, and recency only to break ties.",
  "Act as an LLM judge: cluster sessions that appear to affect the same blast radius even when their titles use different words.",
  "Keep unrelated sessions separate. Do not invent missing work.",
  "Order groups by operational importance: waiting/error/running sessions first, then larger or riskier blast radius, then recent work.",
  "Return strict JSON only with this shape: {\"groups\":[{\"label\":\"2-6 word blast radius label\",\"reason\":\"short reason\",\"nodeIds\":[\"node-id\"]}]}",
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
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
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

function cleanPrompt(input: string): string {
  return redactSecrets(stripAnsi(input))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_MAX_INPUT_CHARS);
}

function normalizeTitle(value: string): string {
  const title = value
    .replace(/^(title|session title)\s*[:.-]\s*/i, "")
    .replace(/^["'`]+|["'`.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title) return "";
  const withoutPunctuation = title.replace(/[.!?;:]+$/g, "");
  const words = withoutPunctuation
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, TITLE_MAX_WORDS);
  return words.join(" ").slice(0, TITLE_MAX_CHARS).trim();
}

export function fallbackSessionTitle(input: string): string {
  const prompt = cleanPrompt(input);
  if (!prompt) return "Untitled session";
  const compact = prompt
    .replace(/^(please|can you|could you|hey|mate|hi|hello)\b[\s,:-]*/i, "")
    .replace(/\b(use|using)\s+(codex|claude|gemini)\b/gi, "")
    .trim();
  const title = normalizeTitle(compact);
  if (!title) return "Untitled session";
  return title.charAt(0).toUpperCase() + title.slice(1);
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
  const fallback = fallbackSessionTitle(prompt);
  const apiKey = getGeminiApiKey();
  if (!apiKey) return fallback;

  const model = getGeminiModel();
  const safePromptHistory = (promptHistory && promptHistory.length > 0 ? promptHistory : [prompt])
    .map(cleanPrompt)
    .filter(Boolean)
    .slice(-8);
  if (safePromptHistory.length === 0) return fallback;

  const context = [
    agentName ? `Agent: ${agentName}` : "",
    ticketTitle ? `Ticket title: ${cleanPrompt(ticketTitle)}` : "",
    gitBranch ? `Branch: ${cleanPrompt(gitBranch)}` : "",
    cwd ? `Working directory: ${cleanPrompt(cwd).split("/").slice(-3).join("/")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

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
    return title || fallback;
  } catch {
    return fallback;
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
                  text: `Cluster these sessions by title blast radius:\n${JSON.stringify(payload)}`,
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
