import { execFile } from "child_process";
import { isAbsolute, relative, resolve, sep } from "path";
import type { Session } from "../types";
import { execGitWithInput, gitRuntimeEnvironment } from "./gitRuntime";
import { terminalRemoteManager } from "./terminalRemote";
import {
  TERMINAL_GIT_MAX_COMMIT_MESSAGE_BYTES,
  TERMINAL_GIT_MAX_COMMITS,
  TERMINAL_GIT_MAX_DIFF_BYTES,
  TERMINAL_GIT_MAX_FILES,
  TERMINAL_GIT_MAX_OUTPUT_BYTES,
  type TerminalGitChangedFile,
  type TerminalGitCommit,
  type TerminalGitCommitMode,
  type TerminalGitCommitResult,
  type TerminalGitDiscardResult,
  type TerminalGitPrInfo,
  type TerminalGitPushResult,
  type TerminalGitStats,
  type TerminalGitStatus,
} from "./terminalGitTypes";

const DEFAULT_TIMEOUT_MS = 5_000;
const MUTATION_TIMEOUT_MS = 15_000;
const PR_FIELDS = "number,title,url,state,headRefName,baseRefName";
const IN_PROGRESS_REFS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"];

interface TerminalGitContext {
  sessionId: string;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  remote: boolean;
}

interface TerminalGitCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

interface RunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  input?: string;
}

export class TerminalGitError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "git_error",
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TerminalGitError";
  }
}

