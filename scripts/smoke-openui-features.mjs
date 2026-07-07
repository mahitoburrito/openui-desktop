import { mkdtemp, rm, writeFile, readFile, access, mkdir } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = Number(process.env.OPENUI_TEST_PORT || 7159);
const BASE_URL = process.env.OPENUI_TEST_BASE_URL || `http://localhost:${PORT}`;

async function waitForServer(url, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/config`);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

async function waitForFileIncludes(path, expected, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const content = await readFile(path, "utf8");
      if (content.includes(expected)) return content;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`File did not include expected text: ${path}`);
}

async function waitForExit(child, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function removeTree(path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(error.code) || attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

async function startServer() {
  if (process.env.OPENUI_TEST_BASE_URL) {
    await waitForServer(BASE_URL);
    return { close: async () => {} };
  }

  const launchCwd = await mkdtemp(join(tmpdir(), "openui-test-home."));
  const child = spawn("node", ["dist/electron/server/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
      HOME: launchCwd,
      PORT: String(PORT),
      LAUNCH_CWD: launchCwd,
      OPENUI_QUIET: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });

  try {
    await waitForServer(BASE_URL);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error.message}\n${logs}`);
  }

  return {
    close: async () => {
      child.kill("SIGTERM");
      await waitForExit(child);
      await removeTree(launchCwd);
    },
  };
}

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

async function makeRepo() {
  const repo = await mkdtemp(join(tmpdir(), "openui-feature-repo."));
  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "OpenUI Test"]);
  await writeFile(join(repo, "tracked.txt"), "one\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

async function api(path, options) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`${path} failed: ${body.error || res.statusText}`);
  }
  return body;
}

