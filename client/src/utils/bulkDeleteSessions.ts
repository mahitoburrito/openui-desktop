import { useStore } from "../stores/useStore";
import { destroyCachedTerminal } from "../components/Terminal";

// Soft-deletes the given canvas sessions with a single confirm and a single
// undo toast. Used by the header trash button, the selection action bar, and
// the keyboard delete path in App. Returns false if the user cancelled.
export async function bulkDeleteSessions(nodeIds: string[]): Promise<boolean> {
  const state = useStore.getState();
  const targets = nodeIds.flatMap((nodeId) => {
    const session = state.sessions.get(nodeId);
    return session ? [{ nodeId, session }] : [];
  });
  if (targets.length === 0) return false;

  const label =
    targets.length === 1
      ? `"${targets[0].session.customName || targets[0].session.agentName || "Session"}"`
      : `${targets.length} sessions`;
  const confirmed = window.confirm(`Delete ${label}? You'll have 5 seconds to undo.`);
  if (!confirmed) return false;

  const deleted: { sessionId: string; nodeId: string; sessionName: string }[] = [];
  let failedCount = 0;
  await Promise.all(
    targets.map(async ({ nodeId, session }) => {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(session.sessionId)}/soft-delete`,
          { method: "POST", signal: AbortSignal.timeout(10000) },
        );
        // 404 = already gone (deleted elsewhere) — treat as deleted, not failed
        if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      } catch (error) {
        console.error(`[bulk-delete] soft-delete failed for ${session.sessionId}:`, error);
        failedCount += 1;
        return;
      }
      deleted.push({
        sessionId: session.sessionId,
        nodeId,
        sessionName: session.customName || session.agentName || "Session",
      });
    }),
  );

  if (deleted.length === 0) {
    window.alert(`Could not delete ${label}.`);
    return true;
  }

  const current = useStore.getState();
  for (const item of deleted) {
    destroyCachedTerminal(item.sessionId);
    current.removeFocusedSession(item.nodeId);
    current.removeSession(item.nodeId);
    current.removeNode(item.nodeId);
  }
  if (current.selectedNodeId && deleted.some((item) => item.nodeId === current.selectedNodeId)) {
    current.setSelectedNodeId(null);
    current.setSidebarOpen(false);
  }
  const deletedIds = new Set(deleted.map((item) => item.nodeId));
  current.setMultiSelectedNodeIds(
    current.multiSelectedNodeIds.filter((id) => !deletedIds.has(id)),
  );

  const timeout = setTimeout(() => useStore.getState().setDeleteToast(null), 5000);
  current.setDeleteToast({
    sessionId: deleted[0].sessionId,
    nodeId: deleted[0].nodeId,
    sessionName: deleted[0].sessionName,
    items: deleted.length > 1 ? deleted : undefined,
    timeout,
  });

  // Report partial failures only after the toast is up — a blocking alert
  // shown first would eat the undo window while the server's delete timers
  // keep running.
  if (failedCount > 0) {
    setTimeout(() => {
      window.alert(`Could not delete ${failedCount} of ${targets.length} sessions.`);
    }, 0);
  }
  return true;
}
