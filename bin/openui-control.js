#!/usr/bin/env node

"use strict";

const { randomBytes } = require("crypto");
const { lstatSync, readFileSync, readdirSync, rmSync, statSync } = require("fs");
const { connect } = require("net");
const { homedir } = require("os");
const { basename, dirname, isAbsolute, join, resolve } = require("path");

const PROTOCOL_VERSION = 1;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

class ControlCliError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new ControlCliError(code, message, details);
}

function controlDirectory(override) {
  const configured = override || process.env.OPENUI_CONTROL_DIR;
  if (configured) {
    if (!isAbsolute(configured)) fail("transport_unavailable", "The control directory must be absolute");
    return resolve(configured);
  }
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime && isAbsolute(runtime)) return join(resolve(runtime), "openui", "local-control");
  return join(homedir(), ".openui", "local-control");
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function assertOwnerOnly(info, label) {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    fail("transport_unavailable", `${label} is not owned by the current user`);
  }
  if ((info.mode & 0o077) !== 0) fail("transport_unavailable", `${label} is not owner-only`);
}

function secureControlDirectory(path) {
  let info;
  try { info = lstatSync(path); } catch { fail("no_instance", "No running OpenUI control instance was found"); }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail("transport_unavailable", "The control directory is not a real directory");
  }
  assertOwnerOnly(info, "The control directory");
}

function removeStaleRecord(directory, recordPath, record) {
  const expected = join(directory, `${record.instanceId}.sock`);
  if (record.socketPath !== expected || dirname(record.socketPath) !== directory) return;
  try { rmSync(recordPath, { force: true }); } catch {}
  try { rmSync(expected, { force: true }); } catch {}
}

function readRecords(directory) {
  secureControlDirectory(directory);
  const records = [];
  let names;
  try { names = readdirSync(directory).slice(0, 256); } catch { return records; }
  for (const name of names) {
    if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
    const recordPath = join(directory, name);
    let info;
    let record;
    try {
      info = lstatSync(recordPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) continue;
      assertOwnerOnly(info, "A discovery record");
      record = JSON.parse(readFileSync(recordPath, "utf8"));
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    if (record.protocolVersion !== PROTOCOL_VERSION) continue;
    if (typeof record.instanceId !== "string" || !/^[a-f0-9]{32}$/.test(record.instanceId)) continue;
    if (name !== `${record.instanceId}.json`) continue;
    const expectedSocket = join(directory, `${record.instanceId}.sock`);
    if (record.socketPath !== expectedSocket || dirname(record.socketPath) !== directory) continue;
    if (!Number.isSafeInteger(record.pid) || record.pid < 1) continue;
    if (typeof record.channel !== "string" || typeof record.version !== "string") continue;
    if (!processIsAlive(record.pid)) {
      removeStaleRecord(directory, recordPath, record);
      continue;
    }
    records.push({ ...record, recordPath });
  }
  return records;
}

function validateSocket(record) {
  let info;
  try { info = lstatSync(record.socketPath); } catch { fail("transport_unavailable", "The instance socket is unavailable"); }
  if (!info.isSocket() || info.isSymbolicLink()) fail("transport_unavailable", "The instance socket is invalid");
  assertOwnerOnly(info, "The instance socket");
}

function request(record, action, params = {}, timeoutMs = 2000) {
  validateSocket(record);
  const requestId = `cli-${randomBytes(12).toString("hex")}`;
  const payload = `${JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    action: { name: action, params },
  })}\n`;
  if (Buffer.byteLength(payload) > MAX_MESSAGE_BYTES) fail("invalid_request", "The request is too large");

  return new Promise((resolveRequest, rejectRequest) => {
    const socket = connect(record.socketPath);
    let settled = false;
    let response = "";
    const timer = setTimeout(() => finish(new ControlCliError("transport_unavailable", "The control request timed out")), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectRequest(error);
      else resolveRequest(value);
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_MESSAGE_BYTES) {
        finish(new ControlCliError("transport_unavailable", "The control response is too large"));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      let envelope;
      try { envelope = JSON.parse(response.slice(0, newline)); } catch {
        finish(new ControlCliError("transport_unavailable", "The control response is invalid"));
        return;
      }
      if (envelope.protocolVersion !== PROTOCOL_VERSION || envelope.requestId !== requestId) {
        finish(new ControlCliError("transport_unavailable", "The control response does not match the request"));
        return;
      }
      if (envelope.response && envelope.response.status === "ok") {
        finish(null, envelope.response.data);
        return;
      }
      const error = envelope.response && envelope.response.error;
      finish(new ControlCliError(
        error && typeof error.code === "string" ? error.code : "internal",
        error && typeof error.message === "string" ? error.message : "The control request failed",
        error && error.details,
      ));
    });
    socket.once("error", () => finish(new ControlCliError("transport_unavailable", "The instance socket is unavailable")));
    socket.once("end", () => {
      if (!settled) finish(new ControlCliError("transport_unavailable", "The instance closed without a response"));
    });
  });
}

