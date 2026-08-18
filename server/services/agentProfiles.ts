import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type {
  AgentProfile,
  AgentProfileConfig,
  AgentProfileReference,
  AgentProfileVersion,
} from "../types";
import { getDataDir } from "./persistence";
import { redactTerminalText } from "./terminalRedaction";

const MAX_PROFILES = 100;
const MAX_VERSIONS = 100;

export class AgentProfileError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set<string>(
    value.map((item: unknown): string => text(item, maxLength)).filter(Boolean),
  )].slice(0, maxItems);
}

function assertNoLiteralSecrets(value: string | undefined, label: string) {
  if (!value) return;
  if (redactTerminalText(value).sensitive) {
    throw new AgentProfileError(`${label} contains a literal secret; reference an environment variable instead`);
  }
}

function validateConfig(raw: any, rejectLiteralSecrets = true): AgentProfileConfig {
  const name = text(raw?.name, 120);
  const command = text(raw?.command, 12_000);
  if (!name) throw new AgentProfileError("Agent profile name is required");
  if (!command) throw new AgentProfileError("Agent profile command is required");
  if (rejectLiteralSecrets) assertNoLiteralSecrets(command, "Agent profile command");

  const rawServers = Array.isArray(raw?.mcpServers) ? raw.mcpServers : [];
  if (rawServers.length > 20) throw new AgentProfileError("Agent profiles support at most 20 MCP servers");
  const serverNames = new Set<string>();
  const mcpServers = rawServers.map((server: any) => {
    const serverName = text(server?.name, 80);
    const url = text(server?.url, 2000) || undefined;
    const serverCommand = text(server?.command, 4000) || undefined;
    if (!serverName || (!url && !serverCommand) || (url && serverCommand)) {
      throw new AgentProfileError("Each MCP server needs a unique name and exactly one of url or command");
    }
    if (serverName.toLowerCase() === "workspace") {
      throw new AgentProfileError("MCP server name workspace is reserved");
    }
    if (url) {
      try {
        const parsed = new URL(url);
        if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
          throw new Error("unsafe URL");
        }
      } catch {
        throw new AgentProfileError(`MCP server ${serverName} requires an HTTP(S) URL without embedded credentials`);
      }
    }
    if (rejectLiteralSecrets) {
      assertNoLiteralSecrets(url, `MCP server ${serverName} URL`);
      assertNoLiteralSecrets(serverCommand, `MCP server ${serverName} command`);
    }
    if (serverNames.has(serverName)) throw new AgentProfileError(`Duplicate MCP server: ${serverName}`);
    serverNames.add(serverName);
    return { name: serverName, url, command: serverCommand };
  });

  const metadataEntries = raw?.metadata && typeof raw.metadata === "object"
    ? Object.entries(raw.metadata).slice(0, 50)
    : [];
  const metadata = Object.fromEntries(metadataEntries.map(([key, value]) => [
    text(key, 80),
    text(String(value), 500),
  ]).filter(([key]) => Boolean(key)));
  const fallbackCommands = stringList(raw?.fallbackCommands, 8, 4000).filter((item) => item !== command);
  if (rejectLiteralSecrets) {
    fallbackCommands.forEach((fallback, index) => (
      assertNoLiteralSecrets(fallback, `Fallback command ${index + 1}`)
    ));
  }

  return {
    name,
    description: text(raw?.description, 2000),
    command,
    initialPrompt: text(raw?.initialPrompt, 12_000) || undefined,
    color: text(raw?.color, 80) || "#7A9DFF",
    icon: text(raw?.icon, 80) || "terminal",
    model: text(raw?.model, 200) || undefined,
    systemPrompt: text(raw?.systemPrompt, 100_000) || undefined,
    tools: stringList(raw?.tools, 128, 200),
    mcpServers,
    skills: stringList(raw?.skills, 20, 300),
    fallbackCommands,
    permissionPolicy:
      raw?.permissionPolicy === "allow-edits" || raw?.permissionPolicy === "read-only"
        ? raw.permissionPolicy
        : "ask",
    metadata,
  };
}

class AgentProfileStore {
  private profiles: AgentProfile[] | undefined;
  private statePath = "";

  list(includeArchived = false): AgentProfile[] {
    return clone(this.load().filter((profile) => includeArchived || !profile.archivedAt));
  }

  get(id: string): AgentProfile {
    const profile = this.load().find((item) => item.id === id);
    if (!profile) throw new AgentProfileError("Agent profile not found", 404);
    return clone(profile);
  }

  resolve(reference: AgentProfileReference, allowArchived = false): {
    profile: AgentProfile;
    version: AgentProfileVersion;
  } {
    const profile = this.load().find((item) => item.id === reference.id);
    if (!profile) throw new AgentProfileError("Agent profile not found", 404);
    if (profile.archivedAt && !allowArchived) {
      throw new AgentProfileError("Archived agent profiles cannot start new sessions", 409);
    }
    const versionNumber = reference.version ?? profile.latestVersion;
    const version = profile.versions.find((item) => item.version === versionNumber);
    if (!version) throw new AgentProfileError(`Agent profile version not found: ${versionNumber}`, 404);
    return { profile: clone(profile), version: clone(version) };
  }

