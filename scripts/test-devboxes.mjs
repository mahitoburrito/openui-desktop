#!/usr/bin/env node
// Behaviour tests for ssh_config parsing, safe appends, and devbox command building.

import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const { parseSshConfig, appendSshConfigHost, readSshConfigHosts } = await import(
  join(here, "..", "dist", "electron", "server", "services", "sshConfig.js")
);
const { buildSshTarget, buildDevboxLaunchCommand } = await import(
  join(here, "..", "dist", "electron", "server", "services", "devboxes.js")
);

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`         actual   ${JSON.stringify(actual)}`);
    console.log(`         expected ${JSON.stringify(expected)}`);
  }
}

console.log("\nssh_config parsing");

check(
  "a plain host block",
  parseSshConfig("Host gpu\n  HostName 10.0.0.5\n  User ubuntu\n  Port 2222\n"),
  [{ name: "gpu", hostName: "10.0.0.5", user: "ubuntu", port: 2222 }],
);

check(
  "one Host line declaring several aliases shares the block",
  parseSshConfig("Host a b\n  HostName box\n  User me\n").map((h) => `${h.name}:${h.hostName}:${h.user}`),
  ["a:box:me", "b:box:me"],
);

check(
  "glob patterns are not connectable hosts",
  parseSshConfig("Host ashby cedar s275-? hive?? *.lab !no\n  HostName x\n").map((h) => h.name),
  ["ashby", "cedar"],
);

check(
  "keyword=value form",
  parseSshConfig("Host k\n  HostName=1.2.3.4\n  Port=99\n"),
  [{ name: "k", hostName: "1.2.3.4", port: 99 }],
);

check(
  "comments, blank lines and unknown keywords are ignored",
  parseSshConfig("# lead\n\nHost c\n  ForwardAgent yes\n  HostName h\n  ProxyCommand none\n"),
  [{ name: "c", hostName: "h" }],
);

check(
  "an out-of-range port is dropped rather than trusted",
  parseSshConfig("Host p\n  HostName h\n  Port 70000\n"),
  [{ name: "p", hostName: "h" }],
);

check("settings before any Host line are ignored", parseSshConfig("User nobody\nPort 22\n"), []);

check("a missing file reads as no hosts", readSshConfigHosts(join(tmpdir(), "definitely-absent-config")), []);

console.log("\nappending to ssh config");

const dir = mkdtempSync(join(tmpdir(), "openui-sshconfig-"));
const configPath = join(dir, "config");
const original = "Host existing\n  HostName 1.1.1.1\n";
writeFileSync(configPath, original);

const added = appendSshConfigHost(
  { name: "gpu-box", hostName: "10.0.0.9", user: "ubuntu", port: 2200, identityFile: "~/.ssh/id_ed25519" },
  configPath,
);
check("a new host is appended", added.ok, true);
check(
  "the appended host parses back with its settings",
  readSshConfigHosts(configPath).find((h) => h.name === "gpu-box"),
  { name: "gpu-box", hostName: "10.0.0.9", user: "ubuntu", port: 2200, identityFile: "~/.ssh/id_ed25519" },
);
check(
  "existing blocks are left byte-identical",
  readFileSync(configPath, "utf-8").startsWith(original),
  true,
);
check("keepalives ride along", readFileSync(configPath, "utf-8").includes("ServerAliveInterval 30"), true);
check("a backup was taken", readdirSync(dir).some((f) => f.includes("openui-backup")), true);

const duplicate = appendSshConfigHost({ name: "existing", hostName: "2.2.2.2" }, configPath);
check("a duplicate alias is refused, not shadowed", [duplicate.ok, duplicate.reason], [false, "duplicate"]);

const spaced = appendSshConfigHost({ name: "bad name", hostName: "h" }, configPath);
check("an alias with spaces is refused", [spaced.ok, spaced.reason], [false, "invalid"]);

const globbed = appendSshConfigHost({ name: "gpu*", hostName: "h" }, configPath);
check("a globbed alias is refused", [globbed.ok, globbed.reason], [false, "invalid"]);

console.log("\nssh targets");

check(
  "an ssh-config box is addressed by alias alone, so the user's own settings apply",
  buildSshTarget({ id: "1", name: "dev", source: "ssh-config", inSshConfig: true }),
  ["dev"],
);
check(
  "a manual box builds explicit arguments",
  buildSshTarget({
    id: "2", name: "gpu", source: "manual", inSshConfig: false,
    host: "10.0.0.5", user: "ubuntu", port: 2222, identityFile: "/k/id",
  }),
  ["-p", "2222", "-i", "/k/id", "ubuntu@10.0.0.5"],
);
check(
  "port 22 and a missing user are left off",
  buildSshTarget({ id: "3", name: "g", source: "manual", inSshConfig: false, host: "h", port: 22 }),
  ["h"],
);

console.log("\nlaunch commands");

const alias = { id: "1", name: "dev", source: "ssh-config", inSshConfig: true };

check(
  "the agent runs under exec so quitting it ends the session",
  buildDevboxLaunchCommand(alias, "claude --yolo", "/home/ubuntu/repo"),
  "ssh 'dev' -t 'cd '\\''/home/ubuntu/repo'\\'' && exec claude --yolo'",
);
check(
  "no remote path means no cd",
  buildDevboxLaunchCommand(alias, "claude"),
  "ssh 'dev' -t 'exec claude'",
);
check(
  "no agent falls back to a login shell",
  buildDevboxLaunchCommand(alias, "", "/srv"),
  "ssh 'dev' -t 'cd '\\''/srv'\\'' && exec $SHELL -l'",
);
check(
  "a defaultPath is used when no path is passed",
  buildDevboxLaunchCommand({ ...alias, defaultPath: "/opt/work" }, "codex"),
  "ssh 'dev' -t 'cd '\\''/opt/work'\\'' && exec codex'",
);
check(
  "a quote in the remote path cannot break out of the command",
  buildDevboxLaunchCommand(alias, "claude", "/tmp/it's here; rm -rf /"),
  "ssh 'dev' -t 'cd '\\''/tmp/it'\\''\\'\\'''\\''s here; rm -rf /'\\'' && exec claude'",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
