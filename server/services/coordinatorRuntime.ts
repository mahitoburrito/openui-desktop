import type { Session } from "../types";
import { sessions, getTerminalWriteQueueState, writeTerminalData } from "./sessionManager";
import {
  CoordinatorStore,
  CoordinatorStoreError,
  coordinatorStore,
  type CoordinatorDirective,
} from "./coordinatorStore";

type CoordinatorSession = Pick<Session, "pty" | "status" | "pendingDelete" | "isRestored" | "firstInputBuffer">
  & Partial<Pick<Session, "statusChangedAt" | "pendingStatus">>;
type SessionMap = Map<string, CoordinatorSession>;
type TerminalWriter = typeof writeTerminalData;
type QueueStateReader = (sessionId: string) => { bytes: number; writes: number };

const ACTIVE_DIRECTIVE_STATES = new Set(["submitted", "observed_working"]);
export const COORDINATOR_IDLE_STABILITY_MS = 3_000;

export interface CoordinatorDeliveryReadiness {
  safe: boolean;
  reason: string;
}

export function coordinatorDeliveryReadiness(
  session: CoordinatorSession | undefined,
  queueState: { bytes: number; writes: number } = { bytes: 0, writes: 0 },
  now = Date.now(),
): CoordinatorDeliveryReadiness {
  if (!session || session.pendingDelete) return { safe: false, reason: "Target session no longer exists" };
  if (!session.pty || session.isRestored) return { safe: false, reason: "Target session has no live process" };
  if (session.status === "waiting_input") {
    return { safe: false, reason: "Target is awaiting input; automatic typing could answer a question or permission prompt" };
  }
  if (session.status !== "idle") return { safe: false, reason: `Target must be idle (currently ${session.status})` };
  if (session.pendingStatus && session.pendingStatus !== "idle") {
    return { safe: false, reason: `Target has a pending ${session.pendingStatus} status` };
  }
  if (
    typeof session.statusChangedAt === "number" &&
    now - session.statusChangedAt < COORDINATOR_IDLE_STABILITY_MS
  ) {
    return { safe: false, reason: "Target idle status is still stabilizing" };
  }
  if (session.firstInputBuffer?.length) {
    return { safe: false, reason: "Target has user input waiting on its prompt" };
  }
  if (queueState.writes > 0 || queueState.bytes > 0) {
    return { safe: false, reason: "Target still has terminal input queued" };
  }
  return { safe: true, reason: "Ready at an idle agent prompt" };
}

function directivePrompt(directive: CoordinatorDirective): string {
  const linkedDecision = directive.decisionId
    ? `\nLinked coordinator decision: ${directive.decisionId}`
    : "";
  return [
    `[OpenUI Coordinator directive ${directive.id}]`,
    directive.text,
    linkedDecision,
    `\nWhen you have incorporated this directive, mention its ID in your response. OpenUI records this terminal submission as unconfirmed until an explicit acknowledgment is received.`,
  ].join("\n");
}

export class CoordinatorRuntime {
  private readonly dispatching = new Set<string>();
  private readonly knownStatuses = new Map<string, string>();
  private seededSessions = false;

  constructor(
    readonly store: CoordinatorStore,
    private readonly sessionMap: SessionMap,
    private readonly writer: TerminalWriter,
    private readonly queueState: QueueStateReader = () => ({ bytes: 0, writes: 0 }),
  ) {}

