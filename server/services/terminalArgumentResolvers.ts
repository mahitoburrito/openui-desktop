import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "path";
import { findPackageRoot, readPackageScriptManifest } from "./terminalManifests";

export type TerminalArgumentTemplate =
  | "files"
  | "folders"
  | "files-and-folders"
  | "cd-folders"
  | "package-scripts"
  | "git-branches"
  | "git-refs"
  | "docker-containers"
  | "docker-running-containers"
  | "docker-images"
  | "docker-compose-services"
  | "docker-contexts"
  | "docker-volumes"
  | "docker-networks"
  | "kubectl-contexts"
  | "kubectl-namespaces"
  | "kubectl-resource-types"
  | "kubectl-resource-names"
  | "kubectl-pods"
  | "kubectl-containers";

export interface TerminalResolvedArgumentValue {
  value: string;
  title?: string;
  description: string;
  source: "filesystem" | "cdpath" | "package-manifest" | "git-ref" | "docker" | "docker-compose" | "kubectl";
  needsShellQuoting?: boolean;
}

export type TerminalArgumentValueResolver = (input: {
  templates: TerminalArgumentTemplate[];
  cwd: string;
  fragment: string;
  environment?: Record<string, string | undefined>;
}) => Promise<TerminalResolvedArgumentValue[]>;

const CACHE_TTL_MS = 2_000;
const MAX_CACHE_ENTRIES = 32;
const MAX_PATH_ENTRIES = 500;
const MAX_CDPATH_ENTRIES = 64;
const MAX_GIT_REF_FILES = 2_048;
const MAX_GIT_REFS = 1_024;
const MAX_PACKED_REFS_BYTES = 4 * 1024 * 1024;
const MAX_GIT_POINTER_BYTES = 4 * 1024;
const MAX_GIT_SEARCH_DEPTH = 16;

const packageScriptCache = new Map<string, {
  expiresAt: number;
  mtimeMs: number;
  size: number;
  values: TerminalResolvedArgumentValue[];
}>();
const gitRefCache = new Map<string, { expiresAt: number; values: TerminalResolvedArgumentValue[] }>();

function setBoundedCache<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearTerminalArgumentResolverCaches() {
  packageScriptCache.clear();
  gitRefCache.clear();
}

function packageScriptValues(cwd: string): TerminalResolvedArgumentValue[] {
  let root: string | null;
  try {
    root = findPackageRoot(cwd);
  } catch {
    return [];
  }
  if (!root) return [];
  const packageJsonPath = resolve(root, "package.json");
  let fileStat;
  try {
    fileStat = statSync(packageJsonPath);
  } catch {
    return [];
  }
  const cached = packageScriptCache.get(packageJsonPath);
  const now = Date.now();
  if (
    cached && cached.expiresAt > now && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size
  ) return cached.values;

  let values: TerminalResolvedArgumentValue[] = [];
  try {
    const manifest = readPackageScriptManifest(root);
    values = (manifest?.scripts || []).map((script) => ({
      value: script.name,
      title: script.name,
      description: script.description,
      source: "package-manifest" as const,
    }));
  } catch {
    values = [];
  }
  setBoundedCache(packageScriptCache, packageJsonPath, {
    expiresAt: now + CACHE_TTL_MS,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    values,
  });
  return values;
}

interface GitDirectories {
  workTree: string;
  gitDir: string;
  commonDir: string;
}

