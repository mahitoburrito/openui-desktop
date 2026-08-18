import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Boxes,
  ChevronLeft,
  Clock3,
  Command,
  CornerDownLeft,
  FileText,
  FolderKanban,
  Loader2,
  Play,
  Search,
  Server,
  Sparkles,
  TerminalSquare,
  Workflow,
  X,
} from "lucide-react";
import {
  applyTerminalSuggestion,
  type TerminalSuggestion,
  type TerminalSuggestionKind,
} from "./terminalSuggestions";
import { TerminalWorkflowLibrary } from "./TerminalWorkflowLibrary";

export { applyTerminalSuggestion } from "./terminalSuggestions";
export type { TerminalSuggestion, TerminalSuggestionKind } from "./terminalSuggestions";

interface WorkflowParameter {
  name: string;
  description?: string;
  defaultValue?: string;
  required?: boolean;
  options?: string[];
  dynamicOptionsCommand?: string;
  sensitive?: boolean;
}

interface TerminalWorkflow {
  id: string;
  name: string;
  description: string;
  command: string;
  parameters: WorkflowParameter[];
}

interface WorkflowEditorState {
  workflow: TerminalWorkflow;
  mode: "insert" | "execute";
  values: Record<string, string>;
  dynamicOptions: Record<string, string[]>;
}

interface TerminalCommandSearchProps {
  open: boolean;
  view: "search" | "workflows";
  sessionId: string;
  sessionName: string;
  cwd: string;
  onClose: () => void;
  onInsert: (command: string) => void;
  onExecute: (command: string, sensitive: boolean) => Promise<void>;
  onSelectSession: (nodeId: string) => void;
  onAction: (action: string) => void;
  onOpenSavedCommands: () => void;
  onBackToSearch: () => void;
  onWorkflowDirtyChange: (dirty: boolean) => void;
}

type SuggestionGroup = {
  id: "complete" | "recall" | "navigate";
  label: string;
  items: TerminalSuggestion[];
};

const supportedActions = new Set([
  "new-session",
  "search-history",
  "open-workflows",
  "open-launch-configurations",
  "synchronize-current-tab",
  "synchronize-all-tabs",
  "stop-synchronizing",
  "toggle-focus",
]);

const kindLabels: Record<TerminalSuggestionKind, string> = {
  action: "Action",
  workflow: "Saved",
  history: "History",
  session: "Session",
  file: "Path",
  command: "Command",
  subcommand: "Subcommand",
  option: "Option",
  argument: "Argument",
  variable: "Variable",
};

const groupForKind = (kind: TerminalSuggestionKind): SuggestionGroup["id"] => {
  if (["command", "subcommand", "option", "argument", "variable", "file"].includes(kind)) {
    return "complete";
  }
  if (["history", "workflow"].includes(kind)) return "recall";
  return "navigate";
};

async function readJson(response: Response, fallback: string) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || fallback);
  return body;
}

