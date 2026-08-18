import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { dirname, join } from "path";
import type {
  TerminalPaneDirection,
  TerminalPaneLayout,
  TerminalWorkspacePaneNode,
  TerminalWorkspaceSnapshot,
  TerminalWorkspaceTab,
} from "../types";
import { getDataDir } from "./persistence";

const STATE_VERSION = 1 as const;
const MAX_TABS = 64;
const MAX_PANES_PER_TAB = 32;
const MAX_PANES_TOTAL = 128;
const MAX_LAYOUT_DEPTH = 12;
const MAX_UNDO_CLOSE = 10;
const MAX_TITLE_LENGTH = 120;
const MAX_ID_LENGTH = 512;
const PANE_RESIZE_STEP = 0.05;
const MIN_PANE_WEIGHT = 0.05;
const MAX_PANE_RESIZE_STEPS = 10;

interface TerminalWorkspaceState {
  version: 1;
  revision: number;
  tabs: TerminalWorkspaceTab[];
  activeTabId?: string;
  detachedSessionIds: string[];
  updatedAt: number;
}

interface NodeValidationContext {
  nodeIds: Set<string>;
  sessionIds: Set<string>;
  panes: number;
}

interface PanePathEntry {
  split: Extract<TerminalWorkspacePaneNode, { type: "split" }>;
  index: number;
}

export class TerminalWorkspaceError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cleanId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TerminalWorkspaceError(`${label} is invalid`);
  }
  return value;
}

function cleanTitle(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new TerminalWorkspaceError("Tab title is invalid");
  }
  const title = value.trim().slice(0, MAX_TITLE_LENGTH);
  return title || undefined;
}

function newNodeId(prefix: "pane" | "split"): string {
  return `${prefix}-${randomUUID()}`;
}

function newTabId(): string {
  return `tab-${randomUUID()}`;
}

function normalizedSizes(values: unknown, count: number): number[] {
  if (count < 2) throw new TerminalWorkspaceError("Split nodes require at least two children");
  const parsed = values === undefined
    ? Array.from({ length: count }, () => 1)
    : Array.isArray(values) && values.length === count
      ? values.map((value) => typeof value === "number" ? value : Number.NaN)
      : null;
  if (!parsed || parsed.some((value) => !Number.isFinite(value) || value <= 0 || value > 1_000_000)) {
    throw new TerminalWorkspaceError("Split sizes must be positive finite values matching the children");
  }
  const total = parsed.reduce((sum, value) => sum + value, 0);
  return parsed.map((value) => value / total);
}

function validateNode(
  raw: any,
  context: NodeValidationContext,
  depth = 0,
): TerminalWorkspacePaneNode {
  if (!raw || typeof raw !== "object" || depth > MAX_LAYOUT_DEPTH) {
    throw new TerminalWorkspaceError("Workspace pane layout is invalid or nested too deeply");
  }
  const id = cleanId(raw.id, "Pane node ID");
  if (context.nodeIds.has(id)) throw new TerminalWorkspaceError(`Duplicate pane node ID: ${id}`);
  context.nodeIds.add(id);
  if (raw.type === "pane") {
    const sessionId = cleanId(raw.sessionId, "Pane session ID");
    if (context.sessionIds.has(sessionId)) {
      throw new TerminalWorkspaceError(`Session appears more than once in the workspace: ${sessionId}`);
    }
    context.sessionIds.add(sessionId);
    context.panes += 1;
    return { id, type: "pane", sessionId };
  }
  if (raw.type !== "split") throw new TerminalWorkspaceError("Workspace nodes must be panes or splits");
  const children = Array.isArray(raw.children) ? raw.children : [];
  if (children.length < 2 || children.length > 8) {
    throw new TerminalWorkspaceError("Workspace splits require between 2 and 8 children");
  }
  const direction = raw.direction === "vertical" ? "vertical" : raw.direction === "horizontal" ? "horizontal" : null;
  if (!direction) throw new TerminalWorkspaceError("Workspace split direction is invalid");
  return {
    id,
    type: "split",
    direction,
    sizes: normalizedSizes(raw.sizes, children.length),
    children: children.map((child: any) => validateNode(child, context, depth + 1)),
  };
}

function collectSessionIds(node: TerminalWorkspacePaneNode, output: string[] = []): string[] {
  if (node.type === "pane") output.push(node.sessionId);
  else for (const child of node.children) collectSessionIds(child, output);
  return output;
}

