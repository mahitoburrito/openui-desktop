import { execFile } from "child_process";
import { accessSync, constants as fsConstants, realpathSync, statSync } from "fs";
import { createHash } from "crypto";
import { delimiter, isAbsolute, resolve } from "path";
import type {
  TerminalArgumentTemplate,
  TerminalResolvedArgumentValue,
} from "./terminalArgumentResolvers";

export interface TerminalResourceCommandRequest {
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface TerminalResourceCommandResult {
  exitCode: number | null;
  stdout: string;
}

export type TerminalResourceCommandRunner = (
  request: TerminalResourceCommandRequest,
) => Promise<TerminalResourceCommandResult>;

export interface TerminalResourceResolverInput {
  templates: TerminalArgumentTemplate[];
  cwd: string;
  environment?: Record<string, string | undefined>;
  commandPath: string;
  tokens: string[];
  positionals: string[];
  timeoutMs?: number;
  runner?: TerminalResourceCommandRunner;
}

const RESOURCE_TEMPLATES = new Set<TerminalArgumentTemplate>([
  "docker-containers",
  "docker-running-containers",
  "docker-images",
  "docker-compose-services",
  "docker-contexts",
  "docker-volumes",
  "docker-networks",
  "kubectl-contexts",
  "kubectl-namespaces",
  "kubectl-resource-types",
  "kubectl-resource-names",
  "kubectl-pods",
  "kubectl-containers",
]);
const CACHE_TTL_MS = 3_000;
const FAILURE_CACHE_TTL_MS = 500;
const MAX_CACHE_ENTRIES = 64;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_RESULT_ENTRIES = 1_024;
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 5_000;
const SAFE_VALUE = /^[^\x00-\x1F\x7F]{1,512}$/;
const SAFE_KUBECTL_RESOURCE = /^[A-Za-z0-9][A-Za-z0-9.\/-]{0,127}$/;
const BLOCKED_ENVIRONMENT = /^(?:BASH_ENV|CLASSPATH|ELECTRON_RUN_AS_NODE|ENV|GEM_HOME|JAVA_TOOL_OPTIONS|LD_|DYLD_|NODE_OPTIONS|NODE_PATH|PERL5OPT|PERLLIB|PSMODULEPATH|PYTHONHOME|PYTHONPATH|RUBYOPT|ZDOTDIR|_JAVA_OPTIONS$)/i;

interface CachedOutput {
  expiresAt: number;
  output: string | null;
}

const outputCache = new Map<string, CachedOutput>();
const pendingOutputs = new Map<string, Promise<string | null>>();
const runnerIds = new WeakMap<TerminalResourceCommandRunner, number>();
let nextRunnerId = 1;

function setBoundedCache(key: string, value: CachedOutput) {
  outputCache.delete(key);
  outputCache.set(key, value);
  while (outputCache.size > MAX_CACHE_ENTRIES) {
    const oldest = outputCache.keys().next().value;
    if (oldest === undefined) break;
    outputCache.delete(oldest);
  }
}

export function clearTerminalResourceResolverCaches() {
  outputCache.clear();
  pendingOutputs.clear();
}

export function isTerminalResourceArgumentTemplate(
  template: TerminalArgumentTemplate,
): boolean {
  return RESOURCE_TEMPLATES.has(template);
}

function safeEnvironment(
  environment: Record<string, string | undefined> | undefined,
): NodeJS.ProcessEnv {
  const source = environment || process.env;
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source).slice(0, 4_096)) {
    if (!key || value === undefined || BLOCKED_ENVIRONMENT.test(key)) continue;
    if (/[^A-Za-z0-9_]/.test(key) || /\0/.test(value) || value.length > 32_768) continue;
    safe[key] = value;
  }
  return safe;
}

