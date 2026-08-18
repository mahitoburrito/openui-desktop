import { useId, type CSSProperties } from "react";
import { Codicon } from "./Codicon";

const fallbackIconMap: Record<string, string> = {
  sparkles: "sparkle",
  code: "code",
  cpu: "server-process",
  zap: "zap",
  rocket: "rocket",
  bot: "hubot",
  brain: "lightbulb",
  wand2: "wand",
  terminal: "terminal",
};

export const AGENT_BRAND_ACCENTS: Record<string, string> = {
  claude: "#D97757",
  codex: "#7A9DFF",
};

export function getAgentAccentColor(agentId: string | undefined, color: string | undefined): string {
  const normalizedAgentId = agentId?.toLowerCase() || "";
  const normalizedColor = color?.toLowerCase();
  if (
    normalizedAgentId.includes("claude") &&
    (!normalizedColor ||
      normalizedColor === "#8b5cf6" ||
      normalizedColor === "#f97316" ||
      normalizedColor === "#c48a6a" ||
      normalizedColor === "#d97652")
  ) {
    return AGENT_BRAND_ACCENTS.claude;
  }
  if (
    normalizedAgentId.includes("codex") &&
    (!normalizedColor ||
      normalizedColor === "#10a37f" ||
      normalizedColor === "#7ccdbd" ||
      normalizedColor === "#6f72f6" ||
      normalizedColor === "#d97652")
  ) {
    return AGENT_BRAND_ACCENTS.codex;
  }
  return color || "#8A8F98";
}

interface AgentIconProps {
  agentId?: string;
  iconId?: string;
  className?: string;
  style?: CSSProperties;
}

function ClaudeCodeIcon({ className, style }: AgentIconProps) {
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 110 88"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {/* Claude Code's terminal mascot: the wide block head, side blocks,
          square eyes, and four long feet from the CLI welcome screen. */}
      <g fill="#D97757">
        <path d="M12 0h86v66H12z" />
        <path d="M2 22h10v22H2zM98 22h10v22H98z" />
        <path d="M13 66h11v22H13zM35 66h11v22H35zM66 66h11v22H66zM88 66h11v22H88z" />
      </g>
      <g fill="#17181A">
        <path d="M23 22h11v12H23zM76 22h11v12H76z" />
        <path d="M22 0h2v66H22zM34 0h2v66H34zM46 0h2v66H46zM58 0h2v66H58zM70 0h2v66H70zM82 0h2v66H82zM96 0h2v66H96z" opacity="0.28" />
      </g>
    </svg>
  );
}

function CodexIcon({ className, style }: AgentIconProps) {
  const gradientId = useId().replace(/:/g, "");

  return (
    <svg className={className} style={style} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z"
        fill="#fff"
      />
      <path
        d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
        fill={`url(#${gradientId})`}
      />
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="12"
          x2="12"
          y1="3"
          y2="21"
        >
          <stop stopColor="#B1A7FF" />
          <stop offset=".5" stopColor="#7A9DFF" />
          <stop offset="1" stopColor="#3941FF" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function AgentIcon({ agentId, iconId, className, style }: AgentIconProps) {
  const brandKey = `${agentId || ""} ${iconId || ""}`.toLowerCase();

  if (brandKey.includes("claude")) {
    return <ClaudeCodeIcon className={className} style={style} />;
  }

  if (brandKey.includes("codex")) {
    return <CodexIcon className={className} style={style} />;
  }

  return (
    <Codicon
      name={fallbackIconMap[iconId || ""] || "server-process"}
      className={className}
      style={style}
    />
  );
}
