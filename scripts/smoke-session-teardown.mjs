// Teardown + persistence smoke tests.
//
// Covers two things the feature smoke suite does not:
//   1. Deleting a session reaps processes it detached, not just its shell.
//   2. The 10s periodic save skips sessions that produced no output.
//
// Run: npm run test:teardown   (builds first, like test:features)

import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = Number(process.env.OPENUI_TEARDOWN_TEST_PORT || 7261);
const BASE_URL = `http://localhost:${PORT}`;

let passed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  passed++;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Returns the predicate's own truthy value, so callers can use what it found. */
async function until(predicate, { timeoutMs = 10000, intervalMs = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

// Terminal input is a WebSocket message, not an HTTP route.
async function sendInput(sessionId, data) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?sessionId=${encodeURIComponent(sessionId)}`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "input", data }));
  // Give the pty a moment to echo before dropping the socket.
  await sleep(1000);
  ws.close();
}

/** Wait until `file` has gone `stableMs` without being rewritten. */
async function waitForQuiescence(file, { stableMs = 6000, timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await stat(file);
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    await sleep(500);
    const now = await stat(file);
    if (now.mtimeMs !== last.mtimeMs) {
      last = now;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= stableMs) return now;
  }
  throw new Error(`${file} never stopped being rewritten`);
}

async function api(path, options) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${options?.method || "GET"} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function startServer(launchCwd) {
  const child = spawn("node", ["dist/electron/server/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
      HOME: launchCwd,
      PORT: String(PORT),
      LAUNCH_CWD: launchCwd,
      OPENUI_CONTROL_DIR: join(launchCwd, "control"),
      OPENUI_QUIET: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (c) => { logs += c.toString(); });
  child.stderr.on("data", (c) => { logs += c.toString(); });

  try {
    await until(async () => {
      try {
        return (await fetch(`${BASE_URL}/api/config`)).ok;
      } catch {
        return false;
      }
    }, { timeoutMs: 15000, label: "server ready" });
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`${error.message}\n${logs}`);
  }

  return {
    logs: () => logs,
    close: async () => {
      child.kill("SIGTERM");
      await until(() => child.exitCode !== null || child.signalCode !== null, {
        timeoutMs: 5000,
        label: "server exit",
      }).catch(() => child.kill("SIGKILL"));
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Unit: the descendant walk
// ---------------------------------------------------------------------------

async function testDescendantWalk() {
  const { descendantsForTest, parseProcessListing } = await import(
    new URL("../dist/electron/server/services/processTree.js", import.meta.url)
  );

  // 500 -> 600 -> 700 -> 800, plus an unrelated tree and init.
  const listing = [
    "    1     0",
    "  500     1",
    "  600   500",
    "  700   600",
    "  800   700",
    "  650   500",
    "  900     1",
    "  910   900",
  ].join("\n");

  const found = descendantsForTest(listing, 500);
  assert(
    found.length === 4 && [600, 650, 700, 800].every((pid) => found.includes(pid)),
    `descendant walk should find the whole subtree, got ${JSON.stringify(found)}`,
  );
  assert(
    !found.includes(900) && !found.includes(910) && !found.includes(1),
    "descendant walk must not escape into unrelated trees or init",
  );

  // Deepest-first: a supervisor must not get to respawn its child.
  assert(
    found.indexOf(800) < found.indexOf(700) && found.indexOf(700) < found.indexOf(600),
    `descendants must be ordered deepest-first, got ${JSON.stringify(found)}`,
  );

  assert(descendantsForTest(listing, 1).length === 0, "pid 1 must never be walked");
  assert(descendantsForTest(listing, 800).length === 0, "a leaf has no descendants");

  // A cyclic/self-parenting row must not hang the walk.
  const cyclic = ["  500     1", "  600   500", "  600   600"].join("\n");
  assert(descendantsForTest(cyclic, 500).includes(600), "self-parenting rows must not break the walk");

  assert(parseProcessListing(null) === null, "a failed ps listing yields null, not an empty tree");
  assert(
    parseProcessListing("garbage\nnot a row").size === 0,
    "unparseable ps output yields an empty map rather than throwing",
  );

  console.log("  ok  descendant walk");
}

async function testSessionMarkerScan() {
  const { parseSessionMarkerListing } = await import(
    new URL("../dist/electron/server/services/processTree.js", import.meta.url)
  );

  const listing = [
    " 500 node server.js PATH=/usr/bin OPENUI_SESSION_ID=session-abc TERM=xterm",
    " 600 sleep 300 OPENUI_SESSION_ID=session-abc",
    " 700 sleep 300 OPENUI_SESSION_ID=session-xyz",
    // A longer id that merely starts with ours must not match.
    " 800 sleep 300 OPENUI_SESSION_ID=session-abcdef",
    // The id appearing in some other variable must not match either.
    " 900 sleep 300 SOME_OTHER=session-abc",
    "   1 launchd OPENUI_SESSION_ID=session-abc",
  ].join("\n");

  const found = parseSessionMarkerListing(listing, "session-abc");
  assert(
    found.length === 2 && found.includes(500) && found.includes(600),
    `marker scan should match only exact ids, got ${JSON.stringify(found)}`,
  );
  assert(!found.includes(800), "a longer id sharing our prefix must not match");
  assert(!found.includes(900), "the id inside a different variable must not match");

  // A variable merely ENDING in our name is a different variable.
  const suffixed = " 950 sleep 300 MY_OPENUI_SESSION_ID=session-abc";
  assert(
    parseSessionMarkerListing(suffixed, "session-abc").length === 0,
    "a variable whose name ends in OPENUI_SESSION_ID must not match",
  );
  // ...but the real variable later on the same line still must.
  const both = " 960 sh MY_OPENUI_SESSION_ID=session-abc OPENUI_SESSION_ID=session-abc";
  assert(
    parseSessionMarkerListing(both, "session-abc").includes(960),
    "a genuine marker must still match when a similarly-named variable precedes it",
  );
  assert(!found.includes(1), "init must never be a reap target");
  assert(
    parseSessionMarkerListing(listing, "").length === 0,
    "an empty session id must match nothing rather than everything",
  );
  assert(parseSessionMarkerListing(null, "session-abc").length === 0, "a failed ps yields no targets");

  console.log("  ok  session-marker scan");
}

// ---------------------------------------------------------------------------
// 2. Integration: deleting a session reaps its detached grandchildren
// ---------------------------------------------------------------------------

async function testDetachedGrandchildIsReaped(launchCwd) {
  const pidFile = join(launchCwd, "detached.pid");

  // The exact shape of the real leak: the session's shell starts a child that
  // detaches into its own process session AND outlives its immediate parent,
  // so it is already reparented to init by the time the delete arrives. SIGHUP
  // to the shell never reaches it and the ppid walk has nothing left to follow.
  //
  // The stray is a `node` process, not `sleep`, for two reasons: it is what the
  // real strays are (bun/node agent plugins), and macOS hides KERN_PROCARGS2
  // for Apple-signed system binaries, so /bin/sleep never exposes the env
  // marker to `ps -E` and could not be matched by any tool.
  const detachScript =
    `const {spawn}=require("child_process");` +
    `const c=spawn(process.execPath,["-e","setTimeout(()=>{},300000)"],{detached:true,stdio:"ignore"});` +
    `require("fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));` +
    `c.unref();`;

  const session = await api("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: "shell",
      agentName: "Teardown Probe",
      command: `node -e '${detachScript}'`,
      cwd: launchCwd,
      nodeId: `node-teardown-${Date.now()}`,
    }),
  });

  await until(async () => {
    try {
      return (await readFile(pidFile, "utf8")).trim().length > 0;
    } catch {
      return false;
    }
  }, { timeoutMs: 15000, label: "detached grandchild to report its pid" });

  const detachedPid = Number((await readFile(pidFile, "utf8")).trim());
  assert(Number.isInteger(detachedPid) && detachedPid > 1, `bad detached pid: ${detachedPid}`);
  assert(pidAlive(detachedPid), "the detached grandchild should be running before the delete");

  await api(`/api/sessions/${session.sessionId}`, { method: "DELETE" });

  // The reaper SIGTERMs, waits out its grace, then SIGKILLs.
  await until(() => !pidAlive(detachedPid), {
    timeoutMs: 15000,
    label: `detached grandchild ${detachedPid} to be reaped`,
  });

  assert(!pidAlive(detachedPid), "deleting a session must reap the process it detached");
  console.log("  ok  detached grandchild reaped on delete");
}