async function reachableRecords(options) {
  const channel = process.env.OPENUI_CHANNEL || "local";
  const candidates = readRecords(options.controlDir).filter((record) => record.channel === channel);
  const checked = await Promise.all(candidates.map(async (record) => {
    try {
      const pong = await request(record, "app.ping", {}, 800);
      return pong && pong.instanceId === record.instanceId ? record : null;
    } catch {
      return null;
    }
  }));
  return checked.filter(Boolean).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function parseArgs(argv) {
  const options = { json: false, instance: undefined, pid: undefined, controlDir: undefined };
  const args = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--json") options.json = true;
    else if (value === "--instance") {
      if (index + 1 >= argv.length) fail("invalid_selector", "--instance requires an exact instance ID");
      options.instance = argv[++index];
    } else if (value === "--pid") {
      if (index + 1 >= argv.length) fail("invalid_selector", "--pid requires a process ID");
      options.pid = Number(argv[++index]);
    } else if (value === "--control-dir") {
      if (index + 1 >= argv.length) fail("invalid_params", "--control-dir requires an absolute path");
      options.controlDir = argv[++index];
    }
    else args.push(value);
  }
  if (options.instance !== undefined && (!SAFE_ID.test(options.instance) || options.instance.length > 128)) {
    fail("invalid_selector", "--instance must be an exact instance ID");
  }
  if (options.pid !== undefined && (!Number.isSafeInteger(options.pid) || options.pid < 1)) {
    fail("invalid_selector", "--pid must be a positive process ID");
  }
  if (options.instance && options.pid) fail("invalid_selector", "Use either --instance or --pid, not both");
  options.controlDir = controlDirectory(options.controlDir);
  return { options, args };
}

function selectRecord(records, options) {
  if (options.instance) {
    const match = records.find((record) => record.instanceId === options.instance);
    if (!match) fail("no_instance", "The requested OpenUI instance is not reachable", { instanceId: options.instance });
    return match;
  }
  if (options.pid) {
    const match = records.find((record) => record.pid === options.pid);
    if (!match) fail("no_instance", "The requested OpenUI process is not reachable", { pid: options.pid });
    return match;
  }
  if (records.length === 0) fail("no_instance", "No running OpenUI control instance was found");
  if (records.length > 1) {
    fail("ambiguous_instance", "Multiple OpenUI instances are running; use --instance or --pid", {
      instances: records.map((record) => ({ instanceId: record.instanceId, pid: record.pid })),
    });
  }
  return records[0];
}

function parseSessionCreate(args) {
  const params = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--cwd") params.cwd = args[++index];
    else if (args[index] === "--name") params.title = args[++index];
    else fail("invalid_params", `Unknown session create option: ${args[index]}`);
  }
  if (params.cwd === undefined && args.includes("--cwd")) fail("invalid_params", "--cwd requires a path");
  if (params.title === undefined && args.includes("--name")) fail("invalid_params", "--name requires a title");
  return params;
}

function parseSessionList(args) {
  const params = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--limit") {
      if (index + 1 >= args.length) fail("invalid_params", "--limit requires a number");
      params.limit = Number(args[++index]);
    } else if (args[index] === "--after") {
      if (index + 1 >= args.length) fail("invalid_params", "--after requires a session ID");
      params.afterSessionId = args[++index];
    } else {
      fail("invalid_params", `Unknown session list option: ${args[index]}`);
    }
  }
  return params;
}

