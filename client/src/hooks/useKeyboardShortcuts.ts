import { useEffect } from "react";
import { useStore } from "../stores/useStore";
import { useReactFlow, useStoreApi } from "@xyflow/react";

export function useKeyboardShortcuts() {
  const reactFlow = useReactFlow();
  const rfStore = useStoreApi();

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
        setSelectedNodeId,
        setSidebarOpen,
        addFocusedSession,
        setCommandPaletteOpen,
        activityCenterOpen,
        setActivityCenterOpen,
        browserPanelOpen,
        setBrowserPanelOpen,
        selectionModeActive,
        setSelectionModeActive,
      } = useStore.getState();

      // Escape — close transient panels first
      if (e.key === "Escape" && activityCenterOpen) {
        e.preventDefault();
        setActivityCenterOpen(false);
        return;
      }

      // Escape — exit selection mode (unless an overlay owns the key: the
      // palette/modals handle their own Escape and one press must not also
      // silently destroy the selection behind them)
      if (e.key === "Escape" && selectionModeActive && viewMode === "canvas") {
        const { commandPaletteOpen, addAgentModalOpen, newSessionModalOpen } =
          useStore.getState();
        if (commandPaletteOpen || addAgentModalOpen || newSessionModalOpen) return;
        e.preventDefault();
        setSelectionModeActive(false);
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

      // Cmd+A — select all sessions while in selection mode
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "a" &&
        selectionModeActive &&
        viewMode === "canvas"
      ) {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        // Select through React Flow's API so its internal selection state
        // stays in sync (prop-level selected flags alone diverge from it).
        rfStore.getState().addSelectedNodes(
          useStore
            .getState()
            .nodes.filter((n) => n.type === "agent")
            .map((n) => n.id),
        );
        return;
      }

      // Escape - close focus-mode browser dock before exiting focus mode
      if (e.key === "Escape" && viewMode === "focus" && browserPanelOpen) {
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

      // Cmd+1 through Cmd+9 — jump to nth session (not in selection mode:
      // it would reopen the sidebar and re-arm single-delete state the mode
      // deliberately cleared)
      if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
        if (selectionModeActive && viewMode === "canvas") return;
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
        if (selectionModeActive && viewMode === "canvas") return;
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
  }, [reactFlow, rfStore]);
}
