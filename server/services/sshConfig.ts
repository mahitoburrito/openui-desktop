import { copyFileSync, existsSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export interface SshConfigHost {
  /** The alias as written on the `Host` line — what you pass to `ssh`. */
  name: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

export function sshConfigPath(): string {
  return join(homedir(), ".ssh", "config");
}

/**
 * A `Host` name containing a glob is a *match pattern*, not a machine you can
 * connect to — `Host s275-? hive??` matches a family of lab hosts and resolves
 * to nothing on its own. Real configs are full of these, so they are dropped
 * rather than offered as devboxes.
 */
function isConnectableName(name: string): boolean {
  return name.length > 0 && !name.includes("*") && !name.includes("?") && !name.startsWith("!");
}

/**
 * Parses the subset of ssh_config we need. Unknown keywords are ignored rather
 * than rejected — a real config carries plenty we do not care about, and
 * failing on any of it would make the feature useless on exactly the machines
 * that have a configured devbox.
 *
 * `Include` is not followed. No behaviour depends on it, and silently reading
 * further files the user did not point us at is worse than listing fewer hosts.
 */
export function parseSshConfig(text: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = [];
  // One `Host` line can declare several aliases; each becomes its own entry
  // sharing the block's settings.
  let current: SshConfigHost[] = [];

  const applyToCurrent = (apply: (host: SshConfigHost) => void) => {
    for (const host of current) apply(host);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // ssh_config accepts `Keyword value` and `Keyword=value`.
    const match = /^([A-Za-z][A-Za-z0-9-]*)\s*=?\s*(.*)$/.exec(line);
    if (!match) continue;
    const keyword = match[1].toLowerCase();
    const value = match[2].trim();

    if (keyword === "host") {
      current = value
        .split(/\s+/)
        .filter(isConnectableName)
        .map((name) => ({ name }));
      hosts.push(...current);
      continue;
    }
    if (!current.length || !value) continue;

    switch (keyword) {
      case "hostname":
        applyToCurrent((host) => { host.hostName = value; });
        break;
      case "user":
        applyToCurrent((host) => { host.user = value; });
        break;
      case "port": {
        const port = Number.parseInt(value, 10);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          applyToCurrent((host) => { host.port = port; });
        }
        break;
      }
      case "identityfile":
        applyToCurrent((host) => { host.identityFile = value; });
        break;
      default:
        break;
    }
  }

  return hosts;
}

export function readSshConfigHosts(path = sshConfigPath()): SshConfigHost[] {
  try {
    if (!existsSync(path)) return [];
    return parseSshConfig(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

export interface AppendHostRequest {
  name: string;
  hostName: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

export type AppendHostResult =
  | { ok: true; backupPath: string | null }
  | { ok: false; reason: "duplicate" | "invalid" | "write-failed"; message: string };

/**
 * Appends a Host block to ~/.ssh/config.
 *
 * This is the only thing here that writes outside our own state directory, so
 * it is deliberately narrow: it appends, it never rewrites or reorders what is
 * already there, it takes a backup first, and it refuses a name that already
 * exists rather than shadowing it (ssh takes the *first* match, so a duplicate
 * would silently do nothing — worse than an error).
 */
export function appendSshConfigHost(
  request: AppendHostRequest,
  path = sshConfigPath(),
): AppendHostResult {
  if (!isConnectableName(request.name) || /\s/.test(request.name)) {
    return { ok: false, reason: "invalid", message: "Alias must not be empty, globbed, or contain spaces." };
  }
  if (!request.hostName.trim() || /\s/.test(request.hostName)) {
    return { ok: false, reason: "invalid", message: "Host must be a single hostname or address." };
  }

  const existing = readSshConfigHosts(path);
  if (existing.some((host) => host.name === request.name)) {
    return {
      ok: false,
      reason: "duplicate",
      message: `"${request.name}" already exists in ${path}. Rename the devbox or edit the file yourself.`,
    };
  }

  const lines = [
    "",
    `# Added by OpenUI Desktop on ${new Date().toISOString().slice(0, 10)}`,
    `Host ${request.name}`,
    `  HostName ${request.hostName.trim()}`,
  ];
  if (request.user) lines.push(`  User ${request.user}`);
  if (request.port && request.port !== 22) lines.push(`  Port ${request.port}`);
  if (request.identityFile) lines.push(`  IdentityFile ${request.identityFile}`);
  // The team's devbox hosts all carry keepalives; a box that drops a long
  // agent session mid-run is the failure this avoids.
  lines.push("  ServerAliveInterval 30", "  ServerAliveCountMax 6", "");

  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let backupPath: string | null = null;
    if (existsSync(path)) {
      backupPath = `${path}.openui-backup-${Date.now()}`;
      copyFileSync(path, backupPath);
    }
    appendFileSync(path, lines.join("\n"), { mode: 0o600 });
    return { ok: true, backupPath };
  } catch (error: any) {
    return { ok: false, reason: "write-failed", message: error?.message || "Could not write ~/.ssh/config" };
  }
}