  reconcile(now = Date.now()) {
    this.store.expireDirectives(now);
    for (const [sessionId, session] of this.sessionMap) {
      const previous = this.knownStatuses.get(sessionId);
      if (previous === undefined) {
        this.knownStatuses.set(sessionId, session.status);
        if (this.seededSessions) {
          this.store.appendEvent(
            "session.observed",
            `Session ${sessionId} is available with status ${session.status}`,
            { sessionId },
          );
        }
      } else if (previous !== session.status) {
        this.knownStatuses.set(sessionId, session.status);
        this.store.appendEvent(
          "session.status.changed",
          `Session ${sessionId} changed from ${previous} to ${session.status}`,
          { sessionId },
        );
      }
    }
    for (const [sessionId] of this.knownStatuses) {
      if (this.sessionMap.has(sessionId)) continue;
      this.knownStatuses.delete(sessionId);
      this.store.appendEvent("session.removed", `Session ${sessionId} was removed`, { sessionId });
    }
    this.seededSessions = true;
    const snapshot = this.store.snapshot();

    for (const directive of snapshot.directives) {
      const session = this.sessionMap.get(directive.sessionId);
      if (!session && directive.state === "queued") {
        this.store.transitionDirective(directive.id, "failed", {
          failureReason: "Target session no longer exists",
        });
        continue;
      }
      if (!session) continue;
      if (
        directive.state === "submitted" &&
        (session.status === "running" || session.status === "tool_calling")
      ) {
        this.store.transitionDirective(directive.id, "observed_working");
      } else if (directive.state === "observed_working" && session.status === "idle") {
        this.store.transitionDirective(directive.id, "completed_unconfirmed");
      }
    }

    if (snapshot.mode === "observe") return;

    for (const [sessionId, session] of this.sessionMap) {
      const directives = this.store.directivesForSession(sessionId);
      if (directives.some((item) => ACTIVE_DIRECTIVE_STATES.has(item.state))) continue;
      const queued = directives.find((item) => item.state === "queued" && item.expiresAt > now);
      if (!queued || this.dispatching.has(queued.id)) continue;
      if (!coordinatorDeliveryReadiness(session, this.queueState(sessionId), now).safe) continue;
      this.dispatch(queued);
    }
  }

  dispatchNow(directiveId: string): CoordinatorDirective {
    const directive = this.store.getDirective(directiveId);
    if (!directive) throw new CoordinatorStoreError("Directive not found", 404);
    if (directive.state !== "queued") return directive;
    if (this.store.snapshot().mode === "observe") return directive;
    const session = this.sessionMap.get(directive.sessionId);
    const readiness = coordinatorDeliveryReadiness(session, this.queueState(directive.sessionId));
    if (!readiness.safe) return directive;
    const hasActive = this.store.directivesForSession(directive.sessionId)
      .some((item) => item.id !== directive.id && ACTIVE_DIRECTIVE_STATES.has(item.state));
    if (!hasActive) this.dispatch(directive);
    return this.store.getDirective(directive.id)!;
  }

  private dispatch(directive: CoordinatorDirective) {
    if (this.dispatching.has(directive.id)) return;
    this.dispatching.add(directive.id);
    const finish = () => this.dispatching.delete(directive.id);
    const accepted = this.writer(directive.sessionId, directivePrompt(directive), {
      kind: "automation",
      bracketedPaste: true,
      clearLine: false,
      submit: true,
      onComplete: () => {
        finish();
        try { this.store.transitionDirective(directive.id, "submitted"); } catch {}
      },
      onError: (error) => {
        finish();
        try {
          this.store.transitionDirective(directive.id, "failed", {
            failureReason: error instanceof Error ? error.message : "Terminal writer failed",
          });
        } catch {}
      },
    });
    if (!accepted) {
      finish();
      this.store.transitionDirective(directive.id, "failed", {
        failureReason: "Terminal writer rejected the directive",
      });
    }
  }
}

export const coordinatorRuntime = new CoordinatorRuntime(
  coordinatorStore,
  sessions,
  writeTerminalData,
  getTerminalWriteQueueState,
);

let reconciliationTimer: ReturnType<typeof setInterval> | undefined;

export function startCoordinatorRuntime() {
  if (reconciliationTimer) return;
  coordinatorRuntime.reconcile();
  reconciliationTimer = setInterval(() => coordinatorRuntime.reconcile(), 1_000);
  reconciliationTimer.unref?.();
}

export function stopCoordinatorRuntime() {
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  reconciliationTimer = undefined;
}
