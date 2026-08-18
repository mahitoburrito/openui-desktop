import { spawn } from "child_process";
import {
  accessSync,
  constants as fsConstants,
  statSync,
} from "fs";
import { basename, delimiter, isAbsolute, join, win32 } from "path";

export const INTERACTIVE_SHELL_PATH_MAX_CHARS = 12_000;
export const INTERACTIVE_SHELL_PATH_TIMEOUT_MS = 3_000;
export const INTERACTIVE_SHELL_PATH_MAX_OUTPUT_BYTES = 256 * 1024;

type ShellKind = "bash" | "zsh" | "fish" | "powershell";

export interface InteractiveShellPathRunRequest {
  executable: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface InteractiveShellPathRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type InteractiveShellPathRunner = (
  request: InteractiveShellPathRunRequest,
) => Promise<InteractiveShellPathRunResult>;

export interface InteractiveShellPathOptions {
  shell?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  runner?: InteractiveShellPathRunner;
}

const cache = new Map<string, Promise<string | undefined>>();
let captureNonce = 0;

function shellKind(shell: string): ShellKind | null {
  const name = basename(shell).toLowerCase().replace(/\.exe$/, "");
  if (name === "bash") return "bash";
  if (name === "zsh") return "zsh";
  if (name === "fish") return "fish";
  if (name === "pwsh" || name === "powershell") return "powershell";
  return null;
}

function executableFile(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function executableOnPath(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  if (isAbsolute(command)) return executableFile(command) ? command : null;
  const hasWindowsExtension = platform === "win32" && /\.[A-Za-z0-9]+$/.test(command);
  const extensions = platform === "win32"
    ? hasWindowsExtension ? [""] : (environment.PATHEXT || ".COM;.EXE").split(";").filter(Boolean)
    : [""];
  for (const directory of (environment.PATH || "").split(platform === "win32" ? ";" : delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = platform === "win32"
        ? win32.join(directory, `${command}${extension}`)
        : join(directory, command);
      if (executableFile(candidate)) return candidate;
    }
  }
  return null;
}

function resolveInteractiveShell(
  requested: string | undefined,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { executable: string; kind: ShellKind } | null {
  const candidates = requested
    ? [requested]
    : platform === "win32"
      ? ["pwsh.exe", "powershell.exe"]
      : [environment.SHELL || "", "/bin/zsh", "/bin/bash", "/usr/bin/fish", "/bin/fish"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const kind = shellKind(candidate);
    if (!kind) continue;
    const executable = executableOnPath(candidate, environment, platform);
    if (executable) return { executable, kind };
  }
  return null;
}

function captureCommand(kind: ShellKind, start: string, end: string): { args: string[] } {
  if (kind === "fish") {
    return { args: ["-i", "-l", "-c", `printf '${start}%s${end}' (string join : $PATH)`] };
  }
  if (kind === "powershell") {
    return { args: ["-NoLogo", "-NonInteractive", "-Command", `Write-Output \"${start}$($env:PATH)${end}\"`] };
  }
  return { args: ["-i", "-l", "-c", `printf '${start}%s${end}' \"$PATH\"`] };
}

function extractPath(output: string, start: string, end: string): string | undefined {
  const startIndex = output.indexOf(start);
  if (startIndex < 0) return undefined;
  const valueStart = startIndex + start.length;
  const endIndex = output.indexOf(end, valueStart);
  if (endIndex < 0) return undefined;
  const value = output.slice(valueStart, endIndex);
  if (
    !value ||
    value.length > INTERACTIVE_SHELL_PATH_MAX_CHARS ||
    /[\0\r\n]/.test(value)
  ) return undefined;
  return value;
}

const defaultRunner: InteractiveShellPathRunner = (request) => new Promise((resolve, reject) => {
  const child = spawn(request.executable, request.args, {
    detached: process.platform !== "win32",
    env: request.environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;

  const kill = () => {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {}
    }
    try { child.kill("SIGKILL"); } catch {}
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    kill();
    reject(error);
  };
  const append = (target: Buffer[], chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > request.maxOutputBytes) {
      fail(new Error("Interactive shell PATH capture exceeded its output limit"));
      return;
    }
    target.push(chunk);
  };
  const timer = setTimeout(() => {
    fail(new Error("Interactive shell PATH capture timed out"));
  }, request.timeoutMs);

  child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));
  child.once("error", fail);
  child.once("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({
      exitCode: code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
  });
});

async function captureUncached(options: InteractiveShellPathOptions): Promise<string | undefined> {
  const environment = { ...(options.environment || process.env) };
  const platform = options.platform || process.platform;
  const shell = resolveInteractiveShell(options.shell, environment, platform);
  if (!shell) return undefined;

  const nonce = `${process.pid}_${Date.now()}_${captureNonce++}`;
  const start = `__OPENUI_PATH_CAPTURE_START_${nonce}__`;
  const end = `__OPENUI_PATH_CAPTURE_END_${nonce}__`;
  const { args } = captureCommand(shell.kind, start, end);
  try {
    const result = await (options.runner || defaultRunner)({
      executable: shell.executable,
      args,
      environment,
      timeoutMs: Math.max(100, Math.min(5_000, options.timeoutMs || INTERACTIVE_SHELL_PATH_TIMEOUT_MS)),
      maxOutputBytes: INTERACTIVE_SHELL_PATH_MAX_OUTPUT_BYTES,
    });
    // Like Warp, accept a valid marked value even when a noisy startup file
    // causes the interactive shell itself to exit nonzero.
    return extractPath(result.stdout, start, end);
  } catch {
    return undefined;
  }
}

export function captureInteractiveShellPath(
  options: InteractiveShellPathOptions = {},
): Promise<string | undefined> {
  const environment = options.environment || process.env;
  const platform = options.platform || process.platform;
  const key = JSON.stringify([
    platform,
    options.shell || environment.SHELL || "",
    environment.HOME || environment.USERPROFILE || "",
    environment.PATH || "",
    environment.PATHEXT || "",
  ]);
  const existing = cache.get(key);
  if (existing) return existing;
  const capture = captureUncached(options);
  if (cache.size >= 8) cache.delete(cache.keys().next().value!);
  cache.set(key, capture);
  return capture;
}

export async function interactiveShellEnvironment(
  options: InteractiveShellPathOptions = {},
): Promise<NodeJS.ProcessEnv> {
  const environment = { ...(options.environment || process.env) };
  const path = await captureInteractiveShellPath({ ...options, environment });
  if (path) environment.PATH = path;
  return environment;
}

export function clearInteractiveShellPathCache() {
  cache.clear();
}
