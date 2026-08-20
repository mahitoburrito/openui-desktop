import type WebSocket from "ws";
import type { AgentStatus, AgentStatusSource, Session } from "../types";
import { sendTerminalMessage } from "./terminalTransport";

/**
 * Every agent status change funnels through here.
 *
 * The problem this solves: status used to be written from six places, each of
 * them free to flip the card on a single event. A tool that ran longer than a
 * few seconds, a spinner repaint after the turn ended, a subagent finishing
 * mid-turn — any of those could swing a card between "Working" and
 * "Needs Input" several times a second. A status that flickers is a status you
 * stop trusting, so nothing here is allowed to change the card on one event
 * alone: a candidate status has to hold for a beat before the UI hears about
 * it, and a status the user has already read has to stand for a while before
 * something less certain can take it away.
 */

/**
 * How sure we are about a status, by where it came from.
 *
 * - `authoritative` — an agent hook that names the state outright (the agent
 *   asked a question, the turn stopped, the user submitted a prompt) or a
 *   process-level fact (the PTY exited). These are not guesses.
 * - `hook` — derived from the tool lifecycle. Reliable that *something* is
 *   happening, less reliable about what.
 * - `inferred` — read off the terminal: how much it is printing, how long it
 *   has been silent. Cheap, always available, and the most likely to be wrong.
 */
const SOURCE_RANK: Record<AgentStatusSource, number> = {
  authoritative: 2,
  hook: 1,
  inferred: 0,
};

/**
 * How long a candidate status must hold before the UI is told about it. The
 * two statuses that mean "the agent stopped" wait longest, because claiming an
 * agent is done or stuck when it isn't costs more than saying so a beat late.
 */
const COMMIT_DELAY_MS: Record<AgentStatus, number> = {
  running: 800,
  tool_calling: 800,
  waiting_input: 2500,
  idle: 3000,
  disconnected: 0,
  error: 0,
};

/** Hard ceiling on any scheduled commit, whatever the dwell arithmetic says. */
const MAX_COMMIT_DELAY_MS = 10_000;

/** An authoritative source has already named the state, so it barely waits. */
const AUTHORITATIVE_COMMIT_DELAY_MS = 250;

/**
 * Once committed, a status holds the card for at least this long against
 * anything short of an authoritative hook. Without it, one stray repaint can
 * yank "Needs Input" away in the moment you look up at it.
 */
const MIN_DWELL_MS: Partial<Record<AgentStatus, number>> = {
  waiting_input: 6000,
  running: 1500,
  tool_calling: 1500,
};

/** A tool call has to be outstanding this long before silence means anything. */
const PROMPT_MIN_PENDING_MS = 6000;

/**
 * ...and the terminal has to have stopped printing for this long. A tool that
 * is actually running keeps the agent's spinner and elapsed-time counter
 * repainting; a permission prompt is a static frame. That difference is the
 * whole signal — it is what the old fixed 3.5s timeout was missing when it
 * flagged every slow build as "Needs Input".
 */
const PROMPT_QUIET_MS = 2500;

/** Silence this long with no tool outstanding means the turn is over. */
const IDLE_SILENCE_MS = 60_000;

/**
 * A tool call whose `post_tool` never arrives — denied, interrupted, or the
 * hook's own curl timed out — would otherwise pin the session on an
 * outstanding tool forever and lock out every other inference. Give up on it.
 */
const STALE_TOOL_MS = 90_000;

/**
 * How long we stand behind a "Needs Input" we only inferred. A real permission
 * prompt can sit unanswered for hours, so this has to be generous; but a guess
 * that was simply wrong must not pulse at the user for the rest of the day.
 */
const INFERRED_PROMPT_GIVE_UP_MS = 5 * 60_000;

/** Plugin hooks quiet this long: assume they died, re-enable terminal reads. */
const PLUGIN_SILENCE_MS = 30_000;

/**
 * Terminal bytes that must accumulate before silence-broken-by-output counts
 * as "the agent is working". A blinking cursor or the echo of a keystroke
 * never reaches it; a working agent clears it immediately.
 */
