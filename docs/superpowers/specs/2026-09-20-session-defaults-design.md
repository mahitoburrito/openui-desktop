# Session defaults, native folder picker, and overview click-off

**Date:** 2026-09-20
**Branch:** `feat/session-defaults`
**Status:** Approved

## Problem

Four unrelated papercuts in the session-launch path:

1. Every Claude Code session types `/careful` into itself two seconds after
   launch. It is on by default and most launches do not want it.
2. Picking a working directory for a new session uses a homegrown directory
   browser — a custom list rendered from `GET /api/browse`, driven by five
   pieces of component state. It is slower and less capable than the folder
   panel macOS already ships (no favourites, no typeahead, no iCloud, no
   drag-in, no keyboard navigation users already know).
3. There is nowhere to set a default starting directory, so every new session
   begins at `launchCwd` and is retargeted by hand.
4. In the session overview, an expanded card can only be collapsed via the back
   button or Esc. Clicking the surrounding grid — the obvious gesture — does
   nothing.

## Scope

In scope: the four items above. Out of scope: renaming `LinearConfig` (see
Decisions), reworking `/api/browse`, and any change to the release pipeline.

## Work item 1 — `/careful` off by default

The feature and its Settings toggle stay. Only the default flips, from on to
off, in the four places that independently encode it:

| File | Current | Target |
| --- | --- | --- |
| `server/routes/api.ts:3586` | `config.autoCareful ?? true` | `config.autoCareful ?? false` |
| `server/services/sessionManager.ts:2089` | `autoCareful !== false` | `autoCareful === true` |
| `client/src/components/SettingsModal.tsx:96` | `useState(true)` | `useState(false)` |
| `client/src/components/SettingsModal.tsx:136` | `config.autoCareful ?? true` | `config.autoCareful ?? false` |

`sessionManager.ts:2089` is the load-bearing one: it guards the
`writeTerminalData(sessionId, "/careful", …)` call. The other three keep the
server's advertised default and the Settings UI agreeing with it, so the toggle
does not render as on while the behaviour is off.

No migration is needed. `loadConfig()` reads
`${LAUNCH_CWD}/.openui-desktop/config.json`, which does not exist on a machine
that has never saved settings; `autoCareful` is therefore unset and picks up the
new default. A user who has explicitly saved `true` keeps it on, which is
correct — that is a real preference, not an inherited default.

## Work item 2 — native macOS folder picker

### Main process

New `electron/nativeDialog.ts` registers the app's first `ipcMain.handle`, on
channel `dialog:open-directory`, following the `registerClipboardIpc` /
`registerBrowserViewIpc` module pattern (a `register…`/`destroy…` pair wired
into `main.ts` alongside the others):

```ts
const result = await dialog.showOpenDialog(window, {
  properties: ["openDirectory", "createDirectory"],
  defaultPath: defaultPath || undefined,
});
return result.canceled ? null : (result.filePaths[0] ?? null);
```

It takes `getWindow: () => BrowserWindow | null` so the dialog is sheet-attached
to the app window when one exists.

`preload.ts` needs no change — it already exposes a generic
`invoke(channel, ...args)` bridge, added for exactly this purpose.

### Renderer

New `client/src/utils/nativeDirectoryPicker.ts` (alongside the existing
`client/src/utils/` helpers), deliberately tiny:

- `canUseNativeDirectoryPicker(): boolean` — true when
  `window.electronAPI?.isElectron` and `invoke` is a function.
- `pickDirectoryNative(defaultPath?: string): Promise<string | null>` — awaits
  the IPC call, returns `null` on cancel or on any throw.

### Call site

`NewSessionModal.openDirPicker` branches:

- native available → `await pickDirectoryNative(cwd || effectiveDefaultDir)`;
  a non-null result goes through the existing `selectDirectory(path)`, which
  already sets `cwd`, records `lastPickedDirectory`, and triggers
  `scanForRepos`. A `null` result is a cancel and does nothing.
- otherwise → today's behaviour: `setShowDirPicker(true)` and `browsePath(…)`.

All `dirBrowse*` state, the inline panel, and `GET /api/browse` stay exactly as
they are. They are the browser-client fallback and are also what the isolated
smoke-server recipe exercises.

## Work item 3 — Settings → Sessions tab

