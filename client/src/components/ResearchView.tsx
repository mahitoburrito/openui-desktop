import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "../stores/useStore";
import { Codicon } from "./Codicon";
import { TrainingChart, type ProbeMetricPoint } from "./research/TrainingChart";

interface ProbeProject {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  repo?: string | null;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

interface ProbeRun {
  id: string;
  slug: string;
  name: string;
  status: string;
  project_id?: string | null;
  experiment_id?: string | null;
  description?: string | null;
  notes?: string | null;
  tags?: string[];
  config?: Record<string, unknown>;
  started_at?: string | null;
  ended_at?: string | null;
  created_at?: string | null;
}

interface ProbeSeries {
  run_id: string;
  kind: string;
  key: string;
  point_count: number;
  last_value?: number | null;
  min_value?: number | null;
  max_value?: number | null;
  x_axis?: string | null;
}

interface ProbeSpan {
  id: string;
  name?: string;
  operation?: string;
  kind?: string;
  status?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
}

interface ProbeArtifact {
  id: string;
  name?: string;
  kind?: string;
  status?: string;
  uri?: string;
  size_bytes?: number;
  created_at?: string;
}

type DetailTab = "metrics" | "spans" | "artifacts" | "config";

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

function compactNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString(undefined, { maximumFractionDigits: 5 });
}

function timeAgo(value?: string | null): string {
  if (!value) return "No time";
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed)) return "No time";
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function statusTone(status?: string): string {
  const normalized = status?.toLowerCase() || "unknown";
  if (["running", "active", "working"].includes(normalized)) return "bg-emerald-400";
  if (["queued", "pending", "waiting"].includes(normalized)) return "bg-amber-400";
  if (["failed", "error", "cancelled"].includes(normalized)) return "bg-rose-400";
  return "bg-zinc-500";
}

function metricScore(series: ProbeSeries): number {
  const key = series.key.toLowerCase();
  let score = series.point_count > 1 ? 60 : 0;
  if (/loss|perplex/.test(key)) score += 100;
  else if (/reward|accuracy|score|eval|pass/.test(key)) score += 80;
  else if (/learning.rate|lr/.test(key)) score += 55;
  return score + Math.min(40, Math.log10(Math.max(1, series.point_count)) * 10);
}

function projectTrainingScore(project: ProbeProject): number {
  const text = `${project.slug} ${project.name} ${project.description || ""}`.toLowerCase();
  let score = 0;
  if (/train|fine.?tun|\bsft\b/.test(text)) score += 120;
  if (/qwen|model|protein|dna/.test(text)) score += 80;
  if (/reinforcement|\brl\b/.test(text)) score += 50;
  if (/survey|tracker|schema|workflow/.test(text)) score -= 140;
  return score;
}

function identityText(identity: unknown): string {
  if (typeof identity === "string") return identity;
  if (!identity || typeof identity !== "object") return "Probe workspace";
  const record = identity as Record<string, unknown>;
  for (const key of ["email", "name", "workspace_name", "workspace", "user"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      const label = nested.email || nested.name;
      if (typeof label === "string") return label;
    }
  }
  return "Probe workspace";
}

function projectKey(project: ProbeProject): string {
  return project.slug || project.id;
}

function runKey(run: ProbeRun): string {
  return run.slug || run.id;
}

function metricLabel(key: string): string {
  const parts = key.split(/[./]/).filter(Boolean);
  const value = parts[parts.length - 1] || key;
  return value.replace(/_/g, " ");
}

interface ResearchViewProps {
  embedded?: boolean;
  requestedRun?: string | null;
  requestedMetric?: string | null;
  onClose?: () => void;
}