function readSmallTextFile(path: string, maxBytes: number): string | null {
  try {
    const fileStat = lstatSync(path);
    if (!fileStat.isFile() || fileStat.size > maxBytes) return null;
    const value = readFileSync(path, "utf8").trim();
    if (!value || /[\0\r\n]/.test(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function gitDirectories(startPath: string): GitDirectories | null {
  let current = resolve(startPath);
  try {
    if (!statSync(current).isDirectory()) current = dirname(current);
  } catch {
    return null;
  }

  for (let depth = 0; depth < MAX_GIT_SEARCH_DEPTH; depth++) {
    const dotGit = resolve(current, ".git");
    try {
      const dotGitStat = lstatSync(dotGit);
      let gitDir: string | null = null;
      if (dotGitStat.isDirectory()) {
        gitDir = dotGit;
      } else if (dotGitStat.isFile() && dotGitStat.size <= MAX_GIT_POINTER_BYTES) {
        const pointer = readFileSync(dotGit, "utf8").trim();
        const match = /^gitdir:\s*(.+)$/i.exec(pointer);
        if (match && !/[\0\r\n]/.test(match[1])) {
          gitDir = resolve(current, match[1]);
        }
      }
      if (gitDir && existsSync(gitDir) && statSync(gitDir).isDirectory()) {
        const commonPointer = readSmallTextFile(resolve(gitDir, "commondir"), MAX_GIT_POINTER_BYTES);
        const commonDir = commonPointer ? resolve(gitDir, commonPointer) : gitDir;
        if (!existsSync(commonDir) || !statSync(commonDir).isDirectory()) return null;
        return { workTree: current, gitDir, commonDir };
      }
    } catch {
      // Keep walking toward the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function safeGitRefName(name: string): boolean {
  return Boolean(name) && name.length <= 256 && name !== "@" &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(name) &&
    !name.includes("..") && !name.includes("@{") && !name.includes("//") &&
    !name.startsWith("/") && !name.endsWith("/") && !name.endsWith(".") &&
    !name.split("/").some((component) => component.startsWith(".") || component.endsWith(".lock"));
}

function walkRefFiles(
  root: string,
  prefix: string,
  description: string,
  values: TerminalResolvedArgumentValue[],
  state: { files: number },
  depth = 0,
) {
  if (depth > MAX_GIT_SEARCH_DEPTH || state.files >= MAX_GIT_REF_FILES || values.length >= MAX_GIT_REFS) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (state.files >= MAX_GIT_REF_FILES || values.length >= MAX_GIT_REFS) break;
    if (entry.isSymbolicLink()) continue;
    const path = resolve(root, entry.name);
    const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkRefFiles(path, nextPrefix, description, values, state, depth + 1);
    } else if (entry.isFile()) {
      state.files += 1;
      if (!safeGitRefName(nextPrefix) || nextPrefix.endsWith("/HEAD")) continue;
      values.push({ value: nextPrefix, title: nextPrefix, description, source: "git-ref" });
    }
  }
}

function packedRefValues(commonDir: string): TerminalResolvedArgumentValue[] {
  const path = resolve(commonDir, "packed-refs");
  try {
    const fileStat = lstatSync(path);
    if (!fileStat.isFile() || fileStat.size > MAX_PACKED_REFS_BYTES) return [];
    return readFileSync(path, "utf8").split(/\r?\n/).slice(0, MAX_GIT_REF_FILES).flatMap((line) => {
      if (!line || line.startsWith("#") || line.startsWith("^")) return [];
      const separator = line.indexOf(" ");
      if (separator < 0) return [];
      const ref = line.slice(separator + 1).trim();
      let value = "";
      let description = "Git ref";
      if (ref.startsWith("refs/heads/")) {
        value = ref.slice("refs/heads/".length);
        description = "Local branch";
      } else if (ref.startsWith("refs/remotes/")) {
        value = ref.slice("refs/remotes/".length);
        description = "Remote branch";
      } else if (ref.startsWith("refs/tags/")) {
        value = ref.slice("refs/tags/".length);
        description = "Git tag";
      }
      if (!safeGitRefName(value) || value.endsWith("/HEAD")) return [];
      return [{ value, title: value, description, source: "git-ref" as const }];
    });
  } catch {
    return [];
  }
}

function gitRefValues(cwd: string, includeTags: boolean): TerminalResolvedArgumentValue[] {
  const directories = gitDirectories(cwd);
  if (!directories) return [];
  const key = `${directories.commonDir}\0${includeTags ? "refs" : "branches"}`;
  const cached = gitRefCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.values;

  const values: TerminalResolvedArgumentValue[] = [];
  const state = { files: 0 };
  walkRefFiles(resolve(directories.commonDir, "refs", "heads"), "", "Local branch", values, state);
  walkRefFiles(resolve(directories.commonDir, "refs", "remotes"), "", "Remote branch", values, state);
  if (includeTags) walkRefFiles(resolve(directories.commonDir, "refs", "tags"), "", "Git tag", values, state);
  values.push(...packedRefValues(directories.commonDir));

  const seen = new Set<string>();
  const deduplicated = values.filter((value) => {
    const key = value.value;
    if (seen.has(key)) return false;
    seen.add(key);
    return includeTags || value.description !== "Git tag";
  }).sort((a, b) => a.value.localeCompare(b.value)).slice(0, MAX_GIT_REFS);
  setBoundedCache(gitRefCache, key, { expiresAt: now + CACHE_TTL_MS, values: deduplicated });
  return deduplicated;
}

function pathValues(
  cwd: string,
  fragment: string,
  template: "files" | "folders" | "files-and-folders",
): TerminalResolvedArgumentValue[] {
  if (!cwd || !existsSync(cwd)) return [];
  const expanded = fragment.startsWith("~/")
    ? resolve(process.env.HOME || cwd, fragment.slice(2))
    : isAbsolute(fragment)
      ? fragment
      : resolve(cwd, fragment || ".");
  const directory = fragment.endsWith("/") || fragment === "" ? expanded : dirname(expanded);
  const nameFragment = fragment.endsWith("/") || fragment === "" ? "" : basename(expanded).toLowerCase();
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true }).slice(0, MAX_PATH_ENTRIES);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!nameFragment.startsWith(".") && entry.name.startsWith(".")) return [];
    if (nameFragment && !entry.name.toLowerCase().includes(nameFragment)) return [];
    const absolutePath = resolve(directory, entry.name);
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { isDirectory = statSync(absolutePath).isDirectory(); } catch { return []; }
    }
    if (template === "files" && isDirectory) return [];
    if (template === "folders" && !isDirectory) return [];
    let displayPath = relative(cwd, absolutePath) || entry.name;
    if (!displayPath.startsWith("..") && !isAbsolute(displayPath)) displayPath = `.${sep}${displayPath}`;
    if (isDirectory) displayPath += sep;
    return [{
      value: displayPath,
      title: `${entry.name}${isDirectory ? sep : ""}`,
      description: absolutePath,
      source: "filesystem" as const,
      needsShellQuoting: /\s/.test(displayPath) || undefined,
    }];
  });
}

