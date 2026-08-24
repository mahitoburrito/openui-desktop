import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, win32 } from "path";
import { parseAllDocuments, stringify } from "yaml";
import type {
  TerminalAutomationState,
  TerminalLaunchConfiguration,
  TerminalLaunchSession,
  TerminalPaneLayout,
  TerminalWorkflow,
  TerminalWorkflowParameter,
} from "../types";
import { getDataDir } from "./persistence";

const STATE_VERSION = 1 as const;
const MAX_WORKFLOWS = 500;
const MAX_LAUNCH_CONFIGURATIONS = 100;
const MAX_WORKFLOW_COMMAND_LENGTH = 12_000;
const MAX_LAUNCH_SESSIONS = 32;
const MAX_YAML_CHARS = 1_000_000;
const PARAMETER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const WORKFLOW_SHELLS = new Set(["zsh", "bash", "fish", "powershell"] as const);

export class TerminalAutomationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function emptyState(): TerminalAutomationState {
  return { version: STATE_VERSION, workflows: [], launchConfigurations: [] };
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function absoluteOnAnyPlatform(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function validateWorkflowParameter(raw: any): TerminalWorkflowParameter {
  const name = cleanText(raw?.name, 80);
  if (!PARAMETER_NAME_RE.test(name)) {
    throw new TerminalAutomationError(`Invalid workflow parameter name: ${name || "(empty)"}`);
  }
  const options: string[] | undefined = Array.isArray(raw?.options)
    ? [...new Set<string>(raw.options.map((item: unknown): string => cleanText(item, 500)).filter(Boolean))].slice(0, 100)
    : undefined;
  const defaultValue = typeof raw?.defaultValue === "string"
    ? raw.defaultValue.slice(0, 4000)
    : undefined;
  const dynamicOptionsCommand = cleanText(raw?.dynamicOptionsCommand, 4000) || undefined;
  if (options?.length && dynamicOptionsCommand) {
    throw new TerminalAutomationError(`Parameter ${name} cannot have both static and dynamic options`);
  }
  if (options && defaultValue !== undefined && !options.includes(defaultValue)) {
    throw new TerminalAutomationError(`Default value for ${name} is not one of its options`);
  }
  return {
    name,
    description: cleanText(raw?.description, 500) || undefined,
    defaultValue,
    required: Boolean(raw?.required),
    options,
    dynamicOptionsCommand,
    sensitive: Boolean(raw?.sensitive),
    shellQuote: Boolean(raw?.shellQuote),
  };
}

function workflowPlaceholders(command: string): string[] {
  const names = new Set<string>();
  for (const match of command.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g)) {
    names.add(match[1]);
  }
  return [...names];
}

function validateWorkflowInput(
  raw: any,
  existing?: TerminalWorkflow,
  preserveTimestamps = false,
): TerminalWorkflow {
  const name = cleanText(raw?.name, 120);
  const command = typeof raw?.command === "string" ? raw.command.trim() : "";
  if (!name) throw new TerminalAutomationError("Workflow name is required");
  if (!command) throw new TerminalAutomationError("Workflow command is required");
  if (command.length > MAX_WORKFLOW_COMMAND_LENGTH) {
    throw new TerminalAutomationError(`Workflow command exceeds ${MAX_WORKFLOW_COMMAND_LENGTH} characters`);
  }
  const parameters = Array.isArray(raw?.parameters)
    ? raw.parameters.map(validateWorkflowParameter)
    : [];
  const names = new Set<string>();
  for (const parameter of parameters) {
    if (names.has(parameter.name)) {
      throw new TerminalAutomationError(`Duplicate workflow parameter: ${parameter.name}`);
    }
    names.add(parameter.name);
  }
  for (const placeholder of workflowPlaceholders(command)) {
    if (!names.has(placeholder)) {
      throw new TerminalAutomationError(`Workflow placeholder has no parameter definition: ${placeholder}`);
    }
  }
  const scope = raw?.scope === "workspace" ? "workspace" : "global";
  const workspacePath = cleanText(raw?.workspacePath, 2000) || undefined;
  if (scope === "workspace" && (!workspacePath || !absoluteOnAnyPlatform(workspacePath))) {
    throw new TerminalAutomationError("Workspace-scoped workflows require an absolute workspacePath");
  }
  const now = Date.now();
  const shells = Array.isArray(raw?.shells)
    ? [...new Set<string>(raw.shells.map((item: unknown) => cleanText(item, 30).toLowerCase()))]
        .filter((item): item is "zsh" | "bash" | "fish" | "powershell" => WORKFLOW_SHELLS.has(item as any))
    : undefined;
  return {
    id: existing?.id || `workflow-${randomUUID()}`,
    name,
    description: cleanText(raw?.description, 2000),
    command,
    parameters,
    tags: Array.isArray(raw?.tags)
      ? [...new Set<string>(raw.tags.map((item: unknown): string => cleanText(item, 60)).filter(Boolean))].slice(0, 20)
      : [],
    scope,
    workspacePath,
    shells: shells?.length ? shells : undefined,
    sourceUrl: cleanText(raw?.sourceUrl, 2000) || undefined,
    author: cleanText(raw?.author, 200) || undefined,
    authorUrl: cleanText(raw?.authorUrl, 2000) || undefined,
    createdAt: existing?.createdAt || now,
    updatedAt: preserveTimestamps && existing ? existing.updatedAt : now,
  };
}

function validatePaneLayout(
  raw: any,
  sessionRefs: Set<string>,
  usedRefs: Set<string>,
  depth = 0,
): TerminalPaneLayout {
  if (depth > 12) throw new TerminalAutomationError("Launch layout is nested too deeply");
  if (raw?.type === "pane") {
    const sessionRef = cleanText(raw.sessionRef, 100);
    if (!sessionRefs.has(sessionRef)) {
      throw new TerminalAutomationError(`Layout references unknown session: ${sessionRef || "(empty)"}`);
    }
    if (usedRefs.has(sessionRef)) {
      throw new TerminalAutomationError(`Layout references session more than once: ${sessionRef}`);
    }
    usedRefs.add(sessionRef);
    return { type: "pane", sessionRef };
  }
  if (raw?.type !== "split") throw new TerminalAutomationError("Layout node must be a pane or split");
  const children = Array.isArray(raw.children) ? raw.children : [];
  if (children.length < 2 || children.length > 8) {
    throw new TerminalAutomationError("Split layouts require between 2 and 8 children");
  }
  const direction = raw.direction === "horizontal" ? "horizontal" : "vertical";
  let sizes: number[] | undefined;
  if (raw.sizes !== undefined) {
    if (!Array.isArray(raw.sizes) || raw.sizes.length !== children.length) {
      throw new TerminalAutomationError("Split sizes must match the number of children");
    }
    const parsedSizes = raw.sizes.map((size: unknown) => Number(size));
    if (parsedSizes.some((size: number) => !Number.isFinite(size) || size <= 0)) {
      throw new TerminalAutomationError("Split sizes must be positive numbers");
    }
    sizes = parsedSizes;
  }
  return {
    type: "split",
    direction,
    sizes,
    children: children.map((child: any) => validatePaneLayout(child, sessionRefs, usedRefs, depth + 1)),
  };
}

function validateLaunchSession(raw: any): TerminalLaunchSession {
  const ref = cleanText(raw?.ref, 100);
  const agentId = cleanText(raw?.agentId, 100);
  const agentName = cleanText(raw?.agentName, 120);
  const command = cleanText(raw?.command, MAX_WORKFLOW_COMMAND_LENGTH);
  const cwd = cleanText(raw?.cwd, 2000);
  if (!ref) throw new TerminalAutomationError("Every launch session requires a ref");
  if (!agentId || !agentName || (!command && agentId !== "shell")) {
    throw new TerminalAutomationError(
      `Launch session ${ref} requires agentId, agentName, and a command unless agentId is shell`,
    );
  }
  if (!cwd || !absoluteOnAnyPlatform(cwd)) {
    throw new TerminalAutomationError(`Launch session ${ref} requires an absolute cwd`);
  }
  const position = raw?.position && Number.isFinite(Number(raw.position.x)) && Number.isFinite(Number(raw.position.y))
    ? { x: Number(raw.position.x), y: Number(raw.position.y) }
    : undefined;
  return {
    ref,
    agentId,
    agentName,
    command,
    cwd,
    customName: cleanText(raw?.customName, 120) || undefined,
    generatedTitle: cleanText(raw?.generatedTitle, 120) || undefined,
    customColor: cleanText(raw?.customColor, 80) || undefined,
    initialPrompt: typeof raw?.initialPrompt === "string" ? raw.initialPrompt.slice(0, 12_000) : undefined,
    workflowId: cleanText(raw?.workflowId, 200) || undefined,
    workflowValues: raw?.workflowValues && typeof raw.workflowValues === "object"
      ? Object.fromEntries(Object.entries(raw.workflowValues).map(([key, value]) => [key, String(value).slice(0, 4000)]))
      : undefined,
    position,
  };
}

function validateLaunchInput(
  raw: any,
  workflows: TerminalWorkflow[],
  existing?: TerminalLaunchConfiguration,
  preserveTimestamps = false,
): TerminalLaunchConfiguration {
  const name = cleanText(raw?.name, 120);
  if (!name) throw new TerminalAutomationError("Launch configuration name is required");
  const sessions = Array.isArray(raw?.sessions) ? raw.sessions.map(validateLaunchSession) : [];
  if (sessions.length === 0 || sessions.length > MAX_LAUNCH_SESSIONS) {
    throw new TerminalAutomationError(`Launch configurations require 1-${MAX_LAUNCH_SESSIONS} sessions`);
  }
  const refs = new Set<string>();
  for (const session of sessions) {
    if (refs.has(session.ref)) throw new TerminalAutomationError(`Duplicate launch session ref: ${session.ref}`);
    refs.add(session.ref);
    if (session.workflowId && !workflows.some((workflow) => workflow.id === session.workflowId)) {
      throw new TerminalAutomationError(`Launch session ${session.ref} references a missing workflow`);
    }
  }
  const usedRefs = new Set<string>();
  const layout = raw?.layout
    ? validatePaneLayout(raw.layout, refs, usedRefs)
    : undefined;
  if (layout && usedRefs.size !== refs.size) {
    const missing = [...refs].filter((ref) => !usedRefs.has(ref));
    throw new TerminalAutomationError(`Layout does not include sessions: ${missing.join(", ")}`);
  }
  const activeSessionRef = cleanText(raw?.activeSessionRef, 100) || undefined;
  if (activeSessionRef && !refs.has(activeSessionRef)) {
    throw new TerminalAutomationError(`activeSessionRef is unknown: ${activeSessionRef}`);
  }
  const now = Date.now();
  return {
    id: existing?.id || `launch-${randomUUID()}`,
    version: STATE_VERSION,
    name,
    description: cleanText(raw?.description, 2000),
    sessions,
    layout,
    activeSessionRef,
    launchMode: raw?.launchMode === "best-effort" ? "best-effort" : "atomic",
    createdAt: existing?.createdAt || now,
    updatedAt: preserveTimestamps && existing ? existing.updatedAt : now,
  };
}

type ImportConflictMode = "skip" | "rename" | "error";

function parseYamlRoots(source: unknown): any[] {
  if (typeof source !== "string" || !source.trim()) {
    throw new TerminalAutomationError("YAML source is required");
  }
  if (source.length > MAX_YAML_CHARS) {
    throw new TerminalAutomationError(`YAML source exceeds ${MAX_YAML_CHARS} characters`);
  }
  const documents = parseAllDocuments(source, { uniqueKeys: true });
  const roots: any[] = [];
  for (const document of documents) {
    if (document.errors.length) {
      throw new TerminalAutomationError(`Invalid YAML: ${document.errors[0].message}`);
    }
    const value = document.toJS({ maxAliasCount: 20 });
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) roots.push(...value);
    else roots.push(value);
  }
  if (!roots.length) throw new TerminalAutomationError("YAML did not contain any records");
  return roots;
}

