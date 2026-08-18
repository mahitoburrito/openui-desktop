import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "fs";
import { extname, isAbsolute, relative, resolve, sep } from "path";
import { TextDecoder } from "util";
import type { Session } from "../types";
import { execGitWithInput } from "./gitRuntime";
import {
  TERMINAL_FILE_MAX_FILES,
  TERMINAL_FILE_MAX_SCAN_BYTES,
  TERMINAL_PATCH_MAX_BYTES,
  boundedFileReadLimits,
  validTerminalFileLineRanges,
  type TerminalFileReadBatchResult,
  type TerminalFileReadFailure,
  type TerminalFileReadFailureCode,
  type TerminalFileReadLocation,
  type TerminalFileReadRequest,
  type TerminalFileReadSuccess,
  type TerminalPatchFile,
  type TerminalPatchResult,
} from "./terminalFileTypes";
import { terminalRemoteManager } from "./terminalRemote";

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const BINARY_EXTENSIONS = new Set([
  ".7z", ".a", ".avi", ".bin", ".bmp", ".class", ".db", ".dmg", ".doc", ".docx",
  ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4",
  ".o", ".pdf", ".png", ".ppt", ".pptx", ".pyc", ".so", ".sqlite", ".tar", ".tgz",
  ".wasm", ".webp", ".woff", ".woff2", ".xls", ".xlsx", ".zip",
]);
const MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};
const GIT_PATCH_MAX_BUFFER = 2 * 1024 * 1024;

export class TerminalFilesError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "TerminalFilesError";
  }
}

function failure(
  path: string,
  code: TerminalFileReadFailureCode,
  message: string,
): TerminalFileReadFailure {
  return { path, code, message };
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function requestedPath(root: string, path: string): string | null {
  if (!path || path.length > 4_096 || /[\x00-\x1f\x7f]/.test(path)) return null;
  const candidate = resolve(root, path);
  return insideRoot(root, candidate) ? candidate : null;
}

function readPrefix(path: string, bytes: number): Buffer {
  if (bytes <= 0) return Buffer.alloc(0);
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(bytes);
    const read = readSync(descriptor, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
}

function decodeUtf8(buffer: Buffer): string | null {
  try {
    return TEXT_DECODER.decode(buffer);
  } catch {
    return null;
  }
}

function decodableUtf8Prefix(buffer: Buffer): boolean {
  for (let trim = 0; trim <= 3 && trim <= buffer.length; trim++) {
    if (decodeUtf8(buffer.subarray(0, buffer.length - trim)) !== null) return true;
  }
  return false;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; bytes: number; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return { value, bytes: encoded.length, truncated: false };
  let end = Math.max(0, maxBytes);
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  const decoded = encoded.subarray(0, end).toString("utf8");
  return { value: decoded, bytes: Buffer.byteLength(decoded), truncated: true };
}

function lineCount(value: string): number {
  if (!value) return 0;
  const matches = value.match(/\n/g)?.length || 0;
  return matches + (value.endsWith("\n") ? 0 : 1);
}

function binaryByContent(path: string, size: number): boolean {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) return true;
  const prefix = readPrefix(path, Math.min(size, 8_192));
  return prefix.includes(0) || !decodableUtf8Prefix(prefix);
}

function localReadFile(
  realRoot: string,
  location: TerminalFileReadLocation,
  maxBytes: number,
  includeBinary: boolean,
): { file?: TerminalFileReadSuccess; failed?: TerminalFileReadFailure; bytes: number } {
  const lexical = requestedPath(realRoot, location.path);
  if (!lexical) return { failed: failure(location.path, "invalid_path", "Path must stay inside the session root"), bytes: 0 };
  let path: string;
  try {
    path = realpathSync(lexical);
  } catch (error: any) {
    const code = error?.code === "ENOENT" ? "not_found" : "io_error";
    return { failed: failure(location.path, code, code === "not_found" ? "File not found" : "File could not be resolved"), bytes: 0 };
  }
  if (!insideRoot(realRoot, path)) {
    return { failed: failure(location.path, "outside_root", "Resolved path leaves the session root"), bytes: 0 };
  }
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { failed: failure(location.path, "io_error", "File metadata could not be read"), bytes: 0 };
  }
  if (!stat.isFile()) return { failed: failure(location.path, "not_file", "Path is not a regular file"), bytes: 0 };
  const relativePath = relative(realRoot, path).split(sep).join("/");
  let isBinary: boolean;
  try {
    isBinary = binaryByContent(path, stat.size);
  } catch {
    return { failed: failure(location.path, "io_error", "File could not be inspected"), bytes: 0 };
  }
  if (isBinary) {
    if (!includeBinary) {
      return { failed: failure(location.path, "binary_disallowed", "Binary reads require includeBinary=true"), bytes: 0 };
    }
    const content = readPrefix(path, Math.min(stat.size, maxBytes));
    return {
      file: {
        path,
        relativePath,
        kind: "binary",
        size: stat.size,
        modified: stat.mtimeMs,
        mime: MIME_TYPES[extname(path).toLowerCase()] || "application/octet-stream",
        base64: content.toString("base64"),
        truncated: stat.size > content.length,
      },
      bytes: content.length,
    };
  }

  const ranges = location.lineRanges || [];
  if (ranges.length && stat.size > TERMINAL_FILE_MAX_SCAN_BYTES) {
    return { failed: failure(location.path, "scan_limit", "Line-range scan exceeds the bounded file size"), bytes: 0 };
  }
  if (ranges.length) {
    let content: string;
    try {
      const raw = readFileSync(path);
      const decoded = decodeUtf8(raw);
      if (decoded === null) {
        return { failed: failure(location.path, "binary_disallowed", "File is not valid UTF-8 text"), bytes: 0 };
      }
      content = decoded;
    } catch {
      return { failed: failure(location.path, "io_error", "File could not be read"), bytes: 0 };
    }
    const lines = content.split(/\r?\n/);
    if (content.endsWith("\n")) lines.pop();
    let remaining = maxBytes;
    let truncated = false;
    const segments = [];
    for (const range of ranges) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const start = Math.min(range.start, lines.length + 1);
      const end = Math.min(range.end, lines.length);
      const selected = start <= end ? lines.slice(start - 1, end).join("\n") : "";
      const bounded = truncateUtf8(selected, remaining);
      remaining -= bounded.bytes;
      truncated ||= bounded.truncated;
      segments.push({ content: bounded.value, lineStart: range.start, lineEnd: end });
      if (bounded.truncated) break;
    }
    return {
      file: {
        path,
        relativePath,
        kind: "text",
        size: stat.size,
        modified: stat.mtimeMs,
        mime: "text/plain",
        segments,
        lineCount: lines.length,
        truncated,
      },
      bytes: maxBytes - remaining,
    };
  }

  const raw = readPrefix(path, Math.min(stat.size, maxBytes));
  let decoded = decodeUtf8(raw);
  if (decoded === null && raw.length < stat.size) {
    for (let trim = 1; trim <= 3 && trim < raw.length; trim++) {
      decoded = decodeUtf8(raw.subarray(0, raw.length - trim));
      if (decoded !== null) break;
    }
  }
  if (decoded === null) {
    return { failed: failure(location.path, "binary_disallowed", "File is not valid UTF-8 text"), bytes: 0 };
  }
  const bytes = Buffer.byteLength(decoded);
  return {
    file: {
      path,
      relativePath,
      kind: "text",
      size: stat.size,
      modified: stat.mtimeMs,
      mime: "text/plain",
      segments: [{ content: decoded }],
      lineCount: lineCount(decoded),
      truncated: stat.size > bytes,
    },
    bytes,
  };
}

