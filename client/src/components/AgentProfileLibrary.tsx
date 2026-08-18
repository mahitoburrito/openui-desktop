import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArrowUpRight,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  Command,
  History,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { AgentIcon } from "./AgentIcon";
import type { Agent } from "../stores/useStore";

export type AgentPermissionPolicy = "ask" | "allow-edits" | "read-only";

export interface AgentProfileConfig {
  name: string;
  description: string;
  command: string;
  initialPrompt?: string;
  color: string;
  icon: string;
  model?: string;
  systemPrompt?: string;
  tools: string[];
  mcpServers: Array<{ name: string; url?: string; command?: string }>;
  skills: string[];
  fallbackCommands: string[];
  permissionPolicy: AgentPermissionPolicy;
  metadata: Record<string, string>;
}

interface AgentProfileVersion {
  version: number;
  createdAt: number;
  config: AgentProfileConfig;
  changeNote?: string;
  promotedFromVersion?: number;
}

interface AgentProfile {
  id: string;
  latestVersion: number;
  versions: AgentProfileVersion[];
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

interface AgentProfileLibraryProps {
  onClose: () => void;
  onProfilesChanged: () => Promise<void> | void;
  onUseProfile?: (agent: Agent) => void;
  initialProfileId?: string;
  initialVersion?: number;
}

type EditorSection = "identity" | "runtime" | "access" | "history";

const EMPTY_CONFIG: AgentProfileConfig = {
  name: "",
  description: "",
  command: "codex",
  initialPrompt: "",
  color: "#7A9DFF",
  icon: "terminal",
  model: "",
  systemPrompt: "",
  tools: [],
  mcpServers: [],
  skills: [],
  fallbackCommands: [],
  permissionPolicy: "ask",
  metadata: {},
};

const ICON_OPTIONS = ["terminal", "bot", "brain", "code", "cpu", "sparkles", "shield", "rocket"];
const MODEL_SUGGESTIONS = ["gpt-5", "gpt-5-codex", "claude-opus-4", "claude-sonnet-4"];

function cloneConfig(config: AgentProfileConfig): AgentProfileConfig {
  return JSON.parse(JSON.stringify(config)) as AgentProfileConfig;
}

function latestVersion(profile: AgentProfile): AgentProfileVersion {
  return profile.versions.find((version) => version.version === profile.latestVersion) || profile.versions[profile.versions.length - 1];
}

function splitList(value: string, limit: number): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))].slice(0, limit);
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function permissionLabel(policy: AgentPermissionPolicy): string {
  if (policy === "read-only") return "Read only";
  if (policy === "allow-edits") return "Allow edits";
  return "Ask first";
}

function policyTone(policy: AgentPermissionPolicy): string {
  if (policy === "read-only") return "text-sky-300 bg-sky-500/10 border-sky-500/25";
  if (policy === "allow-edits") return "text-amber-300 bg-amber-500/10 border-amber-500/25";
  return "text-emerald-300 bg-emerald-500/10 border-emerald-500/25";
}

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <label className="text-[11px] font-medium text-zinc-300">{children}</label>
      {hint && <span className="text-[10px] text-zinc-600">{hint}</span>}
    </div>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-700 focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 ${props.className || ""}`}
    />
  );
}

function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full resize-y rounded-md border border-border bg-canvas px-3 py-2 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-700 focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 ${props.className || ""}`}
    />
  );
}

