import {
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { extname, isAbsolute, relative, resolve, sep } from "path";
import { randomUUID } from "crypto";
import type { Session } from "../types";
import { TERMINAL_FILE_MAX_BYTES } from "./terminalFileTypes";
import { terminalRemoteManager } from "./terminalRemote";

const MAX_FILES = 3_000;
const MAX_DEPTH = 12;
const SKIP_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".cache", ".next", ".openui-uploads", ".turbo", ".venv", "__pycache__",
  "build", "coverage", "dist", "node_modules", "release", "target", "venv",
]);
const BINARY_EXTENSIONS = new Set([
  ".7z", ".a", ".avi", ".bin", ".bmp", ".class", ".db", ".dmg", ".doc", ".docx",
  ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4",
  ".o", ".pdf", ".png", ".ppt", ".pptx", ".pyc", ".so", ".sqlite", ".tar", ".tgz",
  ".wasm", ".webp", ".woff", ".woff2", ".xls", ".xlsx", ".zip",
]);

const REMOTE_LIST_SCRIPT = String.raw`
import collections, json, os, sys
root = os.path.realpath(sys.argv[1])
skip = set(json.loads(sys.argv[2]))
binary = set(json.loads(sys.argv[3]))
limit = int(sys.argv[4])
max_depth = int(sys.argv[5])
max_bytes = int(sys.argv[6])
items = []
truncated = False
queue = collections.deque([(root, 0)])
while queue and not truncated:
    current, depth = queue.popleft()
    try:
        entries = sorted(os.scandir(current), key=lambda entry: entry.name)
    except OSError:
        continue
    for entry in entries:
        if not entry.is_file(follow_symlinks=False):
            continue
        name = entry.name
        if name == ".DS_Store":
            continue
        full = entry.path
        try:
            stat = entry.stat(follow_symlinks=False)
        except OSError:
            continue
        path = os.path.relpath(full, root).replace(os.sep, "/")
        ext = os.path.splitext(name)[1].lower()
        items.append({
            "path": path,
            "name": name,
            "size": stat.st_size,
            "modified": stat.st_mtime * 1000,
            "editable": ext not in binary and stat.st_size <= max_bytes,
        })
        if len(items) >= limit:
            truncated = True
            break
    if truncated or depth >= max_depth:
        continue
    for entry in entries:
        if entry.name in skip:
            continue
        try:
            if entry.is_dir(follow_symlinks=False):
                queue.append((entry.path, depth + 1))
        except OSError:
            continue
print(json.dumps({"root": root, "files": items, "truncated": truncated}))
`;

const REMOTE_WRITE_SCRIPT = String.raw`
import json, os, sys, tempfile
root = os.path.realpath(sys.argv[1])
rel = sys.argv[2]
expected = float(sys.argv[3])
max_bytes = int(sys.argv[4])
content = sys.stdin.buffer.read()
def done(payload):
    print(json.dumps(payload))
    raise SystemExit(0)
if len(content) > max_bytes:
    done({"error": "File is too large to save", "status": 413})
candidate = os.path.realpath(os.path.join(root, rel))
try:
    if os.path.commonpath([root, candidate]) != root:
        done({"error": "Path must stay inside the session root", "status": 400})
except ValueError:
    done({"error": "Path must stay inside the session root", "status": 400})
try:
    stat = os.stat(candidate)
except OSError:
    done({"error": "File not found", "status": 404})
if not os.path.isfile(candidate):
    done({"error": "Path is not a regular file", "status": 400})
modified = stat.st_mtime * 1000
if expected >= 0 and abs(modified - expected) > 1:
    done({"error": "File changed outside OpenUI. Reload it before saving.", "status": 409})
descriptor, temp = tempfile.mkstemp(prefix=".openui-save-", dir=os.path.dirname(candidate))
try:
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temp, stat.st_mode)
    os.replace(temp, candidate)
finally:
    if os.path.exists(temp):
        os.unlink(temp)
saved = os.stat(candidate)
done({"path": rel, "size": saved.st_size, "modified": saved.st_mtime * 1000})
`;

export interface CodeWorkspaceFile {
  path: string;
  name: string;
  size: number;
  modified: number;
  editable: boolean;
}

