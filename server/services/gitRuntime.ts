import { execFile, spawn } from "child_process";
import { interactiveShellEnvironment } from "./interactiveShellPath";

export const GIT_RUNTIME_DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;

export interface GitRuntimeOptions {
  cwd: string;
  maxBuffer?: number;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
}

export interface GitRuntimeResult {
  stdout: string;
  stderr: string;
}

export async function gitRuntimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  return interactiveShellEnvironment({ environment });
}

export async function execGit(
  args: readonly string[],
  options: GitRuntimeOptions,
): Promise<GitRuntimeResult> {
  const environment = await gitRuntimeEnvironment(options.environment);
  return new Promise((resolve, reject) => {
    execFile("git", [...args], {
      cwd: options.cwd,
      env: environment,
      encoding: "utf8",
      maxBuffer: options.maxBuffer || GIT_RUNTIME_DEFAULT_MAX_BUFFER,
      timeout: options.timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function execGitWithInput(
  args: readonly string[],
  input: string,
  options: GitRuntimeOptions,
): Promise<GitRuntimeResult> {
  const environment = await gitRuntimeEnvironment(options.environment);
  const maxBuffer = options.maxBuffer || GIT_RUNTIME_DEFAULT_MAX_BUFFER;
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: options.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch {}
      reject(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        fail(new Error("git output exceeded the maximum buffer"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        fail(new Error("git error output exceeded the maximum buffer"));
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (code === 0) {
        resolve({ stdout: stdoutText, stderr: stderrText });
        return;
      }
      const error = new Error(stderrText.trim() || `git ${args.join(" ")} failed with exit code ${code}`) as Error & {
        stdout?: string;
        stderr?: string;
        code?: number | null;
      };
      error.stdout = stdoutText;
      error.stderr = stderrText;
      error.code = code;
      reject(error);
    });
    if (options.timeoutMs) {
      timer = setTimeout(() => fail(new Error("git command timed out")), options.timeoutMs);
    }
    child.stdin.end(input);
  });
}
