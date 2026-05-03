import { useEffect } from "react";
import { useStore } from "../stores/useStore";
import { useReactFlow } from "@xyflow/react";

export function useKeyboardShortcuts() {
  const reactFlow = useReactFlow();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const {
        sessionListOpen,
        setSessionListOpen,
        viewMode,
        setViewMode,
        focusedSessionIds,
        sessions,
        nodes,
        setSelectedNodeId,
        setSidebarOpen,
        addFocusedSession,
      } = useStore.getState();

      // Escape — exit focus / markdown mode
      if (e.key === "Escape" && (viewMode === "focus" || viewMode === "markdown")) {
        e.preventDefault();
        setViewMode("canvas");
        return;
      }

      // Cmd+Shift+M — toggle markdown viewer
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "m" || e.key === "M")) {
        e.preventDefault();
        setViewMode(viewMode === "markdown" ? "canvas" : "markdown");
        return;
      }

      // Cmd+\ — toggle session list panel
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setSessionListOpen(!sessionListOpen);
        return;
      }

      // Cmd+Shift+F — toggle focus mode
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "f") {
        // Don't override browser find if no sessions are pinned
        if (focusedSessionIds.length === 0) return;
        e.preventDefault();
        setViewMode(viewMode === "focus" ? "canvas" : "focus");
        return;
      }

      // Cmd+1 through Cmd+9 — jump to nth session
      if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
        const index = parseInt(e.key) - 1;
        const sessionEntries = Array.from(sessions.entries());
        if (index < sessionEntries.length) {
          e.preventDefault();
          const [nodeId] = sessionEntries[index];
          setSelectedNodeId(nodeId);
          setSidebarOpen(true);

          if (viewMode === "canvas") {
            const node = nodes.find((n) => n.id === nodeId);
            if (node) {
              reactFlow.setCenter(node.position.x + 110, node.position.y + 60, {
                zoom: 1.2,
                duration: 400,
              });
            }
          }
        }
        return;
      }

      // Cmd+Enter — pin selected session and enter focus mode
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        const selectedNodeId = useStore.getState().selectedNodeId;
        if (selectedNodeId && sessions.has(selectedNodeId)) {
          e.preventDefault();
          if (!focusedSessionIds.includes(selectedNodeId)) {
            addFocusedSession(selectedNodeId);
          }
          setViewMode("focus");
        }
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [reactFlow]);
}
