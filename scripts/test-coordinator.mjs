#!/usr/bin/env node
// Behaviour tests for the durable Coordinator store and guarded delivery state machine.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const { CoordinatorStore, CoordinatorStoreError } = await import(
  join(here, "..", "dist", "electron", "server", "services", "coordinatorStore.js")
);
const { CoordinatorRuntime, coordinatorDeliveryReadiness, COORDINATOR_IDLE_STABILITY_MS } = await import(
  join(here, "..", "dist", "electron", "server", "services", "coordinatorRuntime.js")
);

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`         actual   ${JSON.stringify(actual)}`);
    console.log(`         expected ${JSON.stringify(expected)}`);
  }
}

function throwsStatus(name, fn, expectedStatus) {
  try {
    fn();
    check(name, "did not throw", `status ${expectedStatus}`);
  } catch (error) {
    check(name, error instanceof CoordinatorStoreError ? error.status : "wrong error", expectedStatus);
  }
}

function makeStore(root) {
  return new CoordinatorStore(join(root, "coordinator-state.json"));
}

function makeSession(status = "idle") {
  return { pty: {}, status, pendingDelete: false, isRestored: false, firstInputBuffer: "" };
}

const testRoot = mkdtempSync(join(tmpdir(), "openui-coordinator-test-"));

