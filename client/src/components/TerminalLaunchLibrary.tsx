import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  Download,
  Folder,
  Layers3,
  Loader2,
  Plus,
  Play,
  Rows3,
  Save,
  Search,
  TerminalSquare,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type {
  TerminalLaunchConfiguration,
  TerminalLaunchSession,
  TerminalPaneLayout,
} from "./useTerminalWorkspace";
import { sessionDisplayTitle } from "../utils/sessionTitle";

type LaunchPayload = Omit<TerminalLaunchConfiguration, "id" | "version" | "createdAt" | "updatedAt">;

interface DraftSession extends TerminalLaunchSession {
  workflowValuesText: string;
}

interface LaunchDraft {
  id?: string;
  name: string;
  description: string;
  sessions: DraftSession[];
  layout?: TerminalPaneLayout;
  activeSessionRef?: string;
  launchMode: "atomic" | "best-effort";
}

interface TerminalLaunchLibraryProps {
  open: boolean;
  busy: boolean;
  currentTabName: string;
  currentCwd: string;
  configurations: TerminalLaunchConfiguration[];
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveCurrent: (name: string) => Promise<TerminalLaunchConfiguration | void>;
  onCreate: (input: Record<string, unknown>) => Promise<TerminalLaunchConfiguration>;
  onUpdate: (id: string, input: Record<string, unknown>) => Promise<TerminalLaunchConfiguration>;
  onLaunch: (id: string) => Promise<Record<string, any>>;
  onDelete: (id: string) => Promise<void>;
  onImport: (input: { yaml: string; defaultCwd: string; conflict: "skip" | "rename" | "error" }) => Promise<{
    imported: TerminalLaunchConfiguration[];
    skipped: string[];
    warnings: string[];
  }>;
}

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[oklch(72%_0.13_48)]";
const inputClass = "w-full rounded-md border border-[oklch(28%_0.008_260)] bg-[oklch(11%_0.005_260)] px-2.5 text-[10px] text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-[oklch(58%_0.08_48)]";
const labelClass = "mb-1 block text-[8px] font-medium uppercase tracking-[0.1em] text-zinc-600";

function draftSession(session: TerminalLaunchSession): DraftSession {
  return {
    ...session,
    workflowValues: session.workflowValues ? { ...session.workflowValues } : undefined,
    position: session.position ? { ...session.position } : undefined,
    workflowValuesText: session.workflowValues ? JSON.stringify(session.workflowValues, null, 2) : "",
  };
}

function draftFromConfiguration(configuration: TerminalLaunchConfiguration): LaunchDraft {
  return {
    id: configuration.id,
    name: configuration.name,
    description: configuration.description || "",
    sessions: configuration.sessions.map(draftSession),
    layout: configuration.layout ? structuredClone(configuration.layout) : undefined,
    activeSessionRef: configuration.activeSessionRef,
    launchMode: configuration.launchMode,
  };
}

function emptyDraft(cwd: string): LaunchDraft {
  const session: DraftSession = {
    ref: "shell",
    agentId: "shell",
    agentName: "Shell",
    command: "",
    cwd,
    workflowValuesText: "",
  };
  return {
    name: "",
    description: "",
    sessions: [session],
    layout: { type: "pane", sessionRef: session.ref },
    activeSessionRef: session.ref,
    launchMode: "atomic",
  };
}

function absolutePath(value: string) {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function layoutRefs(layout: TerminalPaneLayout | undefined, output: string[] = []): string[] {
  if (!layout) return output;
  if (layout.type === "pane") output.push(layout.sessionRef);
  else layout.children.forEach((child) => layoutRefs(child, output));
  return output;
}

function renameLayoutRef(layout: TerminalPaneLayout | undefined, from: string, to: string): TerminalPaneLayout | undefined {
  if (!layout) return undefined;
  if (layout.type === "pane") return { ...layout, sessionRef: layout.sessionRef === from ? to : layout.sessionRef };
  return { ...layout, children: layout.children.map((child) => renameLayoutRef(child, from, to)!) };
}

function removeLayoutRef(layout: TerminalPaneLayout | undefined, ref: string): TerminalPaneLayout | undefined {
  if (!layout) return undefined;
  if (layout.type === "pane") return layout.sessionRef === ref ? undefined : layout;
  const children = layout.children
    .map((child) => removeLayoutRef(child, ref))
    .filter((child): child is TerminalPaneLayout => Boolean(child));
  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0];
  return { ...layout, sizes: layout.sizes?.slice(0, children.length), children };
}

function appendLayoutRef(layout: TerminalPaneLayout | undefined, ref: string): TerminalPaneLayout {
  const pane: TerminalPaneLayout = { type: "pane", sessionRef: ref };
  if (!layout) return pane;
  if (layout.type === "pane") return { type: "split", direction: "horizontal", children: [layout, pane] };
  return { ...layout, children: [...layout.children, pane], sizes: undefined };
}

function flatLayout(sessions: DraftSession[], direction: "horizontal" | "vertical"): TerminalPaneLayout | undefined {
  if (!sessions.length) return undefined;
  if (sessions.length === 1) return { type: "pane", sessionRef: sessions[0].ref };
  return {
    type: "split",
    direction,
    children: sessions.map((session) => ({ type: "pane", sessionRef: session.ref })),
  };
}