A fourth tab, `"sessions"`, added to the `SettingsTab` union and the `TABS`
array in `SettingsModal.tsx`. Its body lives in a new file,
`client/src/components/settings/SessionsTab.tsx`, rather than as a fifth
in-file tab component: `SettingsModal.tsx` is already 1024 lines and holds
three tab bodies plus the shared `SettingRow` / `Toggle` / `SectionHeader`
primitives. Those primitives move to `client/src/components/settings/primitives.tsx`
so both files import them from one place rather than the tab importing back from
`SettingsModal` — which would be an import cycle. The visual language is
unchanged.

### Settings in the tab

**Section: Defaults**

| Setting | Config key | Type | Default |
| --- | --- | --- | --- |
| Default starting directory | `defaultStartingDirectory` | `string` | `""` (means `launchCwd`) |
| Remember last-used directory | `rememberLastDirectory` | `boolean` | `true` |
| Default agent | `defaultAgentId` | `string` | `""` (means no preselection) |
| Default initial prompt | `initialPrompt` | `string` | `""` |

*Default starting directory* gets a Browse button wired to the same
`pickDirectoryNative` helper from work item 2, falling back to a plain text
input outside Electron.

*Default agent* is a `<select>` populated from the `agents` array already in the
zustand store (fetched from `/api/agents`).

*Default initial prompt* is a textarea. `initialPrompt` already exists on
`LinearConfig` and is currently written by nothing and read by nothing; this
gives it a UI. `NewSessionModal` seeds its prompt field from it for new
sessions only, never when replacing an existing session.

**Section: Git** — the three rows moved out of `GeneralTab`, unchanged in
behaviour: Auto /careful, Git worktree, Default base branch. `GeneralTab` loses
its entire `Git` `SectionHeader` block; its `autoCareful`, `createWorktree`, and
`defaultBaseBranch` props move to `SessionsTab`.

### Server

`LinearConfig` in `server/types/index.ts` gains the three new optional fields
(`initialPrompt` already existed). `loadConfig`/`saveConfig` in
`server/services/linear.ts` read and write all four.
`GET /linear/config` returns them with the defaults above; `POST /linear/config`
persists them with the same `if (body.x !== undefined)` guard the existing
fields use.

### Directory precedence

`NewSessionModal` currently resolves the working directory as
`cwd || lastPickedDirectory || launchCwd` when opening the browser and
`cwd || existingSession?.cwd || launchCwd` when submitting. Both collapse to one
helper with this order:

1. the session being replaced (`existingSession.originalCwd || .cwd`)
2. `lastPickedDirectory` — **only if** `rememberLastDirectory` is true
3. `defaultStartingDirectory`
4. `launchCwd`

Last-picked outranks the configured default when remembering is on, because it
is the more recent signal of intent; turning the toggle off is what makes the
configured default authoritative. The "Last picked" shortcut button in the
modal is hidden when `rememberLastDirectory` is false.

## Work item 4 — overview click-off collapses

In `SessionOverview.tsx`, inside the `relative grid` container and before the
mapped cards, render a backdrop only while a card is expanded:

```tsx
{overviewExpandedNodeId && (
  <div
    className="absolute inset-0 z-20 cursor-zoom-out"
    onClick={() => setOverviewExpandedNodeId(null)}
    aria-hidden
  />
)}
```

This reuses the exact state transition the back button performs
(`onCollapse={() => setOverviewExpandedNodeId(null)}`), so click-off, the back
button, and Esc are one behaviour.

**The expanded card must also be inset.** It was `absolute inset-0`, which
covers the grid exactly — measured at 16,120 1408x764 for both card and
backdrop, so the backdrop was completely occluded and could never receive a
click. There was no "outside" to click. Changing the card to `absolute inset-6`
leaves a 24px frame of backdrop on all four sides, which both makes the gesture
possible and reads as the lightbox it now is. Non-expanded cards are
`relative` with no z-index and sit below; dimmed cards are already
`pointerEvents: "none"`.

## Work item 5 — make the Settings modal reachable

Discovered while verifying work item 3: `SettingsModal` is exported and
imported by **nothing**. On `origin/main` the entire settings UI is dead code
with no way to open it, so a new tab inside it would be invisible. Adding the
tab is pointless without this.

- `useStore` gains `settingsOpen` / `setSettingsOpen`, mirroring
  `commandPaletteOpen`.
