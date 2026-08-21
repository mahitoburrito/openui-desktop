export type CoordinatorMode = "observe" | "coordinate" | "control";
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

export interface CoordinatorSessionSummary {
  sessionId: string;
  nodeId: string;
  displayName: string;
  agentId: string;
  agentName: string;
  status: string;
  statusChangedAt?: number;
  currentTool?: string;
  cwd: string;
  gitBranch?: string;
  isRestored?: boolean;
  readiness: { safe: boolean; reason: string };
  recentBlocks: Array<{
    id: string;
    command: string;
    status: string;
    startedAt: number;
    completedAt?: number;
    exitCode?: number;
  }>;
}

export interface CoordinatorDecision {
  id: string;
  topic: string;
  choice: string;
  rationale: string;
  scope: { kind: "workspace" } | { kind: "sessions"; sessionIds: string[] };
  revision: number;
  status: "active" | "superseded" | "revoked";
  supersedes?: string;
  author: "user" | "coordinator";
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
  author: "user" | "coordinator";
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

export interface CoordinatorSnapshot {
  mode: CoordinatorMode;
  nextSequence: number;
  sessions: CoordinatorSessionSummary[];
  activeDecisions: CoordinatorDecision[];
  decisions: CoordinatorDecision[];
  directives: CoordinatorDirective[];
  events: CoordinatorEvent[];
}