function normalizeConflictMode(value: unknown): ImportConflictMode {
  return value === "rename" || value === "error" ? value : "skip";
}

function resolveImportedName(
  requested: string,
  occupied: Set<string>,
  conflict: ImportConflictMode,
): string | null {
  if (!occupied.has(requested.toLowerCase())) return requested;
  if (conflict === "skip") return null;
  if (conflict === "error") {
    throw new TerminalAutomationError(`Name already exists: ${requested}`, 409);
  }
  for (let suffix = 1; suffix <= 1000; suffix++) {
    const candidate = `${requested} (imported${suffix === 1 ? "" : ` ${suffix}`})`;
    if (!occupied.has(candidate.toLowerCase())) return candidate;
  }
  throw new TerminalAutomationError(`Could not allocate a unique name for: ${requested}`, 409);
}

function warpWorkflowInput(raw: any, workspacePath?: string): any {
  return {
    name: raw?.name,
    description: raw?.description,
    command: raw?.command,
    tags: raw?.tags,
    parameters: Array.isArray(raw?.arguments)
      ? raw.arguments.map((argument: any) => ({
          name: argument?.name,
          description: argument?.description,
          defaultValue: argument?.default_value,
          required: Boolean(argument?.required),
        }))
      : raw?.parameters,
    scope: workspacePath ? "workspace" : raw?.scope,
    workspacePath: workspacePath || raw?.workspacePath,
    shells: raw?.shells,
    sourceUrl: raw?.source_url || raw?.sourceUrl,
    author: raw?.author,
    authorUrl: raw?.author_url || raw?.authorUrl,
  };
}