try {
  console.log("\ndurable decisions and conflict control");
  {
    const store = makeStore(join(testRoot, "decisions"));
    const first = store.createDecision({
      topic: "API contract",
      choice: "Use v2",
      rationale: "Both workers need one schema",
      scope: { kind: "workspace" },
      author: "user",
    });
    throwsStatus("same topic cannot silently overwrite", () => store.createDecision({
      topic: "api CONTRACT",
      choice: "Use v3",
      rationale: "New requirement",
    }), 409);
    const second = store.createDecision({
      topic: "API contract",
      choice: "Use v3",
      rationale: "New requirement",
      supersedes: first.id,
    });
    check("superseding increments revision", second.revision, 2);
    check(
      "old revision is visibly superseded",
      store.snapshot().decisions.find((item) => item.id === first.id)?.status,
      "superseded",
    );
    const reloaded = makeStore(join(testRoot, "decisions"));
    check("decision survives restart", reloaded.snapshot().decisions.at(-1)?.id, second.id);
    check("state file is a versioned envelope", JSON.parse(readFileSync(reloaded.stateFile, "utf8")).version, 1);
  }

  console.log("\nidempotency and authority");
  {
    const store = makeStore(join(testRoot, "idempotency"));
    const first = store.createDirective({
      sessionId: "session-1",
      text: "Adopt the shared API contract",
      clientRequestId: "request-1",
      author: "coordinator",
    });
    const second = store.createDirective({
      sessionId: "session-1",
      text: "This retry must not replace the original",
      clientRequestId: "request-1",
      author: "coordinator",
    });
    check("duplicate request returns original ID", second.directive.id, first.directive.id);
    check("duplicate is identified", second.duplicate, true);
    store.setMode("observe");
    throwsStatus("observe mode blocks directives", () => store.createDirective({
      sessionId: "session-1",
      text: "Do not send",
    }), 409);
    throwsStatus("observe mode blocks decisions", () => store.createDecision({
      topic: "blocked",
      choice: "none",
      rationale: "observe only",
    }), 409);
  }

  console.log("\nidle-only guarded delivery");
  {
    const store = makeStore(join(testRoot, "delivery"));
    const session = makeSession("waiting_input");
    const sessions = new Map([["worker-1", session]]);
    const writes = [];
    const writer = (sessionId, data, options) => {
      writes.push({ sessionId, data });
      options.onComplete?.();
      return true;
    };
    const runtime = new CoordinatorRuntime(store, sessions, writer);
    const first = store.createDirective({ sessionId: "worker-1", text: "Use the shared serializer" }).directive;
    runtime.reconcile();
    check("waiting_input receives no terminal bytes", writes.length, 0);
    check("waiting_input directive remains queued", store.getDirective(first.id)?.state, "queued");
    check(
      "readiness explains prompt safety",
      coordinatorDeliveryReadiness(session).reason.includes("permission prompt"),
      true,
    );

    session.status = "idle";
    session.firstInputBuffer = "partially typed";
    runtime.reconcile();
    check("partial user input is never overwritten or appended to", writes.length, 0);
    session.firstInputBuffer = "";

    runtime.reconcile();
    check("idle session receives one framed directive", writes.length, 1);
    check("writer completion marks submitted", store.getDirective(first.id)?.state, "submitted");
    check("prompt carries exact directive ID", writes[0].data.includes(first.id), true);

    const second = store.createDirective({ sessionId: "worker-1", text: "Then update the tests" }).directive;
    runtime.reconcile();
    check("submitted directive serializes the per-session queue", writes.length, 1);
    session.status = "running";
    runtime.reconcile();
    check("working evidence is tracked without claiming ACK", store.getDirective(first.id)?.state, "observed_working");
    session.status = "idle";
    runtime.reconcile();
    check("return to idle is explicitly unconfirmed", store.getDirective(first.id)?.state, "completed_unconfirmed");
    check("next directive is released after observed completion", writes.length, 2);
    check("second directive is submitted", store.getDirective(second.id)?.state, "submitted");
    store.acknowledgeDirective(first.id);
    check("explicit acknowledgment is a separate transition", store.getDirective(first.id)?.state, "acknowledged");
  }

  console.log("\npending terminal writes block dispatch");
  {
    const store = makeStore(join(testRoot, "pending-writes"));
    const directive = store.createDirective({ sessionId: "worker-1", text: "Wait behind user input" }).directive;
    const writes = [];
    let pendingWrites = 1;
    const runtime = new CoordinatorRuntime(
      store,
      new Map([["worker-1", makeSession("idle")]]),
      (...args) => { writes.push(args); return true; },
      () => ({ writes: pendingWrites, bytes: pendingWrites * 10 }),
    );
    runtime.reconcile();
    check("pending PTY input keeps directive queued", store.getDirective(directive.id)?.state, "queued");
    check("pending PTY input receives no coordinator bytes", writes.length, 0);
    pendingWrites = 0;
    runtime.reconcile();
    check("directive releases when the writer is idle", writes.length, 1);
  }

  console.log("\nstable idle delivery");
  {
    const now = Date.now();
    const session = { ...makeSession("idle"), statusChangedAt: now };
    check(
      "fresh idle transition is not immediately writable",
      coordinatorDeliveryReadiness(session, { writes: 0, bytes: 0 }, now).safe,
      false,
    );
    check(
      "idle prompt becomes writable after the stability window",
      coordinatorDeliveryReadiness(
        session,
        { writes: 0, bytes: 0 },
        now + COORDINATOR_IDLE_STABILITY_MS,
      ).safe,
      true,
    );
    session.pendingStatus = "waiting_input";
    check(
      "a pending prompt status vetoes delivery",
      coordinatorDeliveryReadiness(
        session,
        { writes: 0, bytes: 0 },
        now + COORDINATOR_IDLE_STABILITY_MS,
      ).safe,
      false,
    );
  }

  console.log("\nobserve mode pauses existing work");
  {
    const store = makeStore(join(testRoot, "observe-queue"));
    const directive = store.createDirective({ sessionId: "worker-1", text: "Wait for authority" }).directive;
    store.setMode("observe");
    const writes = [];
    const runtime = new CoordinatorRuntime(
      store,
      new Map([["worker-1", makeSession("idle")]]),
      (...args) => { writes.push(args); return true; },
    );
    runtime.reconcile();
    check("queued directive is not dispatched in observe mode", writes.length, 0);
    check("paused directive remains queued", store.getDirective(directive.id)?.state, "queued");
  }

  console.log("\nexpiry, missing targets, and malformed recovery");
  {
    const store = makeStore(join(testRoot, "expiry"));
    const directive = store.createDirective({ sessionId: "missing", text: "Will expire", ttlMs: 60_000 }).directive;
    store.expireDirectives(directive.expiresAt + 1);
    check("queued directive expires deterministically", store.getDirective(directive.id)?.state, "expired");

    const missingStore = makeStore(join(testRoot, "missing"));
    const missing = missingStore.createDirective({ sessionId: "gone", text: "Cannot route" }).directive;
    const runtime = new CoordinatorRuntime(missingStore, new Map(), () => true);
    runtime.reconcile();
    check("removed session fails rather than reroutes", missingStore.getDirective(missing.id)?.state, "failed");

    const malformedPath = join(testRoot, "malformed", "coordinator-state.json");
    mkdirSync(dirname(malformedPath), { recursive: true });
    writeFileSync(malformedPath, "{not-json", { encoding: "utf8", mode: 0o600 });
    const recovered = new CoordinatorStore(malformedPath);
    check("malformed state fails closed to an empty snapshot", recovered.snapshot().directives.length, 0);
  }
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
