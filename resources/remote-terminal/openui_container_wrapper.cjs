#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const { constants: osConstants } = require("os");
const { accessSync, constants: fsConstants, lstatSync, readFileSync } = require("fs");
const { basename, isAbsolute, join, resolve } = require("path");

const MAX_ARGUMENTS = 512;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const MAX_INTEGRATION_BYTES = 32 * 1024;
const SUPPORTED_SHELLS = new Set(["bash", "zsh", "fish"]);

function optionSpec({ values = [], flags = [], shortValues = [], shortFlags = "" }) {
  return {
    values: new Set(values),
    flags: new Set(flags),
    shortValues: new Set(shortValues),
    shortFlags: new Set(shortFlags.split("")),
  };
}

const DOCKER_GLOBAL = optionSpec({
  values: ["--config", "--context", "--host", "--log-level", "--tlscacert", "--tlscert", "--tlskey"],
  flags: ["--debug", "--tls", "--tlsverify", "--help", "--version"],
  shortValues: ["c", "H", "l"],
  shortFlags: "D",
});

const DOCKER_EXEC = optionSpec({
  values: ["--detach-keys", "--env", "--env-file", "--user", "--workdir"],
  flags: ["--detach", "--interactive", "--privileged", "--tty"],
  shortValues: ["e", "u", "w"],
  shortFlags: "dit",
});

const DOCKER_RUN = optionSpec({
  values: [
    "--add-host", "--annotation", "--attach", "--blkio-weight", "--cap-add", "--cap-drop",
    "--cgroup-parent", "--cgroupns", "--cidfile", "--cpu-period", "--cpu-quota", "--cpu-rt-period",
    "--cpu-rt-runtime", "--cpu-shares", "--cpus", "--cpuset-cpus", "--cpuset-mems", "--device",
    "--device-cgroup-rule", "--device-read-bps", "--device-read-iops", "--device-write-bps",
    "--device-write-iops", "--dns", "--dns-option", "--dns-search", "--entrypoint", "--env",
    "--env-file", "--expose", "--gpus", "--group-add", "--health-cmd", "--health-interval",
    "--health-retries", "--health-start-interval", "--health-start-period", "--health-timeout",
    "--hostname", "--init-path", "--ip", "--ip6", "--ipc", "--isolation", "--kernel-memory",
    "--label", "--label-file", "--link", "--link-local-ip", "--log-driver", "--log-opt", "--mac-address",
    "--memory", "--memory-reservation", "--memory-swap", "--memory-swappiness", "--mount", "--name",
    "--network", "--network-alias", "--oom-score-adj", "--pid", "--pids-limit", "--platform", "--publish",
    "--pull", "--restart", "--runtime", "--security-opt", "--shm-size", "--stop-signal", "--stop-timeout",
    "--storage-opt", "--sysctl", "--tmpfs", "--ulimit", "--user", "--userns", "--uts", "--volume",
    "--volume-driver", "--volumes-from", "--workdir",
  ],
  flags: [
    "--detach", "--disable-content-trust", "--help", "--init", "--interactive", "--oom-kill-disable",
    "--privileged", "--publish-all", "--read-only", "--rm", "--sig-proxy", "--tty",
  ],
  shortValues: ["a", "e", "h", "l", "m", "p", "u", "v", "w"],
  shortFlags: "ditP",
});

const KUBECTL_GLOBAL = optionSpec({
  values: [
    "--as", "--as-group", "--as-uid", "--cache-dir", "--certificate-authority", "--client-certificate",
    "--client-key", "--cluster", "--context", "--kubeconfig", "--namespace", "--password", "--profile",
    "--profile-output", "--request-timeout", "--server", "--tls-server-name", "--token", "--user", "--username",
    "--vmodule",
  ],
  flags: [
    "--disable-compression", "--help", "--insecure-skip-tls-verify", "--match-server-version",
    "--warnings-as-errors",
  ],
  shortValues: ["n", "s", "v"],
  shortFlags: "",
});

const KUBECTL_EXEC = optionSpec({
  values: ["--container", "--filename", "--pod-running-timeout"],
  flags: ["--quiet", "--stdin", "--tty"],
  shortValues: ["c", "f"],
  shortFlags: "iqt",
});

