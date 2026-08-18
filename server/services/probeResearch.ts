import { execFile } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 12 * 1024 * 1024;

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

const cache = new Map<string, CacheEntry>();

function resolveProbeBinary(): string {
  const candidates = [
    process.env.PROBE_BIN,
    join(homedir(), ".local", "bin", "probe"),
    "/opt/homebrew/bin/probe",
    "/usr/local/bin/probe",
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate)) || "probe";
}

async function runProbeJson<T>(args: string[], timeout = 15_000): Promise<T> {
  try {
    const { stdout } = await execFileAsync(resolveProbeBinary(), args, {
      cwd: process.env.LAUNCH_CWD || homedir(),
      env: process.env,
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_BUFFER,
    });
    return JSON.parse(stdout || "null") as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Probe could not answer: ${detail.split("\n")[0]}`);
  }
}

async function cached<T>(key: string, ttl: number, loader: () => Promise<T>): Promise<T> {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.value as T;

  const value = await loader();
  cache.set(key, { expiresAt: Date.now() + ttl, value });
  return value;
}

export function getProbeIdentity() {
  return cached("identity", 60_000, () => runProbeJson<unknown>(["whoami"]));
}

export function listProbeProjects() {
  return cached("projects", 30_000, () =>
    runProbeJson<{ items: unknown[]; next_cursor?: string | null }>([
      "project",
      "list",
      "--all",
      "--limit",
      "200",
    ]),
  );
}

export function listProbeRuns(project?: string) {
  const args = ["run", "list", "--limit", "200"];
  if (project) args.push("--project", project);
  return cached(`runs:${project || "all"}`, 5_000, () =>
    runProbeJson<{ items: unknown[]; next_cursor?: string | null }>(args),
  );
}

export function getProbeRunSeries(run: string) {
  return cached(`series:${run}`, 5_000, () =>
    runProbeJson<unknown[]>(["run", "series", run]),
  );
}

export function getProbeRunMetrics(
  run: string,
  key: string | undefined,
  kind: string | undefined,
  limit: number,
) {
  const args = ["run", "metrics", run, "--limit", String(limit)];
  if (key) args.push("--key", key);
  if (kind) args.push("--kind", kind);
  return cached(`metrics:${run}:${kind || "all"}:${key || "all"}:${limit}`, 2_000, () =>
    runProbeJson<unknown[]>(args, 25_000),
  );
}

export function getProbeRunSpans(run: string) {
  return cached(`spans:${run}`, 5_000, () =>
    runProbeJson<unknown[]>(["span", "list", run, "--limit", "500"]),
  );
}

export function getProbeRunArtifacts(run: string) {
  return cached(`artifacts:${run}`, 5_000, () =>
    runProbeJson<unknown[]>(["artifact", "list", run]),
  );
}