function isCdPathEligibleToken(fragment: string): boolean {
  const token = fragment.replace(/\\/g, "/");
  return !(
    token.startsWith("/") ||
    token.startsWith("~") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token === "." ||
    token === ".."
  );
}

function navigationValuesFrom(
  cwd: string,
  baseDirectory: string,
  fragment: string,
  source: "filesystem" | "cdpath",
): TerminalResolvedArgumentValue[] {
  const trailingSeparator = fragment.endsWith("/") || fragment.endsWith("\\");
  const expanded = resolve(baseDirectory, fragment || ".");
  const directory = trailingSeparator || fragment === "" ? expanded : dirname(expanded);
  const nameFragment = trailingSeparator || fragment === "" ? "" : basename(expanded).toLowerCase();
  const lastSeparator = Math.max(fragment.lastIndexOf("/"), fragment.lastIndexOf("\\"));
  const tokenPrefix = trailingSeparator
    ? fragment
    : lastSeparator >= 0
      ? fragment.slice(0, lastSeparator + 1)
      : "";
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_PATH_ENTRIES);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!nameFragment.startsWith(".") && entry.name.startsWith(".")) return [];
    if (nameFragment && !entry.name.toLowerCase().includes(nameFragment)) return [];
    const absolutePath = resolve(directory, entry.name);
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { isDirectory = statSync(absolutePath).isDirectory(); } catch { return []; }
    }
    if (!isDirectory) return [];
    const value = `${tokenPrefix}${entry.name}${sep}`;
    return [{
      value,
      title: value,
      description: absolutePath,
      source,
      needsShellQuoting: /\s/.test(value) || undefined,
    }];
  });
}

export function resolveTopLevelAutocdDirectories(cwd: string): TerminalResolvedArgumentValue[] {
  if (!cwd || !existsSync(cwd)) return [];
  return navigationValuesFrom(cwd, cwd, "", "filesystem");
}

function resolveCdPathEntry(
  entry: string,
  cwd: string,
  environment: Record<string, string | undefined>,
): string {
  const home = environment.HOME || process.env.HOME || cwd;
  const expanded = entry === "~"
    ? home
    : entry.startsWith("~/")
      ? resolve(home, entry.slice(2))
      : entry;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function cdPathValues(
  cwd: string,
  fragment: string,
  environment: Record<string, string | undefined>,
): TerminalResolvedArgumentValue[] {
  if (!isCdPathEligibleToken(fragment)) return pathValues(cwd, fragment, "folders");
  if (environment.CDPATH === undefined) {
    return navigationValuesFrom(cwd, cwd, fragment, "filesystem");
  }

  const values: TerminalResolvedArgumentValue[] = [];
  const seen = new Set<string>();
  let cwdSearched = false;
  const append = (next: TerminalResolvedArgumentValue[]) => {
    for (const value of next) {
      if (values.length >= MAX_PATH_ENTRIES) return;
      if (seen.has(value.value)) continue;
      seen.add(value.value);
      values.push(value);
    }
  };

  for (const entry of environment.CDPATH.split(":").slice(0, MAX_CDPATH_ENTRIES)) {
    if (entry === "" || entry === ".") {
      if (cwdSearched) continue;
      append(navigationValuesFrom(cwd, cwd, fragment, "filesystem"));
      cwdSearched = true;
    } else {
      append(navigationValuesFrom(
        cwd,
        resolveCdPathEntry(entry, cwd, environment),
        fragment,
        "cdpath",
      ));
    }
  }
  if (!cwdSearched) append(navigationValuesFrom(cwd, cwd, fragment, "filesystem"));
  return values;
}

export function resolveTerminalArgumentValues(input: {
  templates: TerminalArgumentTemplate[];
  cwd: string;
  fragment: string;
  environment?: Record<string, string | undefined>;
}): TerminalResolvedArgumentValue[] {
  const values: TerminalResolvedArgumentValue[] = [];
  for (const template of [...new Set(input.templates)]) {
    if (template === "package-scripts") values.push(...packageScriptValues(input.cwd));
    else if (template === "git-branches") values.push(...gitRefValues(input.cwd, false));
    else if (template === "git-refs") values.push(...gitRefValues(input.cwd, true));
    else if (template === "cd-folders") {
      values.push(...cdPathValues(input.cwd, input.fragment, input.environment || process.env));
    }
    else if (template === "files" || template === "folders" || template === "files-and-folders") {
      values.push(...pathValues(input.cwd, input.fragment, template));
    }
  }
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.value)) return false;
    seen.add(value.value);
    return true;
  }).slice(0, 1_024);
}