export function ResearchView({
  embedded = false,
  requestedRun = null,
  requestedMetric = null,
  onClose,
}: ResearchViewProps = {}) {
  const {
    viewMode,
    setViewMode,
    openBrowserUrl,
    setSidebarOpen,
  } = useStore();
  const [identity, setIdentity] = useState<unknown>(null);
  const [projects, setProjects] = useState<ProbeProject[]>([]);
  const [runs, setRuns] = useState<ProbeRun[]>([]);
  const [selectedProject, setSelectedProject] = useState("auto");
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [series, setSeries] = useState<ProbeSeries[]>([]);
  const [metrics, setMetrics] = useState<ProbeMetricPoint[]>([]);
  const [spans, setSpans] = useState<ProbeSpan[]>([]);
  const [artifacts, setArtifacts] = useState<ProbeArtifact[]>([]);
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>([]);
  const [detailTab, setDetailTab] = useState<DetailTab>("metrics");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [loadingIndex, setLoadingIndex] = useState(false);
  const [loadingRun, setLoadingRun] = useState(false);
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const isActive = embedded ? viewMode === "focus" : viewMode === "research";

  const loadIndex = useCallback(() => {
    setLoadingIndex(true);
    setError(null);
    const controller = new AbortController();
    Promise.all([
      fetchJson<{ available: boolean; identity: unknown }>("/api/probe-research/status", controller.signal),
      fetchJson<{ items: ProbeProject[] }>("/api/probe-research/projects", controller.signal),
    ])
      .then(([status, projectData]) => {
        setIdentity(status.identity);
        const nextProjects = projectData.items || [];
        setProjects(nextProjects);
        setSelectedProject((current) => {
          if (current !== "auto") return current;
          const trainingProject = [...nextProjects]
            .sort((a, b) => projectTrainingScore(b) - projectTrainingScore(a))[0];
          return trainingProject && projectTrainingScore(trainingProject) > 0
            ? projectKey(trainingProject)
            : "all";
        });
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Probe is unavailable");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingIndex(false);
      });
    return controller;
  }, []);

  useEffect(() => {
    if (!isActive) return;
    const controller = loadIndex();
    return () => controller.abort();
  }, [isActive, loadIndex, refreshToken]);

  useEffect(() => {
    if (!isActive) return;
    const controller = new AbortController();
    setLoadingIndex(true);
    const query = selectedProject === "all" ? "" : `?project=${encodeURIComponent(selectedProject)}`;
    fetchJson<{ items: ProbeRun[] }>(`/api/probe-research/runs${query}`, controller.signal)
      .then((data) => {
        const sorted = [...(data.items || [])].sort((a, b) => {
          const aLive = ["running", "active"].includes(a.status?.toLowerCase()) ? 1 : 0;
          const bLive = ["running", "active"].includes(b.status?.toLowerCase()) ? 1 : 0;
          if (aLive !== bLive) return bLive - aLive;
          return Date.parse(b.started_at || b.created_at || "") - Date.parse(a.started_at || a.created_at || "");
        });
        setRuns(sorted);
        const requested = requestedRun?.replace(/^run:/i, "");
        const requestedMatch = requested
          ? sorted.find((run) => runKey(run) === requested || run.id === requested || run.slug === requested)
          : undefined;
        setSelectedRun((current) => requestedMatch
          ? runKey(requestedMatch)
          : (sorted.some((run) => runKey(run) === current) ? current : (sorted[0] ? runKey(sorted[0]) : null)));
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Runs could not load");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingIndex(false);
      });
    return () => controller.abort();
  }, [isActive, refreshToken, requestedRun, selectedProject]);

  useEffect(() => {
    if (!isActive || !selectedRun) {
      setSeries([]);
      setSpans([]);
      setArtifacts([]);
      return;
    }
    const controller = new AbortController();
    setLoadingRun(true);
    setError(null);
    Promise.all([
      fetchJson<ProbeSeries[]>(`/api/probe-research/runs/${encodeURIComponent(selectedRun)}/series`, controller.signal),
      fetchJson<ProbeSpan[]>(`/api/probe-research/runs/${encodeURIComponent(selectedRun)}/spans`, controller.signal),
      fetchJson<ProbeArtifact[]>(`/api/probe-research/runs/${encodeURIComponent(selectedRun)}/artifacts`, controller.signal),
    ])
      .then(([catalog, spanData, artifactData]) => {
        const sortedCatalog = [...catalog].sort((a, b) => metricScore(b) - metricScore(a));
        const sortedSeries = Array.from(
          new Map(sortedCatalog.map((item) => [item.key, item])).values(),
        );
        setSeries(sortedSeries);
        setSpans(spanData || []);
        setArtifacts(artifactData || []);
        const requested = requestedMetric
          ? sortedSeries.find((item) => item.key === requestedMetric)
          : undefined;
        setSelectedMetrics(requested ? [requested.key] : (sortedSeries[0] ? [sortedSeries[0].key] : []));
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Run data could not load");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingRun(false);
      });
    return () => controller.abort();
  }, [isActive, refreshToken, requestedMetric, selectedRun]);

  useEffect(() => {
    if (!isActive || !selectedRun || selectedMetrics.length === 0) {
      setMetrics([]);
      return;
    }
    const controller = new AbortController();
    setLoadingMetrics(true);
    Promise.all(selectedMetrics.map((key) => {
      const metricKind = series.find((item) => item.key === key)?.kind;
      const kindQuery = metricKind ? `&kind=${encodeURIComponent(metricKind)}` : "";
      return fetchJson<ProbeMetricPoint[]>(
        `/api/probe-research/runs/${encodeURIComponent(selectedRun)}/metrics?key=${encodeURIComponent(key)}${kindQuery}&limit=5000`,
        controller.signal,
      );
    }))
      .then((groups) => setMetrics(groups.flat()))
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Metrics could not load");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingMetrics(false);
      });
    return () => controller.abort();
  }, [isActive, selectedMetrics, selectedRun, series]);

  const currentRun = useMemo(
    () => runs.find((run) => runKey(run) === selectedRun) || null,
    [runs, selectedRun],
  );
  const projectById = useMemo(
    () => new Map(projects.flatMap((project) => [[project.id, project], [project.slug, project]])),
    [projects],
  );
  const currentProject = currentRun?.project_id ? projectById.get(currentRun.project_id) : undefined;
  const visibleSeries = series.slice(0, 28);
  const chartableSeries = series.filter((item) => item.point_count > 1);
  const featuredSeries = (chartableSeries.length > 0 ? chartableSeries : series).slice(0, 6);
  const selectedMetric = selectedMetrics[0] || null;

  const selectMetric = (key: string) => setSelectedMetrics([key]);

  if (!isActive) return null;

  return (
    <div className={`research-surface flex min-h-0 min-w-0 flex-col text-zinc-200 ${embedded ? "relative h-full w-full" : "absolute inset-0 z-40 pt-12"}`}>
      <AnimatePresence>
        {libraryOpen && (
          <>
            <motion.button
              type="button"
              aria-label="Close run library"
              className={`absolute inset-0 z-[64] cursor-default bg-black/15 ${embedded ? "top-0" : "top-12"}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
              onClick={() => setLibraryOpen(false)}
            />
            <motion.aside
              initial={{ opacity: 0, x: -18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className={`absolute bottom-0 left-0 z-[65] flex w-[284px] flex-col border-r border-white/[0.09] bg-[oklch(13%_0.008_255/.96)] shadow-[18px_0_48px_rgba(0,0,0,.35)] backdrop-blur-2xl ${embedded ? "top-0" : "top-12"}`}
            >
              <div className="flex h-14 shrink-0 items-center gap-2 border-b border-white/[0.065] px-4">
                <img src="/probe-mark.svg" alt="" className="h-[18px] w-[18px] invert" />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-semibold text-zinc-200">Runs</div>
                  <div className="truncate text-[10px] text-zinc-600">{identityText(identity)}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setLibraryOpen(false)}
                  className="workspace-icon-button flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-zinc-200"
                  title="Close run library"
                  aria-label="Close run library"
                >
                  <Codicon name="close" size={13} />
                </button>
              </div>

              <label className="border-b border-white/[0.065] px-3 py-3">
                <span className="mb-1.5 block text-[9px] font-semibold uppercase tracking-[0.11em] text-zinc-600">Project</span>
                <span className="relative block">
                  <select
                    value={selectedProject}
                    onChange={(event) => setSelectedProject(event.target.value)}
                    className="h-8 w-full appearance-none rounded-md border border-white/[0.08] bg-white/[0.035] px-2.5 pr-8 text-[11px] text-zinc-300 outline-none transition-colors hover:bg-white/[0.055] focus:border-white/[0.18]"
                  >
                    <option value="all">All projects</option>
                    {projects.map((project) => (
                      <option key={project.id || projectKey(project)} value={projectKey(project)}>
                        {project.name || project.slug}
                      </option>
                    ))}
                  </select>
                  <Codicon name="chevron-down" size={12} className="pointer-events-none absolute right-2.5 top-2 text-zinc-600" />
                </span>
              </label>

              <div className="flex min-h-0 flex-1 flex-col py-2">
                <div className="flex items-center px-4 pb-1.5">
                  <span className="text-[9px] font-semibold uppercase tracking-[0.11em] text-zinc-600">Recent</span>
                  <span className="ml-auto text-[9px] text-zinc-700">{runs.length}</span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-2">
                  {loadingIndex && runs.length === 0 ? (
                    <div className="space-y-1 px-1">
                      {[0, 1, 2, 3].map((item) => <div key={item} className="h-11 animate-pulse rounded-md bg-white/[0.025]" />)}
                    </div>
                  ) : runs.length === 0 ? (
                    <div className="px-3 py-8 text-center text-[10px] text-zinc-700">No runs in this project.</div>
                  ) : runs.map((run) => {
                    const key = runKey(run);
                    const active = key === selectedRun;
                    return (
                      <button
                        key={run.id || key}
                        type="button"
                        onClick={() => {
                          setSelectedRun(key);
                          setLibraryOpen(false);
                        }}
                        className={`mb-0.5 flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${active ? "bg-white/[0.075] text-zinc-100" : "text-zinc-500 hover:bg-white/[0.035] hover:text-zinc-300"}`}
                      >
                        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${statusTone(run.status)}`} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] font-medium">{run.name || run.slug}</span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[9px] text-zinc-700">
                            <span className="truncate">{projectById.get(run.project_id || "")?.name || run.status || "Run"}</span>
                            <span>·</span>
                            <span>{timeAgo(run.started_at || run.created_at)}</span>
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-[58px] shrink-0 items-center border-b border-white/[0.065] px-4">
          <button
            type="button"
            onClick={() => setLibraryOpen(true)}
            className="workspace-icon-button mr-3 flex h-8 items-center gap-2 rounded-md px-2.5 text-[11px] text-zinc-500 hover:text-zinc-200"
            title="Choose a project or run"
          >
            <Codicon name="list-unordered" size={13} />
            Runs
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${statusTone(currentRun?.status)}`} />
              <h1 className="truncate text-[14px] font-semibold tracking-[-0.015em] text-zinc-100">
                {currentRun?.name || (loadingIndex ? "Loading runs…" : "Choose a run")}
              </h1>
              {currentRun?.status && <span className="text-[10px] capitalize text-zinc-600">{currentRun.status}</span>}
            </div>
            <div className="mt-0.5 truncate text-[10px] text-zinc-600">
              {currentProject?.name || currentRun?.slug || "Probe Research"}
              {currentRun?.started_at ? ` · ${timeAgo(currentRun.started_at)} ago` : ""}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setRefreshToken((value) => value + 1)}
              className="workspace-icon-button flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-zinc-300"
              title="Refresh Probe data"
              aria-label="Refresh Probe data"
            >
              <Codicon name="refresh" size={13} />
            </button>
            <button
              type="button"
              onClick={() => openBrowserUrl("https://research.prbe.ai/experiments", "manual")}
              className="workspace-icon-button flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-zinc-200"
              title="Open full Probe dashboard"
              aria-label="Open full Probe dashboard"
            >
              <Codicon name="globe" size={13} />
            </button>
            <button
              type="button"
              onClick={() => {
                if (onClose) {
                  onClose();
                } else {
                  setSidebarOpen(false);
                  setViewMode("canvas");
                }
              }}
              className="workspace-icon-button flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-zinc-200"
              title="Close model training"
              aria-label="Close model training"
            >
              <Codicon name="close" size={13} />
            </button>
          </div>
        </div>

        {error ? (
          <div className="flex flex-1 items-center justify-center px-8">
            <div className="max-w-md text-center">
              <div className="text-[13px] font-medium text-zinc-300">Probe did not answer.</div>
              <div className="mt-2 text-[11px] leading-5 text-zinc-600">{error}</div>
              <button type="button" onClick={() => setRefreshToken((value) => value + 1)} className="mt-4 rounded-md bg-white/[0.07] px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-white/[0.1]">Try again</button>
            </div>
          </div>
        ) : !currentRun ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[12px] text-zinc-700">
            <span>Choose a run to see its training curve.</span>
            <button type="button" onClick={() => setLibraryOpen(true)} className="rounded-md bg-white/[0.07] px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-white/[0.1]">Open runs</button>
          </div>
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={runKey(currentRun)}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="flex h-[64px] shrink-0 items-stretch overflow-x-auto border-b border-white/[0.055] px-4">
                {featuredSeries.map((item) => {
                  const active = selectedMetric === item.key;
                  return (
                    <button
                      key={`${item.kind}:${item.key}`}
                      type="button"
                      onClick={() => selectMetric(item.key)}
                      className={`relative flex min-w-[132px] flex-col justify-center border-b-2 px-3 text-left transition-colors ${active ? "border-blue-400 text-zinc-100" : "border-transparent text-zinc-600 hover:text-zinc-300"}`}
                      title={`${item.key} · ${item.point_count} points`}
                    >
                      <span className="truncate text-[9px] capitalize">{metricLabel(item.key)}</span>
                      <span className="mt-0.5 text-[14px] font-medium tracking-[-0.02em]">{compactNumber(item.last_value)}</span>
                    </button>
                  );
                })}
                {series.length > featuredSeries.length && (
                  <button
                    type="button"
                    onClick={() => {
                      setDetailTab("metrics");
                      setDetailsOpen(true);
                    }}
                    className="flex min-w-[82px] items-center justify-center gap-1.5 text-[10px] text-zinc-600 hover:text-zinc-300"
                  >
                    More
                    <span className="text-zinc-700">{series.length - featuredSeries.length}</span>
                  </button>
                )}
              </div>

              <div className="flex min-h-[320px] flex-1 flex-col px-5 pb-3 pt-3">
                <div className="flex h-7 shrink-0 items-center px-1">
                  <span className="truncate text-[11px] font-medium text-zinc-400">{selectedMetric || "Metric"}</span>
                  <span className="ml-2 text-[9px] text-zinc-700">
                    {series.find((item) => item.key === selectedMetric)?.point_count || 0} points
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  <TrainingChart points={metrics} selectedKeys={selectedMetrics} loading={loadingMetrics || loadingRun} />
                </div>
              </div>

              <div className="flex h-10 shrink-0 items-center gap-1 border-t border-white/[0.065] px-4">
                {(["metrics", "spans", "artifacts", "config"] as DetailTab[]).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => {
                      if (detailsOpen && detailTab === tab) setDetailsOpen(false);
                      else {
                        setDetailTab(tab);
                        setDetailsOpen(true);
                      }
                    }}
                    className={`h-7 rounded-md px-2.5 text-[10px] capitalize transition-colors ${detailsOpen && detailTab === tab ? "bg-white/[0.075] text-zinc-200" : "text-zinc-600 hover:bg-white/[0.035] hover:text-zinc-400"}`}
                  >
                    {tab}
                    <span className="ml-1 text-[9px] text-zinc-700">
                      {tab === "metrics" ? series.length : tab === "spans" ? spans.length : tab === "artifacts" ? artifacts.length : ""}
                    </span>
                  </button>
                ))}
                <span className="ml-auto text-[9px] text-zinc-700">Details stay hidden until you need them</span>
              </div>

              <AnimatePresence initial={false}>
                {detailsOpen && (
                  <motion.div
                    key={detailTab}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                    className="h-[210px] shrink-0 overflow-auto border-t border-white/[0.055] px-5 py-3 text-[10px] text-zinc-500"
                  >
                    {detailTab === "metrics" && (
                      <div className="mx-auto max-w-4xl">
                        <div className="grid grid-cols-[minmax(160px,1fr)_86px_100px_130px] gap-x-4 px-2 pb-2 text-zinc-700">
                          <div>Metric</div><div>Kind</div><div>Latest</div><div>Range</div>
                        </div>
                        {visibleSeries.map((item) => (
                          <button
                            key={`${item.kind}:${item.key}`}
                            type="button"
                            onClick={() => selectMetric(item.key)}
                            className={`grid w-full grid-cols-[minmax(160px,1fr)_86px_100px_130px] gap-x-4 rounded-md px-2 py-1.5 text-left transition-colors ${selectedMetric === item.key ? "bg-white/[0.07] text-zinc-300" : "hover:bg-white/[0.035]"}`}
                          >
                            <span className="truncate text-zinc-400">{item.key}</span>
                            <span>{item.kind}</span>
                            <span>{compactNumber(item.last_value)}</span>
                            <span>{compactNumber(item.min_value)} – {compactNumber(item.max_value)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {detailTab === "spans" && (
                      <div className="mx-auto max-w-4xl space-y-2">
                        {spans.length === 0 ? "No spans logged." : spans.slice(0, 50).map((span) => (
                          <div key={span.id} className="flex items-center gap-3 border-b border-white/[0.04] pb-2">
                            <Codicon name="pulse" size={12} className="text-zinc-700" />
                            <span className="min-w-0 flex-1 truncate text-zinc-400">{span.name || span.operation || span.kind || "Span"}</span>
                            <span>{span.status || "done"}</span>
                            <span className="w-16 text-right">{span.duration_ms != null ? `${compactNumber(span.duration_ms)} ms` : timeAgo(span.started_at)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {detailTab === "artifacts" && (
                      <div className="mx-auto max-w-4xl space-y-2">
                        {artifacts.length === 0 ? "No artifacts logged." : artifacts.slice(0, 50).map((artifact) => (
                          <div key={artifact.id} className="flex items-center gap-3 border-b border-white/[0.04] pb-2">
                            <Codicon name="file" size={12} className="text-zinc-700" />
                            <span className="min-w-0 flex-1 truncate text-zinc-400">{artifact.name || artifact.uri || "Artifact"}</span>
                            <span>{artifact.kind || "file"}</span>
                            <span>{artifact.size_bytes ? `${compactNumber(artifact.size_bytes)} B` : artifact.status || "ready"}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {detailTab === "config" && (
                      <pre className="mx-auto max-w-4xl whitespace-pre-wrap break-words font-mono text-[10px] leading-5 text-zinc-500">{JSON.stringify(currentRun.config || {}, null, 2)}</pre>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </AnimatePresence>
        )}
      </main>
    </div>
  );
}
