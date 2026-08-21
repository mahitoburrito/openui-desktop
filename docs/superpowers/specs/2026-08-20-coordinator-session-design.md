# OpenUI Coordinator Session — Design Spec

**Date:** 2026-08-20
**Status:** Approved for local MVP implementation

## Summary

Add one workspace-scoped Coordinator to OpenUI. It is a session-like PRBE agent that can inspect every active coding-agent session, record durable cross-agent decisions, and send directives through a guarded per-session queue. The coordinator is an OpenUI control-plane feature, not another unprivileged terminal process.

The local MVP uses OpenUI's internal APIs and event journal. ACP is the preferred future adapter for agents with native structured control, MCP is the tool surface exposed to the coordinator, and A2A is reserved for remote OpenUI instances or external agents. Raw PTY input remains a compatibility adapter with explicitly weaker delivery semantics.

## Goals

- Let a user give a single coordinator natural-language directives.
- Give that coordinator a current, structured view of all local sessions.
- Preserve decisions and directive state across app restarts.
- Serialize messages per target session and reject ambiguous routing.
- Distinguish queued, submitted, observed, completed, and acknowledged states.
- Surface coordination state in a dedicated, always-accessible panel.
- Keep destructive lifecycle control out of the MVP.

## Non-goals

- Peer-to-peer autonomous negotiation between worker agents.
- Claiming that terminal input was understood merely because bytes were written.
- Automatically answering permission prompts or `AskUserQuestion` interactions.
- Starting, cancelling, deleting, merging, or deploying sessions autonomously.
- A network-visible A2A server in the first local release.

## Architecture

```text
User
  │ natural-language directive
  ▼
Coordinator panel / embedded PRBE agent
  │ structured tools over loopback API
  ▼
Coordinator service
  ├── durable decision log
  ├── durable directive queues
  ├── bounded event journal
  └── guarded delivery reconciler
          │
          ├── future: ACP adapter (structured prompt/session updates)
          ├── future: A2A adapter (remote agent/task boundary)
          └── MVP: OpenUI PTY writer (submitted, never implied ACK)
```

The server owns truth. The renderer polls a snapshot while the panel is open, and the embedded coordinator agent receives small custom tools backed by the same API. Session titles are display labels only; every mutating call requires an exact stable session ID.

## Authority modes

- `observe`: inspect sessions, events, decisions, and directives; no mutations.
- `coordinate` (default): additionally record decisions and queue directives.
- `control`: reserved for future lifecycle actions. In the MVP it grants no extra operations.

Mode changes are explicit and durable. The AI cannot silently elevate itself.

## Decision contract

```ts
interface CoordinatorDecision {
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
```

Only one active decision may exist for a normalized topic. Replacing it requires the caller to name the active decision in `supersedes`. The service atomically marks the old revision superseded and creates the next revision. This makes stale or conflicting coordinator conclusions visible instead of last-write-wins.

## Directive contract

```ts
type DirectiveState =
  | "queued"
  | "submitted"
  | "observed_working"
  | "completed_unconfirmed"
  | "acknowledged"
  | "rejected"
  | "failed"
  | "expired"
  | "cancelled";

interface CoordinatorDirective {
  id: string;
  clientRequestId?: string;
  sessionId: string;
  text: string;
  decisionId?: string;
  state: DirectiveState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  submittedAt?: number;
  acknowledgedAt?: number;
  failureReason?: string;
}
```

`clientRequestId` is an idempotency key. Repeating it returns the original directive. One submitted directive at a time is allowed per session; later directives remain queued.

### Delivery lifecycle

1. Validate exact session and optional decision IDs, input bounds, authority mode, and idempotency key.
2. Persist `queued` before attempting terminal delivery.
3. Deliver only when the target has a live PTY and status `idle`.
4. Mark `submitted` only after the terminal writer completes the full framed prompt.
5. If status moves to working, mark `observed_working`.
6. If it later returns idle, mark `completed_unconfirmed` and unblock the next item.
7. Only an explicit adapter/user acknowledgment marks `acknowledged`.

`waiting_input` is never safe for automatic delivery: input at that moment may answer a permission or question prompt. Disconnected, restored-without-PTY, errored, and actively working sessions keep their directives queued until safe or expired.

The injected prompt includes the directive ID and any linked decision ID, but no shell command wrapper. Bracketed paste and the existing serialized PTY writer prevent interleaving with user input.

## Persistence and recovery

Coordinator state lives in `.openui-desktop/coordinator-state.json` with owner-only permissions and atomic temp-file rename. Loading validates the complete schema and falls back to a clean state on malformed data rather than partially trusting it. Histories are bounded:

- 500 decisions
- 1,000 directives
- 2,000 events

Queued directives have a 30-minute default TTL. Expired items are terminal and will not be replayed after a long shutdown. Submitted directives remain unconfirmed after restart; they are never silently resent.

## Event model

The service maintains a monotonic sequence and records bounded events for:

- coordinator mode changes
- decisions created, superseded, or revoked
- directives queued and every state transition
- session status changes
- session creation and deletion

Events contain summaries, not raw terminal output. The coordinator reads recent structured terminal blocks on demand, through the existing redacted/plain-output endpoint.

## API and coordinator tools

Loopback API:

- `GET /api/coordinator/snapshot`
- `GET /api/coordinator/events?after=<seq>`
- `PUT /api/coordinator/mode`
- `POST /api/coordinator/decisions`
- `POST /api/coordinator/decisions/:id/revoke`
- `POST /api/coordinator/directives`
- `POST /api/coordinator/directives/:id/acknowledge`
- `POST /api/coordinator/directives/:id/cancel`

Embedded agent tools:

- `list_active_sessions`
- `get_session_status`
- `get_session_activity`
- `get_coordination_state`
- `record_decision`
- `send_directive`
- `acknowledge_directive`

The tools return structured errors from non-2xx responses so the agent cannot mistake a held or rejected operation for success.

## UI

The existing PRBE drawer becomes the Coordinator panel while retaining the PRBE SDK underneath. A header control always opens it. The panel includes:

- live counts for active/attention/offline sessions
- durable active decisions
- recent directive states with target display names
- the coordinator conversation and tool activity
- clear `submitted, unconfirmed` language

Without a configured PRBE key the monitor remains useful, while natural-language coordination explains that agent configuration is required.

## Safety invariants

- No fuzzy matching for mutating targets.
- No terminal delivery in `waiting_input`, working, error, disconnected, or restored states.
- No status named `delivered` or `completed` without qualifying confidence.
- No automatic permission verdicts.
- No autonomous lifecycle or production actions in the MVP.
- Mutations are rejected in observe mode.
- Decision replacement is compare-and-supersede, not last-write-wins.
- Directive creation is persisted before delivery and idempotent on request ID.

## Test plan

Automated behavior tests cover:

- atomic persistence and recovery from malformed state
- duplicate idempotency keys
- conflicting and stale decision supersession
- exact routing and unknown sessions
- observe-mode mutation rejection
- idle-only delivery and no delivery at `waiting_input`
- per-session serialization
- state progression without false acknowledgment
- expiry and restart behavior

Build validation covers both Electron/server TypeScript and the client production bundle. Local manual testing should exercise two agents, queue while one is working, observe guarded delivery after it becomes idle, inspect a shared decision, and verify state after restarting OpenUI.