function workflowYamlRecord(workflow: TerminalWorkflow): Record<string, unknown> {
  return {
    name: workflow.name,
    command: workflow.command,
    ...(workflow.description ? { description: workflow.description } : {}),
    ...(workflow.tags.length ? { tags: workflow.tags } : {}),
    ...(workflow.shells?.length ? { shells: workflow.shells } : {}),
    ...(workflow.sourceUrl ? { source_url: workflow.sourceUrl } : {}),
    ...(workflow.author ? { author: workflow.author } : {}),
    ...(workflow.authorUrl ? { author_url: workflow.authorUrl } : {}),
    ...(workflow.parameters.length
      ? {
          arguments: workflow.parameters.map((parameter) => ({
            name: parameter.name,
            ...(parameter.description ? { description: parameter.description } : {}),
            ...(parameter.defaultValue !== undefined ? { default_value: parameter.defaultValue } : {}),
            ...(parameter.required ? { required: true } : {}),
          })),
        }
      : {}),
  };
}

interface WarpLaunchConversion {
  input: any;
  warnings: string[];
}

function convertWarpLaunchConfiguration(raw: any, defaultCwd?: string): WarpLaunchConversion {
  const windows = Array.isArray(raw?.windows) ? raw.windows : [];
  if (!windows.length) throw new TerminalAutomationError("Warp launch YAML requires at least one window");
  const sessions: TerminalLaunchSession[] = [];
  const tabLayouts: TerminalPaneLayout[] = [];
  const warnings: string[] = [];
  let activeSessionRef: string | undefined;
  let firstActiveTabRef: string | undefined;
  let paneNumber = 0;
  const activeWindowIndex = Number.isSafeInteger(raw?.active_window_index) ? raw.active_window_index : 0;

  const convertPane = (
    node: any,
    windowIndex: number,
    tabIndex: number,
    tab: any,
  ): TerminalPaneLayout => {
    if (Array.isArray(node?.panes)) {
      if (node.panes.length < 2) {
        throw new TerminalAutomationError("Warp split layouts require at least two panes");
      }
      return {
        type: "split",
        direction: node.split_direction === "horizontal" ? "horizontal" : "vertical",
        children: node.panes.map((pane: any) => convertPane(pane, windowIndex, tabIndex, tab)),
      };
    }

    paneNumber++;
    const ref = `window-${windowIndex + 1}-tab-${tabIndex + 1}-pane-${paneNumber}`;
    const cwd = cleanText(node?.cwd, 2000) || cleanText(defaultCwd, 2000);
    if (!cwd || !absoluteOnAnyPlatform(cwd)) {
      throw new TerminalAutomationError(
        `Warp pane ${ref} needs an absolute cwd or an absolute defaultCwd import option`,
      );
    }
    const commands = Array.isArray(node?.commands)
      ? node.commands.map((item: any) => cleanText(item?.exec, MAX_WORKFLOW_COMMAND_LENGTH)).filter(Boolean)
      : [];
    const command = commands.join(" && ").slice(0, MAX_WORKFLOW_COMMAND_LENGTH);
    sessions.push({
      ref,
      agentId: command ? "task" : "shell",
      agentName: command ? "Task" : "Shell",
      command,
      cwd,
      customName: cleanText(tab?.title, 120) || undefined,
      customColor: cleanText(tab?.color, 80) || undefined,
    });
    if (node?.is_focused === true && !activeSessionRef) activeSessionRef = ref;
    if (windowIndex === activeWindowIndex && tabIndex === Number(raw.windows[windowIndex]?.active_tab_index || 0)) {
      firstActiveTabRef ||= ref;
    }
    return { type: "pane", sessionRef: ref };
  };

  windows.forEach((window: any, windowIndex: number) => {
    const tabs = Array.isArray(window?.tabs) ? window.tabs : [];
    if (!tabs.length) throw new TerminalAutomationError(`Warp window ${windowIndex + 1} has no tabs`);
    tabs.forEach((tab: any, tabIndex: number) => {
      if (!tab?.layout) throw new TerminalAutomationError(`Warp tab ${tabIndex + 1} has no layout`);
      tabLayouts.push(convertPane(tab.layout, windowIndex, tabIndex, tab));
    });
  });

  if (tabLayouts.length > 1) {
    warnings.push(
      `Flattened ${windows.length} Warp window(s) and ${tabLayouts.length} tab(s) into one OpenUI focus layout`,
    );
  }
  const layout = tabLayouts.length === 1
    ? tabLayouts[0]
    : { type: "split" as const, direction: "vertical" as const, children: tabLayouts };
  return {
    input: {
      name: raw?.name,
      description: cleanText(raw?.description, 2000) || "Imported from Warp launch-configuration YAML",
      sessions,
      layout,
      activeSessionRef: activeSessionRef || firstActiveTabRef || sessions[0]?.ref,
      launchMode: "atomic",
    },
    warnings,
  };
}

