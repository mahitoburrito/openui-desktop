import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Search,
  Square,
  Loader2,
  ChevronDown,
  ChevronRight,
  Wrench,
  Brain,
  AlertCircle,
  CheckCircle2,
  MessageSquare,
  Send,
} from "lucide-react";
import { usePRBEStore } from "../stores/usePRBEStore";
import type { PRBEStatusEvent } from "../types/prbe";

function EventItem({ event }: { event: PRBEStatusEvent }) {
  const [expanded, setExpanded] = useState(event.isExpanded);

  const isToolCall = event.label.toLowerCase().includes("tool") || event.label.includes("client_");
  const isThinking = event.label.toLowerCase().includes("think");
  const isComplete = event.isCompleted;

  return (
    <div className="px-4 py-2 border-b border-border/50 last:border-b-0">
      <button
        onClick={() => event.detail && setExpanded(!expanded)}
        className="w-full flex items-center gap-2 text-left"
      >
        <div className="flex-shrink-0">
          {!isComplete && isThinking ? (
            <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />
          ) : isToolCall ? (
            <Wrench className="w-3.5 h-3.5 text-purple-400" />
          ) : isComplete ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
          ) : (
            <Brain className="w-3.5 h-3.5 text-blue-400" />
          )}
        </div>
        <span className="text-xs text-zinc-300 flex-1 truncate">{event.label}</span>
        {event.detail && (
          <div className="flex-shrink-0">
            {expanded ? (
              <ChevronDown className="w-3 h-3 text-zinc-500" />
            ) : (
              <ChevronRight className="w-3 h-3 text-zinc-500" />
            )}
          </div>
        )}
      </button>
      {expanded && event.detail && (
        <div className="mt-1.5 ml-5.5 text-[11px] text-zinc-500 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
          {event.detail}
        </div>
      )}
    </div>
  );
}