function updateLayoutAtPath(
  layout: TerminalPaneLayout,
  path: number[],
  updater: (node: TerminalPaneLayout) => TerminalPaneLayout,
): TerminalPaneLayout {
  if (!path.length) return updater(layout);
  if (layout.type === "pane") return layout;
  const [index, ...rest] = path;
  return {
    ...layout,
    children: layout.children.map((child, childIndex) => childIndex === index
      ? updateLayoutAtPath(child, rest, updater)
      : child),
  };
}

function moveLayoutChild(layout: TerminalPaneLayout, path: number[], delta: -1 | 1): TerminalPaneLayout {
  if (!path.length) return layout;
  const parentPath = path.slice(0, -1);
  const childIndex = path[path.length - 1];
  return updateLayoutAtPath(layout, parentPath, (node) => {
    if (node.type === "pane") return node;
    const nextIndex = childIndex + delta;
    if (nextIndex < 0 || nextIndex >= node.children.length) return node;
    const children = [...node.children];
    [children[childIndex], children[nextIndex]] = [children[nextIndex], children[childIndex]];
    const sizes = node.sizes ? [...node.sizes] : undefined;
    if (sizes) [sizes[childIndex], sizes[nextIndex]] = [sizes[nextIndex], sizes[childIndex]];
    return { ...node, children, sizes };
  });
}

function payloadFromDraft(draft: LaunchDraft): LaunchPayload {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    launchMode: draft.launchMode,
    activeSessionRef: draft.activeSessionRef,
    layout: draft.layout,
    sessions: draft.sessions.map(({ workflowValuesText, ...session }) => ({
      ...session,
      ref: session.ref.trim(),
      agentId: session.agentId.trim(),
      agentName: session.agentName.trim(),
      command: session.command.trim(),
      cwd: session.cwd.trim(),
      customName: session.customName?.trim() || undefined,
      customColor: session.customColor?.trim() || undefined,
      initialPrompt: session.initialPrompt?.trim() || undefined,
      workflowId: session.workflowId?.trim() || undefined,
      workflowValues: workflowValuesText.trim() ? JSON.parse(workflowValuesText) : undefined,
      position: session.position && Number.isFinite(session.position.x) && Number.isFinite(session.position.y)
        ? session.position
        : undefined,
    })),
  };
}

