import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const {
  baseSessionTitle,
  migrateLegacySessionTitles,
  normalizeSessionTitle,
  sessionDisplayTitle,
} = require("../dist/electron/shared/sessionTitle.js");
const {
  fallbackSessionTitleFromHistory,
  isLowInformationTitlePrompt,
  isUsefulGeneratedTitle,
  sanitizeTitlePrompt,
  slashCommandSessionTitle,
} = require("../dist/electron/server/services/titleGenerator.js");
const { TerminalWorkspaceService } = require("../dist/electron/server/services/terminalWorkspace.js");
const { loadState, savePersistedState } = require("../dist/electron/server/services/persistence.js");

const checks = [];
function check(name, fn) {
  fn();
  checks.push(name);
}

check("display precedence keeps manual and generated titles distinct", () => {
  const session = {
    agentName: "Codex",
    ticketTitle: "PRB-42 Ticket",
    generatedTitle: "Generated Task",
    customName: "My Locked Name",
  };
  assert.equal(baseSessionTitle(session), "My Locked Name");
  assert.equal(baseSessionTitle({ ...session, customName: undefined }), "Generated Task");
  assert.equal(baseSessionTitle({ ...session, customName: undefined, generatedTitle: undefined }), "PRB-42 Ticket");
  assert.equal(baseSessionTitle({ agentName: "Codex" }), "Codex");
});

check("grouped sessions get visual disambiguators without custom names", () => {
  assert.equal(
    sessionDisplayTitle({ agentName: "Codex", generatedTitle: "Session Naming", sessionOrdinal: 2, sessionGroupSize: 3 }),
    "Session Naming · #2",
  );
  assert.equal(sessionDisplayTitle({ agentName: "Codex", sessionOrdinal: 1, sessionGroupSize: 1 }), "Codex");
  const bounded = sessionDisplayTitle({ generatedTitle: "😀".repeat(120), sessionOrdinal: 12, sessionGroupSize: 20 });
  assert.equal(Array.from(bounded).length, 120);
  assert.match(bounded, / · #12$/);
});

check("workspace tabs follow session titles only until manually renamed", () => {
  const root = mkdtempSync(join(tmpdir(), "openui-title-tabs-"));
  try {
    const workspace = new TerminalWorkspaceService(join(root, "workspace.json"));
    let snapshot = workspace.addTab("session-a", { title: "Codex", titleSource: "session" });
    const tabId = snapshot.tabs[0].id;
    snapshot = workspace.updateInheritedSessionTitle("session-a", "Session Naming");
    assert.equal(snapshot.tabs[0].title, "Session Naming");
    assert.equal(snapshot.tabs[0].titleSource, "session");

    snapshot = workspace.addTab("session-b", { title: "Other Task", titleSource: "session", expectedRevision: snapshot.revision });
    const otherTabId = snapshot.tabs.find((tab) => tab.root.type === "pane" && tab.root.sessionId === "session-b").id;
    snapshot = workspace.closeTab(otherTabId, snapshot.revision);
    const revisionBeforeInheritedTitle = snapshot.revision;
    snapshot = workspace.updateInheritedSessionTitle("session-a", "Session Naming Model");
    assert.equal(snapshot.revision, revisionBeforeInheritedTitle);
    assert.equal(snapshot.closedPaneCount, 1);
    snapshot = workspace.undoClose(["session-a", "session-b"], snapshot.revision);
    assert.equal(snapshot.tabs.length, 2);
    assert.equal(snapshot.tabs.find((tab) => tab.id === tabId).title, "Session Naming Model");

    snapshot = workspace.renameTab(tabId, "Pinned Workspace");
    assert.equal(snapshot.tabs[0].titleSource, "custom");
    snapshot = workspace.updateInheritedSessionTitle("session-a", "A New Generated Title");
    assert.equal(snapshot.tabs[0].title, "Pinned Workspace");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("legacy generated titles migrate out of customName", () => {
  assert.deepEqual(
    migrateLegacySessionTitles("Session Naming", "Session Naming"),
    { customName: undefined, generatedTitle: "Session Naming" },
  );
  assert.deepEqual(
    migrateLegacySessionTitles("Pinned Name", "Session Naming"),
    { customName: "Pinned Name", generatedTitle: "Session Naming" },
  );
});

check("the schema boundary preserves an exact-name manual lock after migration", () => {
  const root = mkdtempSync(join(tmpdir(), "openui-title-state-"));
  const previousDataDir = process.env.OPENUI_DATA_DIR;
  process.env.OPENUI_DATA_DIR = root;
  const node = {
    nodeId: "node-a",
    sessionId: "session-a",
    agentId: "codex",
    agentName: "Codex",
    command: "codex",
    cwd: root,
    createdAt: new Date(0).toISOString(),
    position: { x: 0, y: 0 },
    customName: "Session Naming",
    generatedTitle: "Session Naming",
  };
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify({ version: 2, nodes: [node] }));
    const migrated = loadState();
    assert.equal(migrated.version, 3);
    assert.equal(migrated.nodes[0].customName, undefined);

    migrated.nodes[0].customName = "Session Naming";
    savePersistedState(migrated);
    const reloaded = loadState();
    assert.equal(reloaded.nodes[0].customName, "Session Naming");
    assert.equal(reloaded.nodes[0].generatedTitle, "Session Naming");
    savePersistedState(reloaded);
    assert.equal(JSON.parse(readFileSync(join(root, "state.json.bak"), "utf8")).version, 2);
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENUI_DATA_DIR;
    else process.env.OPENUI_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

check("names are normalized and bounded", () => {
  assert.equal(normalizeSessionTitle("  A   useful\nname  "), "A useful name");
  assert.equal(normalizeSessionTitle("A\u0000 useful\u001f name"), "A useful name");
  assert.equal(Array.from(normalizeSessionTitle("x".repeat(200))).length, 120);
  assert.equal(normalizeSessionTitle("   "), undefined);
});

check("stored title prompts are ANSI-clean and secret-redacted", () => {
  const safe = sanitizeTitlePrompt("\u001b[200~fix auth token=abcdefghijklmnop\u001b[201~");
  assert.equal(safe.includes("\u001b"), false);
  assert.equal(safe.includes("abcdefghijklmnop"), false);
  assert.match(safe, /token=\[redacted\]/);
});

check("low-information follow-ups do not become titles", () => {
  for (const value of ["Continue", "go ahead", "Restate", "What's next?", "Sounds good"]) {
    assert.equal(isLowInformationTitlePrompt(value), true, value);
    assert.equal(isUsefulGeneratedTitle(value), false, value);
  }
  assert.equal(isUsefulGeneratedTitle("Status Confidence Improvements"), true);
});

check("durable work survives conversational follow-ups", () => {
  const title = fallbackSessionTitleFromHistory("continue", [
    "Implement a session overview with nine terminal cards and focus navigation",
    "make sure the animations work",
    "go ahead",
    "continue",
  ]);
  assert.match(title, /Session/i);
  assert.match(title, /Overview/i);
  assert.doesNotMatch(title, /Continue|Go Ahead/i);
  assert.ok(title.split(/\s+/).length <= 8, title);
});

check("slash-only sessions use intent names", () => {
  assert.equal(slashCommandSessionTitle(["/model claude", "/effort high"]), "Model Selection");
});

console.log(`Session title checks: ${checks.length} passed`);
