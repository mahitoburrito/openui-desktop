import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "fs";
import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { getDataDir } from "./persistence";

export type CoordinatorMode = "observe" | "coordinate" | "control";
export type CoordinatorAuthor = "user" | "coordinator";
export type CoordinatorDecisionStatus = "active" | "superseded" | "revoked";
export type CoordinatorDirectiveState =
  | "queued"
  | "submitted"
  | "observed_working"
  | "completed_unconfirmed"
  | "acknowledged"
  | "rejected"
  | "failed"
  | "expired"
  | "cancelled";

export type CoordinatorDecisionScope =
  | { kind: "workspace" }
  | { kind: "sessions"; sessionIds: string[] };

export interface CoordinatorDecision {
  id: string;
  topic: string;
  choice: string;
  rationale: string;
  scope: CoordinatorDecisionScope;
  revision: number;
  status: CoordinatorDecisionStatus;
  supersedes?: string;
  author: CoordinatorAuthor;
  createdAt: number;
  updatedAt: number;
}

export interface CoordinatorDirective {
  id: string;
  clientRequestId?: string;
  sessionId: string;
  text: string;
  decisionId?: string;
  state: CoordinatorDirectiveState;
  author: CoordinatorAuthor;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  submittedAt?: number;
  acknowledgedAt?: number;
  failureReason?: string;
}

export interface CoordinatorEvent {
  id: string;
  sequence: number;
  type: string;
  sessionId?: string;
  decisionId?: string;
  directiveId?: string;
  summary: string;
  createdAt: number;
}

interface CoordinatorPersistedState {
  version: 1;
  mode: CoordinatorMode;
  nextSequence: number;
  decisions: CoordinatorDecision[];
  directives: CoordinatorDirective[];
  events: CoordinatorEvent[];
}

export interface CoordinatorStateSnapshot extends CoordinatorPersistedState {
  stateFile: string;
}

export class CoordinatorStoreError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const MAX_DECISIONS = 500;
const MAX_DIRECTIVES = 1_000;
const MAX_EVENTS = 2_000;
const MAX_STATE_BYTES = 5_000_000;
const DEFAULT_DIRECTIVE_TTL_MS = 30 * 60_000;
const MAX_DIRECTIVE_TTL_MS = 24 * 60 * 60_000;

const TERMINAL_DIRECTIVE_STATES = new Set<CoordinatorDirectiveState>([
  "completed_unconfirmed",
  "acknowledged",
  "rejected",
  "failed",
  "expired",
  "cancelled",
]);

function cleanString(value: unknown, label: string, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new CoordinatorStoreError(`${label} must be a string`);
  const result = value.trim();
  if ((required && !result) || result.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result)) {
    throw new CoordinatorStoreError(`${label} must be ${required ? "non-empty and " : ""}at most ${max} safe characters`);
  }
  return result;
}

function identifier(value: unknown, label: string, required = true): string | undefined {
  const result = cleanString(value, label, 512, required);
  if (result !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) {
    throw new CoordinatorStoreError(`${label} has an invalid format`);
  }
  return result;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function emptyState(): CoordinatorPersistedState {
  return {
    version: 1,
    mode: "coordinate",
    nextSequence: 1,
    decisions: [],
    directives: [],
    events: [],
  };
}

function parseScope(value: unknown): CoordinatorDecisionScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoordinatorStoreError("scope must be an object");
  }
  if ((value as any).kind === "workspace") return { kind: "workspace" };
  if ((value as any).kind !== "sessions" || !Array.isArray((value as any).sessionIds)) {
    throw new CoordinatorStoreError("scope must target the workspace or an explicit session list");
  }
  const sessionIds: string[] = [...new Set<string>(
    (value as any).sessionIds.map((item: unknown) => identifier(item, "scope session ID")!),
  )];
  if (sessionIds.length === 0 || sessionIds.length > 100) {
    throw new CoordinatorStoreError("session scope must contain between 1 and 100 exact session IDs");
  }
  return { kind: "sessions", sessionIds };
}