function nativeLaunchYamlRecord(configuration: TerminalLaunchConfiguration): Record<string, unknown> {
  return {
    openui_version: 1,
    kind: "launch_configuration",
    name: configuration.name,
    ...(configuration.description ? { description: configuration.description } : {}),
    launchMode: configuration.launchMode,
    sessions: configuration.sessions,
    ...(configuration.layout ? { layout: configuration.layout } : {}),
    ...(configuration.activeSessionRef ? { activeSessionRef: configuration.activeSessionRef } : {}),
  };
}

function warpLaunchYamlRecord(configuration: TerminalLaunchConfiguration): Record<string, unknown> {
  const sessionsByRef = new Map(configuration.sessions.map((session) => [session.ref, session]));
  const convertLayout = (layout: TerminalPaneLayout): Record<string, unknown> => {
    if (layout.type === "split") {
      return {
        split_direction: layout.direction,
        panes: layout.children.map(convertLayout),
      };
    }
    const session = sessionsByRef.get(layout.sessionRef);
    if (!session) throw new TerminalAutomationError(`Layout references unknown session: ${layout.sessionRef}`);
    return {
      cwd: session.cwd,
      ...(session.ref === configuration.activeSessionRef ? { is_focused: true } : {}),
      ...(session.command ? { commands: [{ exec: session.command }] } : {}),
    };
  };
  const rootLayout = configuration.layout || { type: "pane" as const, sessionRef: configuration.sessions[0].ref };
  return {
    name: configuration.name,
    active_window_index: 0,
    windows: [{
      active_tab_index: 0,
      tabs: [{
        title: configuration.name,
        layout: convertLayout(rootLayout),
      }],
    }],
  };
}

