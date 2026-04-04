# OpenUI Desktop

**Your AI Agent Command Center — as a native desktop app.**

A standalone Electron application that packages the full [OpenUI](https://github.com/mahitoburrito/openui) experience into a native desktop app. Manage multiple AI coding agents on an infinite canvas without needing a browser or Bun runtime.

## Why Desktop?

- **No browser tab** — dedicated window with native OS integration
- **No runtime dependency** — ships with everything bundled (no Bun required)
- **Native titlebar** — draggable window with macOS traffic lights
- **Single binary** — one app, double-click to launch
- **Cross-platform** — macOS, Linux, and Windows

## Features

Everything from OpenUI, running natively:

- **Infinite canvas** with drag-and-drop agent nodes
- **Real-time status** — Running, Idle, Needs Input, Tool Calling
- **Built-in terminal** with resizable sidebar (drag the left edge)
- **Auto-naming** — sessions are named from your first prompt
- **Agent support** — Claude Code, OpenCode, Ralph Loop
- **Linear integration** — start sessions from tickets
- **GitHub integration** — browse and start from issues
- **Git worktrees** — isolated branches per agent
- **Categories** — group agents by team or project
- **Persistent layout** — everything saved across restarts
- **Claude Code plugin** — precise status via hooks (auto-injected)

## Installation

### From Source

```bash
git clone https://github.com/mahitoburrito/openui.git
cd openui-desktop

# Install dependencies
npm install

# Run in development mode
npm run dev

# Build distributable
npm run dist
```

### Requirements

- Node.js 18+
- npm or yarn
- One of: Claude Code, OpenCode, or Ralph Loop installed globally

## Development

```bash
# Install all dependencies (root + client)
npm install

# Run dev mode (Vite dev server + Electron)
npm run dev
```

In dev mode:
- The React client runs on `http://localhost:5173` via Vite
- The embedded server runs on port `6968`
- Vite proxies `/api` and `/ws` to the server
- Electron loads from the Vite dev server with DevTools open

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

## Architecture

```
openui-desktop/
├── electron/
│   ├── main.ts           # Electron main process — creates window, starts server
│   └── preload.ts        # Context bridge for renderer
├── server/               # Embedded Node.js server (ported from Bun)
│   ├── index.ts          # HTTP + WebSocket server (Hono + ws + node-pty)
│   ├── routes/api.ts     # REST API endpoints
│   ├── services/
│   │   ├── sessionManager.ts  # PTY lifecycle, plugin injection
│   │   ├── persistence.ts     # State save/load to .openui-desktop/
│   │   ├── linear.ts          # Linear API integration
│   │   └── github.ts          # GitHub Issues API
│   └── types/index.ts    # TypeScript interfaces
├── client/               # React frontend (identical to web version)
│   └── src/
│       ├── App.tsx        # ReactFlow canvas
│       ├── components/    # UI components
│       └── stores/        # Zustand state
├── claude-code-plugin/   # Status reporter plugin for Claude Code
└── package.json          # Electron + electron-builder config
```

### Key Differences from Web Version

| Aspect | Web (openui) | Desktop (openui-desktop) |
|--------|-------------|------------------------|
| Runtime | Bun | Node.js (via Electron) |
| PTY | bun-pty | node-pty |
| WebSocket | Bun native WS | ws library |
| HTTP | Bun.serve + Hono | @hono/node-server |
| Entry | CLI (`openui`) | Electron app |
| Window | Browser tab | Native BrowserWindow |
| Data dir | `.openui/` | `.openui-desktop/` |

## Data Storage

State is saved to `.openui-desktop/` in the launch directory (defaults to home):
- `state.json` — node positions, session metadata, categories
- `buffers/*.txt` — terminal output history per session
- `config.json` — Linear settings
- `.env` — Linear API key

## License

MIT
