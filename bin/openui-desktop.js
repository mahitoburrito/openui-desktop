#!/usr/bin/env node

const { execSync, spawn } = require("child_process");
const { existsSync, mkdirSync, readFileSync } = require("fs");
const { join } = require("path");
const { homedir } = require("os");

const packageJson = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8")
);
const CURRENT_VERSION = packageJson.version;

const PORT = process.env.PORT || 6968;
const LAUNCH_CWD = process.cwd();
const IS_DEV = process.env.NODE_ENV === "development" || process.argv.includes("--dev");

// Auto-install plugin if not present
function ensurePluginInstalled() {
  const pluginDir = join(homedir(), ".openui", "claude-code-plugin");
  const pluginJson = join(pluginDir, ".claude-plugin", "plugin.json");

  if (existsSync(pluginJson)) return;

  console.log("\x1b[38;5;141m[plugin]\x1b[0m Installing Claude Code plugin...");

  const GITHUB_RAW =
    "https://raw.githubusercontent.com/mahitoburrito/openui-desktop/main/claude-code-plugin";

  try {
    execSync(`mkdir -p "${pluginDir}/.claude-plugin" "${pluginDir}/hooks"`, {
      stdio: "pipe",
    });
    execSync(
      `curl -sL ${GITHUB_RAW}/.claude-plugin/plugin.json -o "${pluginDir}/.claude-plugin/plugin.json"`,
      { stdio: "pipe" }
    );
    execSync(
      `curl -sL ${GITHUB_RAW}/hooks/hooks.json -o "${pluginDir}/hooks/hooks.json"`,
      { stdio: "pipe" }
    );
    execSync(
      `curl -sL ${GITHUB_RAW}/hooks/status-reporter.sh -o "${pluginDir}/hooks/status-reporter.sh"`,
      { stdio: "pipe" }
    );
    execSync(`chmod +x "${pluginDir}/hooks/status-reporter.sh"`, {
      stdio: "pipe",
    });
    console.log("\x1b[38;5;82m[plugin]\x1b[0m Plugin installed successfully!");
  } catch (e) {
    console.error("\x1b[38;5;196m[plugin]\x1b[0m Failed to install plugin:", e.message);
  }
}

// Check for updates (non-blocking)
async function checkForUpdates() {
  try {
    const res = await fetch(
      "https://registry.npmjs.org/@mahitoburrito%2fopenui-desktop/latest",
      { signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return;
    const data = await res.json();
    if (data.version && data.version !== CURRENT_VERSION) {
      console.log(
        `\x1b[33m  Update available: ${CURRENT_VERSION} → ${data.version}\x1b[0m`
      );
      console.log(
        `\x1b[38;5;245m  Run: npx @mahitoburrito/openui-desktop@latest\x1b[0m\n`
      );
    }
  } catch {
    // Silently ignore
  }
}

// Clear screen and show banner
console.clear();
console.log(`
\x1b[38;5;141m
   ╔═══════════════════════════════════════════════════════════╗
   ║                                                           ║
   ║              OpenUI Desktop  v${CURRENT_VERSION.padEnd(25)}║
   ║              AI Agent Command Center                      ║
   ║                                                           ║
   ╚═══════════════════════════════════════════════════════════╝
\x1b[0m
\x1b[38;5;251m                 ➜  \x1b[1m\x1b[38;5;141mhttp://localhost:${PORT}\x1b[0m
\x1b[38;5;245m                    Press Ctrl+C to stop\x1b[0m
`);

ensurePluginInstalled();
checkForUpdates();

// Compile TypeScript and start server
const tsconfigPath = join(__dirname, "..", "tsconfig.electron.json");
const serverEntry = join(__dirname, "..", "dist", "electron", "server", "index.js");

// Build if needed
if (!existsSync(serverEntry)) {
  console.log("\x1b[38;5;245m[build]\x1b[0m Compiling server...");
  execSync(`npx tsc -p "${tsconfigPath}"`, {
    cwd: join(__dirname, ".."),
    stdio: IS_DEV ? "inherit" : "pipe",
  });
}

// Start the server
process.env.PORT = String(PORT);
process.env.LAUNCH_CWD = LAUNCH_CWD;
process.env.OPENUI_QUIET = IS_DEV ? "" : "1";

const { startServer } = require(serverEntry);
startServer();

// Open browser after a short delay
setTimeout(() => {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    execSync(`${cmd} http://localhost:${PORT}`, { stdio: "pipe" });
  } catch {
    // Ignore if browser can't be opened
  }
}, 1500);