export interface CodeWorkspaceSnapshot {
  root: string;
  files: CodeWorkspaceFile[];
  truncated: boolean;
}

export interface CodeWorkspaceWriteResult {
  path: string;
  size: number;
  modified: number;
}

export class CodeWorkspaceError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "CodeWorkspaceError";
  }
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function safeRoot(root: string): string {
  try {
    const resolved = realpathSync(resolve(root));
    if (!statSync(resolved).isDirectory()) throw new Error("not-directory");
    return resolved;
  } catch {
    throw new CodeWorkspaceError("Session root is unavailable", 404);
  }
}

function safeRelativePath(root: string, value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4_096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new CodeWorkspaceError("A valid file path is required");
  }
  const candidate = resolve(root, value);
  if (!insideRoot(root, candidate)) throw new CodeWorkspaceError("Path must stay inside the session root");
  return value.split("\\").join("/");
}

export function listLocalCodeWorkspaceFiles(
  rootValue: string,
  options: { maxFiles?: number } = {},
): CodeWorkspaceSnapshot {
  const root = safeRoot(rootValue);
  const requestedMaxFiles = typeof options.maxFiles === "number" && Number.isFinite(options.maxFiles)
    ? options.maxFiles
    : MAX_FILES;
  const maxFiles = Math.max(1, Math.min(MAX_FILES, Math.floor(requestedMaxFiles)));
  const files: CodeWorkspaceFile[] = [];
  let truncated = false;
  const directories: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let directoryIndex = 0;

  while (directoryIndex < directories.length && !truncated) {
    const current = directories[directoryIndex++]!;
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }

    // Add files at this level before visiting child folders. Breadth-first
    // discovery keeps root files visible even when a large hidden folder would
    // otherwise consume the complete result budget.
    for (const entry of entries.filter((item) => item.isFile())) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      if (entry.name === ".DS_Store") continue;
      const fullPath = resolve(current.path, entry.name);
      try {
        const link = lstatSync(fullPath);
        if (link.isSymbolicLink()) continue;
        const stat = statSync(fullPath);
        const path = relative(root, fullPath).split(sep).join("/");
        files.push({
          path,
          name: entry.name,
          size: stat.size,
          modified: stat.mtimeMs,
          editable: !BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase()) && stat.size <= TERMINAL_FILE_MAX_BYTES,
        });
      } catch {
        // A disappearing or unreadable file should not break the whole explorer.
      }
    }

    if (truncated || current.depth >= MAX_DEPTH) continue;
    for (const entry of entries.filter((item) => item.isDirectory())) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      directories.push({ path: resolve(current.path, entry.name), depth: current.depth + 1 });
    }
  }

  return { root, files, truncated };
}

