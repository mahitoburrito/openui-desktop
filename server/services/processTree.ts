import { execFile, execFileSync } from "child_process";

const QUIET = !!process.env.OPENUI_QUIET;
const log = QUIET ? (..._args: any[]) => {} : console.log.bind(console);

// How long a descendant gets to exit on its own after SIGTERM before SIGKILL.
export const REAP_GRACE_MS = 2000;

// Injected into every session pty and inherited by every descendant, so it
// still identifies a process after its parent chain is gone.
export const SESSION_MARKER_VAR = "OPENUI_SESSION_ID";

// Killing a PTY only signals the shell that owns it. Interactive shells run
// job control, so the agent CLI lands in its OWN process group and anything it
// daemonizes ends up in its own session entirely — neither is reachable from
// the shell's pid or pgid. Those survivors get reparented to init and run
// forever. Snapshotting the tree BEFORE the shell dies is the only moment the
// parent links still exist to find them by.

/**
 * Every descendant pid of `rootPid`, deepest first.
 *
 * Deepest-first ordering matters for signalling: killing a supervisor before
 * its child lets the supervisor respawn the child on the way out (the codex
 * tap ships exactly such a restart loop).
 */
export async function collectDescendants(rootPid: number): Promise<number[]> {
  if (!isSignalablePid(rootPid)) return [];
  const childrenByParent = await readProcessParents();
  if (!childrenByParent) return [];
  return descendantsFrom(childrenByParent, rootPid);
}

function descendantsFrom(childrenByParent: Map<number, number[]>, rootPid: number): number[] {
  // Guard the root too, not just the children: walking from init would return
  // the entire process table as "descendants".
  if (!isSignalablePid(rootPid)) return [];
  const out: number[] = [];
  const seen = new Set<number>([rootPid]);
  let frontier = [rootPid];

  // Breadth-first by generation, so `out` comes out shallow-to-deep.
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const pid of frontier) {
      for (const child of childrenByParent.get(pid) || []) {
        if (seen.has(child) || !isSignalablePid(child)) continue;
        seen.add(child);
        out.push(child);
        next.push(child);
      }
    }
    frontier = next;
  }

  return out.reverse();
}

/**
 * Terminate `rootPid` and everything under it.
 *
 * `killRoot` lets a caller that already has its own handle on the root (a
 * node-pty instance, which must be killed through the pty so its onExit fires)
 * keep owning that kill while this reaps the descendants around it.
 */
export async function killProcessTree(
  rootPid: number | undefined,
  options: {
    label?: string;
    killRoot?: boolean;
    graceMs?: number;
    /** Also reap anything carrying this OPENUI_SESSION_ID, whatever its parent. */
    sessionMarker?: string;
  } = {},
): Promise<number[]> {
  const { label = String(rootPid), killRoot = true, graceMs = REAP_GRACE_MS, sessionMarker } = options;
  if (!isSignalablePid(rootPid)) return [];

  // Two strategies, because neither covers the other's blind spot.
  //
  // The PPID walk is precise but only sees processes whose parent chain is
  // still intact. A daemon that outlived its immediate parent was reparented
  // to init long before this delete and has no link back to the session.
  //
  // The env marker covers exactly that case: OPENUI_SESSION_ID is set on the
  // pty and inherited by every descendant however deep, and it survives
  // reparenting. It is scoped to one session id, so it can never reach another
  // OpenUI instance's processes.
  const descendants = await collectDescendants(rootPid!);
  const strays = sessionMarker ? await collectProcessesBySessionMarker(sessionMarker) : [];
  const targets = dedupe([
    ...descendants,
    ...strays.filter((pid) => pid !== rootPid),
    ...(killRoot ? [rootPid!] : []),
  ]);
  if (targets.length === 0) return [];

  if (process.platform === "win32") {
    await killTreeWindows(rootPid!);
    return targets;
  }

  for (const pid of targets) signal(pid, "SIGTERM");

  // Anything ignoring SIGTERM, blocked in uninterruptible IO, or respawning
  // gets no second chance.
  //
  // The SIGTERM pass runs microseconds after the snapshot, but the SIGKILL pass
  // is `graceMs` later, so in principle a pid could be recycled underneath it.
  // Not defended against: pids are handed out sequentially up to ~99998, so
  // recycling inside a 2s window would take on the order of 100k spawns in
  // those two seconds. Revisit if the grace period ever grows substantially.
  await delay(graceMs);
  const survivors = targets.filter((pid) => isAlive(pid));
  for (const pid of survivors) signal(pid, "SIGKILL");

  const reaped = targets.length - (killRoot ? 1 : 0);
  if (reaped > 0) {
    log(
      `[reap] ${label}: terminated ${reaped} process(es)` +
        (strays.length > 0 ? `, ${strays.length} found by session marker` : "") +
        (survivors.length > 0 ? `, ${survivors.length} needed SIGKILL` : ""),
    );
  }

  return targets;
}