function boundedArguments(args) {
  return Array.isArray(args) && args.length <= MAX_ARGUMENTS &&
    args.every((arg) => typeof arg === "string" && !arg.includes("\0")) &&
    args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0) <= MAX_ARGUMENT_BYTES;
}

function consumeOption(tokens, index, spec, state) {
  const token = tokens[index];
  if (!token || token === "--" || token === "-") return null;
  const mark = (name) => {
    if (name === "--interactive" || name === "--stdin" || name === "i") state.interactive = true;
    if (name === "--tty" || name === "t") state.tty = true;
  };

  if (token.startsWith("--")) {
    const equals = token.indexOf("=");
    const name = equals >= 0 ? token.slice(0, equals) : token;
    if (spec.values.has(name)) {
      if (equals >= 0) return index + 1;
      return index + 1 < tokens.length ? index + 2 : null;
    }
    if (!spec.flags.has(name) || equals >= 0) return null;
    mark(name);
    return index + 1;
  }

  if (!token.startsWith("-")) return null;
  const body = token.slice(1);
  if (!body) return null;
  for (let offset = 0; offset < body.length; offset++) {
    const name = body[offset];
    if (spec.shortValues.has(name)) {
      mark(name);
      return offset + 1 < body.length
        ? index + 1
        : (index + 1 < tokens.length ? index + 2 : null);
    }
    if (!spec.shortFlags.has(name)) return null;
    mark(name);
  }
  return index + 1;
}

function locateSubcommand(tokens, commands, spec) {
  const state = { interactive: false, tty: false };
  let index = 0;
  while (index < tokens.length) {
    if (commands.has(tokens[index])) return index;
    const next = consumeOption(tokens, index, spec, state);
    if (next === null) return null;
    index = next;
  }
  return null;
}

function operandAfterOptions(tokens, start, spec) {
  const state = { interactive: false, tty: false };
  let index = start;
  while (index < tokens.length) {
    if (tokens[index] === "--") {
      index++;
      return index < tokens.length ? { index, state } : null;
    }
    if (!tokens[index].startsWith("-") || tokens[index] === "-") return { index, state };
    const next = consumeOption(tokens, index, spec, state);
    if (next === null) return null;
    index = next;
  }
  return null;
}

function supportedShell(command) {
  if (!Array.isArray(command) || command.length !== 1) return null;
  const shell = basename(command[0]);
  return SUPPORTED_SHELLS.has(shell) ? shell : null;
}

function shellCommand(shellToken, shell, integrations) {
  const source = integrations?.[shell];
  if (typeof source !== "string" || !source || Buffer.byteLength(source, "utf8") > MAX_INTEGRATION_BYTES) {
    return null;
  }
  if (shell === "bash") {
    const rc = `[[ -r "$HOME/.bashrc" ]] && source "$HOME/.bashrc"\n${source}`;
    return [
      shellToken,
      "-c",
      'exec "$0" --noprofile --rcfile <(printf "%s" "$1") -i',
      shellToken,
      rc,
    ];
  }
  if (shell === "zsh") {
    const rc = `[[ -r "$HOME/.zshrc" ]] && source "$HOME/.zshrc"\n${source}`;
    return [
      shellToken,
      "-f",
      "-c",
      'd="${TMPDIR:-/tmp}/.openui-zsh-$$-$RANDOM"; umask 077; mkdir -p -- "$d" || exit 1; printf "%s" "$1" > "$d/.zshrc" || exit 1; ZDOTDIR="$d" "$0" -i; status=$?; rm -rf -- "$d"; exit "$status"',
      shellToken,
      rc,
    ];
  }
  return [shellToken, "--init-command", source];
}

function planDockerLike(tokens, integrations) {
  const subcommandIndex = locateSubcommand(tokens, new Set(["exec", "run"]), DOCKER_GLOBAL);
  if (subcommandIndex === null) return null;
  const subcommand = tokens[subcommandIndex];
  const operand = operandAfterOptions(
    tokens,
    subcommandIndex + 1,
    subcommand === "exec" ? DOCKER_EXEC : DOCKER_RUN,
  );
  if (!operand || !operand.state.interactive || !operand.state.tty) return null;
  const commandStart = operand.index + 1;
  if (commandStart >= tokens.length) return null;
  const shell = supportedShell(tokens.slice(commandStart));
  if (!shell) return null;
  const command = shellCommand(tokens[commandStart], shell, integrations);
  if (!command) return null;
  return { args: [...tokens.slice(0, commandStart), ...command], shell, subcommand };
}