function parseCommandOptions(args, allowed) {
  const optionMap = {
    "--tab": "tabId",
    "--session": "sessionId",
    "--direction": "direction",
    "--amount": "amount",
    "--cwd": "cwd",
    "--name": "title",
    "--mode": "mode",
  };
  const params = {};
  const positionals = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = optionMap[value];
    if (!key || !allowed.includes(key)) fail("invalid_params", `Unknown option: ${value}`);
    if (index + 1 >= args.length) fail("invalid_params", `${value} requires a value`);
    params[key] = key === "amount" ? Number(args[++index]) : args[++index];
  }
  return { params, positionals };
}

function noPositionals(positionals, command) {
  if (positionals.length > 0) fail("invalid_params", `${command} does not accept positional arguments`);
}

function positionalValue(params, positionals, key, label) {
  if (params[key] !== undefined && positionals.length > 0) {
    fail("invalid_params", `${label} may be provided once`);
  }
  if (positionals.length > 1) fail("invalid_params", `${label} requires exactly one value`);
  const value = params[key] === undefined ? positionals[0] : params[key];
  if (value === undefined) fail("invalid_params", `${label} is required`);
  params[key] = value;
  return params;
}

function usage() {
  return `OpenUI local control

Usage:
  openui-control instance list [--json]
  openui-control instance inspect [--instance ID|--pid PID] [--json]
  openui-control app ping|version|active [--instance ID|--pid PID] [--json]
  openui-control capability list|inspect [ACTION] [--instance ID|--pid PID] [--json]
  openui-control action list|inspect [ACTION] [--instance ID|--pid PID] [--json]
  openui-control tab list|inspect [--tab TAB_ID] [--json]
  openui-control tab create [--cwd PATH] [--name TITLE] [--json]
  openui-control tab activate [--tab TAB_ID|--mode previous|next|last] [--json]
  openui-control tab move left|right [--tab TAB_ID] [--json]
  openui-control tab close|reset-name [--tab TAB_ID] [--json]
  openui-control tab rename TITLE [--tab TAB_ID] [--json]
  openui-control pane list [--tab TAB_ID] [--json]
  openui-control pane inspect|focus|maximize|unmaximize|close [--session SESSION_ID] [--json]
  openui-control pane split left|right|up|down [--session SESSION_ID] [--cwd PATH] [--name TITLE] [--json]
  openui-control pane navigate left|right|up|down [--session SESSION_ID] [--json]
  openui-control pane resize left|right|up|down [--amount N] [--session SESSION_ID] [--json]
  openui-control pane rename TITLE [--session SESSION_ID] [--json]
  openui-control pane reset-name [--session SESSION_ID] [--json]
  openui-control session list [--limit N] [--after SESSION_ID] [--instance ID|--pid PID] [--json]
  openui-control session inspect SESSION_ID [--instance ID|--pid PID] [--json]
  openui-control session create [--cwd PATH] [--name TITLE] [--instance ID|--pid PID] [--json]
  openui-control session activate SESSION_ID [--instance ID|--pid PID] [--json]
  openui-control session reopen-closed [--instance ID|--pid PID] [--json]
`;
}