function executablePath(
  command: "docker" | "kubectl",
  environment: NodeJS.ProcessEnv,
): string | null {
  const platform = process.platform;
  const pathValue = environment.PATH || environment.Path || environment.path || "";
  const extensions = platform === "win32"
    ? (environment.PATHEXT || ".COM;.EXE").split(";").filter((extension) => /^\.(?:COM|EXE)$/i.test(extension))
    : [""];
  for (const directory of pathValue.split(platform === "win32" ? ";" : delimiter).slice(0, 128)) {
    if (!directory || !isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`);
      try {
        const target = realpathSync(candidate);
        if (!statSync(target).isFile()) continue;
        accessSync(target, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
        return candidate;
      } catch {
        // Try the next absolute PATH entry.
      }
    }
  }
  return null;
}

const defaultRunner: TerminalResourceCommandRunner = (request) => new Promise((resolveResult) => {
  execFile(
    request.executable,
    request.args,
    {
      cwd: request.cwd,
      env: request.environment,
      encoding: "utf8",
      timeout: request.timeoutMs,
      maxBuffer: request.maxOutputBytes,
      windowsHide: true,
      shell: false,
      killSignal: "SIGKILL",
    },
    (error, stdout) => {
      resolveResult({
        exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
        stdout: error ? "" : stdout,
      });
    },
  );
});

function environmentIdentity(environment: NodeJS.ProcessEnv): string {
  const entries = Object.entries(environment).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function runnerIdentity(runner: TerminalResourceCommandRunner): string {
  if (runner === defaultRunner) return "default";
  let id = runnerIds.get(runner);
  if (!id) {
    id = nextRunnerId++;
    runnerIds.set(runner, id);
  }
  return `custom-${id}`;
}

function boundedOutput(output: string): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= MAX_OUTPUT_BYTES) return output;
  return bytes.subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
}

async function commandOutput(
  command: "docker" | "kubectl",
  args: string[],
  input: TerminalResourceResolverInput,
): Promise<string | null> {
  if (args.length > 64 || args.some((arg) => /\0/.test(arg) || arg.length > 4_096)) return null;
  const environment = safeEnvironment(input.environment);
  const runner = input.runner || defaultRunner;
  const executable = input.runner ? command : executablePath(command, environment);
  if (!executable) return null;
  const timeoutMs = Math.max(50, Math.min(MAX_TIMEOUT_MS, input.timeoutMs || DEFAULT_TIMEOUT_MS));
  const cacheKey = createHash("sha256").update(JSON.stringify({
    executable,
    args,
    cwd: resolve(input.cwd),
    environment: environmentIdentity(environment),
    runner: runnerIdentity(runner),
    timeoutMs,
  })).digest("hex");
  const cached = outputCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.output;
  const pending = pendingOutputs.get(cacheKey);
  if (pending) return pending;

  const request = runner({
    executable,
    args: [...args],
    cwd: input.cwd,
    environment,
    timeoutMs,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  }).then((result) => result.exitCode === 0 ? boundedOutput(result.stdout) : null).catch(() => null);
  pendingOutputs.set(cacheKey, request);
  try {
    const output = await request;
    setBoundedCache(cacheKey, {
      expiresAt: Date.now() + (output === null ? FAILURE_CACHE_TTL_MS : CACHE_TTL_MS),
      output,
    });
    return output;
  } finally {
    pendingOutputs.delete(cacheKey);
  }
}

function safeText(value: string): string | null {
  const cleaned = value.trim();
  return SAFE_VALUE.test(cleaned) ? cleaned : null;
}

function safeDescription(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(" · ").slice(0, 1_024);
}

function deduplicate(values: TerminalResolvedArgumentValue[]): TerminalResolvedArgumentValue[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!safeText(value.value) || seen.has(value.value)) return false;
    seen.add(value.value);
    return true;
  }).slice(0, MAX_RESULT_ENTRIES);
}

function plainLineValues(
  output: string | null,
  description: string,
  source: TerminalResolvedArgumentValue["source"],
): TerminalResolvedArgumentValue[] {
  if (output === null) return [];
  return deduplicate(output.split(/\r?\n/).flatMap((line) => {
    const value = safeText(line);
    return value ? [{ value, title: value, description, source }] : [];
  }));
}

function optionValue(tokens: string[], names: string[]): string | null {
  let found: string | null = null;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    const equals = token.indexOf("=");
    if (equals > 0 && names.includes(token.slice(0, equals))) {
      found = safeText(token.slice(equals + 1));
    } else if (names.includes(token) && index + 1 < tokens.length) {
      found = safeText(tokens[index + 1]);
      index += 1;
    }
  }
  return found;
}

function canonicalOption(name: string, value: string | null): string[] {
  return value ? [`${name}=${value}`] : [];
}

function dockerRootScope(tokens: string[]): string[] {
  return [
    ...canonicalOption("--context", optionValue(tokens, ["--context"])),
    ...canonicalOption("--host", optionValue(tokens, ["--host", "-H"])),
    ...canonicalOption("--config", optionValue(tokens, ["--config"])),
  ];
}

function composeScope(tokens: string[]): string[] {
  const files: string[] = [];
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    const equals = token.indexOf("=");
    if (equals > 0 && ["--file"].includes(token.slice(0, equals))) {
      const value = safeText(token.slice(equals + 1));
      if (value) files.push(`--file=${value}`);
    } else if (["--file", "-f"].includes(token) && index + 1 < tokens.length) {
      const value = safeText(tokens[index + 1]);
      if (value) files.push(`--file=${value}`);
      index += 1;
    }
  }
  return [
    ...files.slice(-16),
    ...canonicalOption("--project-name", optionValue(tokens, ["--project-name", "-p"])),
    ...canonicalOption("--project-directory", optionValue(tokens, ["--project-directory"])),
    ...canonicalOption("--env-file", optionValue(tokens, ["--env-file"])),
    ...canonicalOption("--profile", optionValue(tokens, ["--profile"])),
  ];
}

function kubectlScope(tokens: string[], includeNamespace: boolean): string[] {
  return [
    ...canonicalOption("--kubeconfig", optionValue(tokens, ["--kubeconfig"])),
    ...canonicalOption("--context", optionValue(tokens, ["--context"])),
    ...canonicalOption("--cluster", optionValue(tokens, ["--cluster"])),
    ...canonicalOption("--user", optionValue(tokens, ["--user"])),
    ...(includeNamespace
      ? canonicalOption("--namespace", optionValue(tokens, ["--namespace", "-n"]))
      : []),
  ];
}

async function dockerValues(
  template: TerminalArgumentTemplate,
  input: TerminalResourceResolverInput,
): Promise<TerminalResolvedArgumentValue[]> {
  const rootScope = dockerRootScope(input.tokens);
  if (template === "docker-compose-services") {
    const output = await commandOutput("docker", [
      ...rootScope, "compose", ...composeScope(input.tokens), "config", "--services",
    ], input);
    return plainLineValues(output, "Compose service", "docker-compose");
  }
  if (template === "docker-contexts") {
    const output = await commandOutput("docker", [
      "context", "ls", "--format", "{{.Name}}\t{{.Description}}\t{{.DockerEndpoint}}",
    ], input);
    if (output === null) return [];
    return deduplicate(output.split(/\r?\n/).flatMap((line) => {
      const [rawName, rawDescription, rawEndpoint] = line.split("\t");
      const value = safeText(rawName || "");
      if (!value) return [];
      return [{
        value,
        title: value,
        description: safeDescription([safeText(rawDescription || ""), safeText(rawEndpoint || "")]) || "Docker context",
        source: "docker" as const,
      }];
    }));
  }
  if (template === "docker-images") {
    const output = await commandOutput("docker", [
      ...rootScope, "image", "ls", "--format", "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedSince}}",
    ], input);
    if (output === null) return [];
    return deduplicate(output.split(/\r?\n/).flatMap((line) => {
      const [rawReference, rawId, rawCreated] = line.split("\t");
      const value = safeText(rawReference || "");
      if (!value || value === "<none>:<none>") return [];
      return [{
        value,
        title: value,
        description: safeDescription([safeText(rawId || ""), safeText(rawCreated || "")]) || "Docker image",
        source: "docker" as const,
      }];
    }));
  }
  if (template === "docker-volumes") {
    return plainLineValues(
      await commandOutput("docker", [...rootScope, "volume", "ls", "--format", "{{.Name}}"], input),
      "Docker volume",
      "docker",
    );
  }
  if (template === "docker-networks") {
    return plainLineValues(
      await commandOutput("docker", [...rootScope, "network", "ls", "--format", "{{.Name}}"], input),
      "Docker network",
      "docker",
    );
  }
  const includeStopped = template === "docker-containers";
  const output = await commandOutput("docker", [
    ...rootScope,
    "ps",
    ...(includeStopped ? ["-a"] : []),
    "--format",
    "{{.Names}}\t{{.ID}}\t{{.Image}}\t{{.Status}}",
  ], input);
  if (output === null) return [];
  return deduplicate(output.split(/\r?\n/).flatMap((line) => {
    const [rawName, rawId, rawImage, rawStatus] = line.split("\t");
    const value = safeText(rawName || "") || safeText(rawId || "");
    if (!value) return [];
    return [{
      value,
      title: value,
      description: safeDescription([
        safeText(rawStatus || ""),
        safeText(rawImage || ""),
        safeText(rawId || ""),
      ]) || "Docker container",
      source: "docker" as const,
    }];
  }));
}

async function kubectlValues(
  template: TerminalArgumentTemplate,
  input: TerminalResourceResolverInput,
): Promise<TerminalResolvedArgumentValue[]> {
  if (template === "kubectl-contexts") {
    return plainLineValues(
      await commandOutput("kubectl", ["config", "get-contexts", "-o", "name"], input),
      "Kubernetes context",
      "kubectl",
    );
  }
  const clusterScope = kubectlScope(input.tokens, false);
  if (template === "kubectl-namespaces") {
    return plainLineValues(
      await commandOutput("kubectl", [
        ...clusterScope,
        "get", "namespaces", "-o", 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
      ], input),
      "Kubernetes namespace",
      "kubectl",
    );
  }
  if (template === "kubectl-resource-types") {
    return plainLineValues(
      await commandOutput("kubectl", [...clusterScope, "api-resources", "--verbs=list", "-o", "name"], input),
      "Kubernetes resource type",
      "kubectl",
    );
  }
  const scoped = kubectlScope(input.tokens, true);
  if (template === "kubectl-containers") {
    const pod = safeText(input.positionals[0] || "");
    if (!pod || !SAFE_KUBECTL_RESOURCE.test(pod)) return [];
    return plainLineValues(
      await commandOutput("kubectl", [
        ...scoped,
        "get", "pod", pod, "-o",
        'jsonpath={range .spec.initContainers[*]}{.name}{"\\n"}{end}{range .spec.containers[*]}{.name}{"\\n"}{end}',
      ], input),
      `Container in pod ${pod}`,
      "kubectl",
    );
  }
  const resource = template === "kubectl-pods" ? "pods" : safeText(input.positionals[0] || "");
  if (!resource || !SAFE_KUBECTL_RESOURCE.test(resource)) return [];
  return plainLineValues(
    await commandOutput("kubectl", [
      ...scoped,
      "get", resource, "-o", 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ], input),
    template === "kubectl-pods" ? "Kubernetes pod" : `${resource} resource`,
    "kubectl",
  );
}

export async function resolveTerminalResourceArgumentValues(
  input: TerminalResourceResolverInput,
): Promise<TerminalResolvedArgumentValue[]> {
  const templates = [...new Set(input.templates)].filter(isTerminalResourceArgumentTemplate).slice(0, 8);
  const groups = await Promise.all(templates.map((template) =>
    template.startsWith("docker-")
      ? dockerValues(template, input)
      : kubectlValues(template, input)
  ));
  return deduplicate(groups.flat());
}
