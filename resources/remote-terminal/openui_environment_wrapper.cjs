#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const { accessSync, constants: fsConstants, lstatSync, readFileSync } = require("fs");
const { constants: osConstants } = require("os");
const { basename, isAbsolute, join, resolve } = require("path");

const MAX_ARGUMENTS = 512;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_POLICY_PATTERNS = 64;
const MAX_POLICY_TOKENS = 31;
const MAX_POLICY_TOKEN_BYTES = 256;
const SUPPORTED_SHELLS = new Set(["bash", "zsh", "fish", "pwsh", "powershell"]);

function boundedArguments(args) {
  return Array.isArray(args) && args.length <= MAX_ARGUMENTS &&
    args.every((arg) => typeof arg === "string" && !arg.includes("\0")) &&
    args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0) <= MAX_ARGUMENT_BYTES;
}

function isEnvironmentSubshell(tool, args) {
  if (!boundedArguments(args)) return false;
  if (tool === "poetry" || tool === "pipenv") return args[0] === "shell";
  if (tool === "aws-vault") {
    if (args[0] !== "exec") return false;
    const separator = args.indexOf("--", 1);
    return separator < 0 || separator === args.length - 1;
  }
  if (tool !== "flox") return false;

  let index = 0;
  while (index < args.length && args[index].startsWith("-") && args[index] !== "-") index++;
  if (args[index] !== "activate") return false;
  const separator = args.indexOf("--", index + 1);
  return separator < 0 || separator === args.length - 1;
}

function validPolicyPattern(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    (value.match === "exact" || value.match === "prefix") &&
    Array.isArray(value.args) && value.args.length <= MAX_POLICY_TOKENS &&
    value.args.every((token) => typeof token === "string" && token.length > 0 &&
      !token.includes("\0") && Buffer.byteLength(token, "utf8") <= MAX_POLICY_TOKEN_BYTES &&
      (!token.includes("*") || token === "*"));
}

function loadSubshellPolicy(environment, tool) {
  const path = environment.OPENUI_SUBSHELL_POLICY_FILE;
  const directory = environment.OPENUI_SHELL_SHIM_DIR;
  if (!path || !directory || !isAbsolute(path) || !isAbsolute(directory)) return { added: [], denied: [] };
  try {
    privateOwnedPath(directory, "directory");
    if (resolve(path, "..") !== resolve(directory)) return { added: [], denied: [] };
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_POLICY_BYTES ||
        (info.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      return { added: [], denied: [] };
    }
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || parsed.version !== 1 || parsed.tool !== tool ||
        !Array.isArray(parsed.added) || !Array.isArray(parsed.denied) ||
        parsed.added.length + parsed.denied.length > MAX_POLICY_PATTERNS ||
        !parsed.added.every(validPolicyPattern) || !parsed.denied.every(validPolicyPattern)) {
      return { added: [], denied: [] };
    }
    return { added: parsed.added, denied: parsed.denied };
  } catch {
    return { added: [], denied: [] };
  }
}

function matchesPolicyPattern(args, pattern) {
  if (pattern.match === "exact" ? args.length !== pattern.args.length : args.length < pattern.args.length) {
    return false;
  }
  return pattern.args.every((token, index) => token === "*" || token === args[index]);
}

function planEnvironmentSubshell(tool, args, policy = { added: [], denied: [] }) {
  const bounded = boundedArguments(args);
  const denied = bounded && policy.denied.some((pattern) => matchesPolicyPattern(args, pattern));
  const added = bounded && policy.added.some((pattern) => matchesPolicyPattern(args, pattern));
  return {
    instrumented: !denied && (isEnvironmentSubshell(tool, args) || added),
    args,
    tool,
  };
}

function privateOwnedPath(path, kind) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`${kind} cannot be a symbolic link`);
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) {
    throw new Error(`Invalid ${kind}`);
  }
  if ((info.mode & 0o077) !== 0) throw new Error(`${kind} must be owner-only`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${kind} must be owned by the current user`);
  }
  return path;
}

function selectShellShim(environment) {
  const directory = environment.OPENUI_SHELL_SHIM_DIR;
  if (!directory || !isAbsolute(directory)) return null;
  const shell = basename(environment.SHELL || "").toLowerCase();
  if (!SUPPORTED_SHELLS.has(shell)) return null;
  try {
    privateOwnedPath(directory, "directory");
    const candidate = join(directory, shell);
    if (resolve(candidate) !== candidate || resolve(candidate, "..") !== resolve(directory)) return null;
    privateOwnedPath(candidate, "file");
    accessSync(candidate, fsConstants.X_OK);
    return { shell, path: candidate };
  } catch {
    return null;
  }
}

function childEnvironment(environment, shellShim = null) {
  const next = { ...environment };
  for (const key of Object.keys(next)) {
    if (key.startsWith("OPENUI_SUBSHELL_")) delete next[key];
  }
  delete next.ELECTRON_RUN_AS_NODE;
  if (shellShim) next.SHELL = shellShim;
  return next;
}

function validateExecutable(path) {
  if (!path || !isAbsolute(path)) throw new Error("Subshell executable must be absolute");
  accessSync(path, fsConstants.X_OK);
  const info = lstatSync(path);
  if (!info.isFile() && !info.isSymbolicLink()) throw new Error("Subshell executable is not a file");
  return path;
}

function main() {
  const tool = process.env.OPENUI_SUBSHELL_TOOL;
  const executable = validateExecutable(process.env.OPENUI_SUBSHELL_REAL_EXECUTABLE);
  const args = process.argv.slice(2);
  const policy = loadSubshellPolicy(process.env, tool);
  const plan = planEnvironmentSubshell(tool, args, policy);
  const selected = plan.instrumented ? selectShellShim(process.env) : null;

  const child = spawn(executable, plan.args, {
    stdio: "inherit",
    env: childEnvironment(process.env, selected?.path || null),
  });
  const handlers = new Map();
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
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
    process.stderr.write(`openui-subshell: ${error.message}\n`);
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
  loadSubshellPolicy,
  planEnvironmentSubshell,
  selectShellShim,
};

if (require.main === module) main();
