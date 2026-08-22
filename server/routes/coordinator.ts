import { Hono } from "hono";
import type { Session } from "../types";
import { sessions, getTerminalSnapshot, getTerminalWriteQueueState } from "../services/sessionManager";
import {
  CoordinatorStoreError,
  coordinatorStore,
  type CoordinatorAuthor,
  type CoordinatorMode,
} from "../services/coordinatorStore";
import {
  coordinatorDeliveryReadiness,
  coordinatorRuntime,
} from "../services/coordinatorRuntime";
import { sessionDisplayTitle } from "../../shared/sessionTitle";

export const coordinatorRoutes = new Hono();

function author(value: unknown): CoordinatorAuthor {
  return value === "user" ? "user" : "coordinator";
}

function errorResponse(c: any, error: unknown) {
  const message = error instanceof Error ? error.message : "Coordinator request failed";
  const status = error instanceof CoordinatorStoreError ? error.status : 500;
  return c.json({ error: message }, status as any);
}

function sessionSummary(sessionId: string, session: Session) {
  const terminal = getTerminalSnapshot(sessionId, false);
  const blocks = terminal?.blocks.slice(-5).map((block) => ({
    id: block.id,
    command: block.command,
    status: block.status,
    startedAt: block.startedAt,
    completedAt: block.completedAt,
    exitCode: block.exitCode,
  })) || [];
  return {
    sessionId,
    nodeId: session.nodeId,
    displayName: sessionDisplayTitle(session),
    agentId: session.agentId,
    agentName: session.agentName,
    status: session.status,
    statusChangedAt: session.statusChangedAt,
    currentTool: session.currentTool,
    cwd: session.cwd,
    gitBranch: session.gitBranch,
    isRestored: session.isRestored,
    readiness: coordinatorDeliveryReadiness(session, getTerminalWriteQueueState(sessionId)),
    recentBlocks: blocks,
  };
}

coordinatorRoutes.get("/snapshot", (c) => {
  coordinatorRuntime.reconcile();
  const state = coordinatorStore.snapshot();
  return c.json({
    mode: state.mode,
    nextSequence: state.nextSequence,
    sessions: [...sessions.entries()]
      .filter(([, session]) => !session.pendingDelete)
      .map(([sessionId, session]) => sessionSummary(sessionId, session)),
    activeDecisions: state.decisions.filter((decision) => decision.status === "active"),
    decisions: state.decisions.slice(-100),
    directives: state.directives.slice(-200),
    events: state.events.slice(-200),
  });
});

coordinatorRoutes.get("/events", (c) => {
  const raw = Number(c.req.query("after") || 0);
  const after = Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
  const events = coordinatorStore.eventsAfter(after);
  return c.json({ events, nextSequence: coordinatorStore.snapshot().nextSequence });
});

coordinatorRoutes.put("/mode", async (c) => {
  try {
    const body = await c.req.json();
    return c.json({ mode: coordinatorStore.setMode(body.mode as CoordinatorMode, author(body.author)) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

coordinatorRoutes.post("/decisions", async (c) => {
  try {
    const body = await c.req.json();
    if (body.scope?.kind === "sessions") {
      for (const sessionId of body.scope.sessionIds || []) {
        if (!sessions.has(sessionId) || sessions.get(sessionId)?.pendingDelete) {
          throw new CoordinatorStoreError(`Scope contains unknown session ${sessionId}`, 404);
        }
      }
    }
    return c.json({ decision: coordinatorStore.createDecision({ ...body, author: author(body.author) }) }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

coordinatorRoutes.post("/decisions/:decisionId/revoke", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    return c.json({
      decision: coordinatorStore.revokeDecision(c.req.param("decisionId"), author(body.author)),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

coordinatorRoutes.post("/directives", async (c) => {
  try {
    const body = await c.req.json();
    if (
      typeof body.sessionId !== "string" ||
      !sessions.has(body.sessionId) ||
      sessions.get(body.sessionId)?.pendingDelete
    ) {
      throw new CoordinatorStoreError("An exact active sessionId is required", 404);
    }
    const result = coordinatorStore.createDirective({ ...body, author: author(body.author) });
    const directive = result.duplicate
      ? result.directive
      : coordinatorRuntime.dispatchNow(result.directive.id);
    const readiness = coordinatorDeliveryReadiness(
      sessions.get(directive.sessionId),
      getTerminalWriteQueueState(directive.sessionId),
    );
    return c.json({ directive, duplicate: result.duplicate, readiness }, result.duplicate ? 200 : 202);
  } catch (error) {
    return errorResponse(c, error);
  }
});

coordinatorRoutes.post("/directives/:directiveId/acknowledge", async (c) => {
  try {
    return c.json({ directive: coordinatorStore.acknowledgeDirective(c.req.param("directiveId")) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

coordinatorRoutes.post("/directives/:directiveId/cancel", async (c) => {
  try {
    return c.json({ directive: coordinatorStore.cancelDirective(c.req.param("directiveId")) });
  } catch (error) {
    return errorResponse(c, error);
  }
});
