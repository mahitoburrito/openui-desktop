import type { Node } from "@xyflow/react";
import type { AgentSession, AgentStatus } from "../stores/useStore";

const GRID_SIZE = 24;
const NODE_WIDTH = 220;
const NODE_HEIGHT = 132;
const GAP_X = 64;
const GAP_Y = 52;

// Padding inside a category box around its agent grid.
const CAT_PAD_X = 24;
const CAT_PAD_TOP = 56; // room for the category label/title row
const CAT_PAD_BOTTOM = 24;
// Vertical gap between stacked category boxes (and the uncategorized grid).
const GROUP_GAP_Y = 80;
const CANVAS_ORIGIN_X = 96;
const CANVAS_ORIGIN_Y = 96;
const TITLE_CLUSTER_PREFIX = "title-cluster-";
const TITLE_CLUSTER_COLORS = [
  "#D97652",
  "oklch(70% 0.11 80)",
  "oklch(70% 0.10 170)",
  "oklch(69% 0.12 230)",
  "oklch(72% 0.11 310)",
];

export interface TitleClusterGroup {
  label: string;
  nodeIds: string[];
  reason?: string;
}

export interface TitleClusterPlan {
  source: "gemini" | "fallback" | "empty";
  groups: TitleClusterGroup[];
}

const STATUS_PRIORITY: Record<AgentStatus, number> = {
  waiting_input: 0,
  error: 1,
  running: 2,
  tool_calling: 3,
  creating: 4,
  idle: 5,
  disconnected: 6,
};