const PTY_ACTIVITY_BYTES = 400;

/**
 * ...and the counter is capped here so it stays a rate rather than becoming a
 * running total. It drains at OUTPUT_DECAY_PER_TICK per tick — 100 bytes a
 * second — so without a cap a turn that printed half a megabyte would leave it
 * above the threshold for over an hour, and the next stray repaint would read
 * as "the agent went back to work". Capped, it drains in about twelve seconds.
 */
export const MAX_RECENT_OUTPUT_BYTES = PTY_ACTIVITY_BYTES * 3;

/** How often the per-session decay + inference tick runs. */
export const STATUS_TICK_MS = 500;

/** Bytes shaved off `recentOutputSize` each tick. */
const OUTPUT_DECAY_PER_TICK = 50;

/** Hook events whose status is a statement of fact rather than a guess. */
const AUTHORITATIVE_HOOK_EVENTS = new Set([
  "Notification",
  "Stop",
  "UserPromptSubmit",
  "SessionEnd",
  "SessionStart",
]);

export function statusSourceForHookEvent(
  hookEvent: string | undefined,
  reportedStatus: string,
): AgentStatusSource {
  if (hookEvent && AUTHORITATIVE_HOOK_EVENTS.has(hookEvent)) return "authoritative";
  // PreToolUse fires with an explicit `waiting_input` for tools that always
  // stop and ask (AskUserQuestion). That is the tool declaring itself, not an
  // inference off its timing.
  if (reportedStatus === "waiting_input") return "authoritative";
  return "hook";
}

function clearPendingStatus(session: Session) {
  if (session.pendingStatusTimer) clearTimeout(session.pendingStatusTimer);
  session.pendingStatusTimer = undefined;
  session.pendingStatus = undefined;
  session.pendingStatusSource = undefined;
  session.pendingStatusCommitAt = undefined;
}

/**
 * The one place a status message is shaped. Anything that pushes status to a
 * client goes through here — a second hand-rolled copy of this payload is how
 * `statusChangedAt` went missing on reconnect, silently resetting how long the
 * client thought a card had been waiting.
 */
export function sendAgentStatus(client: WebSocket, session: Session, hookEvent?: string) {
  sendTerminalMessage(client, {
    type: "status",
    status: session.status,
    statusChangedAt: session.statusChangedAt,
    isRestored: session.isRestored,
    currentTool: session.currentTool,
    hookEvent,
  });
}

function broadcastStatus(session: Session, hookEvent?: string) {
  for (const client of session.clients) sendAgentStatus(client, session, hookEvent);
}

function commitStatus(
  session: Session,
  status: AgentStatus,
  source: AgentStatusSource,
  hookEvent?: string,
) {
  clearPendingStatus(session);
  if (session.status === status) return;

  session.status = status;
  session.statusChangedAt = Date.now();
  session.statusSource = source;
  if (status !== "running" && status !== "tool_calling") {
    session.currentTool = undefined;
  }
  broadcastStatus(session, hookEvent);
}

interface ApplyStatusOptions {
  source: AgentStatusSource;
  hookEvent?: string;
  /** `null` clears the tool; `undefined` leaves whatever is already set. */
  currentTool?: string | null;
  /** Skip the debounce entirely. For session setup and teardown only. */
  immediate?: boolean;
}

/**
 * Propose a status for a session. Whether — and when — the UI sees it depends
 * on how certain the source is and what the card is showing right now.
 */