export function readLocalTerminalFiles(request: TerminalFileReadRequest): TerminalFileReadBatchResult {
  if (!Array.isArray(request.files) || !request.files.length || request.files.length > TERMINAL_FILE_MAX_FILES) {
    throw new TerminalFilesError(`files must contain 1-${TERMINAL_FILE_MAX_FILES} entries`);
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(request.root));
    if (!statSync(realRoot).isDirectory()) throw new Error("not-directory");
  } catch {
    throw new TerminalFilesError("Session root is unavailable", 404);
  }
  const normalized: TerminalFileReadLocation[] = request.files.map((file) => {
    if (!file || typeof file.path !== "string") throw new TerminalFilesError("Each file requires a path");
    const lineRanges = validTerminalFileLineRanges(file.lineRanges);
    if (lineRanges === null) throw new TerminalFilesError("Invalid line range");
    return { path: file.path, lineRanges };
  });
  const { maxFileBytes, maxBatchBytes } = boundedFileReadLimits(request);
  const files: TerminalFileReadSuccess[] = [];
  const failedFiles: TerminalFileReadFailure[] = [];
  let remaining = maxBatchBytes;
  for (const location of normalized) {
    if (remaining <= 0) {
      failedFiles.push(failure(location.path, "budget_exhausted", "Batch byte budget is exhausted"));
      continue;
    }
    const result = localReadFile(realRoot, location, Math.min(maxFileBytes, remaining), request.includeBinary === true);
    if (result.file) files.push(result.file);
    if (result.failed) failedFiles.push(result.failed);
    remaining -= result.bytes;
  }
  return {
    root: realRoot,
    files,
    failedFiles,
    bytesReturned: maxBatchBytes - remaining,
    truncated: files.some((file) => file.truncated) || failedFiles.some((file) => file.code === "budget_exhausted"),
  };
}