class TerminalAutomationStore {
  private state: TerminalAutomationState | undefined;
  private statePath = "";

  listWorkflows(): TerminalWorkflow[] {
    return copy(this.load().workflows);
  }

  getWorkflow(id: string): TerminalWorkflow {
    const workflow = this.load().workflows.find((item) => item.id === id);
    if (!workflow) throw new TerminalAutomationError("Workflow not found", 404);
    return copy(workflow);
  }

  createWorkflow(input: any): TerminalWorkflow {
    const state = this.load();
    if (state.workflows.length >= MAX_WORKFLOWS) throw new TerminalAutomationError("Workflow limit reached", 409);
    const workflow = validateWorkflowInput(input);
    this.assertUniqueName(state.workflows, workflow.name);
    state.workflows.push(workflow);
    this.save();
    return copy(workflow);
  }

  updateWorkflow(id: string, input: any): TerminalWorkflow {
    const state = this.load();
    const index = state.workflows.findIndex((item) => item.id === id);
    if (index < 0) throw new TerminalAutomationError("Workflow not found", 404);
    const workflow = validateWorkflowInput(input, state.workflows[index]);
    this.assertUniqueName(state.workflows, workflow.name, id);
    state.workflows[index] = workflow;
    this.save();
    return copy(workflow);
  }

