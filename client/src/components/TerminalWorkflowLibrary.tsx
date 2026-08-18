import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  Download,
  FolderGit2,
  Globe2,
  Loader2,
  Plus,
  Play,
  Save,
  Search,
  Settings2,
  Trash2,
  Upload,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";

export interface TerminalWorkflowParameter {
  name: string;
  description?: string;
  defaultValue?: string;
  required?: boolean;
  options?: string[];
  dynamicOptionsCommand?: string;
  sensitive?: boolean;
  shellQuote?: boolean;
}

export interface TerminalWorkflow {
  id: string;
  name: string;
  description: string;
  command: string;
  parameters: TerminalWorkflowParameter[];
  tags: string[];
  scope: "global" | "workspace";
  workspacePath?: string;
  shells?: Array<"zsh" | "bash" | "fish" | "powershell">;
  sourceUrl?: string;
  author?: string;
  authorUrl?: string;
  createdAt: number;
  updatedAt: number;
}

interface WorkflowDraft {
  id?: string;
  name: string;
  description: string;
  command: string;
  parameters: TerminalWorkflowParameter[];
  tagsText: string;
  scope: "global" | "workspace";
  workspacePath: string;
  shells: Array<"zsh" | "bash" | "fish" | "powershell">;
  sourceUrl: string;
  author: string;
  authorUrl: string;
}

interface WorkflowUseState {
  mode: "insert" | "execute";
  values: Record<string, string>;
  dynamicOptions: Record<string, string[]>;
}

interface TerminalWorkflowLibraryProps {
  open: boolean;
  cwd: string;
  sessionName: string;
  variant?: "panel" | "command-center";
  onBack?: () => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onInsert: (command: string) => void;
  onExecute: (command: string, sensitive: boolean) => Promise<void>;
}

type WorkflowFilter = "all" | "global" | "workspace";
type ParameterMode = "text" | "static" | "dynamic";
type ShellName = "zsh" | "bash" | "fish" | "powershell";

const shellNames: ShellName[] = ["zsh", "bash", "fish", "powershell"];
const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[oklch(72%_0.13_48)]";
const inputClass = "w-full rounded-md border border-[oklch(28%_0.008_260)] bg-[oklch(11%_0.005_260)] px-2.5 text-[10px] text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-[oklch(58%_0.08_48)]";

async function readJson(response: Response, fallback: string) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || fallback);
  return body;
}

function draftFromWorkflow(workflow: TerminalWorkflow): WorkflowDraft {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description || "",
    command: workflow.command,
    parameters: workflow.parameters.map((parameter) => ({
      ...parameter,
      options: parameter.options ? [...parameter.options] : undefined,
    })),
    tagsText: workflow.tags.join(", "),
    scope: workflow.scope,
    workspacePath: workflow.workspacePath || "",
    shells: workflow.shells ? [...workflow.shells] : [],
    sourceUrl: workflow.sourceUrl || "",
    author: workflow.author || "",
    authorUrl: workflow.authorUrl || "",
  };
}

function emptyDraft(cwd: string): WorkflowDraft {
  return {
    name: "",
    description: "",
    command: "",
    parameters: [],
    tagsText: "",
    scope: "global",
    workspacePath: cwd,
    shells: [],
    sourceUrl: "",
    author: "",
    authorUrl: "",
  };
}

function workflowPayload(draft: WorkflowDraft) {
  return {
    name: draft.name,
    description: draft.description,
    command: draft.command,
    parameters: draft.parameters.map((parameter) => ({
      name: parameter.name,
      description: parameter.description || undefined,
      defaultValue: parameter.options?.length && !parameter.defaultValue ? undefined : parameter.defaultValue,
      required: Boolean(parameter.required),
      options: parameter.options?.filter(Boolean).length ? parameter.options.filter(Boolean) : undefined,
      dynamicOptionsCommand: parameter.dynamicOptionsCommand || undefined,
      sensitive: Boolean(parameter.sensitive),
      shellQuote: Boolean(parameter.shellQuote),
    })),
    tags: [...new Set(draft.tagsText.split(",").map((tag) => tag.trim()).filter(Boolean))],
    scope: draft.scope,
    workspacePath: draft.scope === "workspace" ? draft.workspacePath : undefined,
    shells: draft.shells.length ? draft.shells : undefined,
    sourceUrl: draft.sourceUrl || undefined,
    author: draft.author || undefined,
    authorUrl: draft.authorUrl || undefined,
  };
}

function draftHash(draft: WorkflowDraft) {
  return JSON.stringify(workflowPayload(draft));
}

function placeholderNames(command: string) {
  const names = new Set<string>();
  for (const match of command.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g)) names.add(match[1]);
  return [...names];
}

function parameterMode(parameter: TerminalWorkflowParameter): ParameterMode {
  if (parameter.dynamicOptionsCommand) return "dynamic";
  if (parameter.options) return "static";
  return "text";
}