- `App.tsx` mounts `<SettingsModal open={settingsOpen} …/>` next to
  `<CommandPalette />`.
- `Header.tsx` gains a gear button after the focus-mode button, matching the
  other `commandButton` controls.
- `useKeyboardShortcuts` binds Cmd+, the way it binds Cmd+K for the palette.

## Decisions

**Extending `LinearConfig` rather than renaming it.** The type is a misnomer —
it is the general app config, holding the terminal, git, and notification
settings alongside the Linear API key, and it persists to
`.openui-desktop/config.json`, not to anything Linear-specific. Renaming it
would touch `server/types/index.ts`, `server/services/linear.ts`,
`server/routes/api.ts`, and every settings consumer, for no behavioural gain and
a large unrelated diff. Noted here as known debt; not done.

**Keeping the homegrown picker.** The app runs both under Electron and as a
plain web client served by the standalone server, where `window.electronAPI` is
absent and no native dialog is reachable. Deleting the fallback would break the
browser client and the isolated smoke-server recipe used for testing.

## Testing

- `tsc --noEmit` on the client and `npm run build:electron` clean, apart from a
  pre-existing `PRBEPanel.tsx` `replaceAll` error introduced by `fc3b045`
  (an ES2021 `lib` target issue, in a file this work does not touch).
- `npm run test:status` green at 28 passed, 0 failed — untouched, run as a
  regression guard since `sessionManager.ts` is edited.
- Manual, in the isolated smoke instance (`PORT=7968 LAUNCH_CWD=<scratch>`), not
  against the real app on 6968:
  - a Claude session launches with no `/careful` typed into it;
  - enabling the toggle in Settings restores the old behaviour;
  - in the browser client the Browse button still opens the inline panel
    (this is the fallback path; the native path needs a packaged Electron run);
  - the Sessions tab round-trips all four settings through
    `config.json`;
  - a new session opens at the configured default directory, and at the
    last-picked one when remembering is on;
  - expanding an overview card and clicking the grid collapses it, while
    clicking inside the card's terminal does not.

## Validation in the real Electron app (2026-09-20)

Run against an isolated instance (`PORT=7969`, `VITE_PORT=5273`, scratch
`LAUNCH_CWD`), driven over the Chromium debugging protocol with the native
panel driven by System Events. The packaged app on 6968 was never touched and
`~/.openui-desktop/config.json` was never written.

- **Native panel is real and sheet-attached.** `dialog:open-directory` opens a
  sheet on the OpenUI window whose buttons are `[New Folder] [Cancel] [Open]` —
  an NSOpenPanel with `openDirectory` + `createDirectory`. Selecting a folder
  resolved to that exact path; Cancel resolved to `null`.
- **Both call sites work.** From Settings the picked path lands in the input and
  survives Save into `config.json`; from the new-session modal it lands in the
  working-directory field, the "Last picked" shortcut appears, and the homegrown
  inline panel does not render.
- **Defaults flow through.** With a default starting directory saved, the
  new-session modal opens pre-filled with it.
- **`Cmd+,` opens Settings** with all four tabs; the Sessions tab shows all
  seven rows.
- **`/careful`, instrumented A/B.** With `autoCareful` true the guard is entered
  and the write executes; with it false (the shipped default) the guard is not
  entered and nothing is written. `isClaudeCommand` is `true` in both arms, so
  the negative result is the guard doing its job, not a mis-detected command.
  Note that grepping the terminal stream for `/careful` is **not** a valid
  detector — Claude Code's TUI does not echo bracketed-paste input literally,
  so that check reads false in both arms.
- **Click-off collapses.** Card `[40,144,1320,700]` inside backdrop
  `[16,120,1368,748]`, a 24px gutter; the backdrop is the topmost element there,
  and clicking it returns to the grid while clicking inside the card does not.

## Risks

- `sessionManager.ts` is the file the status engine and terminal lifecycle both
  live in. The edit is one boolean condition inside `dispatchInitialCommand`;
  it must not disturb `startTrackedCommand` or the `promptDelay` chain that
  follows it.
- Moving three rows between tab components is a prop-threading change across
  two files; the risk is a setting that renders but no longer saves. The
  round-trip check in Testing covers it.
- Landing: merging to main **is** releasing (any push to main auto-bumps, tags,
  builds, and publishes), and the `Validate` job has been red since 2026-08-18.
  This work lands as a PR and does not push to main.