  deleteWorkflow(id: string) {
    const state = this.load();
    if (state.launchConfigurations.some((config) => config.sessions.some((session) => session.workflowId === id))) {
      throw new TerminalAutomationError("Workflow is referenced by a launch configuration", 409);
    }
    const index = state.workflows.findIndex((item) => item.id === id);
    if (index < 0) throw new TerminalAutomationError("Workflow not found", 404);
    state.workflows.splice(index, 1);
    this.save();
  }

  renderWorkflow(id: string, values: Record<string, unknown> = {}): { command: string; sensitive: boolean } {
    const workflow = this.getWorkflow(id);
    const allowed = new Set(workflow.parameters.map((parameter) => parameter.name));
    const unknown = Object.keys(values).filter((key) => !allowed.has(key));
    if (unknown.length) throw new TerminalAutomationError(`Unknown workflow parameters: ${unknown.join(", ")}`);
    let command = workflow.command;
    let sensitive = false;
    for (const parameter of workflow.parameters) {
      const supplied = values[parameter.name];
      const value = supplied === undefined || supplied === null
        ? parameter.defaultValue ?? ""
        : String(supplied);
      if (parameter.required && !value) {
        throw new TerminalAutomationError(`Missing required workflow parameter: ${parameter.name}`);
      }
      if (parameter.options?.length && !parameter.options.includes(value)) {
        throw new TerminalAutomationError(`Invalid value for workflow parameter: ${parameter.name}`);
      }
      if (parameter.sensitive && value) sensitive = true;
      const replacement = parameter.shellQuote ? shellQuote(value) : value;
      command = command.replace(new RegExp(`\\{\\{\\s*${parameter.name}\\s*\\}\\}`, "g"), () => replacement);
    }
    return { command, sensitive };
  }

