import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-flash";
const TITLE_MAX_INPUT_CHARS = 5000;
const TITLE_MAX_WORDS = 3;
const GEMINI_TITLE_SYSTEM_PROMPT = [
  "Name an OpenUI desktop agent session from the user's first prompt.",
  "Return only a concise title: 1 to 3 words, hard maximum 3 words.",
  "Prefer a concrete object plus task, product plus feature, or bug plus surface.",
  "Preserve exact repo, product, ticket, feature, bug, local URL, or file names when they are the clearest signal.",
  "Ignore assistant-routing phrasing such as please, can you, use Codex, use Claude, or use Gemini.",
  "Do not mention the agent name unless the user's task is specifically about that agent.",
  "Avoid generic labels: Session, Task, Work, Help, Fix, Update, Coding, Investigation.",
  "No quotes, emoji, markdown, full sentences, trailing punctuation, or extra explanation.",
  "Use title case unless preserving a user-provided identifier or casing.",
  "Examples:",
  "Prompt: make openui automatically show localhost in the side browser panel -> OpenUI Browser Dock",
  "Prompt: review PRB-17 Linear enrichment bug -> PRB-17 Enrichment",
  "Prompt: fix Stripe checkout loading spinner -> Stripe Checkout Spinner",
].join("\n");

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
  return words.join(" ").slice(0, 60).trim();
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
  agentName,
  cwd,
  ticketTitle,
  gitBranch,
}: {
  prompt: string;
  agentName?: string;
  cwd?: string;
  ticketTitle?: string;
  gitBranch?: string;
}): Promise<string> {
  const fallback = fallbackSessionTitle(prompt);
  const apiKey = getGeminiApiKey();
  if (!apiKey) return fallback;

  const model = getGeminiModel();
  const safePrompt = cleanPrompt(prompt);
  if (!safePrompt) return fallback;

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
                  text: `${context}\n\nUser prompt:\n${safePrompt}`,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 12,
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