function validateState(raw: any): TerminalWorkspaceState {
  if (!raw || typeof raw !== "object" || raw.version !== STATE_VERSION) {
    throw new TerminalWorkspaceError("Terminal workspace state has an unsupported version");
  }
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 0) {
    throw new TerminalWorkspaceError("Terminal workspace revision is invalid");
  }
  if (!Array.isArray(raw.tabs) || raw.tabs.length > MAX_TABS) {
    throw new TerminalWorkspaceError(`Terminal workspace may contain at most ${MAX_TABS} tabs`);
  }
  const context: NodeValidationContext = { nodeIds: new Set(), sessionIds: new Set(), panes: 0 };
  const tabIds = new Set<string>();
  const tabs = raw.tabs.map((rawTab: any): TerminalWorkspaceTab => {
    if (!rawTab || typeof rawTab !== "object") throw new TerminalWorkspaceError("Workspace tab is invalid");
    const id = cleanId(rawTab.id, "Tab ID");
    if (tabIds.has(id)) throw new TerminalWorkspaceError(`Duplicate tab ID: ${id}`);
    tabIds.add(id);
    const paneCountBefore = context.panes;
    const root = validateNode(rawTab.root, context);
    const paneIds = collectSessionIds(root);
    if (context.panes - paneCountBefore > MAX_PANES_PER_TAB) {
      throw new TerminalWorkspaceError(`A tab may contain at most ${MAX_PANES_PER_TAB} panes`);
    }
    const activeSessionId = cleanId(rawTab.activeSessionId, "Active pane session ID");
    if (!paneIds.includes(activeSessionId)) {
      throw new TerminalWorkspaceError(`Active pane is not present in tab ${id}`);
    }
    const zoomedSessionId = rawTab.zoomedSessionId === undefined
      ? undefined
      : cleanId(rawTab.zoomedSessionId, "Zoomed pane session ID");
    if (zoomedSessionId && !paneIds.includes(zoomedSessionId)) {
      throw new TerminalWorkspaceError(`Zoomed pane is not present in tab ${id}`);
    }
    return {
      id,
      title: cleanTitle(rawTab.title),
      root,
      activeSessionId,
      zoomedSessionId,
    };
  });
  if (context.panes > MAX_PANES_TOTAL) {
    throw new TerminalWorkspaceError(`Terminal workspace may contain at most ${MAX_PANES_TOTAL} panes`);
  }
  const activeTabId = raw.activeTabId === undefined ? undefined : cleanId(raw.activeTabId, "Active tab ID");
  if (activeTabId && !tabIds.has(activeTabId)) {
    throw new TerminalWorkspaceError("Active tab is not present in the workspace");
  }
  if (tabs.length > 0 && !activeTabId) {
    throw new TerminalWorkspaceError("A nonempty workspace requires an active tab");
  }
  if (tabs.length === 0 && activeTabId) {
    throw new TerminalWorkspaceError("An empty workspace cannot have an active tab");
  }
  const detachedSessionIds = raw.detachedSessionIds === undefined
    ? []
    : Array.isArray(raw.detachedSessionIds)
      ? raw.detachedSessionIds.map((value: unknown) => cleanId(value, "Detached session ID"))
      : null;
  if (!detachedSessionIds || detachedSessionIds.length > MAX_PANES_TOTAL) {
    throw new TerminalWorkspaceError(`Terminal workspace may detach at most ${MAX_PANES_TOTAL} sessions`);
  }
  if (new Set(detachedSessionIds).size !== detachedSessionIds.length) {
    throw new TerminalWorkspaceError("Terminal workspace has duplicate detached sessions");
  }
  if (detachedSessionIds.some((sessionId: string) => context.sessionIds.has(sessionId))) {
    throw new TerminalWorkspaceError("A session cannot be both visible and detached");
  }
  if (context.panes + detachedSessionIds.length > MAX_PANES_TOTAL) {
    throw new TerminalWorkspaceError(
      `Terminal workspace may track at most ${MAX_PANES_TOTAL} visible and detached sessions`,
    );
  }
  return {
    version: STATE_VERSION,
    revision: raw.revision,
    tabs,
    activeTabId,
    detachedSessionIds,
    updatedAt: Number.isFinite(raw.updatedAt) && raw.updatedAt >= 0 ? Number(raw.updatedAt) : Date.now(),
  };
}

function emptyState(): TerminalWorkspaceState {
  return { version: STATE_VERSION, revision: 0, tabs: [], detachedSessionIds: [], updatedAt: Date.now() };
}

function findPanePath(
  node: TerminalWorkspacePaneNode,
  sessionId: string,
  path: PanePathEntry[] = [],
): PanePathEntry[] | null {
  if (node.type === "pane") return node.sessionId === sessionId ? path : null;
  for (let index = 0; index < node.children.length; index++) {
    const result = findPanePath(node.children[index], sessionId, [...path, { split: node, index }]);
    if (result) return result;
  }
  return null;
}

function firstPane(node: TerminalWorkspacePaneNode): string {
  return node.type === "pane" ? node.sessionId : firstPane(node.children[0]);
}

function lastPane(node: TerminalWorkspacePaneNode): string {
  return node.type === "pane" ? node.sessionId : lastPane(node.children[node.children.length - 1]);
}