function validateDraft(draft: LaunchDraft): string | null {
  if (!draft.name.trim()) return "Name is required.";
  if (!draft.sessions.length) return "Add at least one pane.";
  const refs = draft.sessions.map((session) => session.ref.trim());
  if (refs.some((ref) => !ref)) return "Every pane needs a reference.";
  if (new Set(refs).size !== refs.length) return "Pane references must be unique.";
  for (const session of draft.sessions) {
    if (!session.agentId.trim() || !session.agentName.trim()) return `${session.ref || "A pane"} needs an agent type and name.`;
    if (session.agentId !== "shell" && !session.command.trim()) return `${session.ref} needs a startup command.`;
    if (!absolutePath(session.cwd.trim())) return `${session.ref} needs an absolute working directory.`;
    if (session.workflowValuesText.trim()) {
      try {
        const parsed = JSON.parse(session.workflowValuesText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return `${session.ref} workflow values must be a JSON object.`;
      } catch {
        return `${session.ref} workflow values contain invalid JSON.`;
      }
    }
  }
  if (!draft.layout) return "Choose a pane layout.";
  const inLayout = layoutRefs(draft.layout);
  if (inLayout.length !== refs.length || new Set(inLayout).size !== refs.length || refs.some((ref) => !inLayout.includes(ref))) {
    return "The layout must include every pane exactly once.";
  }
  if (draft.activeSessionRef && !refs.includes(draft.activeSessionRef)) return "The focused pane is no longer in this configuration.";
  return null;
}

function draftHash(draft: LaunchDraft) {
  try { return JSON.stringify(payloadFromDraft(draft)); } catch { return JSON.stringify(draft); }
}

function safeFilename(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "launch-configuration";
}

function LayoutNode({
  node,
  root,
  path,
  sessions,
  activeRef,
  onFocus,
  onChange,
}: {
  node: TerminalPaneLayout;
  root: TerminalPaneLayout;
  path: number[];
  sessions: DraftSession[];
  activeRef?: string;
  onFocus: (ref: string) => void;
  onChange: (layout: TerminalPaneLayout) => void;
}) {
  if (node.type === "pane") {
    const session = sessions.find((item) => item.ref === node.sessionRef);
    const focused = activeRef === node.sessionRef;
    return (
      <div className={`group flex min-w-0 items-center gap-1.5 rounded border px-1.5 py-1.5 ${focused
        ? "border-[oklch(43%_0.07_48)] bg-[oklch(16%_0.02_48)]"
        : "border-[oklch(25%_0.007_260)] bg-[oklch(11%_0.005_260)]"}`}>
        <button type="button" onClick={() => onFocus(node.sessionRef)} className={`min-w-0 flex-1 text-left ${focusRing}`} title="Set initial focus">
          <span className="flex items-center gap-1 text-[8px] text-zinc-300">
            {focused ? <Check className="h-2.5 w-2.5 text-[oklch(78%_0.10_48)]" /> : <TerminalSquare className="h-2.5 w-2.5 text-zinc-600" />}
            <span className="truncate">{session ? sessionDisplayTitle(session, node.sessionRef) : node.sessionRef}</span>
          </span>
          <code className="mt-0.5 block truncate text-[7px] text-zinc-700">{node.sessionRef}</code>
        </button>
        {path.length > 0 && (
          <span className="flex opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button type="button" onClick={() => onChange(moveLayoutChild(root, path, -1))} className={`flex h-5 w-5 items-center justify-center rounded text-zinc-700 hover:text-zinc-300 ${focusRing}`} aria-label={`Move ${node.sessionRef} earlier`}><ArrowUp className="h-2.5 w-2.5" /></button>
            <button type="button" onClick={() => onChange(moveLayoutChild(root, path, 1))} className={`flex h-5 w-5 items-center justify-center rounded text-zinc-700 hover:text-zinc-300 ${focusRing}`} aria-label={`Move ${node.sessionRef} later`}><ArrowDown className="h-2.5 w-2.5" /></button>
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="rounded border border-[oklch(24%_0.007_260)] bg-[oklch(9.5%_0.004_260)] p-1.5">
      <button
        type="button"
        onClick={() => onChange(updateLayoutAtPath(root, path, (item) => item.type === "split" ? {
          ...item,
          direction: item.direction === "horizontal" ? "vertical" : "horizontal",
        } : item))}
        className={`mb-1.5 flex h-5 items-center gap-1 rounded px-1.5 text-[7px] uppercase tracking-[0.08em] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 ${focusRing}`}
        title="Toggle split direction"
        data-layout-path={path.join(".") || "root"}
      >
        {node.direction === "horizontal" ? <Columns2 className="h-2.5 w-2.5" /> : <Rows3 className="h-2.5 w-2.5" />}
        {node.direction}
        {node.sizes?.length === node.children.length && <span className="normal-case tracking-normal text-zinc-800">{node.sizes.map((size) => Math.round(size)).join("/")}</span>}
      </button>
      <div className={node.direction === "horizontal" ? "grid gap-1.5" : "space-y-1.5"} style={node.direction === "horizontal" ? { gridTemplateColumns: `repeat(${node.children.length}, minmax(0, 1fr))` } : undefined}>
        {node.children.map((child, index) => (
          <LayoutNode key={`${path.join("-")}-${index}-${child.type === "pane" ? child.sessionRef : child.direction}`} node={child} root={root} path={[...path, index]} sessions={sessions} activeRef={activeRef} onFocus={onFocus} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}

export function TerminalLaunchLibrary({
  open,
  busy,
  currentTabName,
  currentCwd,
  configurations,
  onClose,
  onDirtyChange,
  onSaveCurrent,
  onCreate,
  onUpdate,
  onLaunch,
  onDelete,
  onImport,
}: TerminalLaunchLibraryProps) {
  const [draft, setDraft] = useState<LaunchDraft>(() => emptyDraft(currentCwd));
  const [savedHash, setSavedHash] = useState(() => draftHash(emptyDraft(currentCwd)));
  const [query, setQuery] = useState("");
  const [captureName, setCaptureName] = useState(currentTabName);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Set<number>>(new Set([0]));
  const [importOpen, setImportOpen] = useState(false);
  const [importYaml, setImportYaml] = useState("");
  const [importDefaultCwd, setImportDefaultCwd] = useState(currentCwd);
  const [importConflict, setImportConflict] = useState<"skip" | "rename" | "error">("rename");
  const searchRef = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);
  const dirty = draftHash(draft) !== savedHash;
  const validationError = useMemo(() => validateDraft(draft), [draft]);
  const selectedId = draft.id;
  const active = working || busy;

  const visibleConfigurations = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return configurations;
    return configurations.filter((configuration) => [
      configuration.name,
      configuration.description,
      ...configuration.sessions.flatMap((session) => [session.ref, session.agentName, session.command, session.cwd]),
    ].some((value) => value.toLowerCase().includes(normalized)));
  }, [configurations, query]);

  const selectDraft = (next: LaunchDraft) => {
    setDraft(next);
    setSavedHash(draftHash(next));
    setExpandedSessions(new Set(next.sessions.length ? [0] : []));
    setImportOpen(false);
    setError(null);
    setMessage(null);
  };

  const guardUnsaved = () => !dirty || window.confirm("Discard unsaved launch configuration changes?");

  useEffect(() => {
    if (open && !wasOpen.current) {
      setCaptureName(currentTabName);
      setImportDefaultCwd(currentCwd);
      if (configurations[0]) selectDraft(draftFromConfiguration(configurations[0]));
      else selectDraft(emptyDraft(currentCwd));
      window.setTimeout(() => searchRef.current?.focus(), 0);
    }
    wasOpen.current = open;
  }, [configurations, currentCwd, currentTabName, open]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(() => {
    if (!selectedId || dirty) return;
    const fresh = configurations.find((configuration) => configuration.id === selectedId);
    if (fresh && fresh.updatedAt !== Number(savedHash.match(/"updatedAt":(\d+)/)?.[1])) {
      const next = draftFromConfiguration(fresh);
      setDraft(next);
      setSavedHash(draftHash(next));
    }
    // The selected record is refreshed after mutations; dirty drafts stay untouched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configurations, selectedId]);

  const updateSession = (index: number, patch: Partial<DraftSession>) => {
    setDraft((current) => ({
      ...current,
      sessions: current.sessions.map((session, sessionIndex) => sessionIndex === index ? { ...session, ...patch } : session),
    }));
  };

  const renameSession = (index: number, ref: string) => {
    setDraft((current) => {
      const previous = current.sessions[index]?.ref;
      return {
        ...current,
        sessions: current.sessions.map((session, sessionIndex) => sessionIndex === index ? { ...session, ref } : session),
        layout: previous ? renameLayoutRef(current.layout, previous, ref) : current.layout,
        activeSessionRef: current.activeSessionRef === previous ? ref : current.activeSessionRef,
      };
    });
  };

  const addSession = () => {
    setDraft((current) => {
      const occupied = new Set(current.sessions.map((session) => session.ref));
      let index = current.sessions.length + 1;
      let ref = `pane-${index}`;
      while (occupied.has(ref)) ref = `pane-${++index}`;
      const session: DraftSession = {
        ref,
        agentId: "shell",
        agentName: "Shell",
        command: "",
        cwd: current.sessions[0]?.cwd || currentCwd,
        workflowValuesText: "",
      };
      return {
        ...current,
        sessions: [...current.sessions, session],
        layout: appendLayoutRef(current.layout, ref),
        activeSessionRef: current.activeSessionRef || ref,
      };
    });
    setExpandedSessions((current) => new Set([...current, draft.sessions.length]));
  };

  const removeSession = (index: number) => {
    setDraft((current) => {
      const removed = current.sessions[index];
      const sessions = current.sessions.filter((_, sessionIndex) => sessionIndex !== index);
      const layout = removed ? removeLayoutRef(current.layout, removed.ref) : current.layout;
      return {
        ...current,
        sessions,
        layout,
        activeSessionRef: current.activeSessionRef === removed?.ref ? sessions[0]?.ref : current.activeSessionRef,
      };
    });
    setExpandedSessions((current) => new Set([...current].filter((item) => item !== index).map((item) => item > index ? item - 1 : item)));
  };

  const moveSession = (index: number, delta: -1 | 1) => {
    setDraft((current) => {
      const nextIndex = index + delta;
      if (nextIndex < 0 || nextIndex >= current.sessions.length) return current;
      const sessions = [...current.sessions];
      [sessions[index], sessions[nextIndex]] = [sessions[nextIndex], sessions[index]];
      return { ...current, sessions };
    });
  };

  const saveConfiguration = async (event?: FormEvent) => {
    event?.preventDefault();
    if (validationError) { setError(validationError); return; }
    setWorking(true);
    setError(null);
    setMessage(null);
    try {
      const payload = payloadFromDraft(draft) as unknown as Record<string, unknown>;
      const saved = draft.id ? await onUpdate(draft.id, payload) : await onCreate(payload);
      selectDraft(draftFromConfiguration(saved));
      setMessage(draft.id ? "Configuration updated." : "Configuration created.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Configuration could not be saved");
    } finally {
      setWorking(false);
    }
  };

  const captureCurrent = async (event: FormEvent) => {
    event.preventDefault();
    if (!captureName.trim()) return;
    setWorking(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await onSaveCurrent(captureName.trim());
      if (saved) selectDraft(draftFromConfiguration(saved));
      setMessage("Active tab saved as a reusable layout.");
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : "Active tab could not be saved");
    } finally {
      setWorking(false);
    }
  };

  const launch = async () => {
    if (!draft.id) { setError("Save this configuration before launching it."); return; }
    if (dirty) { setError("Save or discard your changes before launching."); return; }
    setWorking(true);
    setError(null);
    setMessage(null);
    try {
      const result = await onLaunch(draft.id);
      const started = Array.isArray(result.started) ? result.started.length : 0;
      const failures = Array.isArray(result.failures) ? result.failures : [];
      setMessage(failures.length
        ? `Started ${started} pane${started === 1 ? "" : "s"}; ${failures.length} failed: ${failures.map((item: any) => item.ref).join(", ")}.`
        : `Started ${started} pane${started === 1 ? "" : "s"} in a new tab.`);
    } catch (launchError) {
      setError(launchError instanceof Error ? launchError.message : "Configuration could not be launched");
    } finally {
      setWorking(false);
    }
  };

  const deleteConfiguration = async () => {
    if (!draft.id || !window.confirm(`Delete ${draft.name}? This cannot be undone.`)) return;
    setWorking(true);
    setError(null);
    try {
      await onDelete(draft.id);
      const remaining = configurations.filter((configuration) => configuration.id !== draft.id);
      selectDraft(remaining[0] ? draftFromConfiguration(remaining[0]) : emptyDraft(currentCwd));
      setMessage("Configuration deleted.");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Configuration could not be deleted");
    } finally {
      setWorking(false);
    }
  };

  const exportConfiguration = async (format: "openui" | "warp") => {
    if (!draft.id) return;
    setWorking(true);
    setError(null);
    try {
      const response = await fetch(`/api/terminal/launch-configurations/${encodeURIComponent(draft.id)}/export?format=${format}`);
      const yaml = await response.text();
      if (!response.ok) {
        let detail = "Configuration could not be exported";
        try { detail = JSON.parse(yaml).error || detail; } catch { /* Use stable fallback. */ }
        throw new Error(detail);
      }
      const url = URL.createObjectURL(new Blob([yaml], { type: "application/yaml" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${safeFilename(draft.name)}.${format}.yaml`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(`Exported ${format === "warp" ? "Warp-compatible" : "OpenUI"} YAML.`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Configuration could not be exported");
    } finally {
      setWorking(false);
    }
  };

  const importConfigurations = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError(null);
    setMessage(null);
    try {
      const result = await onImport({ yaml: importYaml, defaultCwd: importDefaultCwd, conflict: importConflict });
      setImportOpen(false);
      setImportYaml("");
      if (result.imported[0]) selectDraft(draftFromConfiguration(result.imported[0]));
      const details = [
        `Imported ${result.imported.length}`,
        result.skipped.length ? `skipped ${result.skipped.length}` : "",
        result.warnings.length ? `${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(", ");
      setMessage(`${details}.`);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Launch YAML could not be imported");
    } finally {
      setWorking(false);
    }
  };

  if (!open) return null;
  return (
    <section className="flex h-full w-[min(860px,78vw)] min-w-[640px] overflow-hidden border-l border-[oklch(23%_0.007_260)] bg-[oklch(9%_0.004_260)] text-zinc-200" aria-label="Launch configuration library">
      <aside className="flex w-60 flex-shrink-0 flex-col border-r border-[oklch(22%_0.006_260)] bg-[oklch(8%_0.004_260)]">
        <div className="flex h-11 items-center gap-2 border-b border-[oklch(22%_0.006_260)] px-3">
          <Layers3 className="h-3.5 w-3.5 text-[oklch(76%_0.11_48)]" />
          <span className="text-[11px] font-medium text-zinc-200">Saved layouts</span>
          <span className="ml-auto text-[9px] tabular-nums text-zinc-600">{configurations.length}</span>
        </div>
        <form className="border-b border-[oklch(21%_0.006_260)] p-2" onSubmit={captureCurrent}>
          <label className={labelClass} htmlFor="capture-launch-name">Save active tab</label>
          <div className="flex gap-1">
            <input id="capture-launch-name" value={captureName} onChange={(event) => setCaptureName(event.target.value)} maxLength={120} className={`${inputClass} h-8 min-w-0 flex-1`} />
            <button type="submit" disabled={!captureName.trim() || active} className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-[oklch(67%_0.12_48)] text-[oklch(12%_0.02_48)] hover:bg-[oklch(72%_0.12_48)] disabled:opacity-35 ${focusRing}`} aria-label="Save active tab as layout"><Save className="h-3 w-3" /></button>
          </div>
          <p className="mt-1.5 text-[8px] leading-3.5 text-zinc-700">Captures panes, weights, directories, and focus.</p>
        </form>
        <div className="border-b border-[oklch(21%_0.006_260)] p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search layouts" className={`${inputClass} h-8 pl-7`} aria-label="Search saved layouts" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {visibleConfigurations.length === 0 ? (
            <div className="px-3 py-9 text-center">
              <Layers3 className="mx-auto h-5 w-5 text-zinc-700" />
              <p className="mt-2 text-[10px] text-zinc-500">{configurations.length ? "No layout matches" : "No saved layouts yet"}</p>
              <p className="mt-1 text-[8px] leading-4 text-zinc-700">Save this tab or build a reusable pane setup.</p>
            </div>
          ) : visibleConfigurations.map((configuration) => {
            const selected = configuration.id === draft.id;
            return (
              <button key={configuration.id} type="button" data-launch-configuration-id={configuration.id} onClick={() => { if (guardUnsaved()) selectDraft(draftFromConfiguration(configuration)); }} aria-current={selected ? "true" : undefined} className={`mb-0.5 w-full rounded-md px-2.5 py-2 text-left transition-colors ${focusRing} ${selected ? "bg-[oklch(18%_0.015_48)] text-zinc-100" : "text-zinc-400 hover:bg-[oklch(14%_0.005_260)] hover:text-zinc-200"}`}>
                <span className="block truncate text-[10px] font-medium">{configuration.name}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[8px] text-zinc-600">
                  {configuration.sessions.length} {configuration.sessions.length === 1 ? "pane" : "panes"}
                  <span className="text-zinc-800">·</span>
                  {configuration.launchMode === "atomic" ? "atomic" : "best effort"}
                </span>
                <span className="mt-1 block truncate text-[8px] text-zinc-700">{configuration.sessions.map((session) => sessionDisplayTitle(session)).join(" · ")}</span>
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-2 gap-1 border-t border-[oklch(21%_0.006_260)] p-2">
          <button type="button" data-launch-action="new" onClick={() => { if (guardUnsaved()) selectDraft(emptyDraft(currentCwd)); }} className={`flex h-7 items-center justify-center gap-1 rounded text-[9px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 ${focusRing}`}><Plus className="h-3 w-3" /> New</button>
          <button type="button" data-launch-action="import" onClick={() => { if (guardUnsaved()) { setImportOpen(true); setError(null); setMessage(null); } }} className={`flex h-7 items-center justify-center gap-1 rounded text-[9px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 ${focusRing}`}><Upload className="h-3 w-3" /> Import</button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 flex-shrink-0 items-center gap-2 border-b border-[oklch(22%_0.006_260)] px-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium text-zinc-100">{importOpen ? "Import launch YAML" : draft.id ? draft.name : "New saved layout"}</div>
            <div className="mt-0.5 truncate text-[8px] text-zinc-600">{importOpen ? "OpenUI and Warp launch-configuration files" : dirty ? "Unsaved changes" : draft.id ? "Saved" : "Not saved"}</div>
          </div>
          {active && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500 motion-reduce:animate-none" />}
          {!importOpen && draft.id && (
            <>
              <button type="button" onClick={() => void exportConfiguration("openui")} disabled={active} className={`flex h-7 items-center gap-1 rounded px-1.5 text-[8px] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-30 ${focusRing}`} title="Export OpenUI YAML"><Download className="h-3 w-3" /> OpenUI</button>
              <button type="button" onClick={() => void exportConfiguration("warp")} disabled={active} className={`flex h-7 items-center gap-1 rounded px-1.5 text-[8px] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-30 ${focusRing}`} title="Export Warp-compatible YAML"><Download className="h-3 w-3" /> Warp</button>
              <button type="button" onClick={() => void deleteConfiguration()} disabled={active} className={`flex h-7 w-7 items-center justify-center rounded text-zinc-700 hover:bg-[oklch(18%_0.03_28)] hover:text-[oklch(72%_0.11_28)] disabled:opacity-30 ${focusRing}`} aria-label={`Delete ${draft.name}`}><Trash2 className="h-3.5 w-3.5" /></button>
            </>
          )}
          <button type="button" onClick={onClose} className={`flex h-7 w-7 items-center justify-center rounded text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 ${focusRing}`} aria-label="Close launch configuration library"><X className="h-3.5 w-3.5" /></button>
        </header>

        {(error || message) && (
          <div className={`flex items-start gap-2 border-b px-3 py-2 text-[9px] ${error ? "border-[oklch(31%_0.05_28)] bg-[oklch(14%_0.02_28)] text-[oklch(76%_0.10_28)]" : "border-[oklch(28%_0.035_145)] bg-[oklch(13%_0.016_145)] text-[oklch(76%_0.08_145)]"}`} role={error ? "alert" : "status"}>
            {error ? <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" /> : <Check className="mt-0.5 h-3 w-3 flex-shrink-0" />}
            <span className="min-w-0 leading-4">{error || message}</span>
            <button type="button" onClick={() => { setError(null); setMessage(null); }} className="ml-auto text-current opacity-60 hover:opacity-100" aria-label="Dismiss status"><X className="h-3 w-3" /></button>
          </div>
        )}

        {importOpen ? (
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={importConfigurations}>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="mx-auto max-w-xl">
                <label className={labelClass} htmlFor="launch-yaml">YAML</label>
                <textarea id="launch-yaml" value={importYaml} onChange={(event) => setImportYaml(event.target.value)} className={`${inputClass} min-h-64 resize-y py-2 font-mono leading-4`} placeholder={'name: API workbench\nwindows:\n  - tabs:\n      - title: Development\n        layout:\n          cwd: /absolute/project/path'} />
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <label><span className={labelClass}>Default directory</span><input value={importDefaultCwd} onChange={(event) => setImportDefaultCwd(event.target.value)} className={`${inputClass} h-8 font-mono`} placeholder="/absolute/project/path" /></label>
                  <label><span className={labelClass}>Name conflicts</span><select value={importConflict} onChange={(event) => setImportConflict(event.target.value as typeof importConflict)} className={`${inputClass} h-8`}><option value="rename">Rename imported</option><option value="skip">Skip duplicates</option><option value="error">Stop with error</option></select></label>
                </div>
                <p className="mt-3 text-[8px] leading-4 text-zinc-700">Warp files without a pane directory use the absolute default above. Import warnings remain visible after completion.</p>
              </div>
            </div>
            <div className="flex h-12 flex-shrink-0 items-center justify-end gap-2 border-t border-[oklch(22%_0.006_260)] px-3">
              <button type="button" onClick={() => setImportOpen(false)} className={`h-8 rounded px-3 text-[9px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 ${focusRing}`}>Cancel</button>
              <button type="submit" data-launch-action="import-yaml" disabled={!importYaml.trim() || active} className={`flex h-8 items-center gap-1.5 rounded-md bg-[oklch(67%_0.12_48)] px-3 text-[9px] font-medium text-[oklch(12%_0.02_48)] hover:bg-[oklch(72%_0.12_48)] disabled:opacity-35 ${focusRing}`}><Upload className="h-3 w-3" /> Import YAML</button>
            </div>
          </form>
        ) : (
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={saveConfiguration}>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <div className="grid grid-cols-[minmax(0,1fr)_220px] gap-4">
                <div className="min-w-0">
                  <div className="grid grid-cols-[minmax(0,1fr)_150px] gap-2">
                    <label htmlFor="launch-configuration-name"><span className={labelClass}>Name</span><input id="launch-configuration-name" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} maxLength={120} className={`${inputClass} h-8`} placeholder="API workbench" /></label>
                    <fieldset><legend className={labelClass}>Launch policy</legend><div className="grid h-8 grid-cols-2 rounded-md border border-[oklch(28%_0.008_260)] bg-[oklch(10%_0.004_260)] p-0.5">{(["atomic", "best-effort"] as const).map((mode) => <button key={mode} type="button" data-launch-policy={mode} onClick={() => setDraft((current) => ({ ...current, launchMode: mode }))} aria-pressed={draft.launchMode === mode} className={`rounded text-[8px] ${focusRing} ${draft.launchMode === mode ? "bg-[oklch(22%_0.025_48)] text-[oklch(82%_0.09_48)]" : "text-zinc-600 hover:text-zinc-300"}`}>{mode === "atomic" ? "Atomic" : "Best effort"}</button>)}</div></fieldset>
                  </div>
                  <label className="mt-2 block"><span className={labelClass}>Description</span><textarea value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} maxLength={2000} className={`${inputClass} min-h-16 resize-y py-2 leading-4`} placeholder="What this layout opens and when to use it" /></label>

                  <div className="mt-4 flex items-center gap-2 border-b border-[oklch(22%_0.006_260)] pb-2">
                    <div className="min-w-0 flex-1"><h3 className="text-[10px] font-medium text-zinc-200">Panes</h3><p className="mt-0.5 text-[8px] text-zinc-700">Directories and commands run when the layout opens.</p></div>
                    <button type="button" data-launch-action="add-pane" onClick={addSession} className={`flex h-7 items-center gap-1 rounded px-2 text-[8px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 ${focusRing}`}><Plus className="h-3 w-3" /> Add pane</button>
                  </div>

                  <div className="divide-y divide-[oklch(21%_0.006_260)]">
                    {draft.sessions.map((session, index) => {
                      const expanded = expandedSessions.has(index);
                      const focused = draft.activeSessionRef === session.ref;
                      return (
                        <section key={`${index}-${session.ref}`} data-launch-pane-ref={session.ref} className="py-2.5">
                          <div className="flex items-center gap-1.5">
                            <button type="button" onClick={() => setExpandedSessions((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })} className={`flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-[oklch(14%_0.005_260)] ${focusRing}`} aria-expanded={expanded}>
                              {expanded ? <ChevronDown className="h-3 w-3 text-zinc-600" /> : <ChevronRight className="h-3 w-3 text-zinc-600" />}
                              <span className={`flex h-5 w-5 items-center justify-center rounded ${focused ? "bg-[oklch(22%_0.03_48)] text-[oklch(78%_0.10_48)]" : "bg-zinc-900 text-zinc-600"}`}><TerminalSquare className="h-3 w-3" /></span>
                              <span className="min-w-0"><span className="block truncate text-[9px] font-medium text-zinc-300">{sessionDisplayTitle(session, session.ref || `Pane ${index + 1}`)}</span><span className="mt-0.5 block truncate font-mono text-[7px] text-zinc-700">{session.cwd || "Directory required"}{session.command ? ` · ${session.command}` : ""}</span></span>
                            </button>
                            <button type="button" onClick={() => setDraft((current) => ({ ...current, activeSessionRef: session.ref }))} className={`h-6 rounded px-1.5 text-[7px] ${focusRing} ${focused ? "bg-[oklch(20%_0.025_48)] text-[oklch(78%_0.10_48)]" : "text-zinc-700 hover:text-zinc-300"}`} aria-pressed={focused}>{focused ? "Focused" : "Focus"}</button>
                            <button type="button" onClick={() => moveSession(index, -1)} disabled={index === 0} className={`flex h-6 w-6 items-center justify-center rounded text-zinc-700 hover:text-zinc-300 disabled:opacity-20 ${focusRing}`} aria-label={`Move ${session.ref} up`}><ArrowUp className="h-3 w-3" /></button>
                            <button type="button" onClick={() => moveSession(index, 1)} disabled={index === draft.sessions.length - 1} className={`flex h-6 w-6 items-center justify-center rounded text-zinc-700 hover:text-zinc-300 disabled:opacity-20 ${focusRing}`} aria-label={`Move ${session.ref} down`}><ArrowDown className="h-3 w-3" /></button>
                            <button type="button" onClick={() => removeSession(index)} disabled={draft.sessions.length === 1} className={`flex h-6 w-6 items-center justify-center rounded text-zinc-700 hover:bg-[oklch(18%_0.03_28)] hover:text-[oklch(72%_0.11_28)] disabled:opacity-20 ${focusRing}`} aria-label={`Remove ${session.ref}`}><Trash2 className="h-3 w-3" /></button>
                          </div>
                          {expanded && (
                            <div className="mt-2 grid grid-cols-2 gap-2 pl-8">
                              <label><span className={labelClass}>Reference</span><input value={session.ref} onChange={(event) => renameSession(index, event.target.value)} className={`${inputClass} h-8 font-mono`} placeholder="server" /></label>
                              <label><span className={labelClass}>Display name</span><input value={session.customName || ""} onChange={(event) => updateSession(index, { customName: event.target.value })} maxLength={120} className={`${inputClass} h-8`} placeholder={session.agentName || "Server"} /></label>
                              <label><span className={labelClass}>Agent type</span><input value={session.agentId} onChange={(event) => updateSession(index, { agentId: event.target.value })} className={`${inputClass} h-8 font-mono`} placeholder="shell or task" /></label>
                              <label><span className={labelClass}>Agent name</span><input value={session.agentName} onChange={(event) => updateSession(index, { agentName: event.target.value })} className={`${inputClass} h-8`} placeholder="Shell" /></label>
                              <label className="col-span-2"><span className={labelClass}>Working directory</span><div className="relative"><Folder className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-700" /><input value={session.cwd} onChange={(event) => updateSession(index, { cwd: event.target.value })} className={`${inputClass} h-8 pl-7 font-mono`} placeholder="/absolute/project/path" /></div></label>
                              <label className="col-span-2"><span className={labelClass}>Startup command {session.agentId === "shell" && <span className="normal-case tracking-normal text-zinc-800">(optional)</span>}</span><textarea value={session.command} onChange={(event) => updateSession(index, { command: event.target.value })} className={`${inputClass} min-h-16 resize-y py-2 font-mono leading-4`} placeholder={session.agentId === "shell" ? "Leave empty for an interactive shell" : "npm run dev"} /></label>
                              <details className="col-span-2 rounded border border-[oklch(23%_0.006_260)] bg-[oklch(9.5%_0.004_260)] px-2.5 py-2">
                                <summary className={`cursor-pointer text-[8px] text-zinc-600 hover:text-zinc-300 ${focusRing}`}>Advanced pane settings</summary>
                                <div className="mt-2 grid grid-cols-2 gap-2">
                                  <label><span className={labelClass}>Color</span><input value={session.customColor || ""} onChange={(event) => updateSession(index, { customColor: event.target.value })} className={`${inputClass} h-8`} placeholder="blue or oklch(...)" /></label>
                                  <label><span className={labelClass}>Workflow ID</span><input value={session.workflowId || ""} onChange={(event) => updateSession(index, { workflowId: event.target.value })} className={`${inputClass} h-8 font-mono`} placeholder="Optional" /></label>
                                  <label className="col-span-2"><span className={labelClass}>Initial prompt</span><textarea value={session.initialPrompt || ""} onChange={(event) => updateSession(index, { initialPrompt: event.target.value })} className={`${inputClass} min-h-14 resize-y py-2 leading-4`} placeholder="Optional context sent when the pane starts" /></label>
                                  <label className="col-span-2"><span className={labelClass}>Workflow values (JSON)</span><textarea value={session.workflowValuesText} onChange={(event) => updateSession(index, { workflowValuesText: event.target.value })} className={`${inputClass} min-h-14 resize-y py-2 font-mono leading-4`} placeholder={'{"branch":"main"}'} /></label>
                                </div>
                              </details>
                            </div>
                          )}
                        </section>
                      );
                    })}
                  </div>
                </div>

                <aside className="min-w-0">
                  <div className="sticky top-0">
                    <div className="flex items-center justify-between"><div><h3 className="text-[10px] font-medium text-zinc-200">Layout</h3><p className="mt-0.5 text-[8px] text-zinc-700">Click a split to rotate it.</p></div><span className="text-[8px] text-zinc-700">{draft.sessions.length} panes</span></div>
                    <div className="mt-2 flex gap-1">
                      <button type="button" onClick={() => setDraft((current) => ({ ...current, layout: flatLayout(current.sessions, "horizontal") }))} className={`flex h-7 flex-1 items-center justify-center gap-1 rounded border border-[oklch(25%_0.007_260)] text-[8px] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 ${focusRing}`}><Columns2 className="h-3 w-3" /> Columns</button>
                      <button type="button" onClick={() => setDraft((current) => ({ ...current, layout: flatLayout(current.sessions, "vertical") }))} className={`flex h-7 flex-1 items-center justify-center gap-1 rounded border border-[oklch(25%_0.007_260)] text-[8px] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 ${focusRing}`}><Rows3 className="h-3 w-3" /> Rows</button>
                    </div>
                    <div className="mt-2 min-h-28 rounded-md border border-[oklch(23%_0.007_260)] bg-[oklch(8%_0.004_260)] p-2" data-launch-layout-preview>
                      {draft.layout ? <LayoutNode node={draft.layout} root={draft.layout} path={[]} sessions={draft.sessions} activeRef={draft.activeSessionRef} onFocus={(ref) => setDraft((current) => ({ ...current, activeSessionRef: ref }))} onChange={(layout) => setDraft((current) => ({ ...current, layout }))} /> : <p className="py-8 text-center text-[8px] text-zinc-700">Add a pane to build the layout.</p>}
                    </div>
                    <div className={`mt-3 rounded-md border p-2.5 text-[8px] leading-4 ${draft.launchMode === "atomic" ? "border-[oklch(29%_0.035_48)] bg-[oklch(13%_0.012_48)] text-zinc-500" : "border-[oklch(30%_0.035_85)] bg-[oklch(13%_0.015_85)] text-zinc-500"}`}>
                      <span className="block font-medium text-zinc-300">{draft.launchMode === "atomic" ? "All or nothing" : "Keep successful panes"}</span>
                      {draft.launchMode === "atomic" ? "If any pane fails, OpenUI closes every pane started by this launch." : "OpenUI opens valid panes and reports each failure here."}
                    </div>
                    {validationError && <div className="mt-3 flex gap-2 rounded-md border border-[oklch(30%_0.045_28)] bg-[oklch(13%_0.018_28)] p-2.5 text-[8px] leading-4 text-[oklch(72%_0.09_28)]"><AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" /><span>{validationError}</span></div>}
                  </div>
                </aside>
              </div>
            </div>

            <div className="flex h-12 flex-shrink-0 items-center gap-2 border-t border-[oklch(22%_0.006_260)] px-3">
              <div className="min-w-0 flex-1 text-[8px] text-zinc-700">{draft.launchMode === "atomic" ? "Atomic launch rolls back all panes on failure." : "Best effort keeps panes that start successfully."}</div>
              <button type="submit" disabled={Boolean(validationError) || active} data-launch-action="save" className={`flex h-8 items-center gap-1.5 rounded-md border border-[oklch(31%_0.01_260)] px-3 text-[9px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-35 ${focusRing}`}><Save className="h-3 w-3" /> {draft.id ? "Save changes" : "Create layout"}</button>
              <button type="button" onClick={() => void launch()} disabled={!draft.id || dirty || active} data-launch-action="launch" className={`flex h-8 items-center gap-1.5 rounded-md bg-[oklch(67%_0.12_48)] px-3 text-[9px] font-medium text-[oklch(12%_0.02_48)] hover:bg-[oklch(72%_0.12_48)] disabled:opacity-35 ${focusRing}`}><Play className="h-3 w-3" /> Launch {draft.sessions.length}</button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