/**
 * Every process still carrying `OPENUI_SESSION_ID=<sessionId>` in its
 * environment.
 *
 * Scoped to a single session id on purpose. A broader sweep (kill anything
 * whose id is not in this server's state) would, with a dev instance and the
 * real app running side by side, see the other instance's live sessions as
 * strays and kill the user's work.
 *
 * Platform limit: macOS refuses KERN_PROCARGS2 for Apple-signed system
 * binaries, so `ps -E` shows no environment for things like /bin/sleep and
 * they cannot be matched here. Third-party binaries — node, bun, python, the
 * agent CLIs and their plugins, which is what actually strands — do expose it.
 * Anything invisible to this scan is still covered by the ppid walk for as
 * long as its parent chain survives.
 */
export async function collectProcessesBySessionMarker(sessionId: string): Promise<number[]> {
  if (process.platform === "win32" || !sessionId) return [];
  const listing = await runEnvListing();
  return parseSessionMarkerListing(listing, sessionId);
}

export function parseSessionMarkerListing(listing: string | null, sessionId: string): number[] {
  if (!listing || !sessionId) return [];
  const needle = `${SESSION_MARKER_VAR}=${sessionId}`;
  const out: number[] = [];

  for (const line of listing.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!isSignalablePid(pid)) continue;

    // The marker must be a whole assignment on both sides. Without the leading
    // check a variable merely ENDING in our name (MY_OPENUI_SESSION_ID=...)
    // would match; without the trailing one a longer session id sharing our
    // prefix would.
    const rest = match[2];
    let from = 0;
    let matched = false;
    for (;;) {
      const at = rest.indexOf(needle, from);
      if (at === -1) break;
      const before = at === 0 ? undefined : rest[at - 1];
      const after = rest[at + needle.length];
      const boundedLeft = before === undefined || before === " " || before === "\t";
      const boundedRight = after === undefined || after === " " || after === "\t";
      if (boundedLeft && boundedRight) {
        matched = true;
        break;
      }
      from = at + 1;
    }
    if (!matched) continue;

    out.push(pid);
  }
  return out;
}

/**
 * Fire-and-forget wrapper for synchronous teardown paths.
 *
 * Session deletion is synchronous and must stay that way (the HTTP handler and
 * the SIGINT handler both call it), but reaping needs to await a grace period.
 * Reaping failures must never surface as a failed delete, so this swallows.
 */
export function reapProcessTreeDetached(
  rootPid: number | undefined,
  options: { label?: string; killRoot?: boolean; graceMs?: number; sessionMarker?: string } = {},
): void {
  if (!isSignalablePid(rootPid)) return;
  void killProcessTree(rootPid, options).catch(() => {});
}

/**
 * Synchronous reap, for the quit path.
 *
 * The SIGINT handler runs in a signal context that Electron follows with an
 * immediate process teardown, so a promise scheduled here would never resolve
 * and every descendant would leak on every quit. Costs one `ps` plus a short
 * blocking grace, both on a path that is already ending.
 */