function parseNumstat(output: string): TerminalPatchFile[] {
  const parts = output.split("\0");
  const files: TerminalPatchFile[] = [];
  for (let index = 0; index < parts.length; index++) {
    const record = parts[index];
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new TerminalFilesError("Git returned malformed patch metadata", 500);
    const addedRaw = record.slice(0, firstTab);
    const removedRaw = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    let previousPath: string | undefined;
    if (!path) {
      previousPath = parts[++index];
      path = parts[++index];
      if (!previousPath || !path) throw new TerminalFilesError("Malformed rename metadata", 400);
    }
    const number = (value: string) => /^\d+$/.test(value) ? Number(value) : null;
    files.push({ path, previousPath, added: number(addedRaw), removed: number(removedRaw) });
  }
  if (!files.length) throw new TerminalFilesError("Patch does not contain file changes");
  return files;
}

function validatePatchPaths(root: string, files: TerminalPatchFile[]) {
  for (const file of files) {
    for (const path of [file.path, file.previousPath].filter((value): value is string => Boolean(value))) {
      if (!requestedPath(root, path)) throw new TerminalFilesError("Patch path leaves the session root");
    }
  }
}

async function gitPatchCommand(
  sessionId: string,
  remote: boolean,
  root: string,
  args: string[],
  patch: string,
): Promise<string> {
  if (remote) {
    const result = await terminalRemoteManager.run(sessionId, {
      executable: "git",
      args,
      cwd: root,
      stdin: patch,
      timeoutMs: 5_000,
      maxOutputBytes: GIT_PATCH_MAX_BUFFER,
    });
    if (result.exitCode !== 0 || result.timedOut || result.truncated) {
      throw new TerminalFilesError(result.stderr.trim().slice(0, 4_096) || "Remote patch command failed", 409);
    }
    return result.stdout;
  }
  try {
    const result = await execGitWithInput(args, patch, { cwd: root, maxBuffer: GIT_PATCH_MAX_BUFFER });
    return result.stdout;
  } catch (error: any) {
    throw new TerminalFilesError(String(error?.stderr || error?.message || "Patch command failed").trim().slice(0, 4_096), 409);
  }
}

class TerminalFilesService {
  async readSessionFiles(
    sessionId: string,
    session: Session,
    input: Omit<TerminalFileReadRequest, "root">,
  ): Promise<TerminalFileReadBatchResult> {
    const snapshot = terminalRemoteManager.snapshot(sessionId);
    if (snapshot?.state === "connected") {
      return terminalRemoteManager.readFiles(sessionId, { ...input, root: session.cwd });
    }
    if (snapshot && snapshot.state !== "idle") {
      throw new TerminalFilesError("Remote file transport is unavailable", 503);
    }
    return readLocalTerminalFiles({ ...input, root: session.cwd });
  }

  async applySessionPatch(
    sessionId: string,
    session: Session,
    input: { patch: unknown; validateOnly?: unknown },
  ): Promise<TerminalPatchResult> {
    if (typeof input.patch !== "string" || !input.patch || /\0/.test(input.patch)) {
      throw new TerminalFilesError("patch must be nonempty UTF-8 text");
    }
    if (Buffer.byteLength(input.patch, "utf8") > TERMINAL_PATCH_MAX_BYTES) {
      throw new TerminalFilesError(`patch exceeds ${TERMINAL_PATCH_MAX_BYTES} bytes`, 413);
    }
    const snapshot = terminalRemoteManager.snapshot(sessionId);
    const remote = snapshot?.state === "connected";
    if (snapshot && snapshot.state !== "connected" && snapshot.state !== "idle") {
      throw new TerminalFilesError("Remote patch transport is unavailable", 503);
    }
    let root = session.cwd;
    if (!remote) {
      try {
        root = realpathSync(resolve(root));
        if (!statSync(root).isDirectory()) throw new Error("not-directory");
      } catch {
        throw new TerminalFilesError("Session root is unavailable", 404);
      }
    }
    const metadata = await gitPatchCommand(sessionId, remote, root, ["apply", "--numstat", "-z", "--recount"], input.patch);
    const files = parseNumstat(metadata);
    validatePatchPaths(root, files);
    await gitPatchCommand(
      sessionId,
      remote,
      root,
      ["apply", "--check", "--whitespace=nowarn", "--recount"],
      input.patch,
    );
    const validateOnly = input.validateOnly === true;
    if (!validateOnly) {
      await gitPatchCommand(
        sessionId,
        remote,
        root,
        ["apply", "--whitespace=nowarn", "--recount"],
        input.patch,
      );
    }
    return { root, applied: !validateOnly, validated: true, files };
  }
}

export const terminalFiles = new TerminalFilesService();
