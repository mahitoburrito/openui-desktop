import { existsSync, lstatSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface PackageScriptEntry {
  name: string;
  command: string;
  runCommand: string;
  description: string;
}

export interface PackageScriptManifest {
  root: string;
  packageJsonPath: string;
  packageManager: PackageManager;
  scripts: PackageScriptEntry[];
}

const PACKAGE_JSON_MAX_BYTES = 1024 * 1024;
const MAX_PACKAGE_SCRIPTS = 512;
const MAX_SCRIPT_COMMAND_CHARS = 32_768;
const PACKAGE_ROOT_MAX_DEPTH = 8;
const PACKAGE_SCRIPT_PRIORITY = [
  "dev", "start", "build", "test", "lint", "typecheck", "check", "format", "preview",
];
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@/+~-]{0,127}$/;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
}

export function packageManagerForRoot(root: string): PackageManager {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  return "npm";
}

export function packageScriptCommand(manager: PackageManager, scriptName: string): string {
  const script = shellQuote(scriptName);
  if (manager === "npm") return `npm run ${script}`;
  if (manager === "pnpm") return `pnpm run ${script}`;
  if (manager === "yarn") return `yarn run ${script}`;
  return `bun run ${script}`;
}

export function describePackageScript(scriptName: string): string {
  const lower = scriptName.toLowerCase();
  if (lower === "dev" || lower.includes("dev")) return "Start the development workflow";
  if (lower === "start") return "Start the project";
  if (lower.includes("build")) return "Build the project";
  if (lower.includes("test")) return "Run tests";
  if (lower.includes("lint")) return "Run lint checks";
  if (lower.includes("type")) return "Run type checking";
  if (lower.includes("format")) return "Format or verify formatting";
  if (lower.includes("preview")) return "Preview the built app";
  return "Run package script";
}

export function findPackageRoot(startPath: string): string | null {
  let current = resolve(startPath);
  if (!existsSync(current)) return null;
  const initialStat = statSync(current);
  if (!initialStat.isDirectory()) current = dirname(current);

  for (let depth = 0; depth < PACKAGE_ROOT_MAX_DEPTH; depth++) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function readPackageScriptManifest(startPath: string): PackageScriptManifest | null {
  const root = findPackageRoot(startPath);
  if (!root) return null;
  const packageJsonPath = join(root, "package.json");
  const packageStat = lstatSync(packageJsonPath);
  if (!packageStat.isFile()) throw new Error("package.json is not a file");
  if (packageStat.size > PACKAGE_JSON_MAX_BYTES) throw new Error("package.json is too large");

  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const scriptsObject = parsed && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
    ? parsed.scripts as Record<string, unknown>
    : {};
  const packageManager = packageManagerForRoot(root);
  const scripts = Object.entries(scriptsObject)
    .flatMap(([name, command]) => {
      if (typeof command !== "string" || !SAFE_SCRIPT_NAME.test(name) || command.length > MAX_SCRIPT_COMMAND_CHARS) {
        return [];
      }
      return [{
        name,
        command,
        runCommand: packageScriptCommand(packageManager, name),
        description: describePackageScript(name),
      }];
    })
    .sort((a, b) => {
      const aPriority = PACKAGE_SCRIPT_PRIORITY.indexOf(a.name);
      const bPriority = PACKAGE_SCRIPT_PRIORITY.indexOf(b.name);
      const aRank = aPriority === -1 ? PACKAGE_SCRIPT_PRIORITY.length : aPriority;
      const bRank = bPriority === -1 ? PACKAGE_SCRIPT_PRIORITY.length : bPriority;
      return aRank === bRank ? a.name.localeCompare(b.name) : aRank - bRank;
    })
    .slice(0, MAX_PACKAGE_SCRIPTS);

  return { root, packageJsonPath, packageManager, scripts };
}