function splitAxis(direction: TerminalPaneDirection): "horizontal" | "vertical" {
  return direction === "left" || direction === "right" ? "horizontal" : "vertical";
}

function directionIsBefore(direction: TerminalPaneDirection): boolean {
  return direction === "left" || direction === "up";
}

function insertAdjacent(
  node: TerminalWorkspacePaneNode,
  targetSessionId: string,
  pane: Extract<TerminalWorkspacePaneNode, { type: "pane" }>,
  direction: TerminalPaneDirection,
): boolean {
  if (node.type === "pane") return false;
  const axis = splitAxis(direction);
  const before = directionIsBefore(direction);
  const directIndex = node.children.findIndex(
    (child) => child.type === "pane" && child.sessionId === targetSessionId,
  );
  if (directIndex >= 0 && node.direction === axis) {
    const targetSize = node.sizes[directIndex];
    const insertIndex = before ? directIndex : directIndex + 1;
    node.children.splice(insertIndex, 0, pane);
    node.sizes[directIndex] = targetSize / 2;
    node.sizes.splice(insertIndex, 0, targetSize / 2);
    node.sizes = normalizedSizes(node.sizes, node.children.length);
    return true;
  }
  for (let index = 0; index < node.children.length; index++) {
    const child = node.children[index];
    if (child.type === "pane" && child.sessionId === targetSessionId) {
      node.children[index] = {
        id: newNodeId("split"),
        type: "split",
        direction: axis,
        sizes: [0.5, 0.5],
        children: before ? [pane, child] : [child, pane],
      };
      return true;
    }
    if (insertAdjacent(child, targetSessionId, pane, direction)) return true;
  }
  return false;
}

function removePaneNode(
  node: TerminalWorkspacePaneNode,
  sessionId: string,
): { node?: TerminalWorkspacePaneNode; removed?: Extract<TerminalWorkspacePaneNode, { type: "pane" }> } {
  if (node.type === "pane") {
    return node.sessionId === sessionId ? { removed: node } : { node };
  }
  for (let index = 0; index < node.children.length; index++) {
    const result = removePaneNode(node.children[index], sessionId);
    if (!result.removed) continue;
    if (result.node) {
      node.children[index] = result.node;
    } else {
      node.children.splice(index, 1);
      node.sizes.splice(index, 1);
    }
    if (node.children.length === 0) return { removed: result.removed };
    if (node.children.length === 1) return { node: node.children[0], removed: result.removed };
    node.sizes = normalizedSizes(node.sizes, node.children.length);
    return { node, removed: result.removed };
  }
  return { node };
}

function pruneNode(
  node: TerminalWorkspacePaneNode,
  validSessionIds: Set<string>,
): TerminalWorkspacePaneNode | undefined {
  if (node.type === "pane") return validSessionIds.has(node.sessionId) ? node : undefined;
  const kept: Array<{ child: TerminalWorkspacePaneNode; size: number }> = [];
  node.children.forEach((child, index) => {
    const pruned = pruneNode(child, validSessionIds);
    if (pruned) kept.push({ child: pruned, size: node.sizes[index] || 1 });
  });
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0].child;
  node.children = kept.map((item) => item.child);
  node.sizes = normalizedSizes(kept.map((item) => item.size), kept.length);
  return node;
}

function nodeHasSession(node: TerminalWorkspacePaneNode, sessionId: string): boolean {
  return node.type === "pane"
    ? node.sessionId === sessionId
    : node.children.some((child) => nodeHasSession(child, sessionId));
}

function findSplit(
  node: TerminalWorkspacePaneNode,
  splitId: string,
): Extract<TerminalWorkspacePaneNode, { type: "split" }> | null {
  if (node.type === "pane") return null;
  if (node.id === splitId) return node;
  for (const child of node.children) {
    const found = findSplit(child, splitId);
    if (found) return found;
  }
  return null;
}

function mapLaunchLayout(
  layout: TerminalPaneLayout,
  sessionIdsByRef: Map<string, string>,
): TerminalWorkspacePaneNode | undefined {
  if (layout.type === "pane") {
    const sessionId = sessionIdsByRef.get(layout.sessionRef);
    return sessionId ? { id: newNodeId("pane"), type: "pane", sessionId } : undefined;
  }
  const kept: Array<{ node: TerminalWorkspacePaneNode; size: number }> = [];
  layout.children.forEach((child, index) => {
    const mapped = mapLaunchLayout(child, sessionIdsByRef);
    if (mapped) kept.push({ node: mapped, size: layout.sizes?.[index] || 1 });
  });
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0].node;
  return {
    id: newNodeId("split"),
    type: "split",
    direction: layout.direction,
    sizes: normalizedSizes(kept.map((item) => item.size), kept.length),
    children: kept.map((item) => item.node),
  };
}