export function AgentProfileLibrary({
  onClose,
  onProfilesChanged,
  onUseProfile,
  initialProfileId,
  initialVersion,
}: AgentProfileLibraryProps) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(initialProfileId || null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(initialVersion || null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<AgentProfileConfig>(cloneConfig(EMPTY_CONFIG));
  const [sourceConfig, setSourceConfig] = useState<AgentProfileConfig>(cloneConfig(EMPTY_CONFIG));
  const [changeNote, setChangeNote] = useState("");
  const [metadataText, setMetadataText] = useState("{}");
  const [section, setSection] = useState<EditorSection>("identity");
  const [archiveConfirm, setArchiveConfirm] = useState(false);

  const selectedProfile = profiles.find((profile) => profile.id === selectedId) || null;
  const version = selectedProfile?.versions.find((item) => item.version === selectedVersion) || null;
  const isLatest = Boolean(selectedProfile && version?.version === selectedProfile.latestVersion);
  const readOnly = Boolean(selectedProfile?.archivedAt || (version && !isLatest));
  const dirty = useMemo(() => (
    JSON.stringify(draft) !== JSON.stringify(sourceConfig) ||
    metadataText !== JSON.stringify(sourceConfig.metadata, null, 2)
  ), [draft, metadataText, sourceConfig]);

  const loadProfiles = async (preferredId?: string, preferredVersion?: number) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/agent-profiles?includeArchived=true");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to load profiles");
      const nextProfiles: AgentProfile[] = data.profiles || [];
      setProfiles(nextProfiles);
      const nextProfile = nextProfiles.find((profile) => profile.id === (preferredId || selectedId || initialProfileId))
        || nextProfiles.find((profile) => !profile.archivedAt)
        || nextProfiles[0];
      if (nextProfile) {
        const nextVersion = nextProfile.versions.find((item) => item.version === (preferredVersion || selectedVersion || initialVersion))
          || latestVersion(nextProfile);
        applySelection(nextProfile, nextVersion);
      } else {
        startCreate(false);
      }
    } catch (loadError: any) {
      setError(loadError.message || "Failed to load profiles");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProfiles(initialProfileId, initialVersion);
    // The library owns refreshes after this initial load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmDiscard = () => !dirty || window.confirm("Discard unsaved profile changes?");

  const applySelection = (profile: AgentProfile, profileVersion: AgentProfileVersion) => {
    const config = cloneConfig(profileVersion.config);
    setCreating(false);
    setSelectedId(profile.id);
    setSelectedVersion(profileVersion.version);
    setDraft(config);
    setSourceConfig(config);
    setMetadataText(JSON.stringify(config.metadata, null, 2));
    setChangeNote("");
    setArchiveConfirm(false);
  };

  const selectVersion = (profile: AgentProfile, profileVersion: AgentProfileVersion) => {
    if (!confirmDiscard()) return;
    applySelection(profile, profileVersion);
  };

  const startCreate = (guard = true) => {
    if (guard && !confirmDiscard()) return;
    const config = cloneConfig(EMPTY_CONFIG);
    setCreating(true);
    setSelectedId(null);
    setSelectedVersion(null);
    setDraft(config);
    setSourceConfig(config);
    setMetadataText("{}");
    setChangeNote("Initial version");
    setArchiveConfirm(false);
    setSection("identity");
  };

  const filteredProfiles = profiles.filter((profile) => {
    if (!showArchived && profile.archivedAt) return false;
    const config = latestVersion(profile).config;
    const haystack = `${config.name} ${config.description} ${config.command} ${config.model || ""}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  const updateDraft = <K extends keyof AgentProfileConfig>(key: K, value: AgentProfileConfig[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const parseMetadata = (): Record<string, string> => {
    const parsed = JSON.parse(metadataText || "{}");
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("Metadata must be a JSON object");
    }
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
  };

  const validate = () => {
    if (!draft.name.trim()) throw new Error("Profile name is required");
    if (!draft.command.trim()) throw new Error("Command is required");
    draft.mcpServers.forEach((server, index) => {
      if (!server.name.trim()) throw new Error(`MCP server ${index + 1} needs a name`);
      if (Boolean(server.url?.trim()) === Boolean(server.command?.trim())) {
        throw new Error(`MCP server ${server.name || index + 1} needs exactly one URL or command`);
      }
    });
    parseMetadata();
  };

  const saveProfile = async () => {
    setSaving(true);
    setError(null);
    try {
      validate();
      const body = { ...draft, metadata: parseMetadata(), changeNote: changeNote.trim() || undefined };
      const endpoint = creating ? "/api/agent-profiles" : `/api/agent-profiles/${selectedProfile?.id}/versions`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to save profile");
      await onProfilesChanged();
      await loadProfiles(data.profile.id, data.profile.latestVersion);
    } catch (saveError: any) {
      setError(saveError.message || "Failed to save profile");
    } finally {
      setSaving(false);
    }
  };

  const promoteVersion = async () => {
    if (!selectedProfile || !version || isLatest) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/agent-profiles/${selectedProfile.id}/versions/${version.version}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changeNote: changeNote.trim() || `Restore version ${version.version}` }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to promote version");
      await onProfilesChanged();
      await loadProfiles(data.profile.id, data.profile.latestVersion);
    } catch (promoteError: any) {
      setError(promoteError.message || "Failed to promote version");
    } finally {
      setSaving(false);
    }
  };

  const archiveProfile = async () => {
    if (!selectedProfile) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/agent-profiles/${selectedProfile.id}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmPermanent: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to archive profile");
      await onProfilesChanged();
      await loadProfiles(data.profile.id, data.profile.latestVersion);
    } catch (archiveError: any) {
      setError(archiveError.message || "Failed to archive profile");
    } finally {
      setSaving(false);
      setArchiveConfirm(false);
    }
  };

  const useProfile = () => {
    if (!selectedProfile || !version || selectedProfile.archivedAt) return;
    onUseProfile?.({
      id: `profile:${selectedProfile.id}`,
      name: version.config.name,
      command: version.config.command,
      description: version.config.description,
      color: version.config.color,
      icon: version.config.icon,
      profileId: selectedProfile.id,
      profileVersion: version.version,
      profileConfig: cloneConfig(version.config),
    });
  };

  const handleClose = () => {
    if (confirmDiscard()) onClose();
  };

  const sectionItems: Array<{ id: EditorSection; label: string; icon: typeof Bot }> = [
    { id: "identity", label: "Profile", icon: Bot },
    { id: "runtime", label: "Runtime", icon: Terminal },
    { id: "access", label: "Access", icon: ShieldCheck },
    { id: "history", label: "Versions", icon: History },
  ];

  return (
    <div className="flex h-[min(820px,90vh)] w-[min(1180px,96vw)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
      <header className="flex h-14 flex-shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-indigo-400/20 bg-indigo-500/10 text-indigo-300">
            <SlidersHorizontal className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Agent Profiles</h2>
            <p className="text-[10px] text-zinc-500">Versioned runtime and permission contracts</p>
          </div>
        </div>
        <button onClick={handleClose} className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-surface-active hover:text-white" aria-label="Close agent profiles">
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[248px_minmax(0,1fr)_270px]">
        <aside className="flex min-h-0 flex-col border-r border-border bg-canvas/40">
          <div className="space-y-2 border-b border-border p-3">
            <button onClick={() => startCreate()} className="flex w-full items-center justify-center gap-2 rounded-md bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900 hover:bg-white">
              <Plus className="h-3.5 w-3.5" /> New profile
            </button>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search profiles" className="w-full rounded-md border border-border bg-canvas py-2 pl-8 pr-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-zinc-600" />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {loading && <div className="flex items-center justify-center py-10 text-zinc-600"><Loader2 className="h-4 w-4 animate-spin" /></div>}
            {!loading && filteredProfiles.length === 0 && (
              <div className="px-3 py-10 text-center">
                <Bot className="mx-auto mb-2 h-5 w-5 text-zinc-700" />
                <p className="text-xs text-zinc-500">No profiles found</p>
              </div>
            )}
            <div className="space-y-1">
              {filteredProfiles.map((profile) => {
                const latest = latestVersion(profile);
                const selected = selectedId === profile.id && !creating;
                return (
                  <button
                    key={profile.id}
                    onClick={() => selectVersion(profile, latest)}
                    className={`w-full rounded-md border px-2.5 py-2.5 text-left transition-colors ${selected ? "border-zinc-600 bg-surface-active" : "border-transparent hover:border-border hover:bg-surface-hover"}`}
                  >
                    <div className="flex items-start gap-2.5">
                      <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: `${latest.config.color}18`, color: latest.config.color }}>
                        <AgentIcon agentId={`profile:${profile.id}`} iconId={latest.config.icon} className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`truncate text-xs font-medium ${profile.archivedAt ? "text-zinc-600" : "text-zinc-200"}`}>{latest.config.name}</span>
                          {profile.archivedAt && <Archive className="h-3 w-3 flex-shrink-0 text-zinc-600" />}
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">{latest.config.model || latest.config.command}</p>
                      </div>
                      <span className="mt-0.5 text-[9px] tabular-nums text-zinc-600">v{profile.latestVersion}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 border-t border-border px-3 py-2.5 text-[10px] text-zinc-500">
            <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} className="h-3.5 w-3.5 rounded border-zinc-700 bg-canvas text-indigo-500" />
            Show permanently archived
          </label>
        </aside>

        <main className="flex min-w-0 flex-col">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-sm font-medium text-zinc-100">{creating ? "Untitled profile" : draft.name || "Agent profile"}</h3>
                {!creating && version && <span className="rounded border border-border bg-canvas px-1.5 py-0.5 text-[9px] tabular-nums text-zinc-500">v{version.version}{isLatest ? " · latest" : ""}</span>}
                {readOnly && <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[9px] text-zinc-500">Read only</span>}
              </div>
              <p className="mt-0.5 text-[10px] text-zinc-600">
                {creating ? "Create the first immutable version" : readOnly ? "Historical and archived versions cannot be edited" : "Saving creates a new immutable version"}
              </p>
            </div>
            {dirty && !readOnly && <span className="flex items-center gap-1.5 text-[10px] text-amber-300"><span className="h-1.5 w-1.5 rounded-full bg-amber-300" />Unsaved draft</span>}
          </div>

          <nav className="flex gap-1 border-b border-border px-3 py-2">
            {sectionItems.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} onClick={() => setSection(item.id)} className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] transition-colors ${section === item.id ? "bg-surface-active text-zinc-100" : "text-zinc-500 hover:bg-surface-hover hover:text-zinc-300"}`}>
                  <Icon className="h-3.5 w-3.5" /> {item.label}
                </button>
              );
            })}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {error && (
              <div className="mb-4 flex items-start gap-2 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                <span>{error}</span>
                <button onClick={() => setError(null)} className="ml-auto text-red-300/60 hover:text-red-200"><X className="h-3.5 w-3.5" /></button>
              </div>
            )}

            {section === "identity" && (
              <div className="mx-auto max-w-2xl space-y-5">
                <div className="grid grid-cols-[1fr_128px] gap-4">
                  <div>
                    <FieldLabel hint="Required">Name</FieldLabel>
                    <TextInput value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} placeholder="Safe code review" disabled={readOnly} autoFocus={creating} />
                  </div>
                  <div>
                    <FieldLabel>Accent</FieldLabel>
                    <div className="flex gap-2">
                      <input type="color" value={draft.color} onChange={(event) => updateDraft("color", event.target.value)} disabled={readOnly} className="h-9 w-10 rounded border border-border bg-canvas p-1 disabled:opacity-60" />
                      <TextInput value={draft.color} onChange={(event) => updateDraft("color", event.target.value)} disabled={readOnly} className="font-mono text-[11px]" />
                    </div>
                  </div>
                </div>
                <div>
                  <FieldLabel>Description</FieldLabel>
                  <TextArea value={draft.description} onChange={(event) => updateDraft("description", event.target.value)} rows={3} placeholder="When should an engineer choose this profile?" disabled={readOnly} />
                </div>
                <div>
                  <FieldLabel>Icon</FieldLabel>
                  <div className="flex flex-wrap gap-2">
                    {ICON_OPTIONS.map((icon) => (
                      <button key={icon} onClick={() => updateDraft("icon", icon)} disabled={readOnly} className={`flex h-9 w-9 items-center justify-center rounded-md border ${draft.icon === icon ? "border-zinc-500 bg-surface-active text-zinc-100" : "border-border bg-canvas text-zinc-600 hover:text-zinc-300"} disabled:opacity-60`} title={icon}>
                        <AgentIcon iconId={icon} className="h-4 w-4" />
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <FieldLabel hint="Optional first message">Starter prompt</FieldLabel>
                  <TextArea value={draft.initialPrompt || ""} onChange={(event) => updateDraft("initialPrompt", event.target.value)} rows={5} placeholder="Inspect the current change set and flag high-risk behavior." disabled={readOnly} />
                </div>
                <div>
                  <FieldLabel hint="String values only">Metadata</FieldLabel>
                  <TextArea value={metadataText} onChange={(event) => setMetadataText(event.target.value)} rows={5} className="font-mono text-[11px]" disabled={readOnly} spellCheck={false} />
                </div>
              </div>
            )}

            {section === "runtime" && (
              <div className="mx-auto max-w-2xl space-y-5">
                <div>
                  <FieldLabel hint="Required · profile flags are adapted at launch">Command</FieldLabel>
                  <div className="relative">
                    <Command className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
                    <TextInput value={draft.command} onChange={(event) => updateDraft("command", event.target.value)} placeholder="codex" disabled={readOnly} className="pl-9 font-mono" />
                  </div>
                  <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">Use environment-variable references for credentials. Literal secrets are rejected by the profile API.</p>
                </div>
                <div>
                  <FieldLabel hint="Provider-neutral identifier">Model</FieldLabel>
                  <TextInput list="agent-profile-models" value={draft.model || ""} onChange={(event) => updateDraft("model", event.target.value)} placeholder="Provider default" disabled={readOnly} className="font-mono" />
                  <datalist id="agent-profile-models">{MODEL_SUGGESTIONS.map((model) => <option key={model} value={model} />)}</datalist>
                </div>
                <div>
                  <FieldLabel hint="Injected through a private runtime file">System prompt</FieldLabel>
                  <TextArea value={draft.systemPrompt || ""} onChange={(event) => updateDraft("systemPrompt", event.target.value)} rows={9} placeholder="Define durable behavior, constraints, and escalation rules..." disabled={readOnly} className="leading-relaxed" />
                </div>
                <div>
                  <FieldLabel hint="One command per line · tried in order">Fallback commands</FieldLabel>
                  <TextArea value={draft.fallbackCommands.join("\n")} onChange={(event) => updateDraft("fallbackCommands", splitList(event.target.value, 8))} rows={4} placeholder={"claude\ncodex"} disabled={readOnly} className="font-mono text-[11px]" />
                </div>
              </div>
            )}

            {section === "access" && (
              <div className="mx-auto max-w-2xl space-y-6">
                <div>
                  <FieldLabel hint="Applied before provider-specific permission flows">Permission policy</FieldLabel>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      ["read-only", "Read only", "Blocks mutating tools"],
                      ["ask", "Ask first", "Provider approval flow"],
                      ["allow-edits", "Allow edits", "Tool allowlist still applies"],
                    ] as const).map(([id, label, detail]) => (
                      <button key={id} onClick={() => updateDraft("permissionPolicy", id)} disabled={readOnly} className={`rounded-md border p-3 text-left ${draft.permissionPolicy === id ? "border-zinc-500 bg-surface-active" : "border-border bg-canvas hover:border-zinc-600"} disabled:opacity-60`}>
                        <div className="flex items-center justify-between text-xs font-medium text-zinc-200">{label}{draft.permissionPolicy === id && <Check className="h-3.5 w-3.5" />}</div>
                        <p className="mt-1 text-[10px] leading-snug text-zinc-600">{detail}</p>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <FieldLabel hint="Comma or line separated · exact tool names">Tool allowlist</FieldLabel>
                  <TextArea value={draft.tools.join("\n")} onChange={(event) => updateDraft("tools", splitList(event.target.value, 128))} rows={6} placeholder={"read\ngrep\nbash"} disabled={readOnly} className="font-mono text-[11px]" />
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <div>
                      <FieldLabel>MCP servers</FieldLabel>
                      <p className="text-[10px] text-zinc-600">Each server uses one HTTPS URL or one local command.</p>
                    </div>
                    <button onClick={() => updateDraft("mcpServers", [...draft.mcpServers, { name: "", url: "" }])} disabled={readOnly || draft.mcpServers.length >= 20} className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-[10px] text-zinc-400 hover:bg-surface-active hover:text-zinc-200 disabled:opacity-50"><Plus className="h-3 w-3" /> Add server</button>
                  </div>
                  <div className="space-y-2">
                    {draft.mcpServers.length === 0 && <div className="rounded-md border border-dashed border-border px-3 py-5 text-center text-[10px] text-zinc-600">No MCP servers in this profile</div>}
                    {draft.mcpServers.map((server, index) => (
                      <div key={index} className="grid grid-cols-[130px_1fr_30px] gap-2 rounded-md border border-border bg-canvas p-2">
                        <TextInput value={server.name} onChange={(event) => updateDraft("mcpServers", draft.mcpServers.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} placeholder="linear" disabled={readOnly} className="font-mono text-[11px]" />
                        <TextInput value={server.url || server.command || ""} onChange={(event) => {
                          const value = event.target.value;
                          const remote = /^https?:\/\//i.test(value);
                          updateDraft("mcpServers", draft.mcpServers.map((item, itemIndex) => itemIndex === index ? { name: item.name, ...(remote ? { url: value } : { command: value }) } : item));
                        }} placeholder="https://… or npx …" disabled={readOnly} className="font-mono text-[11px]" />
                        <button onClick={() => updateDraft("mcpServers", draft.mcpServers.filter((_, itemIndex) => itemIndex !== index))} disabled={readOnly} className="flex items-center justify-center rounded text-zinc-600 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <FieldLabel hint="Reusable instruction packages">Skills</FieldLabel>
                  <TextArea value={draft.skills.join("\n")} onChange={(event) => updateDraft("skills", splitList(event.target.value, 20))} rows={4} placeholder={"code-review\nrelease-check"} disabled={readOnly} className="font-mono text-[11px]" />
                </div>
              </div>
            )}

            {section === "history" && (
              <div className="mx-auto max-w-2xl space-y-4">
                {creating ? (
                  <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
                    <History className="mx-auto mb-2 h-5 w-5 text-zinc-700" />
                    <p className="text-xs text-zinc-500">Version history starts after this profile is created.</p>
                  </div>
                ) : (
                  [...(selectedProfile?.versions || [])].sort((a, b) => b.version - a.version).map((item) => {
                    const selected = item.version === version?.version;
                    return (
                      <button key={item.version} onClick={() => selectedProfile && selectVersion(selectedProfile, item)} className={`flex w-full items-start gap-3 rounded-md border p-3 text-left ${selected ? "border-zinc-500 bg-surface-active" : "border-border bg-canvas hover:border-zinc-600"}`}>
                        <div className={`mt-0.5 flex h-7 w-7 items-center justify-center rounded-full border text-[10px] font-medium tabular-nums ${item.version === selectedProfile?.latestVersion ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-border text-zinc-500"}`}>{item.version}</div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-zinc-200">Version {item.version}</span>
                            {item.version === selectedProfile?.latestVersion && <span className="text-[9px] text-emerald-400">LATEST</span>}
                            {item.promotedFromVersion && <span className="flex items-center gap-1 text-[9px] text-indigo-300"><RotateCcw className="h-2.5 w-2.5" /> from v{item.promotedFromVersion}</span>}
                          </div>
                          <p className="mt-1 text-[11px] text-zinc-400">{item.changeNote || "No change note"}</p>
                          <p className="mt-1.5 flex items-center gap-1 text-[9px] text-zinc-600"><Clock3 className="h-2.5 w-2.5" /> {formatDate(item.createdAt)}</p>
                        </div>
                        <ChevronRight className="mt-1 h-3.5 w-3.5 text-zinc-700" />
                      </button>
                    );
                  })
                )}
                {!creating && version && !isLatest && !selectedProfile?.archivedAt && (
                  <div className="rounded-md border border-indigo-500/25 bg-indigo-500/5 p-3">
                    <div className="flex items-start gap-2">
                      <RotateCcw className="mt-0.5 h-3.5 w-3.5 text-indigo-300" />
                      <div className="flex-1">
                        <p className="text-xs font-medium text-zinc-200">Restore without rewriting history</p>
                        <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">Promoting v{version.version} copies it into a new immutable latest version.</p>
                        <TextInput value={changeNote} onChange={(event) => setChangeNote(event.target.value)} placeholder={`Restore version ${version.version}`} className="mt-3" />
                        <button onClick={promoteVersion} disabled={saving} className="mt-2 flex items-center gap-1.5 rounded-md bg-indigo-500 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-400 disabled:opacity-50">{saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />} Promote as new version</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {!readOnly && section !== "history" && (
            <footer className="flex items-end gap-3 border-t border-border bg-canvas/40 px-4 py-3">
              <div className="min-w-0 flex-1">
                <label className="mb-1 block text-[10px] text-zinc-500">Change note</label>
                <input value={changeNote} onChange={(event) => setChangeNote(event.target.value)} placeholder={creating ? "Initial version" : "What changed in this version?"} className="w-full border-0 bg-transparent text-xs text-zinc-300 outline-none placeholder:text-zinc-700" />
              </div>
              <button onClick={saveProfile} disabled={saving || (!dirty && !creating)} className="flex items-center gap-1.5 rounded-md bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                {creating ? "Create profile" : "Save new version"}
              </button>
            </footer>
          )}
        </main>

        <aside className="flex min-h-0 flex-col border-l border-border bg-canvas/40">
          <div className="border-b border-border p-4">
            <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
              <ShieldCheck className="h-3.5 w-3.5" /> Launch contract
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">This exact version is pinned to the new session. Later profile edits will not change it.</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${draft.color}18`, color: draft.color }}>
                <AgentIcon iconId={draft.icon} className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-zinc-200">{draft.name || "Untitled profile"}</p>
                <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">{draft.model || "Provider default"}</p>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              <div className="rounded-md border border-border bg-surface p-3">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[10px] text-zinc-500"><Terminal className="h-3 w-3" /> Command</span>
                  {!creating && version && <span className="text-[9px] tabular-nums text-zinc-600">v{version.version}</span>}
                </div>
                <p className="mt-2 break-all font-mono text-[11px] text-zinc-300">{draft.command || "Not configured"}</p>
              </div>
              <div className={`flex items-center justify-between rounded-md border px-3 py-2.5 ${policyTone(draft.permissionPolicy)}`}>
                <span className="flex items-center gap-1.5 text-[10px]"><ShieldCheck className="h-3 w-3" /> Permissions</span>
                <span className="text-[10px] font-medium">{permissionLabel(draft.permissionPolicy)}</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-md border border-border bg-surface px-2 py-2.5 text-center"><Wrench className="mx-auto h-3.5 w-3.5 text-zinc-600" /><p className="mt-1 text-xs font-medium tabular-nums text-zinc-300">{draft.tools.length}</p><p className="text-[8px] uppercase tracking-wide text-zinc-600">Tools</p></div>
                <div className="rounded-md border border-border bg-surface px-2 py-2.5 text-center"><Server className="mx-auto h-3.5 w-3.5 text-zinc-600" /><p className="mt-1 text-xs font-medium tabular-nums text-zinc-300">{draft.mcpServers.length}</p><p className="text-[8px] uppercase tracking-wide text-zinc-600">MCP</p></div>
                <div className="rounded-md border border-border bg-surface px-2 py-2.5 text-center"><Sparkles className="mx-auto h-3.5 w-3.5 text-zinc-600" /><p className="mt-1 text-xs font-medium tabular-nums text-zinc-300">{draft.skills.length}</p><p className="text-[8px] uppercase tracking-wide text-zinc-600">Skills</p></div>
              </div>
            </div>

            {(draft.tools.length > 0 || draft.mcpServers.length > 0) && (
              <div className="mt-5 space-y-3 border-t border-border pt-4">
                {draft.tools.length > 0 && <div><p className="text-[9px] font-medium uppercase tracking-wider text-zinc-600">Allowed tools</p><div className="mt-2 flex flex-wrap gap-1">{draft.tools.slice(0, 10).map((tool) => <span key={tool} className="rounded border border-border bg-surface px-1.5 py-1 font-mono text-[9px] text-zinc-400">{tool}</span>)}</div></div>}
                {draft.mcpServers.length > 0 && <div><p className="text-[9px] font-medium uppercase tracking-wider text-zinc-600">MCP servers</p><div className="mt-2 space-y-1.5">{draft.mcpServers.map((server, index) => <div key={`${server.name}-${index}`} className="flex items-center gap-2 text-[10px] text-zinc-400"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400/70" /><span className="truncate">{server.name || "Unnamed server"}</span><span className="ml-auto text-[9px] text-zinc-700">{server.url ? "HTTPS" : "LOCAL"}</span></div>)}</div></div>}
              </div>
            )}
          </div>

          <div className="space-y-2 border-t border-border p-3">
            {!creating && selectedProfile?.archivedAt && <div className="rounded-md border border-zinc-700 bg-zinc-900/40 px-3 py-2 text-[10px] leading-relaxed text-zinc-500">Archived profiles are read-only and cannot start new sessions.</div>}
            {!creating && !selectedProfile?.archivedAt && onUseProfile && (
              <button onClick={useProfile} disabled={dirty} className="flex w-full items-center justify-center gap-1.5 rounded-md bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40" title={dirty ? "Save or discard the draft before using this profile" : undefined}>
                Use version {version?.version} <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            )}
            {!creating && !selectedProfile?.archivedAt && !archiveConfirm && (
              <button onClick={() => setArchiveConfirm(true)} className="flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[10px] text-zinc-600 hover:bg-red-500/10 hover:text-red-300"><Archive className="h-3 w-3" /> Archive permanently</button>
            )}
            {archiveConfirm && (
              <div className="rounded-md border border-red-500/25 bg-red-500/10 p-2.5">
                <p className="text-[10px] font-medium text-red-200">This cannot be undone.</p>
                <p className="mt-1 text-[9px] leading-relaxed text-red-300/70">Existing sessions keep their pinned version. New sessions cannot use this profile.</p>
                <div className="mt-2 flex gap-1.5">
                  <button onClick={() => setArchiveConfirm(false)} className="flex-1 rounded border border-red-400/20 px-2 py-1 text-[9px] text-red-200">Cancel</button>
                  <button onClick={archiveProfile} disabled={saving} className="flex-1 rounded bg-red-400 px-2 py-1 text-[9px] font-medium text-red-950 disabled:opacity-50">Archive</button>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
