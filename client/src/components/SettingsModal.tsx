import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Key, Check, AlertCircle, Loader2, ExternalLink, Bug,
  SlidersHorizontal, Puzzle,
} from "lucide-react";
import { usePRBEStore } from "../stores/usePRBEStore";

type SettingsTab = "general" | "integrations";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-[40px] flex-shrink-0 items-center rounded-full transition-colors duration-200 ${
        checked ? "bg-indigo-600" : "bg-zinc-600"
      }`}
    >
      <span
        className={`inline-block h-[16px] w-[16px] rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? "translate-x-[20px]" : "translate-x-[3px]"
        }`}
      />
    </button>
  );
}

function SettingRow({
  title,
  description,
  children,
  last,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 py-3.5 ${last ? "" : "border-b border-border"}`}>
      <div className="min-w-0">
        <div className="text-sm text-zinc-200">{title}</div>
        {description && <div className="text-xs text-zinc-500 mt-0.5">{description}</div>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500 mb-1 mt-5 first:mt-0">
      {title}
    </div>
  );
}

const TABS: { id: SettingsTab; label: string; icon: typeof SlidersHorizontal }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "integrations", label: "Integrations", icon: Puzzle },
];

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [apiKey, setApiKey] = useState("");
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    user?: { name: string; email: string };
    error?: string;
  } | null>(null);
  const [defaultBaseBranch, setDefaultBaseBranch] = useState("main");
  const [createWorktree, setCreateWorktree] = useState(true);
  const [ticketPromptTemplate, setTicketPromptTemplate] = useState("");
  const [autoCareful, setAutoCareful] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const prbeStore = usePRBEStore();
  const [prbeApiKey, setPrbeApiKey] = useState("");
  const [hasPrbeKey, setHasPrbeKey] = useState(false);
  const [isPrbeBuiltIn, setIsPrbeBuiltIn] = useState(false);
  const [isPrbeSaving, setIsPrbeSaving] = useState(false);

  useEffect(() => {
    if (open) {
      fetch("/api/prbe/config")
        .then((res) => res.json())
        .then((config) => {
          setHasPrbeKey(config.hasApiKey);
          setIsPrbeBuiltIn(config.isBuiltIn ?? false);
        })
        .catch(console.error);

      fetch("/api/linear/config")
        .then((res) => res.json())
        .then((config) => {
          setHasExistingKey(config.hasApiKey);
          setDefaultBaseBranch(config.defaultBaseBranch || "main");
          setCreateWorktree(config.createWorktree ?? true);
          setAutoCareful(config.autoCareful ?? true);
          setTicketPromptTemplate(config.ticketPromptTemplate || "");
        })
        .catch(console.error);
    }
  }, [open]);

  const handleValidate = async () => {
    if (!apiKey.trim()) return;
    setIsValidating(true);
    setValidationResult(null);
    try {
      const res = await fetch("/api/linear/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      setValidationResult(await res.json());
    } catch {
      setValidationResult({ valid: false, error: "Failed to validate" });
    } finally {
      setIsValidating(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await fetch("/api/linear/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: apiKey.trim() || undefined,
          defaultBaseBranch,
          createWorktree,
          autoCareful,
          ticketPromptTemplate: ticketPromptTemplate || undefined,
        }),
      });
      if (apiKey.trim()) setHasExistingKey(true);
      setApiKey("");
      setValidationResult(null);
      onClose();
    } catch (e) {
      console.error("Failed to save settings:", e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveKey = async () => {
    setIsSaving(true);
    try {
      await fetch("/api/linear/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "" }),
      });
      setHasExistingKey(false);
      setApiKey("");
      setValidationResult(null);
    } catch (e) {
      console.error("Failed to remove key:", e);
    } finally {
      setIsSaving(false);
    }
  };

  const handlePrbeSave = async () => {
    if (!prbeApiKey.trim()) return;
    setIsPrbeSaving(true);
    try {
      await fetch("/api/prbe/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: prbeApiKey.trim() }),
      });
      setHasPrbeKey(true);
      setPrbeApiKey("");
      if (window.electronAPI?.isElectron) {
        await prbeStore.initialize();
      }
    } catch (e) {
      console.error("Failed to save PRBE config:", e);
    } finally {
      setIsPrbeSaving(false);
    }
  };

  const handlePrbeRemoveKey = async () => {
    try {
      await fetch("/api/prbe/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "" }),
      });
      setHasPrbeKey(false);
      setPrbeApiKey("");
    } catch (e) {
      console.error("Failed to remove PRBE key:", e);
    }
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
          >
            <div className="pointer-events-auto w-full max-w-[680px] mx-4">
              <div className="bg-surface rounded-xl border border-border shadow-2xl overflow-hidden flex flex-col max-h-[calc(100vh-6rem)]">
                {/* Header */}
                <div className="px-5 py-4 border-b border-border flex items-center justify-between flex-shrink-0">
                  <h2 className="text-lg font-semibold text-white">Settings</h2>
                  <button
                    onClick={onClose}
                    className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-canvas transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Body: sidebar + content */}
                <div className="flex flex-1 min-h-0">
                  {/* Sidebar */}
                  <nav className="w-[180px] flex-shrink-0 border-r border-border p-3 space-y-0.5">
                    {TABS.map(({ id, label, icon: Icon }) => (
                      <button
                        key={id}
                        onClick={() => setTab(id)}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                          tab === id
                            ? "bg-zinc-800 text-white font-medium"
                            : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                        }`}
                      >
                        <Icon className="w-4 h-4" />
                        {label}
                      </button>
                    ))}
                  </nav>

                  {/* Content */}
                  <div className="flex-1 overflow-y-auto p-5">
                    {tab === "general" && <GeneralTab
                      defaultBaseBranch={defaultBaseBranch}
                      setDefaultBaseBranch={setDefaultBaseBranch}
                      createWorktree={createWorktree}
                      setCreateWorktree={setCreateWorktree}
                      autoCareful={autoCareful}
                      setAutoCareful={setAutoCareful}
                    />}
                    {tab === "integrations" && <IntegrationsTab
                      apiKey={apiKey}
                      setApiKey={setApiKey}
                      hasExistingKey={hasExistingKey}
                      isValidating={isValidating}
                      validationResult={validationResult}
                      setValidationResult={setValidationResult}
                      handleValidate={handleValidate}
                      handleRemoveKey={handleRemoveKey}
                      ticketPromptTemplate={ticketPromptTemplate}
                      setTicketPromptTemplate={setTicketPromptTemplate}
                      prbeApiKey={prbeApiKey}
                      setPrbeApiKey={setPrbeApiKey}
                      hasPrbeKey={hasPrbeKey}
                      isPrbeBuiltIn={isPrbeBuiltIn}
                      isPrbeSaving={isPrbeSaving}
                      handlePrbeSave={handlePrbeSave}
                      handlePrbeRemoveKey={handlePrbeRemoveKey}
                    />}
                  </div>
                </div>

                {/* Footer */}
                <div className="px-5 py-3.5 border-t border-border flex justify-end gap-2 flex-shrink-0">
                  <button
                    onClick={onClose}
                    className="px-3 py-1.5 rounded-md text-sm text-zinc-400 hover:text-white hover:bg-canvas transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={isSaving || (!!apiKey.trim() && !validationResult?.valid)}
                    className="px-4 py-1.5 rounded-md text-sm font-medium bg-white text-canvas hover:bg-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isSaving ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}

/* ─── Tab content components ─── */

function GeneralTab({
  defaultBaseBranch,
  setDefaultBaseBranch,
  createWorktree,
  setCreateWorktree,
  autoCareful,
  setAutoCareful,
}: {
  defaultBaseBranch: string;
  setDefaultBaseBranch: (v: string) => void;
  createWorktree: boolean;
  setCreateWorktree: (v: boolean) => void;
  autoCareful: boolean;
  setAutoCareful: (v: boolean) => void;
}) {
  return (
    <>
      <SectionHeader title="Git" />
      <div className="rounded-lg border border-border bg-canvas/40">
        <div className="px-4">
          <SettingRow title="Default base branch" description="Branch used when creating ticket branches">
            <input
              type="text"
              value={defaultBaseBranch}
              onChange={(e) => setDefaultBaseBranch(e.target.value)}
              placeholder="main"
              className="w-[120px] px-2.5 py-1.5 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors text-right"
            />
          </SettingRow>
          <SettingRow title="Git worktree" description="Create an isolated working directory for each session branch">
            <Toggle checked={createWorktree} onChange={setCreateWorktree} />
          </SettingRow>
          <SettingRow title="Auto /careful mode" description="Warn before destructive commands (rm -rf, force push)" last>
            <Toggle checked={autoCareful} onChange={setAutoCareful} />
          </SettingRow>
        </div>
      </div>
    </>
  );
}

function IntegrationsTab({
  apiKey,
  setApiKey,
  hasExistingKey,
  isValidating,
  validationResult,
  setValidationResult,
  handleValidate,
  handleRemoveKey,
  ticketPromptTemplate,
  setTicketPromptTemplate,
  prbeApiKey,
  setPrbeApiKey,
  hasPrbeKey,
  isPrbeBuiltIn,
  isPrbeSaving,
  handlePrbeSave,
  handlePrbeRemoveKey,
}: {
  apiKey: string;
  setApiKey: (v: string) => void;
  hasExistingKey: boolean;
  isValidating: boolean;
  validationResult: { valid: boolean; user?: { name: string; email: string }; error?: string } | null;
  setValidationResult: (v: null) => void;
  handleValidate: () => void;
  handleRemoveKey: () => void;
  ticketPromptTemplate: string;
  setTicketPromptTemplate: (v: string) => void;
  prbeApiKey: string;
  setPrbeApiKey: (v: string) => void;
  hasPrbeKey: boolean;
  isPrbeBuiltIn: boolean;
  isPrbeSaving: boolean;
  handlePrbeSave: () => void;
  handlePrbeRemoveKey: () => void;
}) {
  return (
    <>
      {/* Linear */}
      <SectionHeader title="Linear" />
      <div className="rounded-lg border border-border bg-canvas/40">
        <div className="px-4 py-3.5 space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-indigo-500/20 flex items-center justify-center">
              <svg className="w-3.5 h-3.5 text-indigo-400" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 7.5L7.5 3H21v13.5L16.5 21H3V7.5z" />
              </svg>
            </div>
            <span className="text-sm text-zinc-200">Linear Integration</span>
          </div>

          {hasExistingKey ? (
            <>
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-green-500/10 border border-green-500/20">
                <Check className="w-4 h-4 text-green-500" />
                <span className="text-sm text-green-400">API key configured</span>
                <button
                  onClick={handleRemoveKey}
                  className="ml-auto text-xs text-zinc-500 hover:text-red-400 transition-colors"
                >
                  Remove
                </button>
              </div>
              <p className="text-xs text-zinc-500">
                You can start sessions from Linear tickets.
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-zinc-500">
                Connect Linear to start agent sessions from tickets.{" "}
                <a
                  href="https://linear.app/settings/api"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-0.5"
                >
                  Get your API key
                  <ExternalLink className="w-3 h-3" />
                </a>
              </p>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setValidationResult(null);
                    }}
                    placeholder="lin_api_..."
                    className="w-full pl-9 pr-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                  />
                </div>
                <button
                  onClick={handleValidate}
                  disabled={!apiKey.trim() || isValidating}
                  className="px-3 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                >
                  {isValidating ? <Loader2 className="w-4 h-4 animate-spin" /> : "Validate"}
                </button>
              </div>
              {validationResult && (
                <div
                  className={`flex items-center gap-2 px-3 py-2 rounded-md ${
                    validationResult.valid
                      ? "bg-green-500/10 border border-green-500/20"
                      : "bg-red-500/10 border border-red-500/20"
                  }`}
                >
                  {validationResult.valid ? (
                    <>
                      <Check className="w-4 h-4 text-green-500" />
                      <span className="text-sm text-green-400">
                        Connected as {validationResult.user?.name}
                      </span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="w-4 h-4 text-red-500" />
                      <span className="text-sm text-red-400">
                        {validationResult.error}
                      </span>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          <div className="border-t border-border pt-3">
            <div className="text-sm text-zinc-200 mb-1">Ticket prompt template</div>
            <p className="text-xs text-zinc-500 mb-2.5">
              Message sent to the agent when starting from a ticket. Use{" "}
              <code className="text-indigo-400">{"{{url}}"}</code>,{" "}
              <code className="text-indigo-400">{"{{id}}"}</code>,{" "}
              <code className="text-indigo-400">{"{{title}}"}</code> as placeholders.
            </p>
            <textarea
              value={ticketPromptTemplate}
              onChange={(e) => setTicketPromptTemplate(e.target.value)}
              placeholder={"Here is the ticket for this session: {{url}}\n\nPlease use the Linear MCP tool or fetch the URL to read the full ticket details before starting work."}
              rows={4}
              className="w-full px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors resize-none font-mono"
            />
          </div>
        </div>
      </div>

      {/* PRBE Debugger */}
      <SectionHeader title="Debugging" />
      <div className="rounded-lg border border-border bg-canvas/40">
        <div className="px-4 py-3.5 space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-orange-500/20 flex items-center justify-center">
              <Bug className="w-3.5 h-3.5 text-orange-400" />
            </div>
            <span className="text-sm text-zinc-200">PRBE Debugger</span>
          </div>

          {!window.electronAPI?.isElectron && (
            <div className="px-3 py-2 rounded-md bg-zinc-800/50 border border-border">
              <p className="text-xs text-zinc-500">
                PRBE debugging requires the OpenUI Desktop app. The browser version does not support this feature.
              </p>
            </div>
          )}

          {window.electronAPI?.isElectron && (
            <>
              {hasPrbeKey && isPrbeBuiltIn ? (
                <>
                  <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-green-500/10 border border-green-500/20">
                    <Check className="w-4 h-4 text-green-500" />
                    <span className="text-sm text-green-400">PRBE debugger active</span>
                  </div>
                  <p className="text-xs text-zinc-500">
                    Built-in debugging is enabled. You can investigate issues with your agents.
                  </p>
                </>
              ) : hasPrbeKey ? (
                <>
                  <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-green-500/10 border border-green-500/20">
                    <Check className="w-4 h-4 text-green-500" />
                    <span className="text-sm text-green-400">PRBE API key configured</span>
                    <button
                      onClick={handlePrbeRemoveKey}
                      className="ml-auto text-xs text-zinc-500 hover:text-red-400 transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                  <p className="text-xs text-zinc-500">
                    Using a custom API key. You can use the PRBE debugger to investigate issues with your agents.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-xs text-zinc-500">
                    Connect PRBE for AI-powered debugging of your agent sessions.
                  </p>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                      <input
                        type="password"
                        value={prbeApiKey}
                        onChange={(e) => setPrbeApiKey(e.target.value)}
                        placeholder="prbe_..."
                        className="w-full pl-9 pr-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                      />
                    </div>
                    <button
                      onClick={handlePrbeSave}
                      disabled={!prbeApiKey.trim() || isPrbeSaving}
                      className="px-3 py-2 rounded-md bg-orange-600 text-white text-sm font-medium hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                    >
                      {isPrbeSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
