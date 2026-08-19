#!/usr/bin/env node
// Behaviour tests for the agent status funnel (server/services/agentStatus.ts).
//
// This logic is all timing, and every one of its failure modes looks like a
// working app with a card that lies. Run it after any change to the status
// engine: `npm run test:status` (builds first, then runs this).

import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const {
  applyAgentStatus,
  runAgentStatusWatchdog,
  noteAgentOutputActivity,
  startAgentStatusTicker,
  disposeAgentStatus,
} = await import(join(here, "..", "dist", "electron", "server", "services", "agentStatus.js"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function makeSession(status = "idle", overrides = {}) {
  const broadcasts = [];
  const session = {
    status,
    statusChangedAt: Date.now(),
    lastOutputTime: Date.now(),
    recentOutputSize: 0,
    pty: {},
    clients: new Set([
      {
        readyState: 1,
        bufferedAmount: 0,
        send: (encoded, cb) => {
          broadcasts.push(JSON.parse(encoded).status);
          if (cb) cb();
        },
      },
    ]),
    ...overrides,
  };
  return { session, broadcasts };
}

console.log("\nflicker suppression");
{
  // The old 3.5s permission timeout fired mid-tool and the post_tool flipped it
  // straight back. Neither should ever reach a client.
  const { session, broadcasts } = makeSession("running");
  session.statusChangedAt = Date.now() - 10_000;
  applyAgentStatus(session, "waiting_input", { source: "inferred" });
  await sleep(300);
  applyAgentStatus(session, "running", { source: "hook" });
  await sleep(3500);
  check("a momentary waiting_input never reaches the UI", [session.status, broadcasts], ["running", []]);
}
{
  const { session, broadcasts } = makeSession("running");
  session.statusChangedAt = Date.now() - 10_000;
  applyAgentStatus(session, "waiting_input", { source: "inferred" });
  await sleep(1000);
  check("an inferred waiting_input is still pending at 1s", session.status, "running");
  await sleep(2000);
  check("...and commits by 3s", [session.status, broadcasts], ["waiting_input", ["waiting_input"]]);
}
{
  const { session, broadcasts } = makeSession("running");
  session.statusChangedAt = Date.now() - 10_000;
  applyAgentStatus(session, "waiting_input", { source: "authoritative", hookEvent: "Notification" });
  await sleep(500);
  check("an authoritative waiting_input commits fast", [session.status, broadcasts], ["waiting_input", ["waiting_input"]]);
}
{
  const { session } = makeSession("waiting_input", { statusSource: "authoritative" });
  applyAgentStatus(session, "running", { source: "inferred" });
  await sleep(1500);
  check("a guess cannot yank Needs Input away inside its dwell", session.status, "waiting_input");
  applyAgentStatus(session, "running", { source: "authoritative", hookEvent: "UserPromptSubmit" });
  await sleep(500);
  check("...but answering the prompt clears it immediately", session.status, "running");
}

console.log("\nprompt vs slow tool");
{
  const { session } = makeSession("running");
  session.preToolTime = Date.now() - 30_000;
  session.lastOutputTime = Date.now() - 200; // spinner still repainting
  runAgentStatusWatchdog(session);
  await sleep(3000);
  check("a long tool that keeps printing stays Working", session.status, "running");
}
{
  const { session } = makeSession("running");
  session.preToolTime = Date.now() - 30_000;
  session.lastOutputTime = Date.now() - 8_000; // frame has gone static
  runAgentStatusWatchdog(session);
  await sleep(3000);
  check("an outstanding tool + silent terminal becomes Needs Input", session.status, "waiting_input");
}
{
  // Regression: a build that is quiet for its first seconds queues a guess, then
  // floods output. The guess has to be retracted before it lands.
  const { session, broadcasts } = makeSession("running");
  session.preToolTime = Date.now() - 30_000;
  session.lastOutputTime = Date.now() - 8_000;
  runAgentStatusWatchdog(session);
  check("the guess is queued", session.pendingStatus, "waiting_input");
  session.lastOutputTime = Date.now(); // build starts printing
  runAgentStatusWatchdog(session);
  await sleep(3000);
  check("output resuming retracts the queued guess", [session.status, broadcasts], ["running", []]);
}

console.log("\nrace between the two AskUserQuestion hooks");
{
  // Claude Code fires both PreToolUse hooks for AskUserQuestion: the specific
  // one reports waiting_input, the generic one maps to running. They race, and
  // the generic one must not be able to cancel the specific one.
  const { session } = makeSession("running");
  session.statusChangedAt = Date.now() - 10_000;
  applyAgentStatus(session, "waiting_input", { source: "authoritative", hookEvent: "PreToolUse" });
  applyAgentStatus(session, "running", { source: "hook", hookEvent: "PreToolUse" });
  await sleep(600);
  check("the generic pre_tool cannot swallow the question", session.status, "waiting_input");
}
{
  const { session } = makeSession("running");
  session.statusChangedAt = Date.now() - 10_000;
  applyAgentStatus(session, "waiting_input", { source: "authoritative", hookEvent: "Notification" });
  applyAgentStatus(session, "idle", { source: "inferred" });
  await sleep(600);
  check("a guess cannot displace a queued certainty", session.status, "waiting_input");
}

console.log("\nstuck states");
{
  // A tool whose post_tool never arrives used to pin the session forever and
  // lock out the idle rule entirely.
  const { session } = makeSession("running", { statusSource: "hook" });
  session.preToolTime = Date.now() - 200_000;
  session.lastOutputTime = Date.now() - 200_000;
  runAgentStatusWatchdog(session);
  check("a tool call that never reported back is given up on", session.preToolTime, undefined);
  await sleep(3500);
  check("...and the session can reach idle again", session.status, "idle");
}
{
  // Ending the agent with /exit reports disconnected while the shell lives on.
  const { session } = makeSession("disconnected");
  session.recentOutputSize = 900;
  noteAgentOutputActivity(session);
  await sleep(1200);
  check("typing into a live shell recovers an Offline card", session.status, "running");
}
{
  const { session } = makeSession("disconnected", { pty: null });
  session.recentOutputSize = 900;
  noteAgentOutputActivity(session);
  await sleep(1200);
  check("...but a dead PTY stays Offline", session.status, "disconnected");
}

console.log("\nterminal noise");
{
  const { session } = makeSession("idle");
  session.recentOutputSize = 60; // cursor blink or a keystroke echo
  noteAgentOutputActivity(session);
  await sleep(1200);
  check("a stray repaint does not flip Idle to Working", session.status, "idle");
  session.recentOutputSize = 900;
  noteAgentOutputActivity(session);
  await sleep(1200);
  check("sustained output does", session.status, "running");
}

console.log("\nticker ownership");
{
  // A restart landing inside the old tick window used to leave two intervals
  // running, decaying the output counter at twice the intended rate.
  const { session } = makeSession("running");
  const sessions = new Map([["s1", session]]);
  startAgentStatusTicker("s1", session, sessions);
  const first = session.statusTicker;
  startAgentStatusTicker("s1", session, sessions);
  check("restarting the ticker replaces the old handle", session.statusTicker !== first, true);
  session.recentOutputSize = 1000;
  await sleep(1200);
  check("only one ticker decays the counter", session.recentOutputSize >= 750, true);
  disposeAgentStatus(session);
  check("dispose stops the ticker", session.statusTicker, undefined);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