// ---------------------------------------------------------------------------
// 3. Integration: the periodic save skips idle sessions
// ---------------------------------------------------------------------------

async function testIdleSessionIsNotRewritten(launchCwd) {
  const session = await api("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: "shell",
      agentName: "Idle Probe",
      command: "echo teardown-probe-ready",
      cwd: launchCwd,
      nodeId: `node-idle-${Date.now()}`,
    }),
  });

  const bufferFile = join(launchCwd, ".openui-desktop", "buffers", `${session.sessionId}.json`);
  await until(async () => {
    try {
      return (await stat(bufferFile)).size > 0;
    } catch {
      return false;
    }
  }, { timeoutMs: 20000, label: "first buffer write" });

  // Wait for genuine quiescence rather than a fixed delay: a login shell is
  // still sourcing profiles and painting a prompt for several seconds after
  // the first write, and that output SHOULD be persisted.
  // Stability must outlast a full save tick, otherwise a straggling chunk of
  // shell startup output lands right after we start measuring.
  const settled = await waitForQuiescence(bufferFile, { stableMs: 15000, timeoutMs: 90000 });

  // Two full save ticks (10s each) with no output on this session. Before the
  // dirty check this rewrote the whole scrollback on every tick.
  await sleep(23000);
  const afterIdle = await stat(bufferFile);

  assert(
    afterIdle.mtimeMs === settled.mtimeMs,
    `an idle session's scrollback must not be rewritten every tick ` +
      `(mtime moved ${settled.mtimeMs} -> ${afterIdle.mtimeMs})`,
  );

  // ...and a session that DOES produce output still gets persisted.
  await sendInput(session.sessionId, "echo teardown-probe-dirty\r");

  await until(async () => (await stat(bufferFile)).mtimeMs > afterIdle.mtimeMs, {
    timeoutMs: 25000,
    label: "buffer rewrite after new output",
  });
  const afterOutput = await stat(bufferFile);
  assert(
    afterOutput.mtimeMs > afterIdle.mtimeMs,
    "a session that produced output must still be persisted",
  );
  assert(
    (await readFile(bufferFile, "utf8")).includes("teardown-probe-dirty"),
    "the new output must actually be in the persisted scrollback",
  );

  await api(`/api/sessions/${session.sessionId}`, { method: "DELETE" });
  console.log("  ok  idle sessions skipped, active sessions still persisted");
}

