import { useEffect, useRef } from "react";
import { useStore, AgentStatus } from "../stores/useStore";

const NOTIF_STORAGE_KEY = "openui-desktop-notifications";

const NOTIFY_STATUSES: Set<AgentStatus> = new Set([
  "waiting_input",
  "idle",
  "disconnected",
]);

function getNotificationBody(status: AgentStatus, name: string): string {
  switch (status) {
    case "waiting_input":
      return `${name} is waiting for your input`;
    case "idle":
      return `${name} has finished`;
    case "disconnected":
      return `${name} session ended`;
    default:
      return `${name}: ${status}`;
  }
}

/**
 * Watches session status transitions and fires native desktop notifications
 * when the window is not focused and the user has enabled them in settings.
 */
export function useDesktopNotifications() {
  const sessions = useStore((s) => s.sessions);
  const prevStatuses = useRef<Map<string, AgentStatus>>(new Map());

  useEffect(() => {
    const enabled = localStorage.getItem(NOTIF_STORAGE_KEY) === "true";
    if (!enabled || Notification.permission !== "granted") {
      for (const [nodeId, session] of sessions) {
        prevStatuses.current.set(nodeId, session.status);
      }
      return;
    }

    if (document.hasFocus()) {
      for (const [nodeId, session] of sessions) {
        prevStatuses.current.set(nodeId, session.status);
      }
      return;
    }

    for (const [nodeId, session] of sessions) {
      const prev = prevStatuses.current.get(nodeId);
      prevStatuses.current.set(nodeId, session.status);

      if (prev === undefined || prev === session.status) continue;
      if (!NOTIFY_STATUSES.has(session.status)) continue;

      const name = session.customName || session.agentName || session.sessionId;
      new Notification("OpenUI Desktop", {
        body: getNotificationBody(session.status, name),
        silent: false,
      });
    }

    for (const nodeId of prevStatuses.current.keys()) {
      if (!sessions.has(nodeId)) {
        prevStatuses.current.delete(nodeId);
      }
    }
  }, [sessions]);
}