function parseLoadedState(value: unknown): CoordinatorPersistedState | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as any).version !== 1) return null;
    const raw = value as any;
    if (!(["observe", "coordinate", "control"] as unknown[]).includes(raw.mode)) return null;
    if (!Number.isSafeInteger(raw.nextSequence) || raw.nextSequence < 1) return null;
    if (!Array.isArray(raw.decisions) || !Array.isArray(raw.directives) || !Array.isArray(raw.events)) return null;

    const decisions = raw.decisions.slice(-MAX_DECISIONS).map((item: any): CoordinatorDecision => {
      const status = item?.status;
      const author = item?.author;
      if (!["active", "superseded", "revoked"].includes(status)) throw new Error("decision status");
      if (!["user", "coordinator"].includes(author)) throw new Error("decision author");
      if (!Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error("decision revision");
      return {
        id: identifier(item.id, "decision ID")!,
        topic: cleanString(item.topic, "decision topic", 240)!,
        choice: cleanString(item.choice, "decision choice", 4_000)!,
        rationale: cleanString(item.rationale, "decision rationale", 8_000)!,
        scope: parseScope(item.scope),
        revision: item.revision,
        status,
        supersedes: identifier(item.supersedes, "superseded decision ID", false),
        author,
        createdAt: finiteTimestamp(item.createdAt) ?? (() => { throw new Error("decision createdAt"); })(),
        updatedAt: finiteTimestamp(item.updatedAt) ?? (() => { throw new Error("decision updatedAt"); })(),
      };
    });

    const directives = raw.directives.slice(-MAX_DIRECTIVES).map((item: any): CoordinatorDirective => {
      const state = item?.state;
      const author = item?.author;
      if (![
        "queued", "submitted", "observed_working", "completed_unconfirmed", "acknowledged",
        "rejected", "failed", "expired", "cancelled",
      ].includes(state)) throw new Error("directive state");
      if (!["user", "coordinator"].includes(author)) throw new Error("directive author");
      return {
        id: identifier(item.id, "directive ID")!,
        clientRequestId: identifier(item.clientRequestId, "client request ID", false),
        sessionId: identifier(item.sessionId, "session ID")!,
        text: cleanString(item.text, "directive", 12_000)!,
        decisionId: identifier(item.decisionId, "decision ID", false),
        state,
        author,
        createdAt: finiteTimestamp(item.createdAt) ?? (() => { throw new Error("directive createdAt"); })(),
        updatedAt: finiteTimestamp(item.updatedAt) ?? (() => { throw new Error("directive updatedAt"); })(),
        expiresAt: finiteTimestamp(item.expiresAt) ?? (() => { throw new Error("directive expiresAt"); })(),
        submittedAt: finiteTimestamp(item.submittedAt),
        acknowledgedAt: finiteTimestamp(item.acknowledgedAt),
        failureReason: cleanString(item.failureReason, "failure reason", 2_000, false),
      };
    });

    const events = raw.events.slice(-MAX_EVENTS).map((item: any): CoordinatorEvent => {
      if (!Number.isSafeInteger(item?.sequence) || item.sequence < 1) throw new Error("event sequence");
      return {
        id: identifier(item.id, "event ID")!,
        sequence: item.sequence,
        type: identifier(item.type, "event type")!,
        sessionId: identifier(item.sessionId, "session ID", false),
        decisionId: identifier(item.decisionId, "decision ID", false),
        directiveId: identifier(item.directiveId, "directive ID", false),
        summary: cleanString(item.summary, "event summary", 2_000)!,
        createdAt: finiteTimestamp(item.createdAt) ?? (() => { throw new Error("event createdAt"); })(),
      };
    });
    return { version: 1, mode: raw.mode, nextSequence: raw.nextSequence, decisions, directives, events };
  } catch {
    return null;
  }
}