  exportWorkflowsYaml(ids?: string[]): string {
    const requested = ids?.length ? new Set(ids) : null;
    const workflows = this.load().workflows.filter((workflow) => !requested || requested.has(workflow.id));
    if (requested && workflows.length !== requested.size) {
      throw new TerminalAutomationError("One or more workflows were not found", 404);
    }
    if (!workflows.length) throw new TerminalAutomationError("No workflows to export", 404);
    return workflows
      .map((workflow, index) => `${index === 0 ? "" : "---\n"}${stringify(workflowYamlRecord(workflow))}`)
      .join("");
  }

  importWorkflowsYaml(
    source: unknown,
    options: { workspacePath?: string; conflict?: ImportConflictMode } = {},
  ): { imported: TerminalWorkflow[]; skipped: string[] } {
    const state = this.load();
    const roots = parseYamlRoots(source).flatMap((root) => (
      Array.isArray(root?.workflows) ? root.workflows : [root]
    ));
    if (state.workflows.length + roots.length > MAX_WORKFLOWS) {
      throw new TerminalAutomationError("Workflow import would exceed the workflow limit", 409);
    }
    const conflict = normalizeConflictMode(options.conflict);
    const occupied = new Set(state.workflows.map((workflow) => workflow.name.toLowerCase()));
    const imported: TerminalWorkflow[] = [];
    const skipped: string[] = [];
    for (const root of roots) {
      const workflow = validateWorkflowInput(warpWorkflowInput(root, options.workspacePath));
      const resolvedName = resolveImportedName(workflow.name, occupied, conflict);
      if (!resolvedName) {
        skipped.push(workflow.name);
        continue;
      }
      workflow.name = resolvedName;
      occupied.add(resolvedName.toLowerCase());
      imported.push(workflow);
    }
    if (state.workflows.length + imported.length > MAX_WORKFLOWS) {
      throw new TerminalAutomationError("Workflow import would exceed the workflow limit", 409);
    }
    state.workflows.push(...imported);
    if (imported.length) this.save();
    return { imported: copy(imported), skipped };
  }

  listLaunchConfigurations(): TerminalLaunchConfiguration[] {
    return copy(this.load().launchConfigurations);
  }

  getLaunchConfiguration(id: string): TerminalLaunchConfiguration {
    const config = this.load().launchConfigurations.find((item) => item.id === id);
    if (!config) throw new TerminalAutomationError("Launch configuration not found", 404);
    return copy(config);
  }

  exportLaunchConfigurationYaml(id: string, format: "openui" | "warp" = "openui"): string {
    const configuration = this.getLaunchConfiguration(id);
    return stringify(
      format === "warp"
        ? warpLaunchYamlRecord(configuration)
        : nativeLaunchYamlRecord(configuration),
    );
  }

