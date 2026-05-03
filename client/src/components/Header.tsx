import { useState } from "react";
import { Plus, Folder, Settings, Bug, List, Maximize2, Layout, FileText } from "lucide-react";
import { motion } from "framer-motion";
import { useStore } from "../stores/useStore";
import { usePRBEStore } from "../stores/usePRBEStore";
import { SettingsModal } from "./SettingsModal";

export function Header() {
  const {
    setAddAgentModalOpen,
    sessions,
    launchCwd,
    sessionListOpen,
    setSessionListOpen,
    viewMode,
    setViewMode,
    focusedSessionIds,
    openMarkdownFiles,
  } = useStore();
  const { isAvailable: prbeAvailable, hasApiKey: prbeHasKey, isInvestigating: prbeInvestigating, pendingInteraction: prbeInteraction, setPanelOpen: setPrbePanelOpen } = usePRBEStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const showPrbeButton = prbeAvailable && prbeHasKey;

  // Count sessions needing attention
  const needsAttentionCount = Array.from(sessions.values()).filter(
    (s) => s.status === "waiting_input" || s.status === "error"
  ).length;

  return (
    <header className="h-14 px-4 flex items-center justify-between border-b border-border bg-canvas-dark titlebar-drag">
      {/* Logo */}
      <div className="flex items-center gap-3 pl-16">
        <div className="flex items-center gap-2">
          <svg className="w-6 h-6" viewBox="0 0 280 280" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="header-logo-g" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#ffd89b"/>
                <stop offset="50%" stopColor="#f78c3a"/>
                <stop offset="100%" stopColor="#c45a10"/>
              </linearGradient>
            </defs>
            <rect x="52" y="52" width="176" height="176" rx="44" fill="#f78c3a" opacity="0.15"/>
            <rect x="45" y="45" width="176" height="176" rx="44" fill="url(#header-logo-g)"/>
            <g fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" opacity="0.85">
              <line x1="133" y1="82" x2="133" y2="195"/>
              <line x1="76" y1="138" x2="190" y2="138"/>
              <line x1="93" y1="99" x2="173" y2="179"/>
              <line x1="173" y1="99" x2="93" y2="179"/>
            </g>
            <g fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round">
              <line x1="188" y1="60" x2="188" y2="90"/>
              <line x1="173" y1="75" x2="203" y2="75"/>
              <line x1="177" y1="64" x2="199" y2="86"/>
              <line x1="199" y1="64" x2="177" y2="86"/>
            </g>
          </svg>
          <span className="text-sm font-semibold text-white">OpenUI Desktop</span>
        </div>
        
        <div className="h-4 w-px bg-border mx-2" />
        
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <Folder className="w-3 h-3" />
          <span className="font-mono truncate max-w-[200px]">{launchCwd || "~"}</span>
        </div>
      </div>

      {/* Center - Session count */}
      <div className="absolute left-1/2 -translate-x-1/2">
        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-surface text-xs text-zinc-400">
          <div className={`w-1.5 h-1.5 rounded-full ${sessions.size > 0 ? 'bg-green-500' : 'bg-zinc-600'}`} />
          <span>{sessions.size} agent{sessions.size !== 1 ? "s" : ""}</span>
        </div>
      </div>

      {/* Right side buttons */}
      <div className="flex items-center gap-2 titlebar-no-drag">
        {/* Session list toggle */}
        <button
          onClick={() => setSessionListOpen(!sessionListOpen)}
          className={`relative p-2 rounded-md transition-colors ${
            sessionListOpen
              ? "text-white bg-surface-active"
              : "text-zinc-400 hover:text-white hover:bg-surface-active"
          }`}
          title="Toggle session list (Cmd+\\)"
        >
          <List className="w-4 h-4" />
          {needsAttentionCount > 0 && (
            <div className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-orange-500 text-[9px] text-white font-bold flex items-center justify-center">
              {needsAttentionCount}
            </div>
          )}
        </button>

        {/* Markdown viewer toggle — always available */}
        <button
          onClick={() =>
            setViewMode(viewMode === "markdown" ? "canvas" : "markdown")
          }
          className={`relative flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
            viewMode === "markdown"
              ? "text-purple-300 bg-purple-500/20 hover:bg-purple-500/30"
              : "text-zinc-400 hover:text-white hover:bg-surface-active"
          }`}
          title="Markdown viewer (Cmd+Shift+M)"
        >
          <FileText className="w-3.5 h-3.5" />
          {viewMode === "markdown"
            ? "Canvas"
            : openMarkdownFiles.length > 0
              ? `Markdown (${openMarkdownFiles.length})`
              : "Markdown"}
        </button>

        {/* Focus mode toggle */}
        {focusedSessionIds.length > 0 && (
          <button
            onClick={() => setViewMode(viewMode === "focus" ? "canvas" : "focus")}
            className={`relative flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
              viewMode === "focus"
                ? "text-blue-400 bg-blue-500/20 hover:bg-blue-500/30"
                : "text-zinc-400 hover:text-white hover:bg-surface-active"
            }`}
            title="Toggle focus mode (Cmd+Shift+F)"
          >
            {viewMode === "focus" ? (
              <Layout className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
            {viewMode === "focus" ? "Canvas" : `Focus (${focusedSessionIds.length})`}
          </button>
        )}

        <div className="h-4 w-px bg-border" />
        {showPrbeButton && (
          <button
            onClick={() => setPrbePanelOpen(true)}
            className="relative p-2 rounded-md text-zinc-400 hover:text-orange-400 hover:bg-surface-active transition-colors"
            title="PRBE Debugger"
          >
            <Bug className="w-4 h-4" />
            {(prbeInvestigating || prbeInteraction) && (
              <div className="absolute top-1 right-1 w-2 h-2 rounded-full bg-orange-500" />
            )}
          </button>
        )}
        <button
          onClick={() => setSettingsOpen(true)}
          className="p-2 rounded-md text-zinc-400 hover:text-white hover:bg-surface-active transition-colors"
          title="Settings"
        >
          <Settings className="w-4 h-4" />
        </button>
        <motion.button
          onClick={() => setAddAgentModalOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white text-canvas text-sm font-medium hover:bg-zinc-100 transition-colors"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          <Plus className="w-4 h-4" />
          New Agent
        </motion.button>
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}
