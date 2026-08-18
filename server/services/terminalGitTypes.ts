export const TERMINAL_GIT_MAX_OUTPUT_BYTES = 256 * 1024;
export const TERMINAL_GIT_MAX_DIFF_BYTES = 256 * 1024;
export const TERMINAL_GIT_MAX_COMMIT_MESSAGE_BYTES = 16 * 1024;
export const TERMINAL_GIT_MAX_FILES = 2_000;
export const TERMINAL_GIT_MAX_COMMITS = 50;

export interface TerminalGitChangedFile {
  path: string;
  previousPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  untracked: boolean;
  added: number | null;
  removed: number | null;
}

export interface TerminalGitCommitFile {
  path: string;
  status: string;
}

export interface TerminalGitCommit {
  id: string;
  summary: string;
  author: string;
  authoredAt: string;
  files: TerminalGitCommitFile[];
}

export interface TerminalGitStats {
  filesChanged: number;
  added: number;
  removed: number;
  binaryFiles: number;
}

export interface TerminalGitStatus {
  root: string;
  branch: string;
  detached: boolean;
  mainBranch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: TerminalGitChangedFile[];
  stats: TerminalGitStats;
  unpushedCommits: TerminalGitCommit[];
}

export interface TerminalGitPrInfo {
  number: number;
  title: string;
  url: string;
  state: string;
  headRefName: string;
  baseRefName: string;
}

export type TerminalGitCommitMode =
  | "commit_only"
  | "commit_and_push"
  | "commit_and_create_pr";

export interface TerminalGitCommitResult {
  root: string;
  commit: string;
  pushed: boolean;
  pr?: TerminalGitPrInfo;
  status: TerminalGitStatus;
}

export interface TerminalGitPushResult {
  root: string;
  branch: string;
  status: TerminalGitStatus;
}

export interface TerminalGitDiscardResult {
  root: string;
  scope: "file" | "all" | "hunk";
  file?: string;
  hunkIndex?: number;
  status: TerminalGitStatus;
}
