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
        selectedNodeId,
            setSidebarOpen,
        addFocusedSession,
        setCommandPaletteOpen,
        activityCenterOpen,
        setActivityCenterOpen,
        browserPanelOpen,
        setBrowserPanelOpen,
      } = useStore.getState();

      // Escape — close transient panels first
      if (e.key === "Escape" && activityCenterOpen) {
        e.preventDefault();
        setActivityCenterOpen(false);
        return;
      }

      // Cmd+K / Cmd+Shift+P — command palette
      if (
        ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") ||
        ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p")
      ) {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      // Cmd+Shift+A — agent activity center
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        setActivityCenterOpen(true);
        return;
      }

      // Escape — close the browser dock from any view.
      if (e.key === "Escape" && browserPanelOpen) {
        e.preventDefault();
        setBrowserPanelOpen(false);
        return;
      }

      // Escape — exit focus / diff mode
      if (
        e.key === "Escape" &&
        (viewMode === "focus" ||
          viewMode === "diff")
      ) {
        e.preventDefault();
        setViewMode("canvas");
        return;
      }

      // Cmd+Shift+D — toggle diff viewer
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        setViewMode(viewMode === "diff" ? "canvas" : "diff");
        return;
      }

      // Cmd+Shift+B — toggle embedded browser
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        if (viewMode !== "focus") {
          if (selectedNodeId && sessions.has(selectedNodeId)) {
            addFocusedSession(selectedNodeId);
          } else if (focusedSessionIds.length === 0) {
            return;
          }
          setSidebarOpen(false);
          setViewMode("focus");
          setBrowserPanelOpen(true);
          return;
        }
        setBrowserPanelOpen(!browserPanelOpen);
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
          useStore.getState().openSessionInFocus(nodeId);

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