function humanOutput(action, data) {
  if (action === "instance.list") {
    if (data.instances.length === 0) return "No running OpenUI instances.";
    return data.instances.map((item) => `${item.instanceId}  pid=${item.pid}  ${item.version}  ${item.startedAt}`).join("\n");
  }
  if (action === "app.ping") return `OpenUI ${data.instanceId} is reachable (pid ${data.pid}).`;
  if (action === "app.version") return `OpenUI ${data.version} (${data.channel}), control protocol ${data.protocolVersion}.`;
  if (action === "app.active") {
    return data.sessionId
      ? `${data.sessionId}\ttab=${data.tabId}\tpane=${data.paneId}`
      : "OpenUI has no active terminal session.";
  }
  if (action === "capability.list" || action === "action.list") {
    return data.actions.map((item) => `${item.name}\t${item.status}\t${item.scope}`).join("\n");
  }
  if (action === "capability.inspect" || action === "action.inspect") {
    const item = data.action;
    return `${item.name}\t${item.status}\t${item.scope}\t${item.parameterSpec}\t${item.resultSpec}`;
  }
  if (action === "tab.list") {
    if (data.tabs.length === 0) return "No OpenUI terminal tabs.";
    return data.tabs.map((item) =>
      `${item.tabId}\t${item.active ? "active" : "inactive"}\t${item.title || ""}\tpanes=${item.paneCount}`
    ).join("\n");
  }
  if (action === "tab.inspect") {
    const item = data.tab;
    return `${item.tabId}\t${item.active ? "active" : "inactive"}\t${item.title || ""}\tpanes=${item.paneCount}`;
  }
  if (action === "pane.list") {
    if (data.panes.length === 0) return "No OpenUI terminal panes.";
    return data.panes.map((item) =>
      `${item.sessionId}\t${item.active ? "active" : "inactive"}\t${item.session.title}\t${item.session.cwd}`
    ).join("\n");
  }
  if (action === "pane.inspect") {
    const item = data.pane;
    return `${item.sessionId}\t${item.active ? "active" : "inactive"}\t${item.session.title}\t${item.session.cwd}`;
  }
  if (action === "session.list") {
    if (data.sessions.length === 0) return "No OpenUI sessions.";
    return data.sessions.map((item) => `${item.sessionId}\t${item.status}\t${item.title}\t${item.cwd}`).join("\n");
  }
  if (action === "session.inspect" || action === "session.create") {
    const item = data.session;
    return `${item.sessionId}\t${item.status}\t${item.title}\t${item.cwd}`;
  }
  if (data && data.acknowledged) {
    return `${action} acknowledged${data.sessionId ? ` (${data.sessionId})` : ""}.`;
  }
  return JSON.stringify(data, null, 2);
}