// ---------------------------------------------------------------------------
// 4. Integration: annotating a non-tail block survives a restart
// ---------------------------------------------------------------------------

async function testBlockAnnotationIsPersisted(launchCwd) {
  const session = await api("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: "shell",
      agentName: "Annotation Probe",
      command: "echo block-one",
      cwd: launchCwd,
      nodeId: `node-annotate-${Date.now()}`,
    }),
  });

  // Several blocks, so the one we annotate is NOT the tail. A tail-only dirty
  // signature would skip persisting the annotation entirely.
  for (const cmd of ["echo block-two", "echo block-three", "echo block-four"]) {
    await sendInput(session.sessionId, `${cmd}\r`);
  }

  const blocks = await until(async () => {
    const snapshot = await api(`/api/sessions/${session.sessionId}/blocks`);
    return snapshot.blocks && snapshot.blocks.length >= 2 ? snapshot.blocks : false;
  }, { timeoutMs: 30000, label: "terminal blocks to appear" });

  const target = blocks[0];
  assert(
    blocks[blocks.length - 1].id !== target.id,
    "the annotated block must not be the tail, or this test proves nothing",
  );

  // The session must be fully quiet BEFORE annotating. Otherwise a later block
  // append moves the tail and rewrites the file for unrelated reasons, which
  // would mask a dirty-check that ignores non-tail blocks.
  const blocksFile = join(launchCwd, ".openui-desktop", "terminal-blocks", `${session.sessionId}.json`);
  const settled = await waitForQuiescence(blocksFile, { stableMs: 15000, timeoutMs: 90000 });

  await api(`/api/sessions/${session.sessionId}/blocks/${target.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookmarked: true, note: "teardown-probe-note" }),
  });

  await until(async () => {
    try {
      const now = await stat(blocksFile);
      if (now.mtimeMs === settled.mtimeMs) return false;
      return (await readFile(blocksFile, "utf8")).includes("teardown-probe-note");
    } catch {
      return false;
    }
  }, { timeoutMs: 20000, label: "annotation of a non-tail block to reach disk" });

  const persisted = JSON.parse(await readFile(blocksFile, "utf8"));
  const saved = persisted.blocks.find((b) => b.id === target.id);
  assert(saved?.bookmarked === true, "the bookmark must survive to disk");
  assert(saved?.note === "teardown-probe-note", "the note must survive to disk");

  await api(`/api/sessions/${session.sessionId}`, { method: "DELETE" });
  console.log("  ok  non-tail block annotation persisted");
}

// ---------------------------------------------------------------------------

async function main() {
  const launchCwd = await mkdtemp(join(tmpdir(), "openui-teardown."));
  await testDescendantWalk();
  await testSessionMarkerScan();

  const server = await startServer(launchCwd);
  try {
    await testDetachedGrandchildIsReaped(launchCwd);
    await testIdleSessionIsNotRewritten(launchCwd);
    await testBlockAnnotationIsPersisted(launchCwd);
  } finally {
    await server.close();
    await rm(launchCwd, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\nSession teardown smoke tests passed (${passed} assertions)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
