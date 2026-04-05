import { useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { MessageSquare, Shield, FolderOpen, Eye, Send } from "lucide-react";
import { usePRBEStore } from "../stores/usePRBEStore";
import { InteractionType } from "../types/prbe";
import type {
  AskQuestionPayload,
  RequestPermissionPayload,
  RequestPathAccessPayload,
  ReviewSanitizedOutputPayload,
} from "../types/prbe";

export function PRBEInteractionDialog() {
  const { pendingInteraction, respondToInteraction } = usePRBEStore();
  const [answer, setAnswer] = useState("");

  if (!pendingInteraction) return null;

  const handleAskQuestionSubmit = () => {
    if (!answer.trim()) return;
    respondToInteraction(pendingInteraction.interactionId, {
      type: InteractionType.ASK_QUESTION,
      answer: answer.trim(),
    });
    setAnswer("");
  };

  const handlePermissionResponse = (approved: boolean) => {
    respondToInteraction(pendingInteraction.interactionId, {
      type: InteractionType.REQUEST_PERMISSION,
      approved,
    });
  };

  const handlePathAccessResponse = (granted: boolean) => {
    respondToInteraction(pendingInteraction.interactionId, {
      type: InteractionType.REQUEST_PATH_ACCESS,
      granted,
    });
  };

  const handleReviewResponse = (approved: boolean) => {
    respondToInteraction(pendingInteraction.interactionId, {
      type: InteractionType.REVIEW_SANITIZED_OUTPUT,
      approved,
    });
  };

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60]"
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="fixed inset-0 z-[60] flex items-center justify-center pointer-events-none"
      >
        <div className="pointer-events-auto w-full max-w-md mx-4">
          <div className="bg-surface rounded-xl border border-border shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="px-5 py-4 border-b border-border flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-orange-500/20 flex items-center justify-center">
                {pendingInteraction.type === InteractionType.ASK_QUESTION && (
                  <MessageSquare className="w-4 h-4 text-orange-400" />
                )}
                {pendingInteraction.type === InteractionType.REQUEST_PERMISSION && (
                  <Shield className="w-4 h-4 text-yellow-400" />
                )}
                {pendingInteraction.type === InteractionType.REQUEST_PATH_ACCESS && (
                  <FolderOpen className="w-4 h-4 text-blue-400" />
                )}
                {pendingInteraction.type === InteractionType.REVIEW_SANITIZED_OUTPUT && (
                  <Eye className="w-4 h-4 text-purple-400" />
                )}
              </div>
              <div>
                <h3 className="text-sm font-medium text-white">
                  {pendingInteraction.type === InteractionType.ASK_QUESTION && "PRBE Agent Question"}
                  {pendingInteraction.type === InteractionType.REQUEST_PERMISSION && "Permission Request"}
                  {pendingInteraction.type === InteractionType.REQUEST_PATH_ACCESS && "Path Access Request"}
                  {pendingInteraction.type === InteractionType.REVIEW_SANITIZED_OUTPUT && "Review Output"}
                </h3>
                <p className="text-[10px] text-zinc-500">PRBE Debugger needs your input</p>
              </div>
            </div>

            {/* Content */}
            <div className="p-5">
              {/* Ask Question */}
              {pendingInteraction.type === InteractionType.ASK_QUESTION && (() => {
                const p = pendingInteraction as AskQuestionPayload;
                return (
                  <div className="space-y-3">
                    <p className="text-sm text-zinc-300">{p.question}</p>
                    {p.context && (
                      <p className="text-xs text-zinc-500 bg-canvas rounded-md p-2 font-mono">{p.context}</p>
                    )}
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={answer}
                        onChange={(e) => setAnswer(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleAskQuestionSubmit();
                          }
                        }}
                        placeholder="Type your answer..."
                        autoFocus
                        className="flex-1 px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                      />
                      <button
                        onClick={handleAskQuestionSubmit}
                        disabled={!answer.trim()}
                        className="px-3 py-2 rounded-md bg-orange-600 text-white text-sm font-medium hover:bg-orange-500 disabled:opacity-50 transition-colors"
                      >
                        <Send className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })()}

              {/* Request Permission */}
              {pendingInteraction.type === InteractionType.REQUEST_PERMISSION && (() => {
                const p = pendingInteraction as RequestPermissionPayload;
                return (
                  <div className="space-y-3">
                    <p className="text-sm text-zinc-300">{p.action}</p>
                    <div className="bg-canvas rounded-md p-2 font-mono text-xs text-zinc-400 break-all">
                      {p.command}
                    </div>
                    {p.reason && <p className="text-xs text-zinc-500">{p.reason}</p>}
                    <div className="flex gap-2">
                      <button
                        onClick={() => handlePermissionResponse(false)}
                        className="flex-1 px-3 py-2 rounded-md text-sm text-zinc-400 hover:text-white bg-canvas border border-border hover:border-zinc-500 transition-colors"
                      >
                        Deny
                      </button>
                      <button
                        onClick={() => handlePermissionResponse(true)}
                        className="flex-1 px-3 py-2 rounded-md text-sm font-medium bg-orange-600 text-white hover:bg-orange-500 transition-colors"
                      >
                        Approve
                      </button>
                    </div>
                  </div>
                );
              })()}

              {/* Request Path Access */}
              {pendingInteraction.type === InteractionType.REQUEST_PATH_ACCESS && (() => {
                const p = pendingInteraction as RequestPathAccessPayload;
                return (
                  <div className="space-y-3">
                    <p className="text-sm text-zinc-300">The agent wants to access a path outside the approved directories:</p>
                    <div className="bg-canvas rounded-md p-2 font-mono text-xs text-zinc-400 break-all">
                      {p.path}
                    </div>
                    <p className="text-xs text-zinc-500">{p.reason}</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handlePathAccessResponse(false)}
                        className="flex-1 px-3 py-2 rounded-md text-sm text-zinc-400 hover:text-white bg-canvas border border-border hover:border-zinc-500 transition-colors"
                      >
                        Deny
                      </button>
                      <button
                        onClick={() => handlePathAccessResponse(true)}
                        className="flex-1 px-3 py-2 rounded-md text-sm font-medium bg-orange-600 text-white hover:bg-orange-500 transition-colors"
                      >
                        Grant Access
                      </button>
                    </div>
                  </div>
                );
              })()}

              {/* Review Sanitized Output */}
              {pendingInteraction.type === InteractionType.REVIEW_SANITIZED_OUTPUT && (() => {
                const p = pendingInteraction as ReviewSanitizedOutputPayload;
                return (
                  <div className="space-y-3">
                    <p className="text-sm text-zinc-300">Review the sanitized output before it's sent to the PRBE server:</p>
                    <div className="bg-canvas rounded-md p-2 font-mono text-xs text-zinc-400 max-h-48 overflow-y-auto whitespace-pre-wrap">
                      {p.sanitizedAnalysis}
                    </div>
                    <p className="text-xs text-zinc-500">
                      Confidence: {Math.round(p.confidence * 100)}%
                      {p.issues.length > 0 && ` — ${p.issues.length} issue(s) found`}
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleReviewResponse(false)}
                        className="flex-1 px-3 py-2 rounded-md text-sm text-zinc-400 hover:text-white bg-canvas border border-border hover:border-zinc-500 transition-colors"
                      >
                        Reject
                      </button>
                      <button
                        onClick={() => handleReviewResponse(true)}
                        className="flex-1 px-3 py-2 rounded-md text-sm font-medium bg-orange-600 text-white hover:bg-orange-500 transition-colors"
                      >
                        Approve & Send
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