export function TerminalCommandSearch({
  open,
  view,
  sessionId,
  sessionName,
  cwd,
  onClose,
  onInsert,
  onExecute,
  onSelectSession,
  onAction,
  onOpenSavedCommands,
  onBackToSearch,
  onWorkflowDirtyChange,
}: TerminalCommandSearchProps) {
  const [query, setQuery] = useState("");
  const [providerQuery, setProviderQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TerminalSuggestion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workflowEditor, setWorkflowEditor] = useState<WorkflowEditorState | null>(null);
  const [renderedPreview, setRenderedPreview] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const visibleSuggestions = useMemo(
    () => suggestions.filter((item) => item.kind !== "action" || supportedActions.has(item.value)),
    [suggestions],
  );

  const groups = useMemo<SuggestionGroup[]>(() => {
    const labels: Record<SuggestionGroup["id"], string> = {
      complete: "Complete command",
      recall: "Saved commands and history",
      navigate: "Open",
    };
    const order: SuggestionGroup["id"][] = query.trim()
      ? ["complete", "recall", "navigate"]
      : ["navigate", "recall", "complete"];
    return order.flatMap((id) => {
      const items = visibleSuggestions.filter((item) => groupForKind(item.kind) === id);
      return items.length ? [{ id, label: labels[id], items }] : [];
    });
  }, [query, visibleSuggestions]);

  const flatSuggestions = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const selectedIndex = Math.max(0, flatSuggestions.findIndex((item) => item.id === selectedId));
  const selected = flatSuggestions[selectedIndex];

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError(null);
    setWorkflowEditor(null);
    setRenderedPreview(null);
    setGuideOpen(false);
    const timeout = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timeout);
  }, [open, sessionId]);

  useEffect(() => {
    if (!open || !workflowEditor) {
      setRenderedPreview(null);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/terminal/workflows/${encodeURIComponent(workflowEditor.workflow.id)}/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ values: workflowEditor.values }),
          signal: controller.signal,
        });
        if (!response.ok) {
          setRenderedPreview(null);
          return;
        }
        const body = await response.json();
        setRenderedPreview(typeof body.command === "string" ? body.command : null);
      } catch (previewError) {
        if ((previewError as Error).name !== "AbortError") setRenderedPreview(null);
      }
    }, 120);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [open, workflowEditor]);

  useEffect(() => {
    if (!open || workflowEditor) return;
    const controller = new AbortController();
    setLoading(true);
    setSuggestions([]);
    setSelectedId(null);
    const timeout = window.setTimeout(async () => {
      setError(null);
      try {
        const params = new URLSearchParams({ query, sessionId, cwd, limit: "36" });
        const response = await fetch(`/api/terminal/suggestions?${params}`, { signal: controller.signal });
        const body = await readJson(response, "Command search is unavailable");
        const items = Array.isArray(body.suggestions) ? body.suggestions as TerminalSuggestion[] : [];
        setProviderQuery(typeof body.query === "string" ? body.query : query);
        setSuggestions(items);
        setSelectedId((current) => items.some((item) => item.id === current) ? current : items[0]?.id || null);
      } catch (searchError) {
        if ((searchError as Error).name !== "AbortError") {
          setSuggestions([]);
          setError(searchError instanceof Error ? searchError.message : "Command search is unavailable");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 90);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [cwd, open, query, sessionId, workflowEditor]);

  useEffect(() => {
    if (!selectedId) return;
    listRef.current?.querySelector<HTMLElement>(`[data-suggestion-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const finishCommand = async (command: string, mode: "insert" | "execute", sensitive = false) => {
    if (!command.trim()) return;
    setWorking(true);
    setError(null);
    try {
      if (mode === "execute") await onExecute(command, sensitive);
      else onInsert(command);
      onClose();
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : "Command action failed");
    } finally {
      setWorking(false);
    }
  };

  const openWorkflow = async (suggestion: TerminalSuggestion, mode: "insert" | "execute") => {
    setWorking(true);
    setError(null);
    try {
      const response = await fetch(`/api/terminal/workflows/${encodeURIComponent(suggestion.value)}`);
      const body = await readJson(response, "Workflow is unavailable");
      const workflow = body.workflow as TerminalWorkflow;
      if (workflow.parameters.length > 0) {
        setRenderedPreview(null);
        setWorkflowEditor({
          workflow,
          mode,
          values: Object.fromEntries(workflow.parameters.map((parameter) => [parameter.name, parameter.defaultValue || ""])),
          dynamicOptions: {},
        });
        return;
      }
      const renderedResponse = await fetch(`/api/terminal/workflows/${encodeURIComponent(workflow.id)}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: {} }),
      });
      const rendered = await readJson(renderedResponse, "Workflow could not be rendered");
      await finishCommand(rendered.command, mode, Boolean(rendered.sensitive));
    } catch (workflowError) {
      setError(workflowError instanceof Error ? workflowError.message : "Workflow is unavailable");
    } finally {
      setWorking(false);
    }
  };

  const chooseSuggestion = async (suggestion: TerminalSuggestion, mode: "insert" | "execute") => {
    if (suggestion.kind === "session") {
      onSelectSession(String(suggestion.metadata?.nodeId || suggestion.value));
      onClose();
      return;
    }
    if (suggestion.kind === "action") {
      if (suggestion.value === "open-workflows") {
        onOpenSavedCommands();
      } else {
        onAction(suggestion.value);
        onClose();
      }
      return;
    }
    if (suggestion.kind === "workflow") {
      await openWorkflow(suggestion, mode);
      return;
    }
    await finishCommand(applyTerminalSuggestion(providerQuery, suggestion), mode);
  };

  const applyScope = (scope: string) => {
    setQuery(scope);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const moveSelection = (delta: number) => {
    if (!flatSuggestions.length) return;
    const next = (selectedIndex + delta + flatSuggestions.length) % flatSuggestions.length;
    setSelectedId(flatSuggestions[next].id);
  };

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.nativeEvent.stopImmediatePropagation();
      if (workflowEditor) {
        setWorkflowEditor(null);
        window.setTimeout(() => inputRef.current?.focus(), 0);
      } else onClose();
      return;
    }
    if (workflowEditor) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "Enter" && selected) {
      event.preventDefault();
      event.nativeEvent.stopImmediatePropagation();
      void chooseSuggestion(selected, event.metaKey || event.ctrlKey ? "execute" : "insert");
    }
  };

  const loadDynamicOptions = async (parameter: WorkflowParameter) => {
    if (!workflowEditor) return;
    setWorking(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/terminal/workflows/${encodeURIComponent(workflowEditor.workflow.id)}/parameters/${encodeURIComponent(parameter.name)}/options`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: "run-dynamic-options", cwd }),
        },
      );
      const body = await readJson(response, "Dynamic choices could not be loaded");
      setWorkflowEditor((current) => current ? {
        ...current,
        dynamicOptions: { ...current.dynamicOptions, [parameter.name]: body.options || [] },
      } : current);
    } catch (optionError) {
      setError(optionError instanceof Error ? optionError.message : "Dynamic choices could not be loaded");
    } finally {
      setWorking(false);
    }
  };

  const submitWorkflow = async (event: FormEvent) => {
    event.preventDefault();
    if (!workflowEditor) return;
    setWorking(true);
    setError(null);
    try {
      const response = await fetch(`/api/terminal/workflows/${encodeURIComponent(workflowEditor.workflow.id)}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: workflowEditor.values }),
      });
      const rendered = await readJson(response, "Workflow could not be rendered");
      await finishCommand(rendered.command, workflowEditor.mode, Boolean(rendered.sensitive));
    } catch (workflowError) {
      setError(workflowError instanceof Error ? workflowError.message : "Workflow could not be rendered");
    } finally {
      setWorking(false);
    }
  };

  const suggestionIcon = (kind: TerminalSuggestionKind) => {
    if (kind === "history") return Clock3;
    if (kind === "workflow") return Workflow;
    if (kind === "session") return Server;
    if (kind === "action") return Sparkles;
    if (kind === "file") return FileText;
    if (kind === "variable") return Boxes;
    return TerminalSquare;
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="fixed inset-0 z-[99] bg-[oklch(3%_0.003_260/0.72)]"
            onMouseDown={onClose}
            aria-hidden="true"
          />
          <motion.section
            initial={{ opacity: 0, y: 10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.99 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className={`fixed left-1/2 top-1/2 z-[100] flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-[oklch(28%_0.009_260)] bg-[oklch(10%_0.005_260)] shadow-[0_30px_90px_rgba(0,0,0,0.62)] ${view === "workflows"
              ? "h-[min(720px,calc(100vh-48px))] w-[min(980px,calc(100vw-32px))]"
              : "max-h-[min(680px,calc(100vh-48px))] w-[min(820px,calc(100vw-32px))]"}`}
            role="dialog"
            aria-modal="true"
            aria-label={view === "workflows" ? "Saved commands" : "Command Center"}
            onKeyDown={view === "search" ? handleKeyDown : undefined}
          >
          {view === "workflows" ? (
            <TerminalWorkflowLibrary
              open
              variant="command-center"
              cwd={cwd}
              sessionName={sessionName}
              onBack={onBackToSearch}
              onClose={onClose}
              onDirtyChange={onWorkflowDirtyChange}
              onInsert={onInsert}
              onExecute={onExecute}
            />
          ) : (
          <>
          <div className="flex h-11 flex-shrink-0 items-center gap-3 border-b border-[oklch(22%_0.006_260)] px-4">
            <Command className="h-3.5 w-3.5 text-[oklch(75%_0.10_48)]" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-zinc-200">Command Center</div>
              <div className="truncate text-[8px] text-zinc-600">Commands for {sessionName}</div>
            </div>
            <button
              type="button"
              onClick={onOpenSavedCommands}
              className="flex h-7 items-center gap-1.5 rounded px-2.5 text-[9px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[oklch(72%_0.13_48)]"
            >
              <Workflow className="h-3 w-3" /> Saved commands
            </button>
            <button
              type="button"
              onClick={() => setGuideOpen((open) => !open)}
              aria-pressed={guideOpen}
              className={`flex h-7 items-center gap-1.5 rounded px-2.5 text-[9px] hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[oklch(72%_0.13_48)] ${guideOpen ? "bg-zinc-800 text-zinc-200" : "text-zinc-500"}`}
            >
              <BookOpen className="h-3 w-3" /> How to use
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[oklch(72%_0.13_48)]"
              aria-label="Close Command Center"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex min-h-14 items-center gap-3 border-b border-[oklch(23%_0.007_260)] px-4">
            {workflowEditor ? (
              <button
                type="button"
                onClick={() => setWorkflowEditor(null)}
                className="flex h-7 w-7 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[oklch(72%_0.13_48)]"
                aria-label="Back to command results"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            ) : (
              <Search className="h-4 w-4 flex-shrink-0 text-[oklch(74%_0.11_48)]" />
            )}
            {workflowEditor ? (
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-zinc-100">{workflowEditor.workflow.name}</div>
                <div className="mt-0.5 truncate text-[9px] text-zinc-600">Set workflow parameters for {sessionName}</div>
              </div>
            ) : (
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search commands, history, saved commands, paths, sessions…"
                className="h-12 min-w-0 flex-1 bg-transparent font-mono text-[13px] text-zinc-100 outline-none placeholder:font-sans placeholder:text-zinc-600"
                role="combobox"
                aria-expanded="true"
                aria-controls="terminal-command-results"
                aria-activedescendant={selected ? `terminal-suggestion-${selected.id}` : undefined}
                autoComplete="off"
                spellCheck={false}
              />
            )}
            {(loading || working) && <Loader2 className="h-4 w-4 animate-spin text-zinc-500 motion-reduce:animate-none" />}
          </div>

          <div className="flex min-h-8 items-center gap-2 border-b border-[oklch(20%_0.006_260)] px-4 py-1.5 text-[9px] text-zinc-600">
            <FolderKanban className="h-2.5 w-2.5" />
            <span className="max-w-[26ch] truncate font-mono">{cwd || "~"}</span>
            <span className="text-zinc-800">/</span>
            <span className="truncate">{sessionName}</span>
            {!workflowEditor && (
              <div className="ml-auto hidden items-center gap-1 sm:flex" aria-label="Command Center filters">
                {[
                  ["All", ""],
                  ["Saved", "workflows: "],
                  ["History", "history: "],
                  ["Paths", "files: "],
                  ["Sessions", "sessions: "],
                ].map(([label, scope]) => (
                  <button key={label} type="button" onClick={() => applyScope(scope)} className={`rounded px-1.5 py-0.5 transition-colors ${query === scope ? "bg-[oklch(21%_0.025_48)] text-[oklch(78%_0.09_48)]" : "text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"}`}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {guideOpen && !workflowEditor && (
            <div className="grid grid-cols-3 gap-px border-b border-[oklch(22%_0.006_260)] bg-[oklch(22%_0.006_260)] text-[9px]">
              <div className="bg-[oklch(11%_0.005_260)] px-4 py-3"><span className="font-medium text-zinc-300">1. Find</span><span className="mt-1 block leading-4 text-zinc-600">Search commands, previous runs, files, sessions, or saved commands.</span></div>
              <div className="bg-[oklch(11%_0.005_260)] px-4 py-3"><span className="font-medium text-zinc-300">2. Choose</span><span className="mt-1 block leading-4 text-zinc-600">Press Enter to insert. Press Cmd+Enter to run now or queue it.</span></div>
              <div className="bg-[oklch(11%_0.005_260)] px-4 py-3"><span className="font-medium text-zinc-300">3. Reuse</span><span className="mt-1 block leading-4 text-zinc-600">Save parameterized commands, then fill their values without leaving Cmd+P.</span></div>
            </div>
          )}

          {error && (
            <div className="border-b border-[oklch(34%_0.06_28)] bg-[oklch(15%_0.025_28)] px-4 py-2 text-[10px] text-[oklch(78%_0.10_28)]" role="alert">
              {error}
            </div>
          )}

          {workflowEditor ? (
            <form onSubmit={submitWorkflow} className="min-h-0 overflow-y-auto">
              <div className="space-y-4 p-4">
                <div>
                  <div className="text-[10px] text-zinc-500">{workflowEditor.workflow.description || "Saved terminal command"}</div>
                  <div className="mt-3 text-[8px] font-medium uppercase tracking-[0.12em] text-zinc-700">{renderedPreview ? "Command preview" : "Command template"}</div>
                  <code className="mt-1.5 block overflow-x-auto rounded border border-[oklch(24%_0.007_260)] bg-[oklch(7%_0.004_260)] px-3 py-2 text-[10px] leading-5 text-zinc-400" aria-live="polite">
                    {renderedPreview || workflowEditor.workflow.command}
                  </code>
                </div>
                {workflowEditor.workflow.parameters.map((parameter) => {
                  const choices = parameter.options || workflowEditor.dynamicOptions[parameter.name];
                  return (
                    <label key={parameter.name} className="block">
                      <span className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium text-zinc-300">
                        {parameter.name}
                        {parameter.required && <span className="text-[oklch(74%_0.11_48)]">required</span>}
                      </span>
                      {choices?.length ? (
                        <select
                          value={workflowEditor.values[parameter.name] || ""}
                          onChange={(event) => setWorkflowEditor((current) => current ? {
                            ...current,
                            values: { ...current.values, [parameter.name]: event.target.value },
                          } : current)}
                          className="h-9 w-full rounded-md border border-[oklch(28%_0.008_260)] bg-[oklch(13%_0.006_260)] px-2.5 font-mono text-[11px] text-zinc-200 outline-none focus:border-[oklch(58%_0.08_48)]"
                          required={parameter.required}
                        >
                          {!parameter.required && <option value="">Empty</option>}
                          {choices.map((option) => <option key={option} value={option}>{option}</option>)}
                        </select>
                      ) : (
                        <div className="flex gap-2">
                          <input
                            type={parameter.sensitive ? "password" : "text"}
                            value={workflowEditor.values[parameter.name] || ""}
                            onChange={(event) => setWorkflowEditor((current) => current ? {
                              ...current,
                              values: { ...current.values, [parameter.name]: event.target.value },
                            } : current)}
                            className="h-9 min-w-0 flex-1 rounded-md border border-[oklch(28%_0.008_260)] bg-[oklch(13%_0.006_260)] px-2.5 font-mono text-[11px] text-zinc-200 outline-none focus:border-[oklch(58%_0.08_48)]"
                            required={parameter.required}
                            autoComplete="off"
                          />
                          {parameter.dynamicOptionsCommand && (
                            <button
                              type="button"
                              onClick={() => void loadDynamicOptions(parameter)}
                              className="rounded-md border border-[oklch(28%_0.008_260)] px-2.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                            >
                              Load choices
                            </button>
                          )}
                        </div>
                      )}
                      {parameter.description && <span className="mt-1 block text-[9px] text-zinc-600">{parameter.description}</span>}
                    </label>
                  );
                })}
              </div>
              <div className="sticky bottom-0 flex h-11 items-center justify-end gap-2 border-t border-[oklch(23%_0.007_260)] bg-[oklch(10%_0.005_260)] px-4">
                <button type="button" onClick={() => setWorkflowEditor(null)} className="h-7 rounded px-2.5 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={working}
                  className="flex h-7 items-center gap-1.5 rounded bg-[oklch(65%_0.11_48)] px-3 text-[10px] font-medium text-[oklch(12%_0.02_48)] hover:bg-[oklch(72%_0.11_48)] disabled:opacity-50"
                >
                  {workflowEditor.mode === "execute" ? <Play className="h-3 w-3" /> : <CornerDownLeft className="h-3 w-3" />}
                  {workflowEditor.mode === "execute" ? "Run or queue" : "Insert"}
                </button>
              </div>
            </form>
          ) : (
            <div ref={listRef} id="terminal-command-results" role="listbox" className="min-h-0 overflow-y-auto py-1.5">
              {!loading && flatSuggestions.length === 0 && (
                <div className="px-4 py-10 text-center">
                  <Command className="mx-auto h-5 w-5 text-zinc-700" />
                  <div className="mt-3 text-[11px] text-zinc-400">No command matches</div>
                  <div className="mt-1 text-[9px] text-zinc-600">Use a prefix to narrow the provider, or try a shorter query.</div>
                </div>
              )}
              {groups.map((group) => (
                <div key={group.id} className="pb-1">
                  <div className="sticky top-0 z-10 bg-[oklch(10%_0.005_260/0.96)] px-4 py-1.5 text-[8px] font-medium uppercase tracking-[0.14em] text-zinc-600 backdrop-blur-sm">
                    {group.label}
                  </div>
                  {group.items.map((suggestion) => {
                    const Icon = suggestionIcon(suggestion.kind);
                    const active = suggestion.id === selected?.id;
                    return (
                      <button
                        key={suggestion.id}
                        id={`terminal-suggestion-${suggestion.id}`}
                        data-suggestion-id={suggestion.id}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onMouseEnter={() => setSelectedId(suggestion.id)}
                        onClick={() => void chooseSuggestion(suggestion, "insert")}
                        className={`group flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left transition-colors focus-visible:outline-none ${
                          active ? "bg-[oklch(18%_0.012_48)]" : "hover:bg-[oklch(15%_0.006_260)]"
                        }`}
                      >
                        <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded ${active ? "bg-[oklch(25%_0.035_48)] text-[oklch(78%_0.11_48)]" : "bg-[oklch(15%_0.006_260)] text-zinc-600"}`}>
                          <Icon className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate text-[11px] ${["history", "command", "subcommand", "option", "argument", "variable", "file"].includes(suggestion.kind) ? "font-mono" : "font-medium"} ${active ? "text-zinc-100" : "text-zinc-300"}`}>
                            {suggestion.title}
                          </span>
                          <span className="mt-0.5 block truncate text-[9px] text-zinc-600">{suggestion.description}</span>
                        </span>
                        <span className="flex-shrink-0 rounded border border-[oklch(27%_0.008_260)] px-1.5 py-0.5 text-[8px] text-zinc-600">
                          {kindLabels[suggestion.kind]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {!workflowEditor && (
            <div className="flex h-9 flex-shrink-0 items-center gap-3 border-t border-[oklch(23%_0.007_260)] bg-[oklch(9%_0.004_260)] px-4 text-[9px] text-zinc-600">
              <span className="flex items-center gap-1"><ArrowUp className="h-2.5 w-2.5" /><ArrowDown className="h-2.5 w-2.5" /> select</span>
              <span className="flex items-center gap-1"><CornerDownLeft className="h-2.5 w-2.5" /> insert</span>
              <span className="flex items-center gap-1"><Play className="h-2.5 w-2.5" /> ⌘↵ run / queue</span>
              <button type="button" onClick={() => setGuideOpen((open) => !open)} className="ml-auto hover:text-zinc-300">? guide</button>
              <span>Esc close</span>
            </div>
          )}
          </>
          )}
          </motion.section>
        </>
      )}
    </AnimatePresence>
  );
}