  importLaunchConfigurationsYaml(
    source: unknown,
    options: { defaultCwd?: string; conflict?: ImportConflictMode } = {},
  ): { imported: TerminalLaunchConfiguration[]; skipped: string[]; warnings: string[] } {
    const state = this.load();
    const roots = parseYamlRoots(source).flatMap((root) => (
      Array.isArray(root?.launchConfigurations) ? root.launchConfigurations : [root]
    ));
    if (state.launchConfigurations.length + roots.length > MAX_LAUNCH_CONFIGURATIONS) {
      throw new TerminalAutomationError("Launch import would exceed the configuration limit", 409);
    }
    const conflict = normalizeConflictMode(options.conflict);
    const occupied = new Set(state.launchConfigurations.map((configuration) => configuration.name.toLowerCase()));
    const imported: TerminalLaunchConfiguration[] = [];
    const skipped: string[] = [];
    const warnings: string[] = [];
    for (const root of roots) {
      const conversion = Array.isArray(root?.windows)
        ? convertWarpLaunchConfiguration(root, options.defaultCwd)
        : { input: root, warnings: [] };
      const configuration = validateLaunchInput(conversion.input, state.workflows);
      const resolvedName = resolveImportedName(configuration.name, occupied, conflict);
      if (!resolvedName) {
        skipped.push(configuration.name);
        continue;
      }
      configuration.name = resolvedName;
      occupied.add(resolvedName.toLowerCase());
      imported.push(configuration);
      warnings.push(...conversion.warnings.map((warning) => `${resolvedName}: ${warning}`));
    }
    if (state.launchConfigurations.length + imported.length > MAX_LAUNCH_CONFIGURATIONS) {
      throw new TerminalAutomationError("Launch import would exceed the configuration limit", 409);
    }
    state.launchConfigurations.push(...imported);
    if (imported.length) this.save();
    return { imported: copy(imported), skipped, warnings };
  }

  createLaunchConfiguration(input: any): TerminalLaunchConfiguration {
    const state = this.load();
    if (state.launchConfigurations.length >= MAX_LAUNCH_CONFIGURATIONS) {
      throw new TerminalAutomationError("Launch configuration limit reached", 409);
    }
    const config = validateLaunchInput(input, state.workflows);
    this.assertUniqueName(state.launchConfigurations, config.name);
    state.launchConfigurations.push(config);
    this.save();
    return copy(config);
  }

  updateLaunchConfiguration(id: string, input: any): TerminalLaunchConfiguration {
    const state = this.load();
    const index = state.launchConfigurations.findIndex((item) => item.id === id);
    if (index < 0) throw new TerminalAutomationError("Launch configuration not found", 404);
    const config = validateLaunchInput(input, state.workflows, state.launchConfigurations[index]);
    this.assertUniqueName(state.launchConfigurations, config.name, id);
    state.launchConfigurations[index] = config;
    this.save();
    return copy(config);
  }

  deleteLaunchConfiguration(id: string) {
    const state = this.load();
    const index = state.launchConfigurations.findIndex((item) => item.id === id);
    if (index < 0) throw new TerminalAutomationError("Launch configuration not found", 404);
    state.launchConfigurations.splice(index, 1);
    this.save();
  }

  private load(): TerminalAutomationState {
    const path = join(getDataDir(), "terminal-automation.json");
    if (this.state && this.statePath === path) return this.state;
    this.statePath = path;
    this.state = emptyState();
    try {
      if (!existsSync(path)) return this.state;
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.workflows) || !Array.isArray(parsed.launchConfigurations)) {
        return this.state;
      }
      // Re-validate persisted data so malformed or hand-edited files fail
      // closed instead of reaching launch execution.
      const workflows = parsed.workflows.map((workflow: any) => validateWorkflowInput(workflow, workflow, true));
      const launchConfigurations = parsed.launchConfigurations.map((config: any) => (
        validateLaunchInput(config, workflows, config, true)
      ));
      this.state = { version: STATE_VERSION, workflows, launchConfigurations };
    } catch (error) {
      console.error("Failed to load terminal automation state:", error);
      this.state = emptyState();
    }
    return this.state;
  }

  private save() {
    if (!this.state) return;
    mkdirSync(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2));
    renameSync(temporaryPath, this.statePath);
  }

  private assertUniqueName(items: Array<{ id: string; name: string }>, name: string, exceptId?: string) {
    if (items.some((item) => item.id !== exceptId && item.name.toLowerCase() === name.toLowerCase())) {
      throw new TerminalAutomationError(`Name already exists: ${name}`, 409);
    }
  }
}

export const terminalAutomation = new TerminalAutomationStore();