function atomicWrite(path: string, value: CoordinatorPersistedState) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(path), 0o700); } catch {}
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeSync(descriptor, JSON.stringify(value, null, 2), undefined, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    try {
      const directoryDescriptor = openSync(dirname(path), "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch {}
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
    rmSync(temporary, { force: true });
    throw error;
  }
}

export class CoordinatorStore {
  private state: CoordinatorPersistedState;

  constructor(readonly stateFile = join(getDataDir(), "coordinator-state.json")) {
    this.state = this.load();
    this.expireDirectives(Date.now());
  }

  private load(): CoordinatorPersistedState {
    try {
      if (!existsSync(this.stateFile)) return emptyState();
      if (statSync(this.stateFile).size > MAX_STATE_BYTES) throw new Error("state file is too large");
      const parsed = parseLoadedState(JSON.parse(readFileSync(this.stateFile, "utf8")));
      if (parsed) return parsed;
      throw new Error("state file failed schema validation");
    } catch (error) {
      console.warn(`[coordinator] Ignoring invalid state at ${this.stateFile}:`, error);
      return emptyState();
    }
  }

  private save() {
    atomicWrite(this.stateFile, this.state);
  }

  private assertMutable() {
    if (this.state.mode === "observe") {
      throw new CoordinatorStoreError("Coordinator is in observe mode; mutations are disabled", 409);
    }
  }

  snapshot(): CoordinatorStateSnapshot {
    this.expireDirectives(Date.now());
    return { ...clone(this.state), stateFile: this.stateFile };
  }

  eventsAfter(sequence: number): CoordinatorEvent[] {
    return clone(this.state.events.filter((event) => event.sequence > sequence));
  }

  setMode(mode: CoordinatorMode, author: CoordinatorAuthor = "user"): CoordinatorMode {
    if (!["observe", "coordinate", "control"].includes(mode)) {
      throw new CoordinatorStoreError("mode must be observe, coordinate, or control");
    }
    if (this.state.mode === mode) return mode;
    this.state.mode = mode;
    this.appendEvent("coordinator.mode.changed", `Coordinator mode changed to ${mode} by ${author}`, {}, false);
    this.save();
    return mode;
  }

  appendEvent(
    type: string,
    summary: string,
    refs: Pick<CoordinatorEvent, "sessionId" | "decisionId" | "directiveId"> = {},
    persist = true,
  ): CoordinatorEvent {
    const event: CoordinatorEvent = {
      id: randomUUID(),
      sequence: this.state.nextSequence++,
      type: identifier(type, "event type")!,
      summary: cleanString(summary, "event summary", 2_000)!,
      ...refs,
      createdAt: Date.now(),
    };
    this.state.events.push(event);
    this.state.events = this.state.events.slice(-MAX_EVENTS);
    if (persist) this.save();
    return clone(event);
  }

  createDecision(input: {
    topic: unknown;
    choice: unknown;
    rationale: unknown;
    scope?: unknown;
    supersedes?: unknown;
    author?: CoordinatorAuthor;
  }): CoordinatorDecision {
    this.assertMutable();
    const topic = cleanString(input.topic, "topic", 240)!;
    const normalizedTopic = topic.toLocaleLowerCase();
    const active = this.state.decisions.find(
      (decision) => decision.status === "active" && decision.topic.toLocaleLowerCase() === normalizedTopic,
    );
    const supersedes = identifier(input.supersedes, "supersedes", false);
    if (active && supersedes !== active.id) {
      throw new CoordinatorStoreError(
        `Topic already has active decision ${active.id}; pass that exact ID as supersedes`,
        409,
      );
    }
    if (!active && supersedes) {
      throw new CoordinatorStoreError("supersedes does not name the active decision for this topic", 409);
    }
    const now = Date.now();
    const revision = Math.max(
      0,
      ...this.state.decisions
        .filter((decision) => decision.topic.toLocaleLowerCase() === normalizedTopic)
        .map((decision) => decision.revision),
    ) + 1;
    if (active) {
      active.status = "superseded";
      active.updatedAt = now;
    }
    const decision: CoordinatorDecision = {
      id: randomUUID(),
      topic,
      choice: cleanString(input.choice, "choice", 4_000)!,
      rationale: cleanString(input.rationale, "rationale", 8_000)!,
      scope: input.scope === undefined ? { kind: "workspace" } : parseScope(input.scope),
      revision,
      status: "active",
      supersedes,
      author: input.author === "user" ? "user" : "coordinator",
      createdAt: now,
      updatedAt: now,
    };
    this.state.decisions.push(decision);
    this.state.decisions = this.state.decisions.slice(-MAX_DECISIONS);
    this.appendEvent(
      "decision.created",
      `Decision recorded for “${topic}” (revision ${revision})`,
      { decisionId: decision.id },
      false,
    );
    this.save();
    return clone(decision);
  }

  revokeDecision(id: string, author: CoordinatorAuthor = "user"): CoordinatorDecision {
    this.assertMutable();
    const decision = this.state.decisions.find((item) => item.id === id);
    if (!decision) throw new CoordinatorStoreError("Decision not found", 404);
    if (decision.status !== "active") {
      throw new CoordinatorStoreError(`Only an active decision can be revoked (currently ${decision.status})`, 409);
    }
    decision.status = "revoked";
    decision.updatedAt = Date.now();
    this.appendEvent(
      "decision.revoked",
      `Decision “${decision.topic}” revoked by ${author}`,
      { decisionId: decision.id },
      false,
    );
    this.save();
    return clone(decision);
  }

  createDirective(input: {
    sessionId: unknown;
    text: unknown;
    decisionId?: unknown;
    clientRequestId?: unknown;
    ttlMs?: unknown;
    author?: CoordinatorAuthor;
  }): { directive: CoordinatorDirective; duplicate: boolean } {
    this.assertMutable();
    const clientRequestId = identifier(input.clientRequestId, "clientRequestId", false);
    if (clientRequestId) {
      const existing = this.state.directives.find((item) => item.clientRequestId === clientRequestId);
      if (existing) return { directive: clone(existing), duplicate: true };
    }
    const decisionId = identifier(input.decisionId, "decisionId", false);
    if (decisionId) {
      const decision = this.state.decisions.find((item) => item.id === decisionId);
      if (!decision || decision.status !== "active") {
        throw new CoordinatorStoreError("decisionId must name an active decision", 409);
      }
    }
    const rawTtl = input.ttlMs;
    const ttlMs = rawTtl === undefined
      ? DEFAULT_DIRECTIVE_TTL_MS
      : typeof rawTtl === "number" && Number.isFinite(rawTtl)
        ? Math.max(60_000, Math.min(MAX_DIRECTIVE_TTL_MS, Math.floor(rawTtl)))
        : (() => { throw new CoordinatorStoreError("ttlMs must be a finite number"); })();
    const now = Date.now();
    const directive: CoordinatorDirective = {
      id: randomUUID(),
      clientRequestId,
      sessionId: identifier(input.sessionId, "sessionId")!,
      text: cleanString(input.text, "directive", 12_000)!,
      decisionId,
      state: "queued",
      author: input.author === "user" ? "user" : "coordinator",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ttlMs,
    };
    this.state.directives.push(directive);
    this.state.directives = this.state.directives.slice(-MAX_DIRECTIVES);
    this.appendEvent(
      "directive.queued",
      `Directive queued for session ${directive.sessionId}`,
      { sessionId: directive.sessionId, directiveId: directive.id, decisionId },
      false,
    );
    this.save();
    return { directive: clone(directive), duplicate: false };
  }

  getDirective(id: string): CoordinatorDirective | undefined {
    const directive = this.state.directives.find((item) => item.id === id);
    return directive ? clone(directive) : undefined;
  }

  directivesForSession(sessionId: string): CoordinatorDirective[] {
    return clone(this.state.directives.filter((item) => item.sessionId === sessionId));
  }

  transitionDirective(
    id: string,
    state: CoordinatorDirectiveState,
    options: { failureReason?: string; allowTerminalTransition?: boolean } = {},
  ): CoordinatorDirective {
    const directive = this.state.directives.find((item) => item.id === id);
    if (!directive) throw new CoordinatorStoreError("Directive not found", 404);
    if (TERMINAL_DIRECTIVE_STATES.has(directive.state) && !options.allowTerminalTransition) {
      throw new CoordinatorStoreError(`Directive is already terminal (${directive.state})`, 409);
    }
    directive.state = state;
    directive.updatedAt = Date.now();
    directive.failureReason = options.failureReason
      ? cleanString(options.failureReason, "failure reason", 2_000)
      : undefined;
    if (state === "submitted") directive.submittedAt = directive.updatedAt;
    if (state === "acknowledged") directive.acknowledgedAt = directive.updatedAt;
    this.appendEvent(
      `directive.${state}`,
      `Directive ${directive.id} is ${state.replaceAll("_", " ")}`,
      { sessionId: directive.sessionId, directiveId: directive.id, decisionId: directive.decisionId },
      false,
    );
    this.save();
    return clone(directive);
  }

  acknowledgeDirective(id: string): CoordinatorDirective {
    this.assertMutable();
    const directive = this.state.directives.find((item) => item.id === id);
    if (!directive) throw new CoordinatorStoreError("Directive not found", 404);
    if (!["submitted", "observed_working", "completed_unconfirmed"].includes(directive.state)) {
      throw new CoordinatorStoreError(`Directive cannot be acknowledged from ${directive.state}`, 409);
    }
    return this.transitionDirective(id, "acknowledged", { allowTerminalTransition: true });
  }

  cancelDirective(id: string): CoordinatorDirective {
    this.assertMutable();
    const directive = this.state.directives.find((item) => item.id === id);
    if (!directive) throw new CoordinatorStoreError("Directive not found", 404);
    if (directive.state !== "queued") {
      throw new CoordinatorStoreError("Only a queued directive can be cancelled", 409);
    }
    return this.transitionDirective(id, "cancelled");
  }

  expireDirectives(now = Date.now()): CoordinatorDirective[] {
    const expired: CoordinatorDirective[] = [];
    for (const directive of this.state.directives) {
      if (directive.state !== "queued" || directive.expiresAt > now) continue;
      directive.state = "expired";
      directive.updatedAt = now;
      directive.failureReason = "Directive expired before the session reached a safe idle prompt";
      this.appendEvent(
        "directive.expired",
        `Directive ${directive.id} expired before safe delivery`,
        { sessionId: directive.sessionId, directiveId: directive.id, decisionId: directive.decisionId },
        false,
      );
      expired.push(clone(directive));
    }
    if (expired.length > 0) this.save();
    return expired;
  }
}

export const coordinatorStore = new CoordinatorStore();

export function recordCoordinatorSessionEvent(
  type: string,
  sessionId: string,
  summary: string,
): CoordinatorEvent {
  return coordinatorStore.appendEvent(type, summary, { sessionId });
}