export class TerminalWorkspaceService {
  private state: TerminalWorkspaceState;
  private readonly undoCloseStack: TerminalWorkspaceState[] = [];

  constructor(private readonly statePath = join(getDataDir(), "terminal-workspace.json")) {
    this.state = this.load();
  }

  snapshot(): TerminalWorkspaceSnapshot {
    return { ...copy(this.state), closedPaneCount: this.undoCloseStack.length };
  }

  addTab(
    sessionIdValue: unknown,
    options: { title?: unknown; activate?: boolean; expectedRevision?: number } = {},
  ): TerminalWorkspaceSnapshot {
    const sessionId = cleanId(sessionIdValue, "Session ID");
    return this.update(options.expectedRevision, (state) => {
      this.assertSessionAbsent(state, sessionId);
      const tab: TerminalWorkspaceTab = {
        id: newTabId(),
        title: cleanTitle(options.title),
        root: { id: newNodeId("pane"), type: "pane", sessionId },
        activeSessionId: sessionId,
      };
      state.detachedSessionIds = state.detachedSessionIds.filter((id) => id !== sessionId);
      state.tabs.push(tab);
      if (options.activate !== false || !state.activeTabId) state.activeTabId = tab.id;
      return true;
    });
  }

  addLaunchTab(input: {
    layout?: TerminalPaneLayout;
    sessionIdsByRef: Map<string, string> | Record<string, string>;
    activeSessionId?: string;
    title?: string;
    expectedRevision?: number;
  }): TerminalWorkspaceSnapshot {
    const mapping = input.sessionIdsByRef instanceof Map
      ? input.sessionIdsByRef
      : new Map(Object.entries(input.sessionIdsByRef));
    const mappedSessionIds = new Set(mapping.values());
    for (const [ref, sessionId] of mapping) {
      cleanId(ref, "Launch session ref");
      cleanId(sessionId, "Launch session ID");
    }
    return this.update(input.expectedRevision, (state) => {
      for (const sessionId of mapping.values()) this.assertSessionAbsent(state, sessionId);
      state.detachedSessionIds = state.detachedSessionIds.filter((id) => !mappedSessionIds.has(id));
      let root = input.layout ? mapLaunchLayout(input.layout, mapping) : undefined;
      if (!root) {
        const panes = [...mapping.values()].map((sessionId) => ({
          id: newNodeId("pane"),
          type: "pane" as const,
          sessionId,
        }));
        if (!panes.length) throw new TerminalWorkspaceError("Launch did not create any workspace panes", 409);
        root = panes.length === 1
          ? panes[0]
          : {
              id: newNodeId("split"),
              type: "split",
              direction: "horizontal",
              sizes: normalizedSizes(undefined, panes.length),
              children: panes,
            };
      }
      const paneIds = collectSessionIds(root);
      const activeSessionId = input.activeSessionId && paneIds.includes(input.activeSessionId)
        ? input.activeSessionId
        : paneIds[0];
      const tab: TerminalWorkspaceTab = {
        id: newTabId(),
        title: cleanTitle(input.title),
        root,
        activeSessionId,
      };
      state.tabs.push(tab);
      state.activeTabId = tab.id;
      return true;
    });
  }

  splitPane(input: {
    targetSessionId: unknown;
    newSessionId: unknown;
    direction: unknown;
    expectedRevision?: number;
  }): TerminalWorkspaceSnapshot {
    const targetSessionId = cleanId(input.targetSessionId, "Target session ID");
    const newSessionId = cleanId(input.newSessionId, "New session ID");
    const direction = this.direction(input.direction);
    return this.update(input.expectedRevision, (state) => {
      this.assertSessionAbsent(state, newSessionId);
      const tab = this.tabForSession(state, targetSessionId);
      state.detachedSessionIds = state.detachedSessionIds.filter((id) => id !== newSessionId);
      const newPane = { id: newNodeId("pane"), type: "pane" as const, sessionId: newSessionId };
      if (tab.root.type === "pane" && tab.root.sessionId === targetSessionId) {
        tab.root = {
          id: newNodeId("split"),
          type: "split",
          direction: splitAxis(direction),
          sizes: [0.5, 0.5],
          children: directionIsBefore(direction) ? [newPane, tab.root] : [tab.root, newPane],
        };
      } else if (!insertAdjacent(tab.root, targetSessionId, newPane, direction)) {
        throw new TerminalWorkspaceError("Target pane was not found", 404);
      }
      tab.activeSessionId = newSessionId;
      tab.zoomedSessionId = undefined;
      state.activeTabId = tab.id;
      return true;
    });
  }