export function applyAgentStatus(
  session: Session,
  status: AgentStatus,
  options: ApplyStatusOptions,
) {
  const { source, hookEvent } = options;
  const now = Date.now();

  // The current tool is a detail of the running state rather than a state of
  // its own, so it lands immediately and the card follows along.
  if (options.currentTool !== undefined) {
    const nextTool = options.currentTool || undefined;
    const toolChanged = session.currentTool !== nextTool;
    session.currentTool = nextTool;
    if (toolChanged && session.status === status) broadcastStatus(session, hookEvent);
  }

  if (options.immediate) {
    commitStatus(session, status, source, hookEvent);
    return;
  }

  if (session.status === status) {
    // Already showing this, so there is nothing to schedule. Retracting a
    // queued change is only safe from a source at least as sure as the one
    // that queued it: Claude Code fires two PreToolUse hooks for
    // AskUserQuestion — one naming `waiting_input`, one generic `pre_tool`
    // that maps to `running` — they race, and letting the generic one cancel
    // the specific one leaves the card reading "Working" while the agent sits
    // waiting on an answer.
    const pendingRank = SOURCE_RANK[session.pendingStatusSource ?? "inferred"];
    if (!session.pendingStatus || SOURCE_RANK[source] >= pendingRank) {
      clearPendingStatus(session);
    }
    return;
  }

  let delay =
    source === "authoritative" ? AUTHORITATIVE_COMMIT_DELAY_MS : COMMIT_DELAY_MS[status] ?? 0;

  if (source !== "authoritative") {
    // A status we only inferred has not earned the right to block a correction.
    const dwell = session.statusSource === "inferred" ? 0 : MIN_DWELL_MS[session.status] ?? 0;
    // Clamp the timestamp: a backward clock step (sleep/wake, an NTP
    // correction) would otherwise make this look like it changed in the
    // future, and the dwell would be computed as minutes rather than seconds.
    const changedAt = Math.min(session.statusChangedAt ?? 0, now);
    const dwellRemaining = dwell - (now - changedAt);
    if (dwellRemaining > delay) delay = dwellRemaining;
  }

  // Whatever the arithmetic said, nothing waits longer than this. A status
  // parked minutes in the future can only be freed by an authoritative hook,
  // and the card lies in the meantime.
  delay = Math.min(delay, MAX_COMMIT_DELAY_MS);

  if (session.pendingStatus === status) {
    // Same candidate as the one already queued. Let the original timer run so a
    // repeated assertion cannot push the commit further and further out —
    // unless this proposal would land sooner, which is how a certain source
    // overtakes a guess already waiting out someone else's dwell.
    if (now + delay >= (session.pendingStatusCommitAt ?? 0)) return;
  } else if (session.pendingStatus && session.pendingStatusSource) {
    // A different candidate is queued. A weaker source must not cancel it.
    if (SOURCE_RANK[source] < SOURCE_RANK[session.pendingStatusSource]) return;
  }

  clearPendingStatus(session);

  if (delay <= 0) {
    commitStatus(session, status, source, hookEvent);
    return;
  }

  session.pendingStatus = status;
  session.pendingStatusSource = source;
  session.pendingStatusCommitAt = now + delay;
  session.pendingStatusTimer = setTimeout(() => {
    commitStatus(session, status, source, hookEvent);
  }, delay);
}

/**
 * Periodic status inference from the terminal. Runs on the same tick that
 * decays the output counter, for both fresh and restarted sessions.
 */