export function PRBEPanel() {
  const {
    panelOpen,
    setPanelOpen,
    isInvestigating,
    currentQuery,
    events,
    report,
    summary,
    investigationError,
    agentMessage,
    completedInvestigations,
    startInvestigation,
    stopInvestigation,
  } = usePRBEStore();

  const [query, setQuery] = useState("");
  const [followUpMessage, setFollowUpMessage] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll feed
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [events, agentMessage]);

  const handleSubmit = () => {
    const trimmed = query.trim();
    if (!trimmed || isInvestigating) return;
    startInvestigation(trimmed);
    setQuery("");
  };

  const handleSendFollowUp = () => {
    const trimmed = followUpMessage.trim();
    if (!trimmed) return;
    usePRBEStore.getState().sendMessage(trimmed);
    setFollowUpMessage("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const hasReport = !!report;
  const hasError = !!investigationError;

  return (
    <AnimatePresence>
      {panelOpen && (
        <motion.div
          initial={{ x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 40 }}
          className="fixed right-0 top-14 bottom-0 z-40 w-[480px] flex flex-col bg-canvas-dark border-l border-border"
        >
          {/* Header */}
          <div className="flex-shrink-0 px-4 py-3 border-b border-border flex items-center gap-3">
            <div className="w-6 h-6 rounded bg-orange-500/20 flex items-center justify-center">
              <Search className="w-3.5 h-3.5 text-orange-400" />
            </div>
            <div className="flex-1">
              <h2 className="text-sm font-medium text-white">PRBE Debugger</h2>
              <span className="text-[10px] text-zinc-500">
                {isInvestigating ? "Investigating..." : hasReport ? "Investigation complete" : "AI-powered debugging"}
              </span>
            </div>
            <button
              onClick={() => setPanelOpen(false)}
              className="w-7 h-7 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-surface-active transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Input */}
          <div className="flex-shrink-0 px-4 py-3 border-b border-border">
            <div className="flex gap-2">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Describe the issue to investigate..."
                disabled={isInvestigating}
                className="flex-1 px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors disabled:opacity-50"
              />
              {isInvestigating ? (
                <button
                  onClick={stopInvestigation}
                  className="px-3 py-2 rounded-md bg-red-600 text-white text-sm font-medium hover:bg-red-500 transition-colors flex items-center gap-1.5"
                >
                  <Square className="w-3.5 h-3.5" />
                  Stop
                </button>
              ) : (
                <button
                  onClick={handleSubmit}
                  disabled={!query.trim()}
                  className="px-3 py-2 rounded-md bg-orange-600 text-white text-sm font-medium hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                >
                  <Search className="w-3.5 h-3.5" />
                  Investigate
                </button>
              )}
            </div>
          </div>

          {/* Content area */}
          <div className="flex-1 min-h-0 flex flex-col">
            {/* Active investigation or report */}
            {(isInvestigating || hasReport || hasError || events.length > 0) ? (
              <>
                {/* Current query */}
                {currentQuery && (
                  <div className="flex-shrink-0 px-4 py-2 bg-surface/50 border-b border-border">
                    <p className="text-xs text-zinc-400">
                      <span className="text-zinc-500">Query: </span>
                      {currentQuery}
                    </p>
                  </div>
                )}

                {/* Event feed */}
                <div
                  ref={feedRef}
                  className="flex-1 min-h-0 overflow-y-auto"
                >
                  {events.map((event) => (
                    <EventItem key={event.id} event={event} />
                  ))}

                  {/* Agent message */}
                  {agentMessage && (
                    <div className="px-4 py-2 border-b border-border/50">
                      <div className="flex items-start gap-2">
                        <MessageSquare className="w-3.5 h-3.5 text-orange-400 mt-0.5 flex-shrink-0" />
                        <p className="text-xs text-zinc-300">{agentMessage}</p>
                      </div>
                    </div>
                  )}

                  {/* Error */}
                  {hasError && (
                    <div className="px-4 py-3">
                      <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/20">
                        <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="text-xs font-medium text-red-400">Investigation Error</p>
                          <p className="text-xs text-red-400/70 mt-0.5">{investigationError}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Report */}
                  {hasReport && (
                    <div className="px-4 py-3">
                      <div className="rounded-md bg-surface border border-border p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <CheckCircle2 className="w-4 h-4 text-green-400" />
                          <span className="text-xs font-medium text-green-400">Investigation Report</span>
                        </div>
                        {summary && (
                          <p className="text-xs text-zinc-400 mb-2 pb-2 border-b border-border">{summary}</p>
                        )}
                        <div className="text-xs text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed max-h-[400px] overflow-y-auto">
                          {report}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Loading indicator */}
                  {isInvestigating && events.length === 0 && (
                    <div className="px-4 py-6 flex items-center justify-center gap-2">
                      <Loader2 className="w-4 h-4 text-orange-400 animate-spin" />
                      <span className="text-xs text-zinc-500">Starting investigation...</span>
                    </div>
                  )}
                </div>

                {/* Follow-up message input during investigation */}
                {isInvestigating && (
                  <div className="flex-shrink-0 px-4 py-2 border-t border-border">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={followUpMessage}
                        onChange={(e) => setFollowUpMessage(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleSendFollowUp();
                          }
                        }}
                        placeholder="Send a message to the agent..."
                        className="flex-1 px-3 py-1.5 rounded-md bg-canvas border border-border text-white text-xs placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                      />
                      <button
                        onClick={handleSendFollowUp}
                        disabled={!followUpMessage.trim()}
                        className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-surface-active disabled:opacity-30 transition-colors"
                      >
                        <Send className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              /* Empty / history state */
              <div className="flex-1 flex flex-col">
                {completedInvestigations.length > 0 ? (
                  <div className="flex-1 overflow-y-auto">
                    <div className="px-4 py-2">
                      <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Recent Investigations</span>
                    </div>
                    {completedInvestigations.map((inv) => (
                      <button
                        key={inv.id}
                        onClick={() => {
                          setQuery(inv.query);
                        }}
                        className="w-full px-4 py-2 text-left hover:bg-surface-active transition-colors border-b border-border/50"
                      >
                        <p className="text-xs text-zinc-300 truncate">{inv.query}</p>
                        <p className="text-[10px] text-zinc-500 mt-0.5">
                          {new Date(inv.completedAt).toLocaleString()}
                        </p>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center px-8">
                      <Search className="w-8 h-8 text-zinc-700 mx-auto mb-3" />
                      <p className="text-sm text-zinc-400 mb-1">No investigations yet</p>
                      <p className="text-xs text-zinc-600">
                        Describe an issue and PRBE will investigate your agent sessions, logs, and files to find the root cause.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
