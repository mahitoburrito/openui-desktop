import { useEffect, useRef } from "react";
import { useStore, AgentStatus } from "../stores/useStore";
import { sessionDisplayTitle } from "../utils/sessionTitle";

const NOTIFY_STATUSES: Set<AgentStatus> = new Set([
  "waiting_input",
  "idle",
  "disconnected",
  "error",
]);

function getNotificationBody(status: AgentStatus, name: string): string {
  switch (status) {
    case "waiting_input":
      return `${name} is waiting for your input`;
    case "idle":
      return `${name} has finished`;
    case "disconnected":
      return `${name} session ended`;
    case "error":
      return `${name} hit an error`;
    default:
      return `${name}: ${status}`;
  }
}

/**
 * Watches session status transitions and records them for the header activity
 * bell. Agent events should stay quiet in-app; the bell badge is the only
 * screen-level signal for unread activity.
 */
export function useDesktopNotifications() {
  const sessions = useStore((s) => s.sessions);
  const addAgentActivityEvent = useStore((s) => s.addAgentActivityEvent);
  const prevStatuses = useRef<Map<string, AgentStatus>>(new Map());

  useEffect(() => {
    for (const [nodeId, session] of sessions) {
      const prev = prevStatuses.current.get(nodeId);
      prevStatuses.current.set(nodeId, session.status);

      if (prev === undefined || prev === session.status) continue;
      if (!NOTIFY_STATUSES.has(session.status)) continue;

      const name = sessionDisplayTitle(session, session.sessionId);
      const body = getNotificationBody(session.status, name);
      addAgentActivityEvent({
        nodeId,
        sessionId: session.sessionId,
        title: name,
        body,
        status: session.status,
        color: session.customColor || session.color || "#888",
        repoPath: session.originalCwd || session.cwd,
      });
    }

    for (const nodeId of prevStatuses.current.keys()) {
      if (!sessions.has(nodeId)) {
        prevStatuses.current.delete(nodeId);
      }
    }
  }, [sessions, addAgentActivityEvent]);
}
