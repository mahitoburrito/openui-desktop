# Terminal Tab Bar — Design Spec

**Date:** 2026-04-19
**Status:** Approved (pending written-spec review)

## Summary

Add a browser-style tab bar at the top of the canvas that lists every active agent session. Clicking a tab opens the sidebar with that session's terminal. The tab bar is a parallel navigation surface alongside the infinite canvas — you can drive the app entirely from tabs without touching the canvas.

## Motivation

Today, switching between agent sessions requires:
1. Going back to the canvas
2. Locating the right node
3. Clicking it to open the sidebar

With many agents, this is slow. A persistent tab bar gives a one-click path to any session and a scannable overview of all running work.

## Scope

**In scope:**
- Tab bar between `Header` and the canvas in `App.tsx`
- One tab per active session, auto-managed from `sessions` state
- Click tab → open sidebar on that session
- Close tab → delete session (reuses existing undo flow)
- Shrink-to-fit tabs with horizontal scroll when they hit min width
- Status dot, agent icon (colored), session name per tab

**Out of scope (v1):**
- Drag-to-reorder tabs
- Keyboard shortcuts (Cmd+1..9, etc)
- Pinning tabs
- A "+" button (creation stays in the header's "New Agent" button)
- Tabs without a corresponding canvas node (tab ≡ session ≡ node, always)

## Architecture

### Data flow

Tabs are a pure view over the existing `sessions` Map in `useStore`. No new state.

- **Source:** `sessions: Map<string, AgentSession>` (already preserves insertion order)
- **Active tab derivation:** `sidebarOpen && selectedNodeId` → the tab for `selectedNodeId` is active. Otherwise no tab is active.
- **Click handler:** `setSelectedNodeId(nodeId)` + `setSidebarOpen(true)` — same as canvas node click.
- **Close handler:** same path as deleting a node on the canvas (invokes the existing delete + `UndoDeleteToast` flow).

### Placement

In `App.tsx`, the tree becomes:

```
<Header />
<TabBar />    ← new
<Canvas ... />
<Sidebar />
```

The canvas takes the remaining vertical space (`flex-1`). Header is 56px, TabBar is 36px.

### Component structure

```
client/src/components/TabBar.tsx
  └─ Tab.tsx (per session, memoized on sessionId)
       ├─ Agent icon (tinted with customColor || color)
       ├─ Status dot (statusConfig color)
       ├─ Name (customName || agentName, truncated)
       └─ Close button (visible on hover or if tab is active)
```

**Memoization:** each `Tab` subscribes to its own session via a selector (`useStore(state => state.sessions.get(nodeId))`) so a status change on session X does not re-render tabs for session Y.

## Behavior

### Click tab
- Call `setSelectedNodeId(nodeId)` and `setSidebarOpen(true)`.
- If sidebar is already open on that session, no-op.

### Close tab (X button)
- Delete the session + node via the existing delete flow (same as canvas-node delete).
- `UndoDeleteToast` handles undo.
- `e.stopPropagation()` on the X button so the click doesn't also fire the tab click.

### Active tab visibility
- Close button is visible on hover over any tab.
- Close button is also always visible on the active tab (so you can close the active session without hunting).

### Canvas ↔ tabs sync
- One-way: tabs read `selectedNodeId` and `sidebarOpen` to show active state.
- Clicking a canvas node already sets those; the matching tab goes active automatically. No extra wiring.

### Persistence
- None. Sessions persist across restarts; tabs are derived from sessions.

## Overflow & layout

Shrink-to-fit (Chrome-style):
- Tab min-width: 80px (icon + dot + ~4 chars + close, still readable)
- Tab max-width: 180px (comfortable for ~20-char names)
- Between min and max: `flex: 1 1 auto` with `max-width: 180px` cap, tabs share available space
- When all tabs are at min-width and still don't fit: container scrolls horizontally (`overflow-x-auto`)

Empty state (`sessions.size === 0`): the bar renders as an empty 36px strip with just the bottom border. No placeholder text.

## Visual spec

### Bar container
- Height: 36px
- Background: `bg-canvas-dark` (matches header)
- Bottom border: `border-b border-border`
- Padding: 0 (tabs go edge-to-edge)
- Overflow: `overflow-x-auto` with a thin/hidden scrollbar

### Tab (inactive)
- Height: 36px (fills bar)
- Padding: `px-3`, internal `gap-2`
- Right border: `border-r border-border` to separate tabs
- Layout: `[icon] [status-dot] [name...] [close-on-hover]`
- Name color: `text-zinc-400`, `text-xs`
- Background: transparent
- Hover: `bg-surface`

### Tab (active)
- Top border: 2px solid, color = `session.customColor || session.color`
- Background: `bg-surface-active`
- Name color: `text-white`
- Close button: always visible

### Agent icon
- 14px, tinted with agent color
- Uses same icon map as `Sidebar.tsx` (`sparkles`, `code`, `cpu`, `zap`, `rocket`, `bot`, `brain`, `wand2`)
- Icon id comes from `node.data.icon` (fallback `"cpu"`)

### Status dot
- 6px circle
- Color from existing `statusConfig` map (running=green, waiting_input=yellow, tool_calling=purple, idle=gray, disconnected=red, error=red)

### Name
- `text-xs`, truncated with ellipsis (`truncate`)
- `title={name}` attribute for full tooltip on hover

### Close button
- 14px X icon, `text-zinc-500 hover:text-white`
- 16px hit target
- `onClick` calls `e.stopPropagation()` then deletes the session

## Files touched

- `client/src/App.tsx` — insert `<TabBar />` between `<Header />` and the canvas
- `client/src/components/TabBar.tsx` — new file
- `client/src/components/Tab.tsx` — new file (or inline inside `TabBar.tsx` if small enough)

No changes to:
- Store (`useStore.ts`) — reads only
- `Sidebar.tsx`
- `Terminal.tsx`
- Server code

## Testing

Manual test checklist:
- Create 1 session → tab appears; click tab → sidebar opens.
- Create 5 sessions → all tabs fit with breathing room.
- Create 30 sessions → tabs shrink to min-width, bar scrolls horizontally.
- Click node on canvas → matching tab goes active.
- Click tab X → session deleted, undo toast appears; clicking undo restores the tab.
- Close sidebar → no tab is active.
- Status changes on a session → only that tab's dot updates (no other tabs re-render; verify with React DevTools profiler).
- Tab name reflects `customName` after rename in sidebar edit panel.

## Open questions

None at this time. Keyboard shortcuts (Cmd+1..9) and drag-to-reorder are deliberately deferred to a follow-up.
