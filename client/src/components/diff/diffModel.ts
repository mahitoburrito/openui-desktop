// Shared model + helpers for the diff viewer.
// Parses unified git diffs into structured lines (with old/new line numbers),
// builds a collapsible file tree, and maps file extensions to Shiki langs.

export interface ChangedFile {
  path: string;
  status: string;
  added: number;
  removed: number;
  untracked: boolean;
}

export type DiffLineType = "add" | "del" | "ctx" | "hunk" | "meta";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  // Content without the leading +/-/space marker (for highlighting).
  content: string;
  // 1-based line numbers in the old / new file. null when not applicable.
  oldNo: number | null;
  newNo: number | null;
}

// Parse a unified git diff into renderable lines, tracking line numbers so the
// split view can align old/new sides and gutters can show numbers.
export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("@@")) {
      // @@ -a,b +c,d @@ — reset counters to the hunk's starting lines.
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
      }
      out.push({ type: "hunk", text: raw, content: raw, oldNo: null, newNo: null });
    } else if (
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("similarity ") ||
      raw.startsWith("rename ")
    ) {
      out.push({ type: "meta", text: raw, content: raw, oldNo: null, newNo: null });
    } else if (raw.startsWith("+")) {
      out.push({ type: "add", text: raw, content: raw.slice(1), oldNo: null, newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      out.push({ type: "del", text: raw, content: raw.slice(1), oldNo: oldNo++, newNo: null });
    } else {
      const content = raw.startsWith(" ") ? raw.slice(1) : raw;
      out.push({ type: "ctx", text: raw, content, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}

// A row in the split view: a left (old) cell and a right (new) cell.
// ctx rows fill both; add/del rows are paired greedily so a replaced block
// lines up side-by-side, with empty cells padding the shorter side.
export interface SplitRow {
  kind: "pair" | "hunk" | "meta";
  left: DiffLine | null;
  right: DiffLine | null;
  // For hunk/meta rows that span the full width.
  full?: DiffLine;
}

export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "hunk") {
      rows.push({ kind: "hunk", left: null, right: null, full: line });
      i++;
    } else if (line.type === "meta") {
      rows.push({ kind: "meta", left: null, right: null, full: line });
      i++;
    } else if (line.type === "ctx") {
      rows.push({ kind: "pair", left: line, right: line });
      i++;
    } else {
      // Collect a contiguous run of dels then adds, and zip them.
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].type === "del") dels.push(lines[i++]);
      while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
      const n = Math.max(dels.length, adds.length);
      for (let j = 0; j < n; j++) {
        rows.push({
          kind: "pair",
          left: dels[j] ?? null,
          right: adds[j] ?? null,
        });
      }
    }
  }
  return rows;
}

// ── File tree ────────────────────────────────────────────────────────────────

export interface TreeFileNode {
  type: "file";
  name: string;
  file: ChangedFile;
}

export interface TreeDirNode {
  type: "dir";
  name: string; // may be a collapsed "a/b/c" segment
  path: string; // full path prefix for keying
  children: TreeNode[];
}

export type TreeNode = TreeFileNode | TreeDirNode;

interface MutableDir {
  dirs: Map<string, MutableDir>;
  files: ChangedFile[];
}

// Build a nested tree from flat file paths, then collapse any directory that
// has exactly one child directory and no files (OpenCode behavior: a/b/c shown
// as a single row instead of three nested ones).
export function buildFileTree(files: ChangedFile[]): TreeNode[] {
  const root: MutableDir = { dirs: new Map(), files: [] };

  for (const f of files) {
    const parts = f.path.split("/");
    parts.pop(); // drop the filename — only the directory parts build the tree
    let cursor = root;
    for (const part of parts) {
      let next = cursor.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        cursor.dirs.set(part, next);
      }
      cursor = next;
    }
    cursor.files.push({ ...f });
  }

  const build = (dir: MutableDir, prefix: string): TreeNode[] => {
    const nodes: TreeNode[] = [];
    // Directories first, alphabetically, with single-child collapsing.
    const dirNames = [...dir.dirs.keys()].sort();
    for (const name of dirNames) {
      let segName = name;
      let cur = dir.dirs.get(name)!;
      let curPath = prefix ? `${prefix}/${name}` : name;
      // Collapse: while this dir has exactly one subdir and no files, fold it in.
      while (cur.files.length === 0 && cur.dirs.size === 1) {
        const [childName] = cur.dirs.keys();
        segName = `${segName}/${childName}`;
        cur = cur.dirs.get(childName)!;
        curPath = `${curPath}/${childName}`;
      }
      nodes.push({
        type: "dir",
        name: segName,
        path: curPath,
        children: build(cur, curPath),
      });
    }
    // Files after directories, alphabetically.
    const sortedFiles = [...dir.files].sort((a, b) => {
      const an = a.path.split("/").pop()!;
      const bn = b.path.split("/").pop()!;
      return an.localeCompare(bn);
    });
    for (const f of sortedFiles) {
      nodes.push({ type: "file", name: f.path.split("/").pop()!, file: f });
    }
    return nodes;
  };

  return build(root, "");
}

// Flatten the file list in tree (display) order — used for keyboard up/down nav
// so arrowing follows what the user sees.
export function flattenFiles(nodes: TreeNode[]): ChangedFile[] {
  const out: ChangedFile[] = [];
  const walk = (ns: TreeNode[]) => {
    for (const n of ns) {
      if (n.type === "file") out.push(n.file);
      else walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

// Map a file path to a Shiki language id. Falls back to "text".
const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  scss: "scss",
  html: "html",
  md: "markdown",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  vue: "vue",
  svelte: "svelte",
};

export function langForFile(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "text";
}