  create(input: any): AgentProfile {
    const profiles = this.load();
    if (profiles.length >= MAX_PROFILES) throw new AgentProfileError("Agent profile limit reached", 409);
    const config = validateConfig(input);
    this.assertUniqueName(config.name);
    const now = Date.now();
    const profile: AgentProfile = {
      id: `agent-profile-${randomUUID()}`,
      latestVersion: 1,
      versions: [{
        version: 1,
        createdAt: now,
        config,
        changeNote: text(input?.changeNote, 500) || "Initial version",
      }],
      createdAt: now,
      updatedAt: now,
    };
    profiles.push(profile);
    this.save();
    return clone(profile);
  }

  update(id: string, input: any): AgentProfile {
    const profile = this.mutable(id);
    if (profile.archivedAt) throw new AgentProfileError("Archived agent profiles are read-only", 409);
    if (profile.versions.length >= MAX_VERSIONS) throw new AgentProfileError("Agent profile version limit reached", 409);
    const config = validateConfig(input);
    this.assertUniqueName(config.name, id);
    const version = profile.latestVersion + 1;
    profile.versions.push({
      version,
      createdAt: Date.now(),
      config,
      changeNote: text(input?.changeNote, 500) || undefined,
    });
    profile.latestVersion = version;
    profile.updatedAt = Date.now();
    this.save();
    return clone(profile);
  }

  promote(id: string, sourceVersion: number, changeNote?: string): AgentProfile {
    const profile = this.mutable(id);
    if (profile.archivedAt) throw new AgentProfileError("Archived agent profiles are read-only", 409);
    if (profile.versions.length >= MAX_VERSIONS) throw new AgentProfileError("Agent profile version limit reached", 409);
    const source = profile.versions.find((item) => item.version === sourceVersion);
    if (!source) throw new AgentProfileError(`Agent profile version not found: ${sourceVersion}`, 404);
    const version = profile.latestVersion + 1;
    profile.versions.push({
      version,
      createdAt: Date.now(),
      config: clone(source.config),
      changeNote: text(changeNote, 500) || `Promoted version ${sourceVersion}`,
      promotedFromVersion: sourceVersion,
    });
    profile.latestVersion = version;
    profile.updatedAt = Date.now();
    this.save();
    return clone(profile);
  }

  archive(id: string, confirmPermanent: boolean): AgentProfile {
    if (!confirmPermanent) {
      throw new AgentProfileError("Permanent archive requires confirmPermanent=true", 409);
    }
    const profile = this.mutable(id);
    if (profile.archivedAt) return clone(profile);
    profile.archivedAt = Date.now();
    profile.updatedAt = profile.archivedAt;
    this.save();
    return clone(profile);
  }

  private mutable(id: string): AgentProfile {
    const profile = this.load().find((item) => item.id === id);
    if (!profile) throw new AgentProfileError("Agent profile not found", 404);
    return profile;
  }

  private load(): AgentProfile[] {
    const path = join(getDataDir(), "agent-profiles.json");
    if (this.profiles && this.statePath === path) return this.profiles;
    this.statePath = path;
    this.profiles = [];
    try {
      if (!existsSync(path)) return this.profiles;
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(parsed)) return this.profiles;
      this.profiles = parsed.flatMap((raw: any): AgentProfile[] => {
        try {
          const id = text(raw?.id, 200);
          const versions: AgentProfileVersion[] = Array.isArray(raw?.versions)
            ? raw.versions.map((item: any): AgentProfileVersion => ({
                version: Number(item.version),
                createdAt: Number(item.createdAt),
                config: validateConfig(item.config, false),
                changeNote: text(item.changeNote, 500) || undefined,
                promotedFromVersion: Number.isSafeInteger(item.promotedFromVersion)
                  ? item.promotedFromVersion
                  : undefined,
              }))
            : [];
          if (!id || versions.length === 0 || versions.some((item) => !Number.isSafeInteger(item.version))) return [];
          const latestVersion = Math.max(...versions.map((item) => item.version));
          return [{
            id,
            latestVersion,
            versions,
            createdAt: Number(raw.createdAt) || versions[0].createdAt,
            updatedAt: Number(raw.updatedAt) || versions[versions.length - 1].createdAt,
            archivedAt: Number(raw.archivedAt) || undefined,
          }];
        } catch {
          return [];
        }
      });
    } catch (error) {
      console.error("Failed to load agent profiles:", error);
      this.profiles = [];
    }
    return this.profiles;
  }

  private save() {
    if (!this.profiles) return;
    mkdirSync(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.profiles, null, 2));
    renameSync(temporary, this.statePath);
  }

  private assertUniqueName(name: string, exceptId?: string) {
    if (this.load().some((profile) => {
      if (profile.id === exceptId) return false;
      const latest = profile.versions.find((version) => version.version === profile.latestVersion);
      return latest?.config.name.toLowerCase() === name.toLowerCase();
    })) {
      throw new AgentProfileError(`Agent profile name already exists: ${name}`, 409);
    }
  }
}

export const agentProfiles = new AgentProfileStore();