function snap(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

function nodeCreatedAt(nodeId: string, sessions: Map<string, AgentSession>): number {
  const createdAt = sessions.get(nodeId)?.createdAt;
  return createdAt ? new Date(createdAt).getTime() : 0;
}

function sessionTitle(session: AgentSession | undefined, node: Node): string {
  const label = typeof node.data?.label === "string" ? node.data.label.trim() : "";
  const agentName = session?.agentName?.trim() || "";
  const customName = session?.customName?.trim();
  const ticketTitle = session?.ticketTitle?.trim();

  if (customName) return customName;
  if (ticketTitle) return ticketTitle;
  if (label && label !== agentName && label !== session?.agentId) return label;
  return "";
}

function titleClusterId(title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${TITLE_CLUSTER_PREFIX}${normalized || "recent"}`;
}

function isTitleCluster(node: Node): boolean {
  return node.type === "category" && node.id.startsWith(TITLE_CLUSTER_PREFIX);
}

function titleClusterColor(index: number): string {
  return TITLE_CLUSTER_COLORS[index % TITLE_CLUSTER_COLORS.length];
}

// Resolve a node's box. Category nodes carry size in style.width/height (or
// node.width/height); agent nodes use fixed card dimensions.
function nodeSize(node: Node): { w: number; h: number } {
  const styleW = typeof node.style?.width === "number" ? node.style.width : undefined;
  const styleH = typeof node.style?.height === "number" ? node.style.height : undefined;
  return {
    w: styleW ?? (node.width as number | undefined) ?? NODE_WIDTH,
    h: styleH ?? (node.height as number | undefined) ?? NODE_HEIGHT,
  };
}

// An agent belongs to a category if the agent's center sits inside the
// category's bounding box. (Membership is spatial — there is no parentId.)
function centerInBox(
  agentPos: { x: number; y: number },
  box: { x: number; y: number; w: number; h: number },
): boolean {
  const cx = agentPos.x + NODE_WIDTH / 2;
  const cy = agentPos.y + NODE_HEIGHT / 2;
  return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
}

function sortAgents(agentNodes: Node[], sessions: Map<string, AgentSession>): Node[] {
  return [...agentNodes].sort((a, b) => {
    const sessionA = sessions.get(a.id);
    const sessionB = sessions.get(b.id);
    const priorityA = sessionA ? STATUS_PRIORITY[sessionA.status] : 99;
    const priorityB = sessionB ? STATUS_PRIORITY[sessionB.status] : 99;
    if (priorityA !== priorityB) return priorityA - priorityB;
    return nodeCreatedAt(b.id, sessions) - nodeCreatedAt(a.id, sessions);
  });
}

function columnsFor(count: number): number {
  return Math.min(5, Math.max(2, Math.ceil(Math.sqrt(count))));
}

// Lay agents out in a grid whose top-left cell sits at (originX, originY).
// Returns the per-node positions plus the grid's overall width/height so a
// surrounding category box can be sized to fit.
function gridLayout(
  agents: Node[],
  originX: number,
  originY: number,
): { positions: Map<string, { x: number; y: number }>; width: number; height: number } {
  const positions = new Map<string, { x: number; y: number }>();
  if (agents.length === 0) return { positions, width: 0, height: 0 };

  const cols = columnsFor(agents.length);
  agents.forEach((node, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    positions.set(node.id, {
      x: snap(originX + col * (NODE_WIDTH + GAP_X)),
      y: snap(originY + row * (NODE_HEIGHT + GAP_Y)),
    });
  });

  const usedCols = Math.min(cols, agents.length);
  const rows = Math.ceil(agents.length / cols);
  const width = usedCols * NODE_WIDTH + (usedCols - 1) * GAP_X;
  const height = rows * NODE_HEIGHT + (rows - 1) * GAP_Y;
  return { positions, width, height };
}

/**
 * Tidy the canvas. Agents are grouped under the category node that spatially
 * contains them: each category box is moved into a vertical stack, its members
 * arranged in a grid inside it, and the box resized to fit. Agents not inside
 * any category are arranged in a grid below the category stack.
 *
 * Returns a new nodes array (categories repositioned/resized, agents moved).
 * Categories with no members are still stacked so they stay reachable.
 */
export function buildCleanCanvasLayout(
  nodes: Node[],
  sessions: Map<string, AgentSession>,
): Node[] {
  const categoryNodes = nodes.filter((n) => n.type === "category");
  const agentNodes = nodes.filter((n) => n.type === "agent");

  if (agentNodes.length === 0 && categoryNodes.length === 0) return nodes;

  // Assign each agent to the first category whose box contains its center.
  const boxes = categoryNodes.map((cat) => {
    const { w, h } = nodeSize(cat);
    return { id: cat.id, x: cat.position.x, y: cat.position.y, w, h };
  });

  const membersByCat = new Map<string, Node[]>();
  categoryNodes.forEach((c) => membersByCat.set(c.id, []));
  const uncategorized: Node[] = [];

  for (const agent of agentNodes) {
    const owner = boxes.find((box) => centerInBox(agent.position, box));
    if (owner) membersByCat.get(owner.id)!.push(agent);
    else uncategorized.push(agent);
  }

  const agentPositions = new Map<string, { x: number; y: number }>();
  const categoryUpdates = new Map<string, { x: number; y: number; w: number; h: number }>();

  let cursorY = CANVAS_ORIGIN_Y;
  const originX = CANVAS_ORIGIN_X;

  // Stack each category box, with its members gridded inside.
  for (const cat of categoryNodes) {
    const members = sortAgents(membersByCat.get(cat.id) ?? [], sessions);
    const innerOriginX = originX + CAT_PAD_X;
    const innerOriginY = cursorY + CAT_PAD_TOP;
    const { positions, width, height } = gridLayout(members, innerOriginX, innerOriginY);

    for (const [id, pos] of positions) agentPositions.set(id, pos);

    // Size the box to its grid (with a sensible minimum for empty categories).
    const boxW = Math.max(NODE_WIDTH + CAT_PAD_X * 2, width + CAT_PAD_X * 2);
    const boxH = Math.max(140, CAT_PAD_TOP + height + CAT_PAD_BOTTOM);
    categoryUpdates.set(cat.id, { x: snap(originX), y: snap(cursorY), w: snap(boxW), h: snap(boxH) });

    cursorY = cursorY + boxH + GROUP_GAP_Y;
  }

  // Uncategorized agents in a grid below the category stack.
  if (uncategorized.length > 0) {
    const sorted = sortAgents(uncategorized, sessions);
    const { positions } = gridLayout(sorted, originX, cursorY);
    for (const [id, pos] of positions) agentPositions.set(id, pos);
  }

  return nodes.map((node) => {
    if (node.type === "agent") {
      const pos = agentPositions.get(node.id);
      return pos ? { ...node, position: pos } : node;
    }
    if (node.type === "category") {
      const upd = categoryUpdates.get(node.id);
      if (!upd) return node;
      return {
        ...node,
        position: { x: upd.x, y: upd.y },
        style: { ...node.style, width: upd.w, height: upd.h },
        width: upd.w,
        height: upd.h,
      };
    }
    return node;
  });
}

export function buildTitleClusterCanvasLayout(
  nodes: Node[],
  sessions: Map<string, AgentSession>,
  plan?: TitleClusterPlan | null,
): Node[] {
  const manualNodes = nodes.filter((node) => !isTitleCluster(node));
  const manualCategories = manualNodes.filter((node) => node.type === "category");
  const agentNodes = manualNodes.filter((node) => node.type === "agent");

  if (agentNodes.length === 0) return manualNodes;

  const agentById = new Map(agentNodes.map((agent) => [agent.id, agent]));
  let orderedGroups: [string, { title: string; hasTitle: boolean; agents: Node[] }][] = [];

  if (plan?.groups?.length) {
    const used = new Set<string>();
    orderedGroups = plan.groups
      .map((group, index): [string, { title: string; hasTitle: boolean; agents: Node[] }] | null => {
        const agents = group.nodeIds
          .map((id) => agentById.get(id))
          .filter((agent): agent is Node => Boolean(agent) && !used.has(agent.id));
        if (agents.length === 0) return null;
        agents.forEach((agent) => used.add(agent.id));
        const title = group.label?.trim() || "Related Work";
        return [
          `${titleClusterId(title)}-${index}`,
          { title, hasTitle: true, agents },
        ];
      })
      .filter((group): group is [string, { title: string; hasTitle: boolean; agents: Node[] }] => Boolean(group));

    const remainingAgents = agentNodes.filter((agent) => !used.has(agent.id));
    if (remainingAgents.length > 0) {
      orderedGroups.push([
        titleClusterId("Untitled, recent first"),
        { title: "Untitled, recent first", hasTitle: false, agents: remainingAgents },
      ]);
    }
  } else {
    const groups = new Map<string, { title: string; hasTitle: boolean; agents: Node[] }>();
    for (const agent of agentNodes) {
      const session = sessions.get(agent.id);
      const title = sessionTitle(session, agent);
      const groupTitle = title || "Untitled, recent first";
      const id = titleClusterId(groupTitle);
      const existing = groups.get(id);
      if (existing) {
        existing.agents.push(agent);
      } else {
        groups.set(id, { title: groupTitle, hasTitle: !!title, agents: [agent] });
      }
    }

    orderedGroups = Array.from(groups.entries()).sort(([, a], [, b]) => {
      if (a.hasTitle !== b.hasTitle) return a.hasTitle ? -1 : 1;
      if (!a.hasTitle && !b.hasTitle) {
        const newestA = Math.max(...a.agents.map((agent) => nodeCreatedAt(agent.id, sessions)));
        const newestB = Math.max(...b.agents.map((agent) => nodeCreatedAt(agent.id, sessions)));
        return newestB - newestA;
      }
      return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    });
  }

  const agentPositions = new Map<string, { x: number; y: number }>();
  const clusterNodes: Node[] = [];
  let cursorY = CANVAS_ORIGIN_Y;

  orderedGroups.forEach(([id, group], index) => {
    const sortedAgents = group.hasTitle
      ? [...group.agents].sort((a, b) => nodeCreatedAt(b.id, sessions) - nodeCreatedAt(a.id, sessions))
      : sortAgents(group.agents, sessions);
    const innerOriginX = CANVAS_ORIGIN_X + CAT_PAD_X;
    const innerOriginY = cursorY + CAT_PAD_TOP;
    const { positions, width, height } = gridLayout(sortedAgents, innerOriginX, innerOriginY);

    for (const [agentId, pos] of positions) agentPositions.set(agentId, pos);

    const boxW = Math.max(NODE_WIDTH + CAT_PAD_X * 2, width + CAT_PAD_X * 2);
    const boxH = Math.max(150, CAT_PAD_TOP + height + CAT_PAD_BOTTOM);
    const color = titleClusterColor(index);
    clusterNodes.push({
      id,
      type: "category",
      position: { x: snap(CANVAS_ORIGIN_X), y: snap(cursorY) },
      style: { width: snap(boxW), height: snap(boxH) },
      width: snap(boxW),
      height: snap(boxH),
      data: {
        label: group.title,
        color,
      },
      zIndex: -1,
    });

    cursorY = cursorY + boxH + GROUP_GAP_Y;
  });

  const movedAgents = agentNodes.map((node) => {
    const pos = agentPositions.get(node.id);
    return pos ? { ...node, position: pos } : node;
  });

  return [...manualCategories, ...clusterNodes, ...movedAgents];
}

export async function fetchTitleClusterPlan(
  nodes: Node[],
  sessions: Map<string, AgentSession>,
): Promise<TitleClusterPlan | null> {
  const agentNodes = nodes.filter((node) => node.type === "agent");
  if (agentNodes.length === 0) return null;

  const res = await fetch("/api/layout/title-clusters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nodes: agentNodes.map((node) => {
        const session = sessions.get(node.id);
        return {
          id: node.id,
          label: typeof node.data?.label === "string" ? node.data.label : "",
          sessionId: session?.sessionId,
        };
      }),
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data?.groups)) return null;
  return data as TitleClusterPlan;
}

export async function persistAgentPositions(nodes: Node[]): Promise<void> {
  const positions: Record<string, { x: number; y: number }> = {};
  for (const node of nodes) {
    if (node.type !== "agent") continue;
    positions[node.id] = {
      x: snap(node.position.x),
      y: snap(node.position.y),
    };
  }
  if (Object.keys(positions).length > 0) {
    await fetch("/api/state/positions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positions }),
    });
  }

  // Persist any category boxes that cleanup moved/resized, including generated
  // title clusters. Generated clusters missing from the next layout are removed.
  const categoryNodes = nodes.filter((n) => n.type === "category");
  const desiredCategoryIds = new Set(categoryNodes.map((cat) => cat.id));
  let existingCategories: { id: string }[] = [];
  try {
    const res = await fetch("/api/categories");
    if (res.ok) existingCategories = await res.json();
  } catch {
    existingCategories = [];
  }
  const existingIds = new Set(existingCategories.map((cat) => cat.id));

  const staleGeneratedDeletes = existingCategories
    .filter((cat) => cat.id.startsWith(TITLE_CLUSTER_PREFIX) && !desiredCategoryIds.has(cat.id))
    .map((cat) => fetch(`/api/categories/${cat.id}`, { method: "DELETE" }).catch(() => undefined));

  const categoryWrites = categoryNodes.map((cat) => {
    const w = typeof cat.style?.width === "number" ? cat.style.width : (cat.width as number | undefined);
    const h = typeof cat.style?.height === "number" ? cat.style.height : (cat.height as number | undefined);
    const payload = {
      id: cat.id,
      label: typeof cat.data?.label === "string" ? cat.data.label : "Cluster",
      color: typeof cat.data?.color === "string" ? cat.data.color : "#D97652",
      position: cat.position,
      width: w,
      height: h,
    };

    if (existingIds.has(cat.id)) {
      return fetch(`/api/categories/${cat.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => undefined);
    }

    return fetch("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => undefined);
  });
  await Promise.all([...staleGeneratedDeletes, ...categoryWrites]);
}
