# Devboxes: run sessions on a remote machine over SSH

**Date:** 2026-09-21
**Branch:** `feat/devbox-ssh`
**Status:** Approved

## Problem

You provision a devbox and want OpenUI to use it. Today there is no way to say
so. Sessions always launch a local shell, and the only route to a remote machine
is to start a local session and type `ssh` by hand every time.

## What already exists

This matters more than the feature itself, because it determines how much is
left to build.

**The remote protocol is built.** Every session gets a private shim directory
prepended to its PATH (`sessionManager.ts:1581`,
`PATH: ${shimDirectory}${delimiter}${originalPath}`), and that directory
contains an `ssh` shim pointing at `resources/remote-terminal/openui_ssh_wrapper.cjs`.
Anything in the session that runs `ssh` is intercepted: the wrapper mints a
token and a control directory, and stands up `openui_remote_server.py` on the
far side. `terminalRemoteManager` (`terminalRemote.ts`, 967 lines) then serves
remote file reads, patches, path completion and resource commands over a framed
protocol with reconnect.

Because the shim is *first* on PATH and the launch command is typed into that
shell, a session whose launch command is `ssh gpu-box -t claude` gets the same
treatment as one where the user types `ssh` ten minutes later. **This feature is
therefore almost entirely UI and configuration** — it does not touch the remote
protocol.

**There is no saved-host concept.** No list, no status, no way to start a
session on a named machine.

## Scope

In scope: saved devboxes, a Settings tab to manage them, connection testing,
and a "Run on" selector in the new-session modal.

Out of scope: box lifecycle (provision/start/stop), which `prbe-ai/devbox`
already owns; remote directory *browsing* (the remote path is typed, not
picked); and any change to the remote protocol.

## Host sources

Two, deliberately.

**Manual entries** are added in-app: name, host, user, port, identity file. This
is the cold-start path and the reason we do not read `~/.ssh/config` alone — a
box provisioned five minutes ago is not in it, and an empty list with "edit
~/.ssh/config and come back" is a dead end.

**Discovered entries** are read from `~/.ssh/config`. They are *listed* in
Settings, never auto-promoted: a real config is full of things that are not
devboxes. The one on this machine holds bare IPs, `ssh.runpod.io`,
`cory.eecs.berkeley.edu`, and a multi-alias wildcard line
(`Host ashby cedar cory … s275-? hive??`). Dumping that into the session picker
would be noise. You promote the ones you want with "Add as devbox".

The parser must therefore handle **several aliases on one `Host` line** and
**skip any name containing `*` or `?`**, which are match patterns rather than
connectable hosts. `Include` is not supported in this cut; no `Include`
directive appears in practice and the parser ignores unknown keywords rather
than failing.

### Optionally writing back

When adding a manual box, an unticked-by-default checkbox offers to append it to
`~/.ssh/config` as a `Host` block. Ticked, `ssh <name>` then works in your own
terminal and for every other tool, and converges on the aliases the team's
devbox repo already standardises on.

This edits a file the user owns, so it is deliberately conservative: append
only, never rewrite or reorder existing blocks; copy the file to
`~/.ssh/config.openui-backup-<timestamp>` first; and **refuse** if the alias
already exists rather than shadow or clobber it. Failure to write is reported
and never blocks saving the devbox itself.

## Data model

`DevboxConfig`, stored in the existing app config
(`${LAUNCH_CWD}/.openui-desktop/config.json`) as `devboxes: DevboxConfig[]`:

| field | meaning |
| --- | --- |
| `id` | stable identifier |
| `name` | display name, and the ssh alias when `source` is `ssh-config` |
| `source` | `manual` or `ssh-config` |
| `host` / `user` / `port` / `identityFile` | connection details, `manual` only |
| `inSshConfig` | true when the alias resolves through `~/.ssh/config` |
| `defaultPath` | optional remote working directory |