function planKubectl(tokens, integrations) {
  const subcommandIndex = locateSubcommand(tokens, new Set(["exec"]), KUBECTL_GLOBAL);
  if (subcommandIndex === null) return null;
  const separator = tokens.indexOf("--", subcommandIndex + 1);
  if (separator < 0 || separator + 1 >= tokens.length) return null;
  const state = { interactive: false, tty: false };
  let operands = 0;
  let index = subcommandIndex + 1;
  while (index < separator) {
    if (!tokens[index].startsWith("-") || tokens[index] === "-") {
      operands++;
      index++;
      continue;
    }
    const next = consumeOption(tokens, index, KUBECTL_EXEC, state);
    if (next === null || next > separator) return null;
    index = next;
  }
  if (operands !== 1 || !state.interactive || !state.tty) return null;
  const shell = supportedShell(tokens.slice(separator + 1));
  if (!shell) return null;
  const command = shellCommand(tokens[separator + 1], shell, integrations);
  if (!command) return null;
  return { args: [...tokens.slice(0, separator + 1), ...command], shell, subcommand: "exec" };
}

function planContainerInvocation(tool, args, integrations) {
  if (!boundedArguments(args)) return { instrumented: false, args };
  const plan = tool === "docker" || tool === "podman"
    ? planDockerLike(args, integrations)
    : tool === "kubectl"
      ? planKubectl(args, integrations)
      : null;
  return plan
    ? { instrumented: true, ...plan }
    : { instrumented: false, args };
}

function readIntegrations(root) {
  const directory = resolve(root, "shell-integration");
  const integrations = {};
  for (const shell of SUPPORTED_SHELLS) {
    const path = join(directory, `openui.${shell === "bash" ? "bash" : shell}`);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_INTEGRATION_BYTES) {
      throw new Error(`Invalid ${shell} integration asset`);
    }
    integrations[shell] = readFileSync(path, "utf8");
  }
  return integrations;
}

function childEnvironment(environment) {
  const next = { ...environment };
  for (const key of Object.keys(next)) {
    if (
      key.startsWith("OPENUI_CONTAINER_") ||
      key === "OPENUI_REMOTE_CONTROL_TOKEN" ||
      key === "OPENUI_SSH_CONTROL_DIR" ||
      key === "OPENUI_SSH_REAL_EXECUTABLE" ||
      key === "OPENUI_SSH_WRAPPER" ||
      key === "OPENUI_REMOTE_ASSET_DIR" ||
      key === "OPENUI_NODE_RUNTIME"
    ) delete next[key];
  }
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

function validateExecutable(path) {
  if (!path || !isAbsolute(path)) throw new Error("Container executable must be absolute");
  accessSync(path, fsConstants.X_OK);
  const info = lstatSync(path);
  if (!info.isFile() && !info.isSymbolicLink()) throw new Error("Container executable is not a file");
  return path;
}

function main() {
  const tool = process.env.OPENUI_CONTAINER_TOOL;
  const executable = validateExecutable(process.env.OPENUI_CONTAINER_REAL_EXECUTABLE);
  const root = process.env.OPENUI_CONTAINER_ASSET_DIR;
  let plan = { instrumented: false, args: process.argv.slice(2) };
  try {
    plan = planContainerInvocation(tool, plan.args, readIntegrations(root));
  } catch {
    // Missing/corrupt assets must never block the user's original command.
  }

  const child = spawn(executable, plan.args, {
    stdio: "inherit",
    env: childEnvironment(process.env),
  });
  const forwarded = ["SIGHUP", "SIGINT", "SIGTERM"];
  const handlers = new Map();
  for (const signal of forwarded) {
    const handler = () => {
      try { child.kill(signal); } catch {}
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const cleanup = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  child.once("error", (error) => {
    cleanup();
    process.stderr.write(`openui-container: ${error.message}\n`);
    process.exitCode = error.code === "ENOENT" ? 127 : 126;
  });
  child.once("exit", (code, signal) => {
    cleanup();
    if (typeof code === "number") process.exitCode = code;
    else process.exitCode = 128 + (osConstants.signals[signal] || 0);
  });
}

module.exports = {
  childEnvironment,
  planContainerInvocation,
};

if (require.main === module) main();