export function writeLocalCodeWorkspaceFile(
  rootValue: string,
  input: { path: unknown; content: unknown; expectedModified?: unknown },
): CodeWorkspaceWriteResult {
  const root = safeRoot(rootValue);
  const path = safeRelativePath(root, input.path);
  if (typeof input.content !== "string") throw new CodeWorkspaceError("File content must be text");
  if (Buffer.byteLength(input.content, "utf8") > TERMINAL_FILE_MAX_BYTES) {
    throw new CodeWorkspaceError("File is too large to save", 413);
  }
  let target: string;
  try {
    target = realpathSync(resolve(root, path));
  } catch {
    throw new CodeWorkspaceError("File not found", 404);
  }
  if (!insideRoot(root, target)) throw new CodeWorkspaceError("Resolved path leaves the session root");
  const stat = statSync(target);
  if (!stat.isFile()) throw new CodeWorkspaceError("Path is not a regular file");
  const expectedModified = typeof input.expectedModified === "number" && Number.isFinite(input.expectedModified)
    ? input.expectedModified
    : -1;
  if (expectedModified >= 0 && Math.abs(stat.mtimeMs - expectedModified) > 1) {
    throw new CodeWorkspaceError("File changed outside OpenUI. Reload it before saving.", 409);
  }
  const temp = resolve(target, `../.openui-save-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temp, input.content, { encoding: "utf8", mode: stat.mode });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  const saved = statSync(target);
  return { path, size: saved.size, modified: saved.mtimeMs };
}

class CodeWorkspaceService {
  async listSessionFiles(sessionId: string, session: Session): Promise<CodeWorkspaceSnapshot> {
    const snapshot = terminalRemoteManager.snapshot(sessionId);
    if (snapshot?.state === "connected") {
      const result = await terminalRemoteManager.run(sessionId, {
        executable: "python3",
        args: [
          "-c",
          REMOTE_LIST_SCRIPT,
          session.cwd,
          JSON.stringify([...SKIP_DIRECTORIES]),
          JSON.stringify([...BINARY_EXTENSIONS]),
          String(MAX_FILES),
          String(MAX_DEPTH),
          String(TERMINAL_FILE_MAX_BYTES),
        ],
        cwd: session.cwd,
        timeoutMs: 8_000,
        maxOutputBytes: 256 * 1024,
      });
      if (result.exitCode !== 0 || result.timedOut || result.truncated) {
        throw new CodeWorkspaceError(result.stderr.trim() || "Remote workspace could not be listed", 503);
      }
      try {
        const parsed = JSON.parse(result.stdout) as CodeWorkspaceSnapshot;
        if (!parsed || typeof parsed.root !== "string" || !Array.isArray(parsed.files)) throw new Error("invalid");
        const files = parsed.files.filter((file) =>
          file && typeof file.path === "string" && typeof file.name === "string" &&
          typeof file.size === "number" && typeof file.modified === "number" && typeof file.editable === "boolean" &&
          !file.path.startsWith("/") && !file.path.split("/").includes("..") && !/[\x00-\x1f\x7f]/.test(file.path)
        ).slice(0, MAX_FILES);
        if (files.length !== parsed.files.length) throw new Error("unsafe");
        return { root: parsed.root, files, truncated: parsed.truncated === true };
      } catch {
        throw new CodeWorkspaceError("Remote workspace returned an invalid file list", 503);
      }
    }
    if (snapshot && snapshot.state !== "idle") {
      throw new CodeWorkspaceError("Remote file transport is unavailable", 503);
    }
    return listLocalCodeWorkspaceFiles(session.cwd);
  }

  async writeSessionFile(
    sessionId: string,
    session: Session,
    input: { path: unknown; content: unknown; expectedModified?: unknown },
  ): Promise<CodeWorkspaceWriteResult> {
    const snapshot = terminalRemoteManager.snapshot(sessionId);
    if (snapshot?.state === "connected") {
      if (typeof input.content !== "string") throw new CodeWorkspaceError("File content must be text");
      if (Buffer.byteLength(input.content, "utf8") > TERMINAL_FILE_MAX_BYTES) {
        throw new CodeWorkspaceError("File is too large to save", 413);
      }
      const path = safeRelativePath(resolve(session.cwd), input.path);
      const expected = typeof input.expectedModified === "number" && Number.isFinite(input.expectedModified)
        ? input.expectedModified
        : -1;
      const result = await terminalRemoteManager.run(sessionId, {
        executable: "python3",
        args: ["-c", REMOTE_WRITE_SCRIPT, session.cwd, path, String(expected), String(TERMINAL_FILE_MAX_BYTES)],
        cwd: session.cwd,
        stdin: input.content,
        timeoutMs: 8_000,
        maxOutputBytes: 16 * 1024,
      });
      if (result.exitCode !== 0 || result.timedOut || result.truncated) {
        throw new CodeWorkspaceError(result.stderr.trim() || "Remote file could not be saved", 503);
      }
      try {
        const parsed = JSON.parse(result.stdout);
        if (parsed.error) throw new CodeWorkspaceError(parsed.error, Number(parsed.status) || 400);
        if (typeof parsed.path !== "string" || typeof parsed.size !== "number" || typeof parsed.modified !== "number") {
          throw new Error("invalid");
        }
        return { path: parsed.path, size: parsed.size, modified: parsed.modified };
      } catch (error) {
        if (error instanceof CodeWorkspaceError) throw error;
        throw new CodeWorkspaceError("Remote workspace returned an invalid save result", 503);
      }
    }
    if (snapshot && snapshot.state !== "idle") {
      throw new CodeWorkspaceError("Remote file transport is unavailable", 503);
    }
    return writeLocalCodeWorkspaceFile(session.cwd, input);
  }
}

export const codeWorkspace = new CodeWorkspaceService();
