import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useStore, type AgentStatus } from "../stores/useStore";
import { AgentIcon, getAgentAccentColor } from "./AgentIcon";
import { SessionChat } from "./SessionChat";
import { Terminal } from "./Terminal";
import { WorkspaceIconButton } from "./WorkspaceChrome";

const statusConfig: Record<AgentStatus, { label: string; color: string }> = {
  creating: { label: "Creating…", color: "#818CF8" },
  running: { label: "Working", color: "#22C55E" },
  tool_calling: { label: "Working", color: "#22C55E" },
  waiting_input: { label: "Needs input", color: "#D97652" },
  idle: { label: "Idle", color: "#FBBF24" },
  disconnected: { label: "Offline", color: "#6B7280" },
  error: { label: "Error", color: "#EF4444" },
};

type PreviewView = "chat" | "terminal";

export function Sidebar() {
  const {
    sidebarOpen,
    setSidebarOpen,
    viewMode,
    selectedNodeId,
    setSelectedNodeId,
    sessions,
    nodes,
    openSessionInFocus,
    setNewSessionModalOpen,
    setNewSessionForNodeId,
  } = useStore();
  const [previewView, setPreviewView] = useState<PreviewView>("chat");

  const session = selectedNodeId ? sessions.get(selectedNodeId) : null;
  const node = selectedNodeId ? nodes.find((item) => item.id === selectedNodeId) : null;

  useEffect(() => {
    if (viewMode === "focus" && sidebarOpen) setSidebarOpen(false);
  }, [sidebarOpen, setSidebarOpen, viewMode]);

  useEffect(() => {
    setPreviewView("chat");
  }, [session?.sessionId]);

  if (!session || !selectedNodeId) return null;

  const status = statusConfig[session.status] || statusConfig.idle;
  const color = getAgentAccentColor(
    session.agentId,
    session.customColor || session.color,
  );
  const title = session.customName || session.agentName;
  const cwd = session.cwd || session.originalCwd || "~";

  const close = () => {
    setSidebarOpen(false);
    setSelectedNodeId(null);
  };

  return (
    <AnimatePresence>
      {sidebarOpen && (
        <motion.aside
          initial={{ x: 36, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 36, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="focus-chat-surface fixed bottom-3 right-3 top-[54px] z-[65] flex w-[min(620px,calc(100vw-30px))] flex-col overflow-hidden rounded-[18px] border border-white/[0.085] shadow-[-24px_16px_64px_oklch(0.02_0.004_255/.28)]"
          aria-label={`${title} preview`}
        >
          <header className="flex h-[52px] flex-shrink-0 items-center gap-2.5 border-b border-white/[0.065] bg-white/[0.018] px-3.5">
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[7px] border border-white/[0.065] bg-white/[0.03]">
              <AgentIcon
                agentId={session.agentId}
                iconId={(node?.data?.icon as string) || session.agentId}
                className="h-[17px] w-[17px]"
                style={{ color }}
              />
            </span>
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-[12px] font-semibold text-zinc-200">{title}</strong>
              <span className="mt-0.5 flex items-center gap-1.5 text-[9.5px]" style={{ color: status.color }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: status.color }} />
                {status.label}
              </span>
            </span>

            <div className="flex items-center gap-0.5 rounded-[10px] border border-white/[0.055] bg-white/[0.025] p-0.5">
              <WorkspaceIconButton
                icon="comment-discussion"
                label="Chat"
                active={previewView === "chat"}
                onClick={() => setPreviewView("chat")}
                className="h-7 w-7"
                iconSize={13}
              />
              <WorkspaceIconButton
                icon="terminal"
                label="Terminal"
                active={previewView === "terminal"}
                onClick={() => setPreviewView("terminal")}
                className="h-7 w-7"
                iconSize={13}
              />
            </div>
            <WorkspaceIconButton
              icon="screen-full"
              label="Open focus"
              onClick={() => openSessionInFocus(selectedNodeId)}
              title="Open full Focus"
              className="h-7 w-7"
              iconSize={13}
            />
            <WorkspaceIconButton
              icon="refresh"
              label="New session"
              onClick={() => {
                setNewSessionForNodeId(selectedNodeId);
                setNewSessionModalOpen(true);
              }}
              className="h-7 w-7"
              iconSize={13}
            />
            <WorkspaceIconButton
              icon="close"
              label="Close preview"
              onClick={close}
              className="h-7 w-7"
              iconSize={13}
            />
          </header>

          <div className="min-h-0 flex-1">
            {previewView === "chat" ? (
              <SessionChat
                sessionId={session.sessionId}
                directory={cwd}
                statusLabel={status.label}
                statusColor={status.color}
                agentId={session.agentId}
                agentName={session.agentName}
                agentColor={color}
                showHeader={false}
              />
            ) : (
              <div className="h-full min-h-0 bg-[oklch(0.09_0.004_255)]">
                <Terminal
                  key={`preview-${session.sessionId}`}
                  sessionId={session.sessionId}
                  color={color}
                  nodeId={selectedNodeId}
                  cwd={session.cwd}
                  glass
                />
              </div>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