export function killProcessTreesSync(
  roots: Array<{ pid: number | undefined; label?: string; sessionMarker?: string }>,
  options: { killRoot?: boolean; graceMs?: number } = {},
): number[] {
  const { killRoot = true, graceMs = 400 } = options;
  const signalable = roots.filter((root) => isSignalablePid(root.pid));
  if (signalable.length === 0) return [];

  if (process.platform === "win32") {
    for (const root of signalable) {
      try {
        execFileSync("taskkill", ["/pid", String(root.pid), "/T", "/F"], { timeout: 5000, stdio: "ignore" });
      } catch {}
    }
    return signalable.map((root) => root.pid!);
  }

  // One `ps` pair for the whole shutdown, not one per session. Quitting with a
  // dozen sessions open otherwise meant a dozen full process-table scans and a
  // dozen serial grace periods, and Electron does not wait that long.
  const childrenByParent = readProcessParentsSync();
  const wantsMarkers = signalable.some((root) => root.sessionMarker);
  const envListing = wantsMarkers ? runEnvListingSync() : null;

  const targets = dedupe(
    signalable.flatMap((root) => [
      ...(childrenByParent ? descendantsFrom(childrenByParent, root.pid!) : []),
      ...(root.sessionMarker
        ? parseSessionMarkerListing(envListing, root.sessionMarker).filter((pid) => pid !== root.pid)
        : []),
      ...(killRoot ? [root.pid!] : []),
    ]),
  );
  if (targets.length === 0) return [];

  for (const pid of targets) signal(pid, "SIGTERM");
  sleepSync(graceMs);
  for (const pid of targets.filter((pid) => isAlive(pid))) signal(pid, "SIGKILL");

  const reaped = targets.length - (killRoot ? signalable.length : 0);
  if (reaped > 0) {
    log(`[reap] shutdown: terminated ${reaped} process(es) across ${signalable.length} session(s)`);
  }
  return targets;
}

function isSignalablePid(pid: number | undefined): pid is number {
  // pid 1 is init and pid 0 signals our entire process group — either would
  // take the app (or the machine) down with the session.
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

function signal(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone, or not ours to signal.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means it exists but belongs to another user — still "alive", but
    // not something we can do anything about.
    return e?.code === "EPERM";
  }
}

async function readProcessParents(): Promise<Map<number, number[]> | null> {
  return parseProcessListing(await runProcessListing());
}

function runEnvListingSync(): string | null {
  if (process.platform === "win32") return null;
  try {
    return execFileSync("ps", ["-Eww", "-Ao", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5000,
    });
  } catch {
    return null;
  }
}

function readProcessParentsSync(): Map<number, number[]> | null {
  if (process.platform === "win32") return null;
  try {
    return parseProcessListing(
      execFileSync("ps", ["-Ao", "pid=,ppid="], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 5000,
      }),
    );
  } catch {
    return null;
  }
}

export function parseProcessListing(listing: string | null): Map<number, number[]> | null {
  if (!listing) return null;

  const childrenByParent = new Map<number, number[]>();
  for (const line of listing.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (pid === ppid) continue;
    const siblings = childrenByParent.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenByParent.set(ppid, [pid]);
  }
  return childrenByParent;
}

function runEnvListing(): Promise<string | null> {
  return new Promise((resolve) => {
    // -E appends each process's environment to its command column.
    execFile(
      "ps",
      ["-Eww", "-Ao", "pid=,command="],
      { maxBuffer: 64 * 1024 * 1024, timeout: 5000 },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

function dedupe(pids: number[]): number[] {
  const seen = new Set<number>();
  return pids.filter((pid) => (seen.has(pid) ? false : (seen.add(pid), true)));
}

function runProcessListing(): Promise<string | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-Ao", "pid=,ppid="],
      { maxBuffer: 8 * 1024 * 1024, timeout: 5000 },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

function killTreeWindows(rootPid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile("taskkill", ["/pid", String(rootPid), "/T", "/F"], { timeout: 5000 }, () => resolve());
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Blocking sleep, only for the shutdown path where the event loop is done.
function sleepSync(ms: number) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {}
  }
}

// Exported for tests: lets the descendant walk be exercised against a fixed
// process table instead of whatever happens to be running on the machine.
export function descendantsForTest(listing: string, rootPid: number): number[] {
  const parents = parseProcessListing(listing);
  return parents ? descendantsFrom(parents, rootPid) : [];
}
