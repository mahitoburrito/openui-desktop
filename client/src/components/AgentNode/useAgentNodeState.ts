import { useState, useEffect } from "react";
import { useStore, AgentSession } from "../../stores/useStore";
import { destroyCachedTerminal } from "../Terminal";

interface AgentNodeData {
  sessionId: string;
}

export function useAgentNodeState(
  id: string,
  nodeData: AgentNodeData,
  session: AgentSession | undefined
) {
  const { removeNode, removeSession, setSelectedNodeId, setSidebarOpen, setDeleteToast } =
    useStore();

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Close context menu on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".context-menu-container")) {
        return;
      }
      setContextMenu(null);
    };
    if (contextMenu) {
      setTimeout(() => {
        window.addEventListener("click", handleClick);
      }, 0);
      return () => window.removeEventListener("click", handleClick);
    }
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleDelete = async () => {
    const sessionId = session?.sessionId || nodeData.sessionId;
    const sessionName = session?.customName || session?.agentName || "Session";

    // Confirmation dialog
    const confirmed = window.confirm(`Delete "${sessionName}"? You'll have 5 seconds to undo.`);
    if (!confirmed) return;

    // Soft-delete on the server
    if (sessionId) {
      await fetch(`/api/sessions/${sessionId}/soft-delete`, { method: "POST" });
    }

    // Clean up cached terminal instance
    if (sessionId) {
      destroyCachedTerminal(sessionId);
    }

    // Remove from UI immediately
    removeSession(id);
    removeNode(id);
    setSelectedNodeId(null);
    setSidebarOpen(false);

    // Show undo toast
    const timeout = setTimeout(() => {
      setDeleteToast(null);
    }, 5000);

    setDeleteToast({
      sessionId: sessionId || "",
      nodeId: id,
      sessionName,
      timeout,
    });
  };

  const closeContextMenu = () => {
    setContextMenu(null);
  };

  return {
    contextMenu,
    handleContextMenu,
    handleDelete,
    closeContextMenu,
  };
}