export function runAgentStatusWatchdog(session: Session) {
  const now = Date.now();

  // The plugin has gone quiet — unlock terminal-based inference so the card
  // can still recover if the hooks died mid-turn.
  if (session.pluginReportedStatus && session.lastPluginStatusTime) {
    if (now - session.lastPluginStatusTime > PLUGIN_SILENCE_MS) {
      session.pluginReportedStatus = false;
    }
  }

  // Let go of a tool call that will never report back, so it stops blocking
  // every inference below it.
  if (session.preToolTime && now - session.preToolTime > STALE_TOOL_MS) {
    session.preToolTime = undefined;
  }

  if (!session.lastOutputTime) return;
  const quietFor = now - session.lastOutputTime;
  const working = session.status === "running" || session.status === "tool_calling";

  if (working && session.preToolTime) {
    if (now - session.preToolTime >= PROMPT_MIN_PENDING_MS && quietFor >= PROMPT_QUIET_MS) {
      // Tool outstanding and the frame has gone static: parked on a prompt.
      applyAgentStatus(session, "waiting_input", {
        source: "inferred",
        hookEvent: "permission_prompt",
      });
    } else if (
      session.pendingStatus === "waiting_input" &&
      session.pendingStatusSource === "inferred"
    ) {
      // The terminal started printing again before that guess landed. The tool
      // was only slow, not waiting on anyone — retract it before the UI ever
      // sees it. Without this, a build's own output arrives too late to stop
      // the "Needs Input" its opening silence already queued.
      clearPendingStatus(session);
    }
    return;
  }

  // Long silence means the turn is over. This deliberately also covers a
  // "Needs Input" we merely inferred: a real prompt can sit for hours and must
  // be left alone, but a guess that was wrong should not pulse forever.
  const silenceLimit =
    session.status === "waiting_input" ? INFERRED_PROMPT_GIVE_UP_MS : IDLE_SILENCE_MS;
  const canConcede =
    working || (session.status === "waiting_input" && session.statusSource === "inferred");

  // A command still executing in the terminal is not an idle session, however
  // quiet it has gone. `make`, `docker build` and long test phases all go
  // silent for minutes while very much running.
  const commandRunning = session.terminalBlocks?.some((block) => block.status === "running");

  if (canConcede && !commandRunning && quietFor > silenceLimit) {
    applyAgentStatus(session, "idle", { source: "inferred", hookEvent: "output_silence" });
  }
}

/**
 * Terminal output arrived. Only sustained output counts — a single repaint
 * after the turn ended is not the agent going back to work.
 */
export function noteAgentOutputActivity(session: Session) {
  // Hook-driven sessions ignore terminal noise — except when the status on
  // screen is one the engine itself inferred. The watchdog only guesses
  // `waiting_input` while a tool is outstanding, which means the plugin IS
  // reporting; without this exception the engine writes a status from terminal
  // evidence and then refuses to correct it from the same evidence, leaving a
  // visibly-printing agent reading "Needs Input" until the plugin goes quiet.
  if (session.pluginReportedStatus && session.statusSource !== "inferred") return;
  if (session.recentOutputSize < PTY_ACTIVITY_BYTES) return;

  // `disconnected` is deliberately NOT recoverable here. The PTY is a shell
  // with the agent running inside it, so `/exit` ends the agent while the
  // shell lives on — and it is tempting to revive the card when that shell
  // prints again. But the agent really is gone: the trailing output of the
  // exit itself, or the echo of someone typing at the bare prompt, would put
  // the card back to "Working" with nothing working. "Offline" is the true
  // label, and the sidebar already offers New Session from there.
  if (session.status !== "idle" && session.status !== "waiting_input") return;

  applyAgentStatus(session, "running", { source: "inferred", hookEvent: "output_activity" });
}

/**
 * Start the per-session decay + inference tick. Owns its own handle so a
 * restart can stop the previous one: the old self-clearing guard checked
 * `session.pty`, which a restart re-populates before the next tick fires,
 * leaving the stale interval running forever alongside the new one and
 * decaying the output counter at twice the intended rate.
 */
export function startAgentStatusTicker(
  sessionId: string,
  session: Session,
  sessions: Map<string, Session>,
) {
  stopAgentStatusTicker(session);
  session.statusTicker = setInterval(() => {
    if (sessions.get(sessionId) !== session || !session.pty) {
      stopAgentStatusTicker(session);
      return;
    }
    session.recentOutputSize = Math.max(0, session.recentOutputSize - OUTPUT_DECAY_PER_TICK);
    runAgentStatusWatchdog(session);
  }, STATUS_TICK_MS);
}

export function stopAgentStatusTicker(session: Session) {
  if (session.statusTicker) clearInterval(session.statusTicker);
  session.statusTicker = undefined;
}

/** Drop any queued status work. Call before a session is torn down. */
export function disposeAgentStatus(session: Session) {
  clearPendingStatus(session);
  stopAgentStatusTicker(session);
}