No secrets are stored. An identity file is referenced **by path**; keys and
passphrases stay where ssh already keeps them. Entries whose `source` is
`ssh-config` store only the alias — the details stay in the config file and are
re-read, so they cannot drift.

## Connecting

`buildSshTarget(devbox)` produces the argument list:

- `inSshConfig` → `["<name>"]`, letting ssh apply the user's own `HostName`,
  `User`, `Port`, `IdentityFile`, keepalives and host-key settings.
- otherwise → `["-p", port]`, `["-i", identityFile]`, `user@host`, with only the
  parts that are set.

**Test connection** runs the same target with
`-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new` and
`true`, through the *real* ssh rather than the shim, so a test never starts a
remote server. It reports the exit status and, on failure, ssh's own stderr —
"Permission denied (publickey)" is far more useful than "could not connect".
`BatchMode` guarantees it fails instead of hanging on a password prompt.

## Launching a session on a devbox

The new-session modal gains a **Run on** selector: `Local` plus each saved
devbox. Choosing a devbox reveals a remote **working directory** field, seeded
from `defaultPath`.

The launch command becomes, with the agent command and args already resolved:

```
ssh <target…> -t 'cd <remote path> && exec <agent> <args>'
```

`-t` forces a PTY, which the agent TUIs require. `exec` replaces the shell so
that quitting the agent ends the session rather than dropping to a remote
prompt. The `cd` is omitted when no path is given. The remote path is
single-quote escaped.

The session's **local** `cwd` stays a real local directory — the ssh client has
to run somewhere, and `pty.spawn` requires a valid cwd. It is not shown as the
session's location; `devboxId` and `remotePath` ride on the session record and
the UI labels the session `gpu-box:/home/ubuntu/repo` instead.

### Missing agents

Not handled, deliberately, because **local sessions do not handle it either**.
`/api/agents` is a hardcoded list; `resolveAgentLaunchCommand` falls through to
the bare command when the executable is absent, and the shell reports
`command not found`. A remote session behaves identically. Building remote-only
agent probing would solve on the harder side a problem the product does not
solve on the easier one. If it becomes a real annoyance, the fix is one
availability check serving both.

## Components

| unit | responsibility |
| --- | --- |
| `server/services/sshConfig.ts` | parse `~/.ssh/config`; append a host block |
| `server/services/devboxes.ts` | CRUD over the config list, `buildSshTarget`, `testDevbox` |
| `server/routes/devboxes.ts` | `GET /devboxes`, `POST`, `PUT /:id`, `DELETE /:id`, `POST /:id/test` |
| `client/src/components/settings/DevboxesTab.tsx` | the Settings tab |
| `NewSessionModal` | Run on selector, remote path, command assembly |

`sshConfig.ts` is kept separate from `devboxes.ts` because parsing and editing
someone's ssh config is the part most worth testing in isolation, and it has no
dependency on our config store.

## Testing

- Unit coverage for the parser via a new `scripts/test-devboxes.mjs`, following
  the existing `test-status` / `test-coordinator` pattern: multi-alias `Host`
  lines, wildcard rejection, missing file, unknown keywords, and
  `buildSshTarget` for each shape.
- Append safety: refuses a duplicate alias, writes a backup, leaves existing
  blocks byte-identical.
- Manual, against a real devbox if one is reachable, otherwise `localhost` as a
  stand-in host: add, test, launch a session, confirm the remote server attaches
  (`terminalRemoteManager.isConnected`).
- `build:electron`, `build:client`, `test:status`, `test:coordinator` stay green.

## Risks

- **Editing `~/.ssh/config`.** Mitigated by append-only, backup, and refusing
  duplicates — but it is the one action here that touches a file outside our
  own state directory, and it stays opt-in and off by default.
- **`-t` and quoting.** A remote path with quotes or spaces must not break the
  command or allow injection. The path is single-quote escaped, and the test
  suite covers it.
- **Session record fields.** `devboxId` / `remotePath` are additive and optional;
  older persisted sessions lack them and must keep loading.