export function TerminalWorkflowLibrary({
  open,
  cwd,
  sessionName,
  variant = "panel",
  onBack,
  onClose,
  onDirtyChange,
  onInsert,
  onExecute,
}: TerminalWorkflowLibraryProps) {
  const [workflows, setWorkflows] = useState<TerminalWorkflow[]>([]);
  const [draft, setDraft] = useState<WorkflowDraft>(() => emptyDraft(cwd));
  const [savedHash, setSavedHash] = useState(() => draftHash(emptyDraft(cwd)));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<WorkflowFilter>("all");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [expandedParameters, setExpandedParameters] = useState<Set<number>>(new Set());
  const [workflowUse, setWorkflowUse] = useState<WorkflowUseState | null>(null);
  const [renderedCommand, setRenderedCommand] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importYaml, setImportYaml] = useState("");
  const [importConflict, setImportConflict] = useState<"skip" | "rename" | "error">("rename");
  const [importToWorkspace, setImportToWorkspace] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const dirty = draftHash(draft) !== savedHash;
  const detectedParameters = useMemo(() => placeholderNames(draft.command), [draft.command]);
  const missingParameters = detectedParameters.filter((name) => !draft.parameters.some((parameter) => parameter.name === name));
  const unusedParameters = draft.parameters.filter((parameter) => !detectedParameters.includes(parameter.name));

  const visibleWorkflows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return workflows.filter((workflow) => {
      if (filter !== "all" && workflow.scope !== filter) return false;
      if (!normalizedQuery) return true;
      return [workflow.name, workflow.description, workflow.command, workflow.tags.join(" ")]
        .some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [filter, query, workflows]);

  const loadWorkflows = async (preferredId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/terminal/workflows");
      const body = await readJson(response, "Workflows are unavailable");
      const items = Array.isArray(body.workflows) ? body.workflows as TerminalWorkflow[] : [];
      setWorkflows(items);
      const selected = items.find((workflow) => workflow.id === preferredId)
        || items.find((workflow) => workflow.id === draft.id)
        || items[0];
      if (selected) {
        const nextDraft = draftFromWorkflow(selected);
        setDraft(nextDraft);
        setSavedHash(draftHash(nextDraft));
      } else {
        const nextDraft = emptyDraft(cwd);
        setDraft(nextDraft);
        setSavedHash(draftHash(nextDraft));
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Workflows are unavailable");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    setImportOpen(false);
    setWorkflowUse(null);
    void loadWorkflows();
    const timeout = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(timeout);
    // Opening the rail intentionally refreshes the persisted workflow store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!open || !draft.id || !workflowUse) {
      setRenderedCommand(null);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/terminal/workflows/${encodeURIComponent(draft.id!)}/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ values: workflowUse.values }),
          signal: controller.signal,
        });
        if (!response.ok) {
          setRenderedCommand(null);
          return;
        }
        const body = await response.json();
        setRenderedCommand(typeof body.command === "string" ? body.command : null);
      } catch (previewError) {
        if ((previewError as Error).name !== "AbortError") setRenderedCommand(null);
      }
    }, 120);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [draft.id, open, workflowUse]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const guardUnsaved = () => !dirty || window.confirm("Discard unsaved workflow changes?");

  const selectWorkflow = (workflow: TerminalWorkflow) => {
    if (!guardUnsaved()) return;
    const nextDraft = draftFromWorkflow(workflow);
    setDraft(nextDraft);
    setSavedHash(draftHash(nextDraft));
    setExpandedParameters(new Set());
    setWorkflowUse(null);
    setImportOpen(false);
    setError(null);
    setMessage(null);
  };

  const startNew = () => {
    if (!guardUnsaved()) return;
    const nextDraft = emptyDraft(cwd);
    setDraft(nextDraft);
    setSavedHash(draftHash(nextDraft));
    setExpandedParameters(new Set());
    setWorkflowUse(null);
    setImportOpen(false);
    setError(null);
    setMessage(null);
  };

  const addParameter = (requestedName?: string) => {
    let name = requestedName || "argument";
    let suffix = 2;
    while (draft.parameters.some((parameter) => parameter.name === name)) name = `argument-${suffix++}`;
    const index = draft.parameters.length;
    setDraft((current) => ({
      ...current,
      parameters: [...current.parameters, { name, description: "", defaultValue: "", required: true }],
    }));
    setExpandedParameters((current) => new Set([...current, index]));
  };

  const updateParameter = (index: number, patch: Partial<TerminalWorkflowParameter>) => {
    setDraft((current) => ({
      ...current,
      parameters: current.parameters.map((parameter, parameterIndex) => parameterIndex === index
        ? { ...parameter, ...patch }
        : parameter),
    }));
  };

  const renameParameter = (index: number, name: string) => {
    if (!name) return;
    setDraft((current) => {
      const previousName = current.parameters[index]?.name;
      const command = previousName && previousName !== name
        ? current.command.replace(new RegExp(`\\{\\{\\s*${previousName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`, "g"), () => `{{${name}}}`)
        : current.command;
      return {
        ...current,
        command,
        parameters: current.parameters.map((parameter, parameterIndex) => parameterIndex === index
          ? { ...parameter, name }
          : parameter),
      };
    });
  };

  const removeParameter = (index: number) => {
    setDraft((current) => ({
      ...current,
      parameters: current.parameters.filter((_, parameterIndex) => parameterIndex !== index),
    }));
    setExpandedParameters((current) => new Set([...current].filter((item) => item !== index).map((item) => item > index ? item - 1 : item)));
  };

  const changeParameterMode = (index: number, mode: ParameterMode) => {
    if (mode === "static") updateParameter(index, { options: [], dynamicOptionsCommand: undefined });
    else if (mode === "dynamic") updateParameter(index, { options: undefined, dynamicOptionsCommand: "" });
    else updateParameter(index, { options: undefined, dynamicOptionsCommand: undefined });
  };

  const saveWorkflow = async (event?: FormEvent) => {
    event?.preventDefault();
    setWorking(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(draft.id
        ? `/api/terminal/workflows/${encodeURIComponent(draft.id)}`
        : "/api/terminal/workflows", {
        method: draft.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workflowPayload(draft)),
      });
      const body = await readJson(response, "Workflow could not be saved");
      const saved = body.workflow as TerminalWorkflow;
      const nextDraft = draftFromWorkflow(saved);
      setDraft(nextDraft);
      setSavedHash(draftHash(nextDraft));
      setMessage(draft.id ? "Saved command updated." : "Command saved.");
      await loadWorkflows(saved.id);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Workflow could not be saved");
    } finally {
      setWorking(false);
    }
  };

  const deleteWorkflow = async () => {
    if (!draft.id || !window.confirm(`Delete ${draft.name}? This cannot be undone.`)) return;
    setWorking(true);
    setError(null);
    try {
      const response = await fetch(`/api/terminal/workflows/${encodeURIComponent(draft.id)}`, { method: "DELETE" });
      await readJson(response, "Workflow could not be deleted");
      setMessage("Saved command deleted.");
      await loadWorkflows();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Workflow could not be deleted");
    } finally {
      setWorking(false);
    }
  };

  const exportWorkflows = async (id?: string) => {
    setWorking(true);
    setError(null);
    try {
      const params = id ? `?ids=${encodeURIComponent(id)}` : "";
      const response = await fetch(`/api/terminal/workflows/export${params}`);
      const yaml = await response.text();
      if (!response.ok) {
        let detail = "Workflows could not be exported";
        try { detail = JSON.parse(yaml).error || detail; } catch { /* Keep the stable fallback. */ }
        throw new Error(detail);
      }
      const url = URL.createObjectURL(new Blob([yaml], { type: "application/yaml" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = id ? `${draft.name.replace(/[^A-Za-z0-9._-]+/g, "-") || "workflow"}.yaml` : "openui-workflows.yaml";
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(id ? "Saved command exported." : "Saved commands exported.");
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Workflows could not be exported");
    } finally {
      setWorking(false);
    }
  };

  const importWorkflows = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/terminal/workflows/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yaml: importYaml,
          conflict: importConflict,
          workspacePath: importToWorkspace ? cwd : undefined,
        }),
      });
      const body = await readJson(response, "Workflow YAML could not be imported");
      const imported = Array.isArray(body.imported) ? body.imported as TerminalWorkflow[] : [];
      const skipped = Array.isArray(body.skipped) ? body.skipped.length : 0;
      setImportOpen(false);
      setImportYaml("");
      setMessage(`Imported ${imported.length} saved command${imported.length === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}.`);
      await loadWorkflows(imported[0]?.id);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Workflow YAML could not be imported");
    } finally {
      setWorking(false);
    }
  };

  const beginUse = (mode: "insert" | "execute") => {
    if (!draft.id) {
      setError("Save this workflow before using it.");
      return;
    }
    setRenderedCommand(null);
    setWorkflowUse({
      mode,
      values: Object.fromEntries(draft.parameters.map((parameter) => [
        parameter.name,
        parameter.defaultValue || (parameter.required ? parameter.options?.[0] || "" : ""),
      ])),
      dynamicOptions: {},
    });
    setError(null);
    setMessage(null);
  };

  const loadDynamicOptions = async (parameter: TerminalWorkflowParameter) => {
    if (!draft.id || !workflowUse) return;
    setWorking(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/terminal/workflows/${encodeURIComponent(draft.id)}/parameters/${encodeURIComponent(parameter.name)}/options`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: "run-dynamic-options", cwd }),
        },
      );
      const body = await readJson(response, "Dynamic choices could not be loaded");
      const options = Array.isArray(body.options) ? body.options as string[] : [];
      setWorkflowUse((current) => current ? {
        ...current,
        values: {
          ...current.values,
          [parameter.name]: current.values[parameter.name] || (parameter.required ? options[0] || "" : ""),
        },
        dynamicOptions: { ...current.dynamicOptions, [parameter.name]: options },
      } : current);
    } catch (optionError) {
      setError(optionError instanceof Error ? optionError.message : "Dynamic choices could not be loaded");
    } finally {
      setWorking(false);
    }
  };

  const submitUse = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.id || !workflowUse) return;
    setWorking(true);
    setError(null);
    try {
      const response = await fetch(`/api/terminal/workflows/${encodeURIComponent(draft.id)}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: workflowUse.values }),
      });
      const body = await readJson(response, "Workflow could not be rendered");
      if (workflowUse.mode === "execute") await onExecute(body.command, Boolean(body.sensitive));
      else onInsert(body.command);
      onClose();
    } catch (useError) {
      setError(useError instanceof Error ? useError.message : "Workflow could not be rendered");
    } finally {
      setWorking(false);
    }
  };

  if (!open) return null;

  return (
    <section
      className={`flex h-full overflow-hidden bg-[oklch(9%_0.004_260)] text-zinc-200 ${variant === "command-center"
        ? "w-full min-w-0"
        : "w-[min(760px,72vw)] min-w-[560px] border-l border-[oklch(23%_0.007_260)]"}`}
      aria-label="Workflow library"
    >
      <aside className="flex w-56 flex-shrink-0 flex-col border-r border-[oklch(22%_0.006_260)] bg-[oklch(8%_0.004_260)]">
        <div className="flex h-11 items-center gap-2 border-b border-[oklch(22%_0.006_260)] px-3">
          <WorkflowIcon className="h-3.5 w-3.5 text-[oklch(76%_0.11_48)]" />
          <span className="text-[11px] font-medium text-zinc-200">Saved commands</span>
          <span className="ml-auto text-[9px] tabular-nums text-zinc-600">{workflows.length}</span>
        </div>
        <div className="border-b border-[oklch(21%_0.006_260)] p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search saved commands"
              className={`${inputClass} h-8 pl-7`}
              aria-label="Search workflows"
            />
          </div>
          <div className="mt-1.5 flex gap-1" role="group" aria-label="Workflow scope filter">
            {(["all", "global", "workspace"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                aria-pressed={filter === value}
                className={`h-6 rounded px-2 text-[8px] capitalize transition-colors ${focusRing} ${filter === value
                  ? "bg-[oklch(21%_0.025_48)] text-[oklch(80%_0.10_48)]"
                  : "text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"}`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {loading ? (
            <div className="space-y-1.5 p-1.5" aria-label="Loading workflows">
              {[0, 1, 2].map((item) => <div key={item} className="h-12 animate-pulse rounded-md bg-zinc-900 motion-reduce:animate-none" />)}
            </div>
          ) : visibleWorkflows.length === 0 ? (
            <div className="px-3 py-9 text-center">
              <WorkflowIcon className="mx-auto h-5 w-5 text-zinc-700" />
              <p className="mt-2 text-[10px] text-zinc-500">{workflows.length ? "No saved command matches" : "No saved commands yet"}</p>
              <p className="mt-1 text-[8px] leading-4 text-zinc-700">Save a command once, then reuse it from Cmd+P.</p>
            </div>
          ) : visibleWorkflows.map((workflow) => {
            const selected = workflow.id === draft.id;
            return (
              <button
                key={workflow.id}
                data-workflow-id={workflow.id}
                type="button"
                onClick={() => selectWorkflow(workflow)}
                aria-current={selected ? "true" : undefined}
                className={`mb-0.5 w-full rounded-md px-2.5 py-2 text-left transition-colors ${focusRing} ${selected
                  ? "bg-[oklch(18%_0.015_48)] text-zinc-100"
                  : "text-zinc-400 hover:bg-[oklch(14%_0.005_260)] hover:text-zinc-200"}`}
              >
                <span className="block truncate text-[10px] font-medium">{workflow.name}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[8px] text-zinc-600">
                  {workflow.scope === "workspace" ? <FolderGit2 className="h-2.5 w-2.5" /> : <Globe2 className="h-2.5 w-2.5" />}
                  {workflow.scope}
                  {workflow.parameters.length > 0 && <><span className="text-zinc-800">·</span>{workflow.parameters.length} args</>}
                </span>
                <code className="mt-1 block truncate text-[8px] text-zinc-700">{workflow.command}</code>
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-2 gap-1 border-t border-[oklch(21%_0.006_260)] p-2">
          <button type="button" data-workflow-action="new" onClick={startNew} className={`flex h-7 items-center justify-center gap-1 rounded text-[9px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 ${focusRing}`}>
            <Plus className="h-3 w-3" /> New
          </button>
          <button type="button" onClick={() => { if (guardUnsaved()) { setImportOpen(true); setWorkflowUse(null); } }} className={`flex h-7 items-center justify-center gap-1 rounded text-[9px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 ${focusRing}`}>
            <Upload className="h-3 w-3" /> Import
          </button>
          <button type="button" onClick={() => void exportWorkflows(draft.id)} disabled={!draft.id || working} className={`flex h-7 items-center justify-center gap-1 rounded text-[9px] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-30 ${focusRing}`}>
            <Download className="h-3 w-3" /> Selected
          </button>
          <button type="button" onClick={() => void exportWorkflows()} disabled={!workflows.length || working} className={`flex h-7 items-center justify-center gap-1 rounded text-[9px] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-30 ${focusRing}`}>
            <Download className="h-3 w-3" /> All
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 flex-shrink-0 items-center gap-2 border-b border-[oklch(22%_0.006_260)] px-3">
          {onBack && (
            <button type="button" onClick={onBack} className={`flex h-7 w-7 items-center justify-center rounded text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 ${focusRing}`} aria-label="Back to Command Center" title="Back to Command Center">
              <ChevronRight className="h-3.5 w-3.5 rotate-180" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium text-zinc-100">
              {importOpen ? "Import saved command YAML" : workflowUse ? `Use ${draft.name}` : draft.id ? draft.name : "New saved command"}
            </div>
            <div className="mt-0.5 truncate text-[8px] text-zinc-600">
              {workflowUse ? `${workflowUse.mode === "execute" ? "Run or queue" : "Insert"} in ${sessionName}` : importOpen ? "Warp-compatible and OpenUI command files" : dirty ? "Unsaved changes" : "Saved"}
            </div>
          </div>
          {working && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500 motion-reduce:animate-none" />}
          {!importOpen && !workflowUse && draft.id && (
            <button type="button" onClick={() => void deleteWorkflow()} disabled={working} className={`flex h-7 w-7 items-center justify-center rounded text-zinc-700 hover:bg-[oklch(18%_0.03_28)] hover:text-[oklch(72%_0.11_28)] disabled:opacity-30 ${focusRing}`} aria-label={`Delete ${draft.name}`} title="Delete workflow">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button type="button" onClick={onClose} className={`flex h-7 w-7 items-center justify-center rounded text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 ${focusRing}`} aria-label="Close workflow library">
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        {(error || message) && (
          <div className={`flex items-center gap-2 border-b px-3 py-2 text-[9px] ${error
            ? "border-[oklch(31%_0.05_28)] bg-[oklch(14%_0.02_28)] text-[oklch(76%_0.10_28)]"
            : "border-[oklch(28%_0.035_145)] bg-[oklch(13%_0.016_145)] text-[oklch(76%_0.08_145)]"}`} role={error ? "alert" : "status"}>
            {error ? <AlertTriangle className="h-3 w-3 flex-shrink-0" /> : <Check className="h-3 w-3 flex-shrink-0" />}
            <span className="min-w-0 flex-1">{error || message}</span>
            <button type="button" onClick={() => { setError(null); setMessage(null); }} className="text-current opacity-60 hover:opacity-100" aria-label="Dismiss message"><X className="h-3 w-3" /></button>
          </div>
        )}

        {importOpen ? (
          <form onSubmit={importWorkflows} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <label className="text-[9px] font-medium text-zinc-400" htmlFor="workflow-import-yaml">YAML</label>
              <textarea
                id="workflow-import-yaml"
                autoFocus
                value={importYaml}
                onChange={(event) => setImportYaml(event.target.value)}
                placeholder={'name: Deploy service\ncommand: kubectl -n {{namespace}} apply -f {{file}}'}
                className={`${inputClass} mt-1.5 min-h-64 resize-y px-3 py-2.5 font-mono leading-5`}
                spellCheck={false}
              />
              <div className="mt-4 grid grid-cols-2 gap-4">
                <label className="block text-[9px] text-zinc-500">Name conflicts
                  <select value={importConflict} onChange={(event) => setImportConflict(event.target.value as typeof importConflict)} className={`${inputClass} mt-1.5 h-8`}>
                    <option value="rename">Rename imported</option>
                    <option value="skip">Skip existing</option>
                    <option value="error">Stop on conflict</option>
                  </select>
                </label>
                <label className="flex items-start gap-2 pt-5 text-[9px] text-zinc-400">
                  <input type="checkbox" checked={importToWorkspace} onChange={(event) => setImportToWorkspace(event.target.checked)} className="mt-0.5 accent-orange-500" />
                  <span>Scope imported workflows to <code className="block max-w-48 truncate text-[8px] text-zinc-600">{cwd}</code></span>
                </label>
              </div>
            </div>
            <footer className="flex h-12 items-center justify-end gap-2 border-t border-[oklch(22%_0.006_260)] px-3">
              <button type="button" onClick={() => setImportOpen(false)} className={`h-7 rounded px-2.5 text-[9px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 ${focusRing}`}>Cancel</button>
              <button type="submit" disabled={!importYaml.trim() || working} className={`flex h-7 items-center gap-1.5 rounded bg-[oklch(66%_0.11_48)] px-3 text-[9px] font-medium text-[oklch(12%_0.02_48)] hover:bg-[oklch(72%_0.11_48)] disabled:opacity-40 ${focusRing}`}><Upload className="h-3 w-3" /> Import</button>
            </footer>
          </form>
        ) : workflowUse ? (
          <form onSubmit={submitUse} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <p className="text-[9px] leading-4 text-zinc-500">{draft.description || "Set the values, review the command, then insert or run it."}</p>
              <div className="mt-3 text-[7px] font-medium uppercase tracking-[0.12em] text-zinc-700">{renderedCommand ? "Command preview" : "Command template"}</div>
              <code className="mt-1.5 block rounded-md border border-[oklch(24%_0.007_260)] bg-[oklch(7%_0.004_260)] p-3 text-[9px] leading-5 text-zinc-400" aria-live="polite">{renderedCommand || draft.command}</code>
              <div className="mt-5 space-y-4">
                {draft.parameters.map((parameter) => {
                  const choices = parameter.options || workflowUse.dynamicOptions[parameter.name];
                  return (
                    <label key={parameter.name} className="block">
                      <span className="mb-1.5 flex items-center gap-2 text-[9px] font-medium text-zinc-300">
                        {parameter.name}
                        {parameter.required && <span className="rounded bg-[oklch(23%_0.025_48)] px-1.5 py-0.5 text-[7px] text-[oklch(78%_0.10_48)]">required</span>}
                        {parameter.sensitive && <span className="rounded bg-[oklch(19%_0.02_28)] px-1.5 py-0.5 text-[7px] text-[oklch(70%_0.09_28)]">sensitive</span>}
                      </span>
                      {choices?.length ? (
                        <select
                          data-workflow-value={parameter.name}
                          value={workflowUse.values[parameter.name] || ""}
                          onChange={(event) => setWorkflowUse((current) => current ? { ...current, values: { ...current.values, [parameter.name]: event.target.value } } : current)}
                          className={`${inputClass} h-9 font-mono`}
                          required={parameter.required}
                        >
                          {!parameter.required && <option value="">Empty</option>}
                          {choices.map((option) => <option key={option} value={option}>{option}</option>)}
                        </select>
                      ) : (
                        <div className="flex gap-2">
                          <input
                            data-workflow-value={parameter.name}
                            type={parameter.sensitive ? "password" : "text"}
                            value={workflowUse.values[parameter.name] || ""}
                            onChange={(event) => setWorkflowUse((current) => current ? { ...current, values: { ...current.values, [parameter.name]: event.target.value } } : current)}
                            className={`${inputClass} h-9 min-w-0 flex-1 font-mono`}
                            required={parameter.required}
                            autoComplete="off"
                          />
                          {parameter.dynamicOptionsCommand && (
                            <button type="button" onClick={() => void loadDynamicOptions(parameter)} disabled={working} className={`h-9 rounded-md border border-[oklch(28%_0.008_260)] px-2.5 text-[9px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40 ${focusRing}`}>Run choices command</button>
                          )}
                        </div>
                      )}
                      {parameter.description && <span className="mt-1 block text-[8px] text-zinc-600">{parameter.description}</span>}
                    </label>
                  );
                })}
              </div>
            </div>
            <footer className="flex h-12 items-center justify-between border-t border-[oklch(22%_0.006_260)] px-3">
              <button type="button" onClick={() => setWorkflowUse(null)} className={`h-7 rounded px-2.5 text-[9px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 ${focusRing}`}>Back to editor</button>
              <button type="submit" data-workflow-action="confirm-use" disabled={working} className={`flex h-7 items-center gap-1.5 rounded bg-[oklch(66%_0.11_48)] px-3 text-[9px] font-medium text-[oklch(12%_0.02_48)] hover:bg-[oklch(72%_0.11_48)] disabled:opacity-40 ${focusRing}`}>
                {workflowUse.mode === "execute" ? <Play className="h-3 w-3" /> : <CornerDownLeft className="h-3 w-3" />}
                {workflowUse.mode === "execute" ? "Run or queue" : "Insert command"}
              </button>
            </footer>
          </form>
        ) : (
          <form onSubmit={saveWorkflow} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(150px,0.48fr)] gap-3">
                <label className="text-[9px] font-medium text-zinc-400">Name
                  <input data-workflow-field="name" autoFocus={!draft.id} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} maxLength={120} placeholder="Deploy service" className={`${inputClass} mt-1.5 h-8`} />
                </label>
                <label className="text-[9px] font-medium text-zinc-400">Tags
                  <input value={draft.tagsText} onChange={(event) => setDraft((current) => ({ ...current, tagsText: event.target.value }))} placeholder="deploy, kubernetes" className={`${inputClass} mt-1.5 h-8`} />
                </label>
              </div>
              <label className="mt-3 block text-[9px] font-medium text-zinc-400">Description
                <input value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} maxLength={2000} placeholder="What this command does and when to use it" className={`${inputClass} mt-1.5 h-8`} />
              </label>
              <label className="mt-4 block text-[9px] font-medium text-zinc-400">Command
                <textarea
                  data-workflow-field="command"
                  value={draft.command}
                  onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))}
                  maxLength={12_000}
                  rows={6}
                  placeholder="kubectl -n {{namespace}} set image deployment/{{service}} app={{image}}"
                  className={`${inputClass} mt-1.5 resize-y px-3 py-2.5 font-mono text-[11px] leading-5`}
                  spellCheck={false}
                />
              </label>

              {(missingParameters.length > 0 || unusedParameters.length > 0) && (
                <div className="mt-2 rounded-md border border-[oklch(31%_0.045_75)] bg-[oklch(14%_0.018_75)] p-2.5 text-[8px] text-[oklch(76%_0.08_75)]">
                  {missingParameters.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="mr-1">Define detected arguments:</span>
                      {missingParameters.map((name) => <button key={name} type="button" data-workflow-detected={name} onClick={() => addParameter(name)} className={`rounded bg-[oklch(23%_0.035_75)] px-2 py-1 font-mono hover:bg-[oklch(28%_0.045_75)] ${focusRing}`}>+ {name}</button>)}
                    </div>
                  )}
                  {unusedParameters.length > 0 && <div className={missingParameters.length ? "mt-2" : ""}>Unused definitions: {unusedParameters.map((parameter) => parameter.name).join(", ")}</div>}
                </div>
              )}

              <div className="mt-5 flex items-center justify-between">
                <div>
                  <h3 className="text-[10px] font-medium text-zinc-300">Arguments</h3>
                  <p className="mt-0.5 text-[8px] text-zinc-600">Use double braces in the command, for example <code>{"{{environment}}"}</code>.</p>
                </div>
                <button type="button" onClick={() => addParameter()} className={`flex h-7 items-center gap-1 rounded px-2 text-[9px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 ${focusRing}`}><Plus className="h-3 w-3" /> Add argument</button>
              </div>

              <div className="mt-2 space-y-1.5">
                {draft.parameters.length === 0 ? (
                  <button type="button" onClick={() => addParameter()} className={`w-full rounded-md border border-dashed border-[oklch(27%_0.007_260)] px-3 py-5 text-center text-[9px] text-zinc-600 hover:border-[oklch(38%_0.025_48)] hover:text-zinc-400 ${focusRing}`}>Add an argument or type one in the command</button>
                ) : draft.parameters.map((parameter, index) => {
                  const expanded = expandedParameters.has(index);
                  const mode = parameterMode(parameter);
                  return (
                    <div key={`${index}-${parameter.name}`} className="rounded-md border border-[oklch(24%_0.007_260)] bg-[oklch(10%_0.004_260)]">
                      <div className="flex items-center gap-2 p-2">
                        <button type="button" onClick={() => setExpandedParameters((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })} className={`flex h-6 w-6 items-center justify-center rounded text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 ${focusRing}`} aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${parameter.name || "argument"}`}>
                          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        </button>
                        <input value={parameter.name} onChange={(event) => renameParameter(index, event.target.value)} maxLength={80} aria-label={`Argument ${index + 1} name`} className={`${inputClass} h-7 min-w-0 flex-1 font-mono`} />
                        <label className="flex items-center gap-1.5 text-[8px] text-zinc-500"><input type="checkbox" checked={Boolean(parameter.required)} onChange={(event) => updateParameter(index, { required: event.target.checked })} className="accent-orange-500" /> Required</label>
                        <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[7px] text-zinc-600">{mode}</span>
                        <button type="button" onClick={() => removeParameter(index)} className={`flex h-6 w-6 items-center justify-center rounded text-zinc-700 hover:bg-[oklch(18%_0.03_28)] hover:text-[oklch(72%_0.11_28)] ${focusRing}`} aria-label={`Remove ${parameter.name || "argument"}`}><Trash2 className="h-3 w-3" /></button>
                      </div>
                      {expanded && (
                        <div className="grid grid-cols-2 gap-3 border-t border-[oklch(22%_0.006_260)] p-3">
                          <label className="col-span-2 text-[8px] text-zinc-500">Description
                            <input value={parameter.description || ""} onChange={(event) => updateParameter(index, { description: event.target.value })} maxLength={500} className={`${inputClass} mt-1 h-8`} />
                          </label>
                          <label className="text-[8px] text-zinc-500">Value source
                            <select value={mode} onChange={(event) => changeParameterMode(index, event.target.value as ParameterMode)} className={`${inputClass} mt-1 h-8`}>
                              <option value="text">Text</option>
                              <option value="static">Static choices</option>
                              <option value="dynamic">Dynamic choices command</option>
                            </select>
                          </label>
                          <label className="text-[8px] text-zinc-500">Default value
                            <input value={parameter.defaultValue || ""} onChange={(event) => updateParameter(index, { defaultValue: event.target.value })} maxLength={4000} className={`${inputClass} mt-1 h-8 font-mono`} />
                          </label>
                          {mode === "static" && (
                            <label className="col-span-2 text-[8px] text-zinc-500">Choices, one per line
                              <textarea value={(parameter.options || []).join("\n")} onChange={(event) => updateParameter(index, { options: event.target.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) })} rows={3} className={`${inputClass} mt-1 resize-y px-2.5 py-2 font-mono leading-4`} />
                            </label>
                          )}
                          {mode === "dynamic" && (
                            <label className="col-span-2 text-[8px] text-zinc-500">Choices command
                              <input value={parameter.dynamicOptionsCommand || ""} onChange={(event) => updateParameter(index, { dynamicOptionsCommand: event.target.value })} maxLength={4000} placeholder="kubectl get namespaces -o name" className={`${inputClass} mt-1 h-8 font-mono`} />
                              <span className="mt-1 block text-[7px] leading-3 text-zinc-700">Runs only after explicit confirmation while using the workflow. Output is redacted and capped.</span>
                            </label>
                          )}
                          <label className="flex items-center gap-2 text-[8px] text-zinc-500"><input type="checkbox" checked={Boolean(parameter.shellQuote)} onChange={(event) => updateParameter(index, { shellQuote: event.target.checked })} className="accent-orange-500" /> Shell-quote this value</label>
                          <label className="flex items-center gap-2 text-[8px] text-zinc-500"><input type="checkbox" checked={Boolean(parameter.sensitive)} onChange={(event) => updateParameter(index, { sensitive: event.target.checked })} className="accent-orange-500" /> Treat as sensitive</label>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <details className="mt-5 rounded-md border border-[oklch(23%_0.006_260)] bg-[oklch(9%_0.004_260)]">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[9px] text-zinc-500 hover:text-zinc-300"><Settings2 className="h-3 w-3" /> Scope, shells, and attribution</summary>
                <div className="grid grid-cols-2 gap-3 border-t border-[oklch(22%_0.006_260)] p-3">
                  <label className="text-[8px] text-zinc-500">Scope
                    <select value={draft.scope} onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value as WorkflowDraft["scope"], workspacePath: event.target.value === "workspace" ? current.workspacePath || cwd : current.workspacePath }))} className={`${inputClass} mt-1 h-8`}>
                      <option value="global">Global</option>
                      <option value="workspace">Workspace</option>
                    </select>
                  </label>
                  <label className="text-[8px] text-zinc-500">Workspace path
                    <input value={draft.workspacePath} onChange={(event) => setDraft((current) => ({ ...current, workspacePath: event.target.value }))} disabled={draft.scope !== "workspace"} className={`${inputClass} mt-1 h-8 font-mono disabled:opacity-35`} />
                  </label>
                  <div className="col-span-2">
                    <div className="text-[8px] text-zinc-500">Available shells</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {shellNames.map((shell) => {
                        const active = draft.shells.includes(shell);
                        return <button key={shell} type="button" aria-pressed={active} onClick={() => setDraft((current) => ({ ...current, shells: active ? current.shells.filter((item) => item !== shell) : [...current.shells, shell] }))} className={`h-6 rounded px-2 font-mono text-[8px] ${focusRing} ${active ? "bg-[oklch(21%_0.025_48)] text-[oklch(78%_0.09_48)]" : "bg-zinc-900 text-zinc-600 hover:text-zinc-300"}`}>{shell}</button>;
                      })}
                      <span className="self-center text-[7px] text-zinc-700">No selection means every shell.</span>
                    </div>
                  </div>
                  <label className="text-[8px] text-zinc-500">Author<input value={draft.author} onChange={(event) => setDraft((current) => ({ ...current, author: event.target.value }))} className={`${inputClass} mt-1 h-8`} /></label>
                  <label className="text-[8px] text-zinc-500">Source URL<input value={draft.sourceUrl} onChange={(event) => setDraft((current) => ({ ...current, sourceUrl: event.target.value }))} className={`${inputClass} mt-1 h-8`} /></label>
                  <label className="col-span-2 text-[8px] text-zinc-500">Author URL<input value={draft.authorUrl} onChange={(event) => setDraft((current) => ({ ...current, authorUrl: event.target.value }))} className={`${inputClass} mt-1 h-8`} /></label>
                </div>
              </details>
            </div>
            <footer className="flex h-12 flex-shrink-0 items-center gap-2 border-t border-[oklch(22%_0.006_260)] px-3">
              <span className="min-w-0 flex-1 truncate text-[8px] text-zinc-700">{draft.scope === "workspace" ? draft.workspacePath || "Workspace path required" : "Available in every workspace"}</span>
              {draft.id && <button type="button" data-workflow-action="insert" onClick={(event) => { event.preventDefault(); event.stopPropagation(); beginUse("insert"); }} disabled={dirty || working} title={dirty ? "Save changes before using this workflow" : "Insert the rendered command"} className={`flex h-7 items-center gap-1.5 rounded px-2.5 text-[9px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30 ${focusRing}`}><CornerDownLeft className="h-3 w-3" /> Insert</button>}
              {draft.id && <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); beginUse("execute"); }} disabled={dirty || working} title={dirty ? "Save changes before using this workflow" : "Run now or add to the queue"} className={`flex h-7 items-center gap-1.5 rounded px-2.5 text-[9px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30 ${focusRing}`}><Play className="h-3 w-3" /> Run</button>}
              <button type="submit" data-workflow-action="save" disabled={!dirty || !draft.name.trim() || !draft.command.trim() || working} className={`flex h-7 items-center gap-1.5 rounded bg-[oklch(66%_0.11_48)] px-3 text-[9px] font-medium text-[oklch(12%_0.02_48)] hover:bg-[oklch(72%_0.11_48)] disabled:cursor-not-allowed disabled:opacity-35 ${focusRing}`}><Save className="h-3 w-3" /> {draft.id ? "Save changes" : "Save command"}</button>
            </footer>
          </form>
        )}
      </div>
    </section>
  );
}