  movePane(input: {
    sessionId: unknown;
    targetSessionId: unknown;
    direction: unknown;
    expectedRevision?: number;
  }): TerminalWorkspaceSnapshot {
    const sessionId = cleanId(input.sessionId, "Session ID");
    const targetSessionId = cleanId(input.targetSessionId, "Target session ID");
    const direction = this.direction(input.direction);
    if (sessionId === targetSessionId) throw new TerminalWorkspaceError("A pane cannot move relative to itself");
    return this.update(input.expectedRevision, (state) => {
      const sourceTab = this.tabForSession(state, sessionId);
      const targetTab = this.tabForSession(state, targetSessionId);
      const sourceOrder = collectSessionIds(sourceTab.root);
      const sourceIndex = sourceOrder.indexOf(sessionId);
      const removed = removePaneNode(sourceTab.root, sessionId);
      if (!removed.removed) throw new TerminalWorkspaceError("Pane was not found", 404);
      if (removed.node) {
        sourceTab.root = removed.node;
        const remaining = collectSessionIds(sourceTab.root);
        sourceTab.activeSessionId = remaining[Math.min(sourceIndex, remaining.length - 1)];
        if (sourceTab.zoomedSessionId === sessionId) sourceTab.zoomedSessionId = undefined;
      } else {
        const sourceTabIndex = state.tabs.findIndex((tab) => tab.id === sourceTab.id);
        state.tabs.splice(sourceTabIndex, 1);
      }
      const currentTargetTab = this.tabForSession(state, targetSessionId);
      if (currentTargetTab.root.type === "pane" && currentTargetTab.root.sessionId === targetSessionId) {
        currentTargetTab.root = {
          id: newNodeId("split"),
          type: "split",
          direction: splitAxis(direction),
          sizes: [0.5, 0.5],
          children: directionIsBefore(direction)
            ? [removed.removed, currentTargetTab.root]
            : [currentTargetTab.root, removed.removed],
        };
      } else if (!insertAdjacent(currentTargetTab.root, targetSessionId, removed.removed, direction)) {
        throw new TerminalWorkspaceError("Target pane was not found", 404);
      }
      currentTargetTab.activeSessionId = sessionId;
      currentTargetTab.zoomedSessionId = undefined;
      state.activeTabId = currentTargetTab.id;
      return true;
    });
  }

  focusPane(sessionIdValue: unknown, expectedRevision?: number): TerminalWorkspaceSnapshot {
    const sessionId = cleanId(sessionIdValue, "Session ID");
    return this.update(expectedRevision, (state) => {
      const tab = this.tabForSession(state, sessionId);
      if (tab.activeSessionId === sessionId && state.activeTabId === tab.id) return false;
      tab.activeSessionId = sessionId;
      state.activeTabId = tab.id;
      return true;
    });
  }

  focusDirection(input: {
    sessionId: unknown;
    direction: unknown;
    expectedRevision?: number;
  }): TerminalWorkspaceSnapshot {
    const sessionId = cleanId(input.sessionId, "Session ID");
    const direction = this.direction(input.direction);
    return this.update(input.expectedRevision, (state) => {
      const tab = this.tabForSession(state, sessionId);
      const path = findPanePath(tab.root, sessionId);
      if (!path) throw new TerminalWorkspaceError("Pane was not found", 404);
      const axis = splitAxis(direction);
      const before = directionIsBefore(direction);
      for (let index = path.length - 1; index >= 0; index--) {
        const entry = path[index];
        if (entry.split.direction !== axis) continue;
        const siblingIndex = entry.index + (before ? -1 : 1);
        if (siblingIndex < 0 || siblingIndex >= entry.split.children.length) continue;
        const target = before
          ? lastPane(entry.split.children[siblingIndex])
          : firstPane(entry.split.children[siblingIndex]);
        tab.activeSessionId = target;
        state.activeTabId = tab.id;
        return true;
      }
      if (tab.activeSessionId !== sessionId || state.activeTabId !== tab.id) {
        tab.activeSessionId = sessionId;
        state.activeTabId = tab.id;
        return true;
      }
      return false;
    });
  }

  resizeSplit(input: {
    splitId: unknown;
    sizes: unknown;
    expectedRevision?: number;
  }): TerminalWorkspaceSnapshot {
    const splitId = cleanId(input.splitId, "Split ID");
    return this.update(input.expectedRevision, (state) => {
      let split: Extract<TerminalWorkspacePaneNode, { type: "split" }> | null = null;
      for (const tab of state.tabs) {
        split = findSplit(tab.root, splitId);
        if (split) break;
      }
      if (!split) throw new TerminalWorkspaceError("Split was not found", 404);
      const next = normalizedSizes(input.sizes, split.children.length);
      if (next.every((value, index) => Math.abs(value - split!.sizes[index]) < 1e-9)) return false;
      split.sizes = next;
      return true;
    });
  }