function cleanError(value: unknown, fallback: string): string {
  const text = String(value || fallback).replace(/[\x00\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
  return (text || fallback).slice(0, 4_096);
}

function commandError(result: TerminalGitCommandResult, fallback: string, status = 409): TerminalGitError {
  if (result.timedOut) return new TerminalGitError("Git operation timed out", 504, "git_timeout");
  if (result.truncated) return new TerminalGitError("Git output exceeded the bounded response size", 413, "git_output_limit");
  return new TerminalGitError(cleanError(result.stderr || result.stdout, fallback), status);
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function repoRelativePath(root: string, value: string): string | null {
  if (!value || value.length > 4_096 || value.includes("\0")) return null;
  const candidate = resolve(root, value);
  if (!insideRoot(root, candidate)) return null;
  const rel = relative(root, candidate).split(sep).join("/");
  return rel && rel.length <= 4_096 ? rel : null;
}

function safeRepoOutputPath(root: string, value: string): string | null {
  if (!value || value.length > 4_096 || value.includes("\0") || isAbsolute(value)) return null;
  return repoRelativePath(root, value);
}

function parseCount(value: string): number | null {
  if (value === "-") return null;
  if (!/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function parseNumstat(root: string, output: string): Map<string, { added: number | null; removed: number | null }> {
  const parts = output.split("\0");
  const result = new Map<string, { added: number | null; removed: number | null }>();
  for (let index = 0; index < parts.length; index++) {
    const record = parts[index];
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    let path = record.slice(secondTab + 1);
    if (!path) {
      index += 1; // previous path
      path = parts[++index] || "";
    }
    const safePath = safeRepoOutputPath(root, path);
    if (!safePath) continue;
    result.set(safePath, {
      added: parseCount(record.slice(0, firstTab)),
      removed: parseCount(record.slice(firstTab + 1, secondTab)),
    });
  }
  return result;
}

function parsePorcelain(
  root: string,
  output: string,
  numstat: Map<string, { added: number | null; removed: number | null }>,
): TerminalGitChangedFile[] {
  const records = output.split("\0");
  const files: TerminalGitChangedFile[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const path = safeRepoOutputPath(root, record.slice(3));
    if (!path) continue;
    let previousPath: string | undefined;
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      previousPath = safeRepoOutputPath(root, records[++index] || "") || undefined;
    }
    if (files.length >= TERMINAL_GIT_MAX_FILES) {
      throw new TerminalGitError("Git status exceeds the bounded file count", 413, "git_file_limit");
    }
    const counts = numstat.get(path) || { added: 0, removed: 0 };
    files.push({
      path,
      previousPath,
      indexStatus,
      worktreeStatus,
      untracked: indexStatus === "?" && worktreeStatus === "?",
      added: counts.added,
      removed: counts.removed,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function statusStats(files: TerminalGitChangedFile[]): TerminalGitStats {
  let added = 0;
  let removed = 0;
  let binaryFiles = 0;
  for (const file of files) {
    if (file.added === null || file.removed === null) binaryFiles += 1;
    else {
      added += file.added;
      removed += file.removed;
    }
  }
  return { filesChanged: files.length, added, removed, binaryFiles };
}

function parseCommits(root: string, output: string): TerminalGitCommit[] {
  const commits: TerminalGitCommit[] = [];
  for (const rawChunk of output.split("\x1e")) {
    if (!rawChunk || commits.length >= TERMINAL_GIT_MAX_COMMITS) continue;
    const fields = rawChunk.replace(/^\n+/, "").split("\0");
    const id = fields.shift() || "";
    const summary = fields.shift() || "";
    const author = fields.shift() || "";
    const authoredAt = fields.shift() || "";
    if (!/^[0-9a-f]{40,64}$/i.test(id) || !authoredAt) continue;
    const files = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const status = fields[index].replace(/^\n+/, "");
      const path = safeRepoOutputPath(root, fields[index + 1]);
      if (!/^[A-Z?]{1,3}\d*$/.test(status) || !path) continue;
      if (files.length >= TERMINAL_GIT_MAX_FILES) {
        throw new TerminalGitError("Git commit metadata exceeds the bounded file count", 413, "git_file_limit");
      }
      files.push({ path, status });
    }
    commits.push({
      id,
      summary: summary.slice(0, 1_024),
      author: author.slice(0, 512),
      authoredAt: authoredAt.slice(0, 128),
      files,
    });
  }
  return commits;
}

function parsePrInfo(output: string): TerminalGitPrInfo {
  let value: any;
  try {
    value = JSON.parse(output);
  } catch {
    throw new TerminalGitError("GitHub CLI returned malformed PR metadata", 502, "invalid_pr_response");
  }
  if (
    !value || !Number.isSafeInteger(value.number) || value.number < 1 ||
    typeof value.title !== "string" || typeof value.url !== "string" ||
    typeof value.state !== "string" || typeof value.headRefName !== "string" ||
    typeof value.baseRefName !== "string" || value.title.length > 4_096 ||
    value.url.length > 4_096 || !/^https:\/\//.test(value.url) ||
    /[\x00-\x1f\x7f]/.test(value.title + value.url + value.state + value.headRefName + value.baseRefName)
  ) throw new TerminalGitError("GitHub CLI returned unsafe PR metadata", 502, "invalid_pr_response");
  return {
    number: value.number,
    title: value.title,
    url: value.url,
    state: value.state.slice(0, 64),
    headRefName: value.headRefName.slice(0, 512),
    baseRefName: value.baseRefName.slice(0, 512),
  };
}

function extractHunkPatch(diff: string, hunkIndex: number): string | null {
  if (!Number.isSafeInteger(hunkIndex) || hunkIndex < 0) return null;
  const header: string[] = [];
  const hunks: string[][] = [];
  let current: string[] | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      current = [line];
      hunks.push(current);
    } else if (current) current.push(line);
    else if (line) header.push(line);
  }
  const selected = hunks[hunkIndex];
  if (!selected || !header.length) return null;
  return `${[...header, ...selected].join("\n").replace(/\n+$/, "")}\n`;
}

async function runLocal(
  executable: "git" | "gh",
  args: string[],
  context: TerminalGitContext,
  options: RunOptions,
): Promise<TerminalGitCommandResult> {
  const environment = await gitRuntimeEnvironment(context.environment || process.env);
  if (options.input !== undefined) {
    if (executable !== "git") throw new TerminalGitError("stdin is not supported for this command", 500);
    try {
      const result = await execGitWithInput(args, options.input, {
        cwd: context.cwd,
        environment,
        maxBuffer: options.maxOutputBytes,
        timeoutMs: options.timeoutMs,
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, timedOut: false, truncated: false };
    } catch (error: any) {
      return {
        exitCode: typeof error?.code === "number" ? error.code : null,
        stdout: typeof error?.stdout === "string" ? error.stdout : "",
        stderr: typeof error?.stderr === "string" ? error.stderr : String(error?.message || ""),
        timedOut: /timed out/i.test(String(error?.message || "")),
        truncated: /maximum buffer/i.test(String(error?.message || "")),
      };
    }
  }
  return new Promise((done) => {
    execFile(executable, args, {
      cwd: context.cwd,
      env: environment,
      encoding: "utf8",
      maxBuffer: options.maxOutputBytes,
      timeout: options.timeoutMs,
      windowsHide: true,
    }, (error: any, stdout, stderr) => {
      done({
        exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : String(error?.message || ""),
        timedOut: Boolean(error?.killed) || error?.code === "ETIMEDOUT",
        truncated: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
    });
  });
}

class TerminalGitService {
  private readonly operations = new Set<string>();

  private context(
    sessionId: string,
    session: Pick<Session, "cwd">,
    environment?: NodeJS.ProcessEnv,
  ): TerminalGitContext {
    const snapshot = terminalRemoteManager.snapshot(sessionId);
    if (snapshot?.state === "connected") return { sessionId, cwd: session.cwd, environment, remote: true };
    if (snapshot && snapshot.state !== "idle") {
      throw new TerminalGitError("Remote Git transport is unavailable", 503, "remote_unavailable");
    }
    return { sessionId, cwd: session.cwd, environment, remote: false };
  }

  private async run(
    context: TerminalGitContext,
    executable: "git" | "gh",
    args: string[],
    options: RunOptions = {},
  ): Promise<TerminalGitCommandResult> {
    if (
      !args.length || args.length > 128 ||
      args.some((arg) => typeof arg !== "string" || arg.length > 32_768 || arg.includes("\0"))
    ) throw new TerminalGitError("Invalid Git command arguments", 500);
    const timeoutMs = Math.max(100, Math.min(30_000, options.timeoutMs || DEFAULT_TIMEOUT_MS));
    const maxOutputBytes = Math.max(1_024, Math.min(TERMINAL_GIT_MAX_OUTPUT_BYTES, options.maxOutputBytes || TERMINAL_GIT_MAX_OUTPUT_BYTES));
    if (context.remote) {
      const result = await terminalRemoteManager.run(context.sessionId, {
        executable,
        args,
        cwd: context.cwd,
        environment: context.environment,
        timeoutMs,
        maxOutputBytes,
        ...(options.input !== undefined ? { stdin: options.input } : {}),
      });
      return result;
    }
    return runLocal(executable, args, context, { ...options, timeoutMs, maxOutputBytes });
  }

  private async required(
    context: TerminalGitContext,
    executable: "git" | "gh",
    args: string[],
    fallback: string,
    options: RunOptions = {},
  ): Promise<TerminalGitCommandResult> {
    const result = await this.run(context, executable, args, options);
    if (result.exitCode !== 0 || result.timedOut || result.truncated) throw commandError(result, fallback);
    return result;
  }

  private async root(context: TerminalGitContext): Promise<string> {
    const result = await this.run(context, "git", ["rev-parse", "--show-toplevel"]);
    if (result.timedOut || result.truncated) throw commandError(result, "Git repository lookup failed", 502);
    if (result.exitCode !== 0) throw new TerminalGitError("Not a Git repository", 400, "not_repository");
    const root = result.stdout.trim();
    if (!root || root.length > 16_384 || root.includes("\0") || !isAbsolute(root)) {
      throw new TerminalGitError("Git returned an invalid repository root", 502, "invalid_git_response");
    }
    context.cwd = root;
    return root;
  }

  private async optionalText(context: TerminalGitContext, args: string[]): Promise<string | undefined> {
    const result = await this.run(context, "git", args);
    if (result.timedOut || result.truncated) throw commandError(result, "Git query failed", 502);
    if (result.exitCode !== 0) return undefined;
    const value = result.stdout.trim();
    return value || undefined;
  }

  private async mainBranch(context: TerminalGitContext): Promise<string | undefined> {
    const remoteHead = await this.optionalText(context, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (remoteHead?.startsWith("origin/")) return remoteHead.slice("origin/".length);
    for (const candidate of ["main", "master"]) {
      const exists = await this.run(context, "git", ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
      if (exists.exitCode === 0) return candidate;
      if (exists.timedOut || exists.truncated) throw commandError(exists, "Git branch lookup failed", 502);
    }
    return undefined;
  }

  private async commits(context: TerminalGitContext, root: string, range?: string): Promise<TerminalGitCommit[]> {
    if (!range) return [];
    const result = await this.required(context, "git", [
      "log",
      "-z",
      "--no-renames",
      "--name-status",
      `--max-count=${TERMINAL_GIT_MAX_COMMITS}`,
      "--format=%x1e%H%x00%s%x00%an%x00%aI",
      range,
      "--",
    ], "Git commit history failed");
    return parseCommits(root, result.stdout);
  }

  private async status(context: TerminalGitContext): Promise<TerminalGitStatus> {
    const root = await this.root(context);
    const branchText = await this.optionalText(context, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const detached = !branchText;
    const branch = branchText || await this.optionalText(context, ["rev-parse", "--short", "HEAD"]) || "";
    const mainBranch = await this.mainBranch(context);
    const upstream = await this.optionalText(context, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const counts = await this.optionalText(context, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
      const match = counts?.match(/^(\d+)\s+(\d+)$/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    }
    const porcelain = await this.required(context, "git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "Git status failed");
    const numstatResult = await this.run(context, "git", ["diff", "--numstat", "-z", "HEAD"]);
    if (numstatResult.timedOut || numstatResult.truncated) throw commandError(numstatResult, "Git diff statistics failed", 502);
    const numstat = numstatResult.exitCode === 0
      ? parseNumstat(root, numstatResult.stdout)
      : new Map<string, { added: number | null; removed: number | null }>();
    const files = parsePorcelain(root, porcelain.stdout, numstat);
    const range = upstream
      ? `${upstream}..HEAD`
      : mainBranch && branchText && branchText !== mainBranch
        ? `refs/heads/${mainBranch}..HEAD`
        : undefined;
    const unpushedCommits = await this.commits(context, root, range);
    return {
      root,
      branch,
      detached,
      mainBranch,
      upstream,
      ahead,
      behind,
      files,
      stats: statusStats(files),
      unpushedCommits,
    };
  }

  async statusSession(
    sessionId: string,
    session: Pick<Session, "cwd">,
    environment?: NodeJS.ProcessEnv,
  ): Promise<TerminalGitStatus> {
    return this.status(this.context(sessionId, session, environment));
  }

  async diffSession(
    sessionId: string,
    session: Pick<Session, "cwd">,
    input: { file: unknown; untracked?: unknown },
    environment?: NodeJS.ProcessEnv,
  ): Promise<{ root: string; file: string; diff: string; truncated: false }> {
    const context = this.context(sessionId, session, environment);
    const root = await this.root(context);
    if (typeof input.file !== "string") throw new TerminalGitError("file is required");
    const file = repoRelativePath(root, input.file);
    if (!file) throw new TerminalGitError("File must stay inside the repository");
    const args = input.untracked === true
      ? ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", file]
      : ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", file];
    const result = await this.run(context, "git", args, { maxOutputBytes: TERMINAL_GIT_MAX_DIFF_BYTES });
    if (
      result.timedOut || result.truncated ||
      (result.exitCode !== 0 && !(input.untracked === true && result.exitCode === 1))
    ) throw commandError(result, "Git diff failed");
    return { root, file, diff: result.stdout, truncated: false };
  }

  private async branch(context: TerminalGitContext, requested?: unknown): Promise<string> {
    const current = await this.optionalText(context, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!current) throw new TerminalGitError("Git operation requires a named branch", 409, "detached_head");
    const branch = requested === undefined ? current : typeof requested === "string" ? requested.trim() : "";
    if (!branch || branch.length > 512 || branch.includes("\0")) throw new TerminalGitError("Invalid branch name");
    const valid = await this.run(context, "git", ["check-ref-format", "--branch", branch]);
    if (valid.exitCode !== 0 || valid.timedOut || valid.truncated) {
      throw new TerminalGitError("Invalid branch name", 400, "invalid_branch");
    }
    return branch;
  }

  private async assertNoOperationInProgress(context: TerminalGitContext) {
    for (const ref of IN_PROGRESS_REFS) {
      const result = await this.run(context, "git", ["rev-parse", "--verify", "--quiet", ref]);
      if (result.exitCode === 0) {
        throw new TerminalGitError("Another Git operation is already in progress", 409, "git_operation_in_progress");
      }
      if (result.timedOut || result.truncated) throw commandError(result, "Git operation check failed", 502);
    }
  }

  private async withOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.operations.has(key)) {
      throw new TerminalGitError("A Git operation is already running for this repository", 409, "git_operation_in_progress");
    }
    this.operations.add(key);
    try {
      return await operation();
    } finally {
      this.operations.delete(key);
    }
  }

  private async push(context: TerminalGitContext, branch: string): Promise<void> {
    await this.required(
      context,
      "git",
      ["push", "--set-upstream", "origin", branch],
      "Git push failed",
      { timeoutMs: MUTATION_TIMEOUT_MS },
    );
  }

  private async viewPr(
    context: TerminalGitContext,
    branch?: string,
    optional = false,
  ): Promise<TerminalGitPrInfo | undefined> {
    const result = await this.run(
      context,
      "gh",
      ["pr", "view", ...(branch ? [branch] : []), "--json", PR_FIELDS],
      { timeoutMs: MUTATION_TIMEOUT_MS },
    );
    if (result.exitCode !== 0 || result.timedOut || result.truncated) {
      if (optional && !result.timedOut && !result.truncated) return undefined;
      throw commandError(result, "GitHub PR lookup failed");
    }
    return parsePrInfo(result.stdout);
  }

  private async createPr(context: TerminalGitContext, branch: string): Promise<TerminalGitPrInfo> {
    const existing = await this.viewPr(context, branch, true);
    if (existing) return existing;
    const created = await this.run(
      context,
      "gh",
      ["pr", "create", "--fill", "--head", branch],
      { timeoutMs: MUTATION_TIMEOUT_MS },
    );
    if (created.exitCode !== 0 || created.timedOut || created.truncated) {
      const raced = await this.viewPr(context, branch, true);
      if (raced) return raced;
      throw commandError(created, "GitHub PR creation failed");
    }
    const result = await this.viewPr(context, branch);
    if (!result) throw new TerminalGitError("GitHub PR was created but metadata is unavailable", 502);
    return result;
  }

  async commitSession(
    sessionId: string,
    session: Pick<Session, "cwd">,
    input: { message?: unknown; includeUnstaged?: unknown; branch?: unknown; mode?: unknown },
    environment?: NodeJS.ProcessEnv,
  ): Promise<TerminalGitCommitResult> {
    if (
      typeof input.message !== "string" || !input.message.trim() || input.message.includes("\0") ||
      /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.message) ||
      Buffer.byteLength(input.message, "utf8") > TERMINAL_GIT_MAX_COMMIT_MESSAGE_BYTES
    ) throw new TerminalGitError(`message must contain 1-${TERMINAL_GIT_MAX_COMMIT_MESSAGE_BYTES} UTF-8 bytes`);
    const message = input.message;
    const mode: TerminalGitCommitMode =
      input.mode === undefined ? "commit_only" : input.mode as TerminalGitCommitMode;
    if (!(new Set<TerminalGitCommitMode>(["commit_only", "commit_and_push", "commit_and_create_pr"])).has(mode)) {
      throw new TerminalGitError("Invalid commit mode");
    }
    const context = this.context(sessionId, session, environment);
    const root = await this.root(context);
    const branch = await this.branch(context, input.branch);
    const current = await this.optionalText(context, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (current !== branch) throw new TerminalGitError("Requested branch is not currently checked out", 409, "branch_mismatch");
    return this.withOperation(`${sessionId}\0${root}`, async () => {
      await this.assertNoOperationInProgress(context);
      if (input.includeUnstaged === true) {
        await this.required(context, "git", ["add", "--all"], "Failed to stage changes", { timeoutMs: MUTATION_TIMEOUT_MS });
      }
      const staged = await this.run(context, "git", ["diff", "--cached", "--quiet", "--exit-code"]);
      if (staged.timedOut || staged.truncated || ![0, 1].includes(staged.exitCode ?? -1)) {
        throw commandError(staged, "Failed to inspect staged changes");
      }
      if (staged.exitCode === 0) throw new TerminalGitError("There are no staged changes to commit", 409, "empty_commit");
      await this.required(
        context,
        "git",
        ["commit", "--message", message],
        "Git commit failed",
        { timeoutMs: MUTATION_TIMEOUT_MS },
      );
      const commit = (await this.required(context, "git", ["rev-parse", "HEAD"], "Failed to read the new commit")).stdout.trim();
      let pushed = false;
      let pr: TerminalGitPrInfo | undefined;
      if (mode !== "commit_only") {
        try {
          await this.push(context, branch);
          pushed = true;
        } catch (error: any) {
          throw new TerminalGitError(error?.message || "Git push failed", error?.status || 409, error?.code || "git_error", {
            stage: "push",
            commit,
          });
        }
      }
      if (mode === "commit_and_create_pr") {
        try {
          pr = await this.createPr(context, branch);
        } catch (error: any) {
          throw new TerminalGitError(error?.message || "GitHub PR creation failed", error?.status || 409, error?.code || "git_error", {
            stage: "create_pr",
            commit,
            pushed,
          });
        }
      }
      return { root, commit, pushed, pr, status: await this.status(context) };
    });
  }

  async pushSession(
    sessionId: string,
    session: Pick<Session, "cwd">,
    input: { branch?: unknown } = {},
    environment?: NodeJS.ProcessEnv,
  ): Promise<TerminalGitPushResult> {
    const context = this.context(sessionId, session, environment);
    const root = await this.root(context);
    const branch = await this.branch(context, input.branch);
    return this.withOperation(`${sessionId}\0${root}`, async () => {
      await this.assertNoOperationInProgress(context);
      await this.push(context, branch);
      return { root, branch, status: await this.status(context) };
    });
  }

  async createPrSession(
    sessionId: string,
    session: Pick<Session, "cwd">,
    input: { branch?: unknown } = {},
    environment?: NodeJS.ProcessEnv,
  ): Promise<{ root: string; pr: TerminalGitPrInfo }> {
    const context = this.context(sessionId, session, environment);
    const root = await this.root(context);
    const branch = await this.branch(context, input.branch);
    return this.withOperation(`${sessionId}\0${root}`, async () => ({ root, pr: await this.createPr(context, branch) }));
  }

  async viewPrSession(
    sessionId: string,
    session: Pick<Session, "cwd">,
    environment?: NodeJS.ProcessEnv,
  ): Promise<{ root: string; pr: TerminalGitPrInfo | null }> {
    const context = this.context(sessionId, session, environment);
    const root = await this.root(context);
    return { root, pr: await this.viewPr(context, undefined, true) || null };
  }

  async discardSession(
    sessionId: string,
    session: Pick<Session, "cwd">,
    input: { scope?: unknown; file?: unknown; hunkIndex?: unknown },
    environment?: NodeJS.ProcessEnv,
  ): Promise<TerminalGitDiscardResult> {
    const context = this.context(sessionId, session, environment);
    const root = await this.root(context);
    const scope = input.scope === "all" ? "all" : input.scope === "hunk" ? "hunk" : "file";
    const file = typeof input.file === "string" ? repoRelativePath(root, input.file) : null;
    if (scope !== "all" && !file) throw new TerminalGitError("A confined file path is required");
    return this.withOperation(`${sessionId}\0${root}`, async () => {
      await this.assertNoOperationInProgress(context);
      if (scope === "all") {
        const head = await this.run(context, "git", ["rev-parse", "--verify", "HEAD"]);
        if (head.exitCode === 0) await this.required(context, "git", ["reset", "--hard", "HEAD"], "Failed to reset repository");
        await this.required(context, "git", ["clean", "-fd"], "Failed to clean repository");
      } else if (scope === "hunk") {
        const hunkIndex = Number(input.hunkIndex);
        if (!Number.isSafeInteger(hunkIndex) || hunkIndex < 0) throw new TerminalGitError("hunkIndex must be non-negative");
        const status = await this.status(context);
        const entry = status.files.find((candidate) => candidate.path === file);
        if (!entry || entry.untracked) throw new TerminalGitError("Hunk discard requires a tracked changed file", 409);
        const diff = await this.diffSession(sessionId, { cwd: root }, { file }, environment);
        const patch = extractHunkPatch(diff.diff, hunkIndex);
        if (!patch) throw new TerminalGitError("Hunk not found", 404);
        const cached = await this.run(context, "git", ["apply", "--reverse", "--cached", "--whitespace=nowarn"], { input: patch });
        if (cached.timedOut || cached.truncated) throw commandError(cached, "Failed to discard staged hunk");
        await this.required(
          context,
          "git",
          ["apply", "--reverse", "--whitespace=nowarn"],
          "Failed to discard hunk",
          { input: patch },
        );
      } else {
        const status = await this.status(context);
        const entry = status.files.find((candidate) => candidate.path === file);
        if (!entry) throw new TerminalGitError("Changed file not found", 404);
        if (entry.untracked) {
          await this.required(context, "git", ["clean", "-fd", "--", file!], "Failed to discard untracked file");
        } else {
          await this.required(
            context,
            "git",
            ["restore", "--source=HEAD", "--staged", "--worktree", "--", file!],
            "Failed to restore file",
          );
        }
      }
      return {
        root,
        scope,
        ...(scope !== "all" ? { file: file! } : {}),
        ...(scope === "hunk" ? { hunkIndex: Number(input.hunkIndex) } : {}),
        status: await this.status(context),
      };
    });
  }
}

export const terminalGit = new TerminalGitService();
