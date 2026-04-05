# OpenUI Desktop

**Your AI Agent Command Center — as a native desktop app.**

A standalone Electron application that packages the full [OpenUI](https://github.com/mahitoburrito/openui) experience into a native desktop app. Manage multiple AI coding agents on an infinite canvas without needing a browser or Bun runtime.

## Install

### Desktop App (Electron)

Download the latest release for your platform:

**[Download from GitHub Releases](https://github.com/mahitoburrito/openui-desktop/releases/latest)**

| Platform | Download |
|----------|----------|
| Mac (Apple Silicon) | `OpenUI-x.x.x-arm64.dmg` |
| Mac (Intel) | `OpenUI-x.x.x-x64.dmg` |
| Windows | `OpenUI-Setup-x.x.x.exe` |
| Linux | `OpenUI-x.x.x.AppImage` or `.deb` |

**Mac users:** The app is unsigned. On first launch, right-click the app → **Open** → **Open** to bypass Gatekeeper. You only need to do this once.

### Browser (no install)

Run it instantly in your browser with npx — no download required:

```bash
npx openui-desktop
```

This starts a local server and opens the UI at `http://localhost:6968`.

### From Source

```bash
git clone https://github.com/mahitoburrito/openui-desktop.git
cd openui-desktop
npm install

# Run as desktop app (Electron)
npm run dev

# Or run as browser app
npm start
```

## Requirements

- **Desktop app:** Just download and run — everything is bundled
- **npx / source:** Node.js 18+, plus one of: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), OpenCode, or Ralph Loop installed globally

## Updating

### Desktop App

Check [GitHub Releases](https://github.com/mahitoburrito/openui-desktop/releases/latest) for new versions. Download the latest DMG/installer and replace the old app.

### npx

Always runs the latest version automatically:

```bash
npx openui-desktop@latest
```

### From Source

```bash
git pull
npm install
npm run dev
```

## Features

- **Infinite canvas** with drag-and-drop agent nodes
- **Real-time status** — Running, Idle, Needs Input, Tool Calling
- **Built-in terminal** with resizable sidebar
- **Auto-naming** — sessions named from your first prompt
- **Agent support** — Claude Code, OpenCode, Ralph Loop
- **Linear integration** — start sessions from tickets
- **GitHub integration** — browse and start from issues
- **Git worktrees** — isolated branches per agent
- **Categories** — group agents by team or project
- **Persistent layout** — everything saved across restarts
- **Claude Code plugin** — precise status via hooks (auto-injected)

## Development

```bash
npm install
npm run dev
```

In dev mode:
- React client runs on `http://localhost:5173` via Vite
- Embedded server runs on port `6968`
- Vite proxies `/api` and `/ws` to the server
- Electron loads from the Vite dev server with DevTools open

Use `PORT=7968 npm run dev` to run on a different port (useful if the browser version is already running).

## Build & Package

```bash
# Build client + electron
npm run build

# Package as directory (for testing)
npm run pack

# Build distributable (DMG/AppImage/NSIS)
npm run dist
```

Output goes to `release/`.

## Releasing a New Version

Releases are built automatically by GitHub Actions for all platforms.

```bash
# Bump version
npm version patch    # or minor, or major

# Push the tag — CI builds Mac, Windows, and Linux
git push && git push --tags
```

The workflow builds and uploads binaries to the GitHub Release automatically.

## Architecture

```
openui-desktop/
├── bin/                  # CLI entry point for npx
├── electron/
│   ├── main.ts           # Electron main process
│   └── preload.ts        # Context bridge for renderer
├── server/               # Embedded Node.js server
│   ├── index.ts          # HTTP + WebSocket (Hono + ws + node-pty)
│   ├── routes/api.ts     # REST API
│   └── services/         # Session, persistence, Linear, GitHub
├── client/               # React frontend (ReactFlow canvas)
├── claude-code-plugin/   # Status reporter plugin for Claude Code
└── package.json
```

### Web vs Desktop

| Aspect | Web (openui) | Desktop (openui-desktop) |
|--------|-------------|------------------------|
| Runtime | Bun | Node.js (via Electron) |
| PTY | bun-pty | node-pty |
| WebSocket | Bun native WS | ws library |
| HTTP | Bun.serve + Hono | @hono/node-server |
| Entry | CLI (`openui`) | Electron app or `npx` |
| Window | Browser tab | Native BrowserWindow |
| Data dir | `.openui/` | `.openui-desktop/` |

## License

MIT