  toggleZoom(sessionIdValue: unknown, expectedRevision?: number): TerminalWorkspaceSnapshot {
    const sessionId = cleanId(sessionIdValue, "Session ID");
    return this.update(expectedRevision, (state) => {
      const tab = this.tabForSession(state, sessionId);
      tab.zoomedSessionId = tab.zoomedSessionId === sessionId ? undefined : sessionId;
      tab.activeSessionId = sessionId;
      state.activeTabId = tab.id;
      return true;
    });
  }

  setZoom(
    sessionIdValue: unknown,
    zoomed: boolean,
    expectedRevision?: number,
  ): TerminalWorkspaceSnapshot {
    const sessionId = cleanId(sessionIdValue, "Session ID");
    return this.update(expectedRevision, (state) => {
      const tab = this.tabForSession(state, sessionId);
      const next = zoomed ? sessionId : undefined;
      if (
        tab.zoomedSessionId === next &&
        (!zoomed || (tab.activeSessionId === sessionId && state.activeTabId === tab.id))
      ) return false;
      tab.zoomedSessionId = next;
      if (zoomed) {
        tab.activeSessionId = sessionId;
        state.activeTabId = tab.id;
      }
      return true;
    });
  }

  activateTab(tabIdValue: unknown, expectedRevision?: number): TerminalWorkspaceSnapshot {
    const tabId = cleanId(tabIdValue, "Tab ID");
    return this.update(expectedRevision, (state) => {
      if (!state.tabs.some((tab) => tab.id === tabId)) throw new TerminalWorkspaceError("Tab was not found", 404);
      if (state.activeTabId === tabId) return false;
      state.activeTabId = tabId;
      return true;
    });
  }

