export const TERMINAL_FILE_DEFAULT_MAX_BYTES = 128 * 1024;
export const TERMINAL_FILE_MAX_BYTES = 256 * 1024;
export const TERMINAL_FILE_DEFAULT_BATCH_BYTES = 256 * 1024;
export const TERMINAL_FILE_MAX_BATCH_BYTES = 320 * 1024;
export const TERMINAL_FILE_MAX_FILES = 32;
export const TERMINAL_FILE_MAX_RANGES = 32;
export const TERMINAL_FILE_MAX_SCAN_BYTES = 16 * 1024 * 1024;
export const TERMINAL_PATCH_MAX_BYTES = 256 * 1024;

export interface TerminalFileLineRange {
  start: number;
  end: number;
}

export interface TerminalFileReadLocation {
  path: string;
  lineRanges?: TerminalFileLineRange[];
}

export interface TerminalFileReadRequest {
  root: string;
  files: TerminalFileReadLocation[];
  maxFileBytes?: number;
  maxBatchBytes?: number;
  includeBinary?: boolean;
}

export interface TerminalFileTextSegment {
  content: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface TerminalFileReadSuccess {
  path: string;
  relativePath: string;
  kind: "text" | "binary";
  size: number;
  modified: number;
  mime?: string;
  segments?: TerminalFileTextSegment[];
  base64?: string;
  lineCount?: number;
  truncated: boolean;
}

export type TerminalFileReadFailureCode =
  | "invalid_path"
  | "outside_root"
  | "not_found"
  | "not_file"
  | "binary_disallowed"
  | "scan_limit"
  | "budget_exhausted"
  | "cancelled"
  | "io_error";

export interface TerminalFileReadFailure {
  path: string;
  code: TerminalFileReadFailureCode;
  message: string;
}

export interface TerminalFileReadBatchResult {
  root: string;
  files: TerminalFileReadSuccess[];
  failedFiles: TerminalFileReadFailure[];
  bytesReturned: number;
  truncated: boolean;
}

export interface TerminalPatchRequest {
  root: string;
  patch: string;
  validateOnly?: boolean;
}

export interface TerminalPatchFile {
  path: string;
  previousPath?: string;
  added: number | null;
  removed: number | null;
}

export interface TerminalPatchResult {
  root: string;
  applied: boolean;
  validated: boolean;
  files: TerminalPatchFile[];
}

export function boundedFileReadLimits(request: {
  maxFileBytes?: number;
  maxBatchBytes?: number;
}): { maxFileBytes: number; maxBatchBytes: number } {
  const maxFileBytes = Number.isInteger(request.maxFileBytes)
    ? Math.max(1, Math.min(TERMINAL_FILE_MAX_BYTES, request.maxFileBytes!))
    : TERMINAL_FILE_DEFAULT_MAX_BYTES;
  const maxBatchBytes = Number.isInteger(request.maxBatchBytes)
    ? Math.max(1, Math.min(TERMINAL_FILE_MAX_BATCH_BYTES, request.maxBatchBytes!))
    : TERMINAL_FILE_DEFAULT_BATCH_BYTES;
  return { maxFileBytes, maxBatchBytes };
}

export function validTerminalFileLineRanges(value: unknown): TerminalFileLineRange[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > TERMINAL_FILE_MAX_RANGES) return null;
  const ranges: TerminalFileLineRange[] = [];
  for (const range of value) {
    if (
      !range || !Number.isInteger(range.start) || !Number.isInteger(range.end) ||
      range.start < 1 || range.end < range.start || range.end > 1_000_000
    ) return null;
    ranges.push({ start: range.start, end: range.end });
  }
  return ranges;
}