async function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const server = await startServer();
  const repos = [];
  let previousAgentRules;
  try {
    previousAgentRules = (await api("/api/agent-rules")).rules || "";

    const repo = await makeRepo();
    repos.push(repo);

    await writeFile(join(repo, "tracked.txt"), "two\n");
    await writeFile(join(repo, "untracked.txt"), "scratch\n");

    const files = await api(`/api/diff/files?path=${encodeURIComponent(repo)}`);
    await assert(files.files.some((file) => file.path === "tracked.txt"), "tracked change missing");
    await assert(files.files.some((file) => file.path === "untracked.txt"), "untracked change missing");

    const summary = await api(`/api/diff/summary?path=${encodeURIComponent(repo)}`);
    await assert(summary.commitMessage.includes("tracked.txt"), "summary did not include tracked file");
    await assert(summary.commitMessage.includes("untracked.txt"), "summary did not include untracked file");

    await api("/api/diff/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: repo, scope: "file", file: "tracked.txt" }),
    });
    await assert((await readFile(join(repo, "tracked.txt"), "utf8")) === "one\n", "tracked file was not restored");

    await api("/api/diff/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: repo, scope: "file", file: "untracked.txt" }),
    });
    let untrackedExists = true;
    try {
      await access(join(repo, "untracked.txt"));
    } catch {
      untrackedExists = false;
    }
    await assert(!untrackedExists, "untracked file was not removed");

    const allRepo = await makeRepo();
    repos.push(allRepo);
    await writeFile(join(allRepo, "tracked.txt"), "changed\n");
    await writeFile(join(allRepo, "extra.txt"), "extra\n");
    await api("/api/diff/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: allRepo, scope: "all" }),
    });
    await assert((await readFile(join(allRepo, "tracked.txt"), "utf8")) === "one\n", "discard all did not restore tracked file");
    let extraExists = true;
    try {
      await access(join(allRepo, "extra.txt"));
    } catch {
      extraExists = false;
    }
    await assert(!extraExists, "discard all did not remove untracked file");

    const checkpointRepo = await makeRepo();
    repos.push(checkpointRepo);
    await writeFile(join(checkpointRepo, "tracked.txt"), "baseline wip\n");
    await writeFile(join(checkpointRepo, "keep.txt"), "keep baseline\n");
    await mkdir(join(checkpointRepo, "nested"), { recursive: true });
    await writeFile(join(checkpointRepo, "nested", "keep.txt"), "nested baseline\n");
    const createdCheckpoint = await api("/api/checkpoints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: checkpointRepo, name: "Known good" }),
    });
    await assert(createdCheckpoint.checkpoint.files.length === 3, "checkpoint should capture changed files");

    const checkpointList = await api(`/api/checkpoints?path=${encodeURIComponent(checkpointRepo)}`);
    await assert(checkpointList.checkpoints.some((item) => item.name === "Known good"), "checkpoint list missing created checkpoint");

    await writeFile(join(checkpointRepo, "tracked.txt"), "agent bad\n");
    await rm(join(checkpointRepo, "keep.txt"), { force: true });
    await rm(join(checkpointRepo, "nested"), { recursive: true, force: true });
    await writeFile(join(checkpointRepo, "extra.txt"), "agent extra\n");
    await api(`/api/checkpoints/${createdCheckpoint.checkpoint.id}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: checkpointRepo }),
    });
    await assert((await readFile(join(checkpointRepo, "tracked.txt"), "utf8")) === "baseline wip\n", "checkpoint did not restore tracked content");
    await assert((await readFile(join(checkpointRepo, "keep.txt"), "utf8")) === "keep baseline\n", "checkpoint did not restore saved untracked file");
    await assert((await readFile(join(checkpointRepo, "nested", "keep.txt"), "utf8")) === "nested baseline\n", "checkpoint did not restore nested untracked file");
    let checkpointExtraExists = true;
    try {
      await access(join(checkpointRepo, "extra.txt"));
    } catch {
      checkpointExtraExists = false;
    }
    await assert(!checkpointExtraExists, "checkpoint did not remove newer untracked file");
    const deletedCheckpoint = await api(
      `/api/checkpoints/${createdCheckpoint.checkpoint.id}?path=${encodeURIComponent(checkpointRepo)}`,
      { method: "DELETE" },
    );
    await assert(deletedCheckpoint.deleted, "checkpoint delete did not report deletion");

    const autoCheckpointRepo = await makeRepo();
    repos.push(autoCheckpointRepo);
    const autoCheckpointSession = await api("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "test",
        agentName: "Auto Checkpoint Test",
        command: "sh -lc 'printf \"agent\\n\" > tracked.txt; printf \"extra\\n\" > extra.txt'",
        cwd: autoCheckpointRepo,
        nodeId: "node-auto-checkpoint-test",
      }),
    });
    await assert(autoCheckpointSession.launchCheckpoint?.id, "session should return launch checkpoint");
    await assert(autoCheckpointSession.launchCheckpoint.source === "session-launch", "launch checkpoint source missing");
    await waitForFileIncludes(join(autoCheckpointRepo, "tracked.txt"), "agent");
    await api(`/api/checkpoints/${autoCheckpointSession.launchCheckpoint.id}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: autoCheckpointRepo }),
    });
    await assert((await readFile(join(autoCheckpointRepo, "tracked.txt"), "utf8")) === "one\n", "launch checkpoint did not restore tracked file");
    let autoExtraExists = true;
    try {
      await access(join(autoCheckpointRepo, "extra.txt"));
    } catch {
      autoExtraExists = false;
    }
    await assert(!autoExtraExists, "launch checkpoint did not remove agent-created file");
    await api(`/api/sessions/${autoCheckpointSession.sessionId}`, { method: "DELETE" });
    await api(
      `/api/checkpoints/${autoCheckpointSession.launchCheckpoint.id}?path=${encodeURIComponent(autoCheckpointRepo)}`,
      { method: "DELETE" },
    );

    const summarySessionRepo = await makeRepo();
    repos.push(summarySessionRepo);
    const summarySession = await api("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "test",
        agentName: "Change Summary Test",
        command: "sh -lc 'printf \"summary\\n\" > tracked.txt; printf \"scratch\\n\" > scratch.txt; sleep 1'",
        cwd: summarySessionRepo,
        nodeId: "node-change-summary-test",
      }),
    });
    await waitForFileIncludes(join(summarySessionRepo, "tracked.txt"), "summary");
    const changeSummaries = await api("/api/sessions/changes");
    const summaryItem = changeSummaries.summaries.find((item) => item.sessionId === summarySession.sessionId);
    await assert(summaryItem, "session change summary missing");
    await assert(summaryItem.changedFileCount === 2, "session change summary should count tracked and untracked files");
    await assert(summaryItem.files.some((file) => file.path === "tracked.txt"), "session change summary missing tracked file");
    await assert(summaryItem.files.some((file) => file.path === "scratch.txt"), "session change summary missing untracked file");
    await api(`/api/sessions/${summarySession.sessionId}`, { method: "DELETE" });
    if (summarySession.launchCheckpoint?.id) {
      await api(
        `/api/checkpoints/${summarySession.launchCheckpoint.id}?path=${encodeURIComponent(summarySessionRepo)}`,
        { method: "DELETE" },
      );
    }

    const taskRepo = await makeRepo();
    repos.push(taskRepo);
    await writeFile(
      join(taskRepo, "package.json"),
      `${JSON.stringify(
        {
          scripts: {
            build: "node -e \"require('fs').writeFileSync('task-output.txt','ok')\"",
            test: "node -e \"console.log('ok')\"",
            lint: "node -e \"console.log('lint')\"",
          },
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(join(taskRepo, "src"), { recursive: true });
    const taskScripts = await api(`/api/tasks/scripts?path=${encodeURIComponent(join(taskRepo, "src"))}`);
    await assert(taskScripts.root === taskRepo, "task discovery should find nearest package root");
    await assert(taskScripts.packageManager === "npm", "task discovery should default to npm");
    const buildScript = taskScripts.scripts.find((script) => script.name === "build");
    await assert(buildScript, "task discovery missing build script");
    await assert(buildScript.runCommand === "npm run 'build'", "build script run command was not shell-safe");
    const taskSession = await api("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "task",
        agentName: "Task",
        command: buildScript.runCommand,
        cwd: taskRepo,
        nodeId: "node-package-task-test",
        customName: "Task: build",
      }),
    });
    await waitForFileIncludes(join(taskRepo, "task-output.txt"), "ok", 10000);
    await api(`/api/sessions/${taskSession.sessionId}`, { method: "DELETE" });
    if (taskSession.launchCheckpoint?.id) {
      await api(
        `/api/checkpoints/${taskSession.launchCheckpoint.id}?path=${encodeURIComponent(taskRepo)}`,
        { method: "DELETE" },
      );
    }

    const hunkRepo = await makeRepo();
    repos.push(hunkRepo);
    const originalLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    await writeFile(join(hunkRepo, "hunks.txt"), `${originalLines.join("\n")}\n`);
    await git(hunkRepo, ["add", "hunks.txt"]);
    await git(hunkRepo, ["commit", "-q", "-m", "add hunks"]);

    const changedLines = [...originalLines];
    changedLines[1] = "line 2 changed";
    changedLines[17] = "line 18 changed";
    await writeFile(join(hunkRepo, "hunks.txt"), `${changedLines.join("\n")}\n`);

    const hunkDiff = await api(
      `/api/diff/file?path=${encodeURIComponent(hunkRepo)}&file=${encodeURIComponent("hunks.txt")}`,
    );
    await assert((hunkDiff.diff.match(/^@@ /gm) || []).length === 2, "test diff should have two hunks");

    await api("/api/diff/discard-hunk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: hunkRepo, file: "hunks.txt", hunkIndex: 0 }),
    });
    const afterHunkReject = await readFile(join(hunkRepo, "hunks.txt"), "utf8");
    await assert(afterHunkReject.includes("line 2\n"), "first hunk was not restored");
    await assert(!afterHunkReject.includes("line 2 changed"), "first hunk change remains");
    await assert(afterHunkReject.includes("line 18 changed"), "second hunk should remain changed");

    const blocked = await fetch(`${BASE_URL}/api/diff/discard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: allRepo, scope: "file", file: "../outside.txt" }),
    });
    await assert(!blocked.ok, "path traversal discard should fail");

    const hunkBlocked = await fetch(`${BASE_URL}/api/diff/discard-hunk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: hunkRepo, file: "../outside.txt", hunkIndex: 0 }),
    });
    await assert(!hunkBlocked.ok, "path traversal hunk discard should fail");

    const promptRepo = await mkdtemp(join(tmpdir(), "openui-prompt-repo."));
    repos.push(promptRepo);
    await api("/api/agent-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules: "Always include the OpenUI smoke rule." }),
    });
    const promptSession = await api("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "test",
        agentName: "Prompt Test",
        command: "cat > prompt.txt",
        cwd: promptRepo,
        nodeId: "node-prompt-test",
        initialPrompt: "hello from launch template",
      }),
    });
    await waitForFileIncludes(join(promptRepo, "prompt.txt"), "hello from launch template");
    const promptContent = await readFile(join(promptRepo, "prompt.txt"), "utf8");
    await assert(promptContent.includes("Persistent OpenUI agent rules:"), "agent rules heading missing from launch prompt");
    await assert(promptContent.includes("Always include the OpenUI smoke rule."), "saved agent rules missing from launch prompt");
    const sortPlan = await api("/api/layout/title-clusters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodes: [{ id: "node-prompt-test", label: "OpenUI Browser Dock" }],
      }),
    });
    await assert(Array.isArray(sortPlan.groups), "title cluster sort did not return groups");
    await assert(
      sortPlan.groups.some((group) => Array.isArray(group.nodeIds) && group.nodeIds.includes("node-prompt-test")),
      "title cluster sort omitted the test session",
    );

    const outboundLinkedInSession = await api("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "test",
        agentName: "Outbound Test",
        command: "cat > outbound-linkedin.txt",
        cwd: promptRepo,
        nodeId: "node-outbound-linkedin",
        customName: "LinkedIn founder outbound messages",
      }),
    });
    const outboundBookfaceSession = await api("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "test",
        agentName: "Outbound Test",
        command: "cat > outbound-bookface.txt",
        cwd: promptRepo,
        nodeId: "node-outbound-bookface",
        customName: "Bookface batchmate outreach list",
      }),
    });
    const checkoutSession = await api("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "test",
        agentName: "Checkout Test",
        command: "cat > checkout.txt",
        cwd: promptRepo,
        nodeId: "node-checkout-stripe",
        customName: "Stripe checkout loading bug",
      }),
    });
    const outboundSortPlan = await api("/api/layout/title-clusters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodes: [
          { id: "node-outbound-linkedin", label: "LinkedIn founder outbound messages" },
          { id: "node-outbound-bookface", label: "Bookface batchmate outreach list" },
          { id: "node-checkout-stripe", label: "Stripe checkout loading bug" },
        ],
      }),
    });
    const outboundGroup = outboundSortPlan.groups.find((group) =>
      Array.isArray(group.nodeIds) &&
      group.nodeIds.includes("node-outbound-linkedin") &&
      group.nodeIds.includes("node-outbound-bookface")
    );
    await assert(outboundGroup, "outbound work across LinkedIn and Bookface should be grouped together");
    await assert(
      !outboundGroup.nodeIds.includes("node-checkout-stripe"),
      "unrelated checkout work should not be grouped with outbound work",
    );
    await api(`/api/sessions/${outboundLinkedInSession.sessionId}`, { method: "DELETE" });
    await api(`/api/sessions/${outboundBookfaceSession.sessionId}`, { method: "DELETE" });
    await api(`/api/sessions/${checkoutSession.sessionId}`, { method: "DELETE" });

    const intentSessions = [
      { nodeId: "node-ide-titles", customName: "Session titles sorting cleanup" },
      { nodeId: "node-ide-sidebar", customName: "OpenUI sidebar polish" },
      { nodeId: "node-ide-notifications", customName: "Notification parsing tweaks" },
      { nodeId: "node-exp-runs", customName: "Manage experimentation runs" },
      { nodeId: "node-exp-dashboard", customName: "Experiments dashboard setup" },
      { nodeId: "node-stripe-webhook", customName: "Stripe webhook retries bug" },
    ];
    const intentSessionIds = [];
    for (const { nodeId, customName } of intentSessions) {
      const created = await api("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: "test",
          agentName: "Intent Test",
          command: `cat > ${nodeId}.txt`,
          cwd: promptRepo,
          nodeId,
          customName,
        }),
      });
      intentSessionIds.push(created.sessionId);
    }
    const intentSortPlan = await api("/api/layout/title-clusters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodes: intentSessions.map(({ nodeId, customName }) => ({ id: nodeId, label: customName })),
      }),
    });
    const ideGroup = intentSortPlan.groups.find((group) =>
      Array.isArray(group.nodeIds) && group.nodeIds.includes("node-ide-titles"),
    );
    await assert(
      ideGroup &&
        ideGroup.nodeIds.includes("node-ide-sidebar") &&
        ideGroup.nodeIds.includes("node-ide-notifications"),
      "IDE tweaking sessions should be grouped together by content",
    );
    const experimentsGroup = intentSortPlan.groups.find((group) =>
      Array.isArray(group.nodeIds) && group.nodeIds.includes("node-exp-runs"),
    );
    await assert(
      experimentsGroup && experimentsGroup.nodeIds.includes("node-exp-dashboard"),
      "experimentation sessions should be grouped together by content",
    );
    await assert(
      !ideGroup.nodeIds.includes("node-stripe-webhook") &&
        !experimentsGroup.nodeIds.includes("node-stripe-webhook"),
      "unrelated webhook work should stay outside intent groups",
    );
    for (const sessionId of intentSessionIds) {
      await api(`/api/sessions/${sessionId}`, { method: "DELETE" });
    }
    await api(`/api/sessions/${promptSession.sessionId}`, { method: "DELETE" });

    console.log("OpenUI feature smoke tests passed");
  } finally {
    if (previousAgentRules !== undefined) {
      await fetch(`${BASE_URL}/api/agent-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: previousAgentRules }),
      }).catch(() => undefined);
    }
    await Promise.all(repos.map((repo) => rm(repo, { recursive: true, force: true })));
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