  moveTab(input: {
    tabId: unknown;
    direction: unknown;
    expectedRevision?: number;
  }): TerminalWorkspaceSnapshot {
    const tabId = cleanId(input.tabId, "Tab ID");
    if (input.direction !== "left" && input.direction !== "right") {
      throw new TerminalWorkspaceError("Tab direction must be left or right");
    }
    return this.update(input.expectedRevision, (state) => {
      const index = state.tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) throw new TerminalWorkspaceError("Tab was not found", 404);
      const nextIndex = index + (input.direction === "left" ? -1 : 1);
      if (nextIndex < 0 || nextIndex >= state.tabs.length) return false;
      const [tab] = state.tabs.splice(index, 1);
      state.tabs.splice(nextIndex, 0, tab);
      return true;
    });
  }

  resizePane(input: {
    sessionId: unknown;
    direction: unknown;
    amount?: unknown;
    expectedRevision?: number;
  }): TerminalWorkspaceSnapshot {
    const sessionId = cleanId(input.sessionId, "Session ID");
    const direction = this.direction(input.direction);
    const amount = input.amount === undefined ? 1 : input.amount;
    if (!Number.isSafeInteger(amount) || Number(amount) < 1 || Number(amount) > MAX_PANE_RESIZE_STEPS) {
      throw new TerminalWorkspaceError(
        `Pane resize amount must be an integer between 1 and ${MAX_PANE_RESIZE_STEPS}`,
      );
    }
    return this.update(input.expectedRevision, (state) => {
      const tab = this.tabForSession(state, sessionId);
      const path = findPanePath(tab.root, sessionId);
      if (!path) throw new TerminalWorkspaceError("Pane was not found", 404);
      const axis = splitAxis(direction);
      const before = directionIsBefore(direction);
      for (let index = path.length - 1; index >= 0; index--) {
        const entry = path[index];
        if (entry.split.direction !== axis) continue;
        const neighborIndex = entry.index + (before ? -1 : 1);
        if (neighborIndex < 0 || neighborIndex >= entry.split.children.length) continue;
        const available = entry.split.sizes[neighborIndex] - MIN_PANE_WEIGHT;
        const delta = Math.min(PANE_RESIZE_STEP * Number(amount), available);
        if (delta <= 1e-9) return false;
        entry.split.sizes[entry.index] += delta;
        entry.split.sizes[neighborIndex] -= delta;
        entry.split.sizes = normalizedSizes(entry.split.sizes, entry.split.children.length);
        tab.activeSessionId = sessionId;
        state.activeTabId = tab.id;
        return true;
      }
      return false;
    });
  }

  renameTab(tabIdValue: unknown, title: unknown, expectedRevision?: number): TerminalWorkspaceSnapshot {
    const tabId = cleanId(tabIdValue, "Tab ID");
    const clean = cleanTitle(title);
    return this.update(expectedRevision, (state) => {
      const tab = state.tabs.find((item) => item.id === tabId);
      if (!tab) throw new TerminalWorkspaceError("Tab was not found", 404);
      if (tab.title === clean) return false;
      tab.title = clean;
      return true;
    });
  }

  closePane(sessionIdValue: unknown, expectedRevision?: number): TerminalWorkspaceSnapshot {
    const sessionId = cleanId(sessionIdValue, "Session ID");
    return this.update(expectedRevision, (state) => {
      const tab = this.tabForSession(state, sessionId);
      const order = collectSessionIds(tab.root);
      const index = order.indexOf(sessionId);
      const result = removePaneNode(tab.root, sessionId);
      if (!result.removed) throw new TerminalWorkspaceError("Pane was not found", 404);
      state.detachedSessionIds.push(sessionId);
      if (!result.node) {
        const tabIndex = state.tabs.findIndex((item) => item.id === tab.id);
        state.tabs.splice(tabIndex, 1);
        state.activeTabId = state.tabs[Math.min(tabIndex, state.tabs.length - 1)]?.id;
      } else {
        tab.root = result.node;
        const remaining = collectSessionIds(tab.root);
        tab.activeSessionId = remaining[Math.min(index, remaining.length - 1)];
        if (tab.zoomedSessionId === sessionId) tab.zoomedSessionId = undefined;
      }
      return true;
    }, { saveUndo: true });
  }

  closeTab(tabIdValue: unknown, expectedRevision?: number): TerminalWorkspaceSnapshot {
    const tabId = cleanId(tabIdValue, "Tab ID");
    return this.update(expectedRevision, (state) => {
      const index = state.tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) throw new TerminalWorkspaceError("Tab was not found", 404);
      state.detachedSessionIds.push(...collectSessionIds(state.tabs[index].root));
      state.tabs.splice(index, 1);
      if (state.activeTabId === tabId) {
        state.activeTabId = state.tabs[Math.min(index, state.tabs.length - 1)]?.id;
      }
      return true;
    }, { saveUndo: true });
  }

  undoClose(validSessionIdsValue?: Iterable<string>, expectedRevision?: number): TerminalWorkspaceSnapshot {
    this.assertRevision(expectedRevision);
    const previous = this.undoCloseStack[this.undoCloseStack.length - 1];
    if (!previous) throw new TerminalWorkspaceError("There is no closed pane to restore", 409);
    if (validSessionIdsValue) {
      const valid = new Set(validSessionIdsValue);
      const missing = previous.tabs.flatMap((tab) => collectSessionIds(tab.root)).find((id) => !valid.has(id));
      if (missing) throw new TerminalWorkspaceError("A closed pane's session no longer exists", 409);
    }
    const next = copy(previous);
    next.revision = this.state.revision + 1;
    next.updatedAt = Date.now();
    const validated = validateState(next);
    this.persist(validated);
    this.state = validated;
    this.undoCloseStack.pop();
    return this.snapshot();
  }

  restoreDetachedSession(
    sessionIdValue: unknown,
    validSessionIdsValue?: Iterable<string>,
    expectedRevision?: number,
  ): TerminalWorkspaceSnapshot {
    const sessionId = cleanId(sessionIdValue, "Session ID");
    this.assertRevision(expectedRevision);
    if (this.state.tabs.some((tab) => nodeHasSession(tab.root, sessionId))) return this.snapshot();
    if (!this.state.detachedSessionIds.includes(sessionId)) {
      return this.addTab(sessionId, { expectedRevision });
    }
    const previous = this.undoCloseStack[this.undoCloseStack.length - 1];
    if (previous?.tabs.some((tab) => nodeHasSession(tab.root, sessionId))) {
      return this.undoClose(validSessionIdsValue, expectedRevision);
    }
    return this.addTab(sessionId, { expectedRevision });
  }

  removeSession(sessionIdValue: unknown): TerminalWorkspaceSnapshot {
    const sessionId = cleanId(sessionIdValue, "Session ID");
    return this.update(undefined, (state) => {
      const tab = state.tabs.find((item) => nodeHasSession(item.root, sessionId));
      if (!tab) {
        const detachedIndex = state.detachedSessionIds.indexOf(sessionId);
        if (detachedIndex < 0) return false;
        state.detachedSessionIds.splice(detachedIndex, 1);
        return true;
      }
      const order = collectSessionIds(tab.root);
      const index = order.indexOf(sessionId);
      const result = removePaneNode(tab.root, sessionId);
      if (!result.node) {
        const tabIndex = state.tabs.findIndex((item) => item.id === tab.id);
        state.tabs.splice(tabIndex, 1);
        if (state.activeTabId === tab.id) {
          state.activeTabId = state.tabs[Math.min(tabIndex, state.tabs.length - 1)]?.id;
        }
      } else {
        tab.root = result.node;
        const remaining = collectSessionIds(tab.root);
        if (tab.activeSessionId === sessionId) {
          tab.activeSessionId = remaining[Math.min(index, remaining.length - 1)];
        }
        if (tab.zoomedSessionId === sessionId) tab.zoomedSessionId = undefined;
      }
      return true;
    });
  }

  reconcile(
    validSessionIdsValue: Iterable<string>,
    options: { addMissing?: boolean } = {},
  ): TerminalWorkspaceSnapshot {
    const validSessionIds = [...new Set(validSessionIdsValue)].map((id) => cleanId(id, "Session ID"));
    const valid = new Set(validSessionIds);
    return this.update(undefined, (state) => {
      const before = JSON.stringify(state);
      state.detachedSessionIds = state.detachedSessionIds.filter((sessionId) => valid.has(sessionId));
      state.tabs = state.tabs.flatMap((tab) => {
        const root = pruneNode(tab.root, valid);
        if (!root) return [];
        const panes = collectSessionIds(root);
        tab.root = root;
        if (!panes.includes(tab.activeSessionId)) tab.activeSessionId = panes[0];
        if (tab.zoomedSessionId && !panes.includes(tab.zoomedSessionId)) tab.zoomedSessionId = undefined;
        return [tab];
      });
      if (state.activeTabId && !state.tabs.some((tab) => tab.id === state.activeTabId)) {
        state.activeTabId = state.tabs[0]?.id;
      }
      if (options.addMissing) {
        const present = new Set(state.tabs.flatMap((tab) => collectSessionIds(tab.root)));
        for (const sessionId of validSessionIds) {
          if (
            present.has(sessionId) || state.detachedSessionIds.includes(sessionId) ||
            state.tabs.length >= MAX_TABS ||
            present.size + state.detachedSessionIds.length >= MAX_PANES_TOTAL
          ) continue;
          const tab: TerminalWorkspaceTab = {
            id: newTabId(),
            root: { id: newNodeId("pane"), type: "pane", sessionId },
            activeSessionId: sessionId,
          };
          state.tabs.push(tab);
          state.activeTabId ||= tab.id;
          present.add(sessionId);
        }
      }
      return JSON.stringify(state) !== before;
    });
  }

  resetForTests(): TerminalWorkspaceSnapshot {
    const next = emptyState();
    next.revision = this.state.revision + 1;
    this.persist(next);
    this.state = next;
    this.undoCloseStack.length = 0;
    return this.snapshot();
  }

  private direction(value: unknown): TerminalPaneDirection {
    if (value === "left" || value === "right" || value === "up" || value === "down") return value;
    throw new TerminalWorkspaceError("Pane direction must be left, right, up, or down");
  }

  private assertSessionAbsent(state: TerminalWorkspaceState, sessionId: string) {
    if (state.tabs.some((tab) => nodeHasSession(tab.root, sessionId))) {
      throw new TerminalWorkspaceError("Session is already present in the terminal workspace", 409);
    }
  }

  private tabForSession(state: TerminalWorkspaceState, sessionId: string): TerminalWorkspaceTab {
    const tab = state.tabs.find((item) => nodeHasSession(item.root, sessionId));
    if (!tab) throw new TerminalWorkspaceError("Pane was not found", 404);
    return tab;
  }

  private assertRevision(expectedRevision?: number) {
    if (expectedRevision === undefined) return;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TerminalWorkspaceError("expectedRevision must be a nonnegative integer");
    }
    if (expectedRevision !== this.state.revision) {
      throw new TerminalWorkspaceError(
        `Workspace revision conflict: expected ${expectedRevision}, current ${this.state.revision}`,
        409,
      );
    }
  }

  private update(
    expectedRevision: number | undefined,
    mutate: (state: TerminalWorkspaceState) => boolean,
    options: { saveUndo?: boolean } = {},
  ): TerminalWorkspaceSnapshot {
    this.assertRevision(expectedRevision);
    const previous = copy(this.state);
    const next = copy(this.state);
    if (!mutate(next)) return this.snapshot();
    next.revision = this.state.revision + 1;
    next.updatedAt = Date.now();
    const validated = validateState(next);
    this.persist(validated);
    this.state = validated;
    if (options.saveUndo) {
      this.undoCloseStack.push(previous);
      if (this.undoCloseStack.length > MAX_UNDO_CLOSE) this.undoCloseStack.shift();
    } else {
      this.undoCloseStack.length = 0;
    }
    return this.snapshot();
  }

  private load(): TerminalWorkspaceState {
    for (const path of [this.statePath, `${this.statePath}.bak`]) {
      try {
        if (!existsSync(path)) continue;
        return validateState(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        // A corrupt current generation falls back to the prior generation.
      }
    }
    return emptyState();
  }

  private persist(state: TerminalWorkspaceState) {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.tmp`;
    const backup = `${this.statePath}.bak`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    try {
      if (existsSync(this.statePath)) {
        rmSync(backup, { force: true });
        renameSync(this.statePath, backup);
      }
      renameSync(temporary, this.statePath);
      chmodSync(this.statePath, 0o600);
    } catch (error) {
      rmSync(temporary, { force: true });
      if (!existsSync(this.statePath) && existsSync(backup)) renameSync(backup, this.statePath);
      throw error;
    }
  }
}

export const terminalWorkspace = new TerminalWorkspaceService();
