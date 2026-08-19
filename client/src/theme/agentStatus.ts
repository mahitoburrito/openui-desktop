import type { AgentStatus } from "../stores/useStore";

/**
 * The one place an agent status becomes a word and a colour.
 *
 * Six surfaces used to each carry their own map, and they had drifted into six
 * different vocabularies for the same seven states: `waiting_input` was
 * "Needs Input" on the canvas and "Waiting for input" in the sidebar,
 * `tool_calling` was "Working" on the card and "Tool Calling" in the sidebar,
 * `disconnected` was "Offline" in one place and "Disconnected" in another. The
 * colours had drifted further, and two of them were actively misleading: the
 * sidebar painted `disconnected` in the same red as `error`, so a session you
 * simply closed looked like one that had crashed, and it painted
 * `tool_calling` purple against a green `running` — one state, two colours,
 * depending on which panel you happened to be looking at.
 *
 * Add a surface that shows status, import this. Do not write another map.
 */

export interface AgentStatusStyle {
  /** What the user reads. One word per state, the same word everywhere. */
  label: string;
  /** Solid accent: dots, text, icons. */
  color: string;
  /** ~12% tint for chip and pill fills. */
  bg: string;
  /** ~30% for the border of a card in this state. */
  border: string;
  /** ~60% for a state that is asking for something. */
  borderStrong: string;
  /** The agent is doing something right now. */
  isActive?: boolean;
  /** The agent is waiting on the person. Earns the eye. */
  needsAttention?: boolean;
}

/**
 * oklch throughout, matching the workspace tokens in index.css. The point of
 * the perceptual space here is that every state sits at roughly the same
 * lightness, so the seven read as one family and the only thing that separates
 * them is hue and chroma — which is what carries the meaning.
 *
 * The attention hierarchy is deliberate: only `waiting_input` and `error` carry
 * heavy warm chroma. Everything else is either cool or near-neutral, so amber
 * and red are the only two things on a full canvas that pull your eye.
 */
export const AGENT_STATUS: Record<AgentStatus, AgentStatusStyle> = {
  creating: {
    label: "Starting",
    color: "oklch(72% 0.11 280)",
    bg: "oklch(72% 0.11 280 / 0.12)",
    border: "oklch(72% 0.11 280 / 0.30)",
    borderStrong: "oklch(72% 0.11 280 / 0.60)",
    isActive: true,
  },
  running: {
    label: "Working",
    color: "oklch(74% 0.12 145)",
    bg: "oklch(74% 0.12 145 / 0.12)",
    border: "oklch(74% 0.12 145 / 0.30)",
    borderStrong: "oklch(74% 0.12 145 / 0.60)",
    isActive: true,
  },
  // Running a tool is still working as far as the reader is concerned. The
  // card names the specific tool separately; the state does not change.
  tool_calling: {
    label: "Working",
    color: "oklch(74% 0.12 145)",
    bg: "oklch(74% 0.12 145 / 0.12)",
    border: "oklch(74% 0.12 145 / 0.30)",
    borderStrong: "oklch(74% 0.12 145 / 0.60)",
    isActive: true,
  },
  waiting_input: {
    label: "Needs Input",
    color: "oklch(72% 0.13 48)",
    bg: "oklch(72% 0.13 48 / 0.12)",
    border: "oklch(72% 0.13 48 / 0.30)",
    borderStrong: "oklch(72% 0.13 48 / 0.60)",
    needsAttention: true,
  },
  // Deliberately near-neutral and deliberately still called "Idle". "Ready"
  // was the tempting alternative, but "Ready" and "Needs Input" both read as
  // "your turn" and would blur the one distinction that has to stay sharp:
  // grey means nothing wants you, amber means something does.
  idle: {
    label: "Idle",
    color: "oklch(67% 0.02 260)",
    bg: "oklch(67% 0.02 260 / 0.12)",
    border: "oklch(67% 0.02 260 / 0.30)",
    borderStrong: "oklch(67% 0.02 260 / 0.60)",
  },
  // Dimmer than idle, and pointedly not red. A closed session is not a crash.
  disconnected: {
    label: "Offline",
    color: "oklch(58% 0.02 260)",
    bg: "oklch(58% 0.02 260 / 0.15)",
    border: "oklch(58% 0.02 260 / 0.30)",
    borderStrong: "oklch(58% 0.02 260 / 0.60)",
  },
  error: {
    label: "Error",
    color: "oklch(70% 0.15 28)",
    bg: "oklch(70% 0.15 28 / 0.12)",
    border: "oklch(70% 0.15 28 / 0.30)",
    borderStrong: "oklch(70% 0.15 28 / 0.60)",
    needsAttention: true,
  },
};

/** Never throw on a status the client has not heard of yet. */
export function agentStatusStyle(status: AgentStatus | undefined): AgentStatusStyle {
  return (status && AGENT_STATUS[status]) || AGENT_STATUS.idle;
}