async function run(argv) {
  if (process.platform === "win32") {
    fail("transport_unavailable", "OpenUI local control requires an owner-only Unix socket on this build");
  }
  const { options, args } = parseArgs(argv);
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    process.stdout.write(usage());
    return;
  }
  const records = await reachableRecords(options);
  let action;
  let data;
  if (args[0] === "instance" && args[1] === "list" && args.length === 2) {
    action = "instance.list";
    data = {
      instances: records.map(({ recordPath, socketPath, ...record }) => record),
    };
  } else {
    const record = selectRecord(records, options);
    let params = {};
    if (args[0] === "instance" && args[1] === "inspect" && args.length === 2) action = "instance.inspect";
    else if (args[0] === "app" && args[1] === "ping" && args.length === 2) action = "app.ping";
    else if (args[0] === "app" && args[1] === "version" && args.length === 2) action = "app.version";
    else if (args[0] === "app" && args[1] === "active" && args.length === 2) action = "app.active";
    else if (args[0] === "capability" && args[1] === "list" && args.length === 2) action = "capability.list";
    else if (args[0] === "capability" && args[1] === "inspect" && args.length === 3) {
      action = "capability.inspect";
      params = { name: args[2] };
    }
    else if (args[0] === "action" && args[1] === "list" && args.length === 2) action = "action.list";
    else if (args[0] === "action" && args[1] === "inspect" && args.length === 3) {
      action = "action.inspect";
      params = { name: args[2] };
    }
    else if (args[0] === "tab" && args[1] === "list") {
      action = "tab.list";
      const parsed = parseCommandOptions(args.slice(2), []);
      noPositionals(parsed.positionals, "tab list");
    }
    else if (args[0] === "tab" && args[1] === "inspect") {
      action = "tab.inspect";
      const parsed = parseCommandOptions(args.slice(2), ["tabId"]);
      noPositionals(parsed.positionals, "tab inspect");
      params = parsed.params;
    }
    else if (args[0] === "tab" && args[1] === "create") {
      action = "tab.create";
      const parsed = parseCommandOptions(args.slice(2), ["cwd", "title"]);
      noPositionals(parsed.positionals, "tab create");
      params = parsed.params;
    }
    else if (args[0] === "tab" && args[1] === "activate") {
      action = "tab.activate";
      const parsed = parseCommandOptions(args.slice(2), ["tabId", "mode"]);
      noPositionals(parsed.positionals, "tab activate");
      params = parsed.params;
    }
    else if (args[0] === "tab" && args[1] === "move") {
      action = "tab.move";
      const parsed = parseCommandOptions(args.slice(2), ["tabId", "direction"]);
      params = positionalValue(parsed.params, parsed.positionals, "direction", "tab move direction");
    }
    else if (args[0] === "tab" && args[1] === "close") {
      action = "tab.close";
      const parsed = parseCommandOptions(args.slice(2), ["tabId"]);
      noPositionals(parsed.positionals, "tab close");
      params = parsed.params;
    }
    else if (args[0] === "tab" && args[1] === "rename") {
      action = "tab.rename";
      const parsed = parseCommandOptions(args.slice(2), ["tabId"]);
      params = positionalValue(parsed.params, parsed.positionals, "title", "tab title");
    }
    else if (args[0] === "tab" && args[1] === "reset-name") {
      action = "tab.reset_name";
      const parsed = parseCommandOptions(args.slice(2), ["tabId"]);
      noPositionals(parsed.positionals, "tab reset-name");
      params = parsed.params;
    }
    else if (args[0] === "pane" && args[1] === "list") {
      action = "pane.list";
      const parsed = parseCommandOptions(args.slice(2), ["tabId"]);
      noPositionals(parsed.positionals, "pane list");
      params = parsed.params;
    }
    else if (args[0] === "pane" && ["inspect", "focus", "maximize", "unmaximize", "close"].includes(args[1])) {
      const actionByCommand = {
        inspect: "pane.inspect",
        focus: "pane.focus",
        maximize: "pane.maximize",
        unmaximize: "pane.unmaximize",
        close: "pane.close",
      };
      action = actionByCommand[args[1]];
      const parsed = parseCommandOptions(args.slice(2), ["sessionId"]);
      noPositionals(parsed.positionals, `pane ${args[1]}`);
      params = parsed.params;
    }
    else if (args[0] === "pane" && args[1] === "split") {
      action = "pane.split";
      const parsed = parseCommandOptions(args.slice(2), ["sessionId", "direction", "cwd", "title"]);
      params = positionalValue(parsed.params, parsed.positionals, "direction", "pane split direction");
    }
    else if (args[0] === "pane" && args[1] === "navigate") {
      action = "pane.navigate";
      const parsed = parseCommandOptions(args.slice(2), ["sessionId", "direction"]);
      params = positionalValue(parsed.params, parsed.positionals, "direction", "pane navigation direction");
    }
    else if (args[0] === "pane" && args[1] === "resize") {
      action = "pane.resize";
      const parsed = parseCommandOptions(args.slice(2), ["sessionId", "direction", "amount"]);
      params = positionalValue(parsed.params, parsed.positionals, "direction", "pane resize direction");
    }
    else if (args[0] === "pane" && args[1] === "rename") {
      action = "pane.rename";
      const parsed = parseCommandOptions(args.slice(2), ["sessionId"]);
      params = positionalValue(parsed.params, parsed.positionals, "title", "pane title");
    }
    else if (args[0] === "pane" && args[1] === "reset-name") {
      action = "pane.reset_name";
      const parsed = parseCommandOptions(args.slice(2), ["sessionId"]);
      noPositionals(parsed.positionals, "pane reset-name");
      params = parsed.params;
    }
    else if (args[0] === "session" && args[1] === "list") {
      action = "session.list";
      params = parseSessionList(args.slice(2));
    }
    else if (args[0] === "session" && args[1] === "inspect" && args.length === 3) {
      action = "session.inspect";
      params = { sessionId: args[2] };
    } else if (args[0] === "session" && args[1] === "create") {
      action = "session.create";
      params = parseSessionCreate(args.slice(2));
    } else if (args[0] === "session" && args[1] === "activate" && args.length === 3) {
      action = "session.activate";
      params = { sessionId: args[2] };
    } else if (args[0] === "session" && args[1] === "reopen-closed" && args.length === 2) {
      action = "session.reopen_closed";
    } else {
      fail("invalid_request", `Unknown command: ${args.join(" ")}`);
    }
    data = await request(record, action, params);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, action, data })}\n`);
  } else {
    process.stdout.write(`${humanOutput(action, data)}\n`);
  }
}

let jsonRequested = process.argv.includes("--json");
run(process.argv.slice(2)).catch((error) => {
  const known = error instanceof ControlCliError
    ? error
    : new ControlCliError("internal", "OpenUI local control failed");
  if (jsonRequested) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: { code: known.code, message: known.message, details: known.details },
    })}\n`);
  } else {
    process.stderr.write(`openui-control: ${known.message} (${known.code})\n`);
  }
  process.exitCode = 1;
});
