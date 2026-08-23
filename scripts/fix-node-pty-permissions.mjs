// npm does not preserve the executable bit on files shipped inside a package unless
// they are declared as bin entries, so node-pty's prebuilt `spawn-helper` lands as
// 0644. macOS uses that helper to hand the child its controlling terminal, and
// without +x every PTY spawn dies with `posix_spawnp failed`.
//
// Long-lived clones hide this: once node-gyp has produced build/Release, node-pty
// prefers it and never touches prebuilds. CI installs fresh on every run, so it hits
// the broken path every time — which is why the release workflow's Validate job went
// red on macOS while the same suite stayed green locally.
import { chmod, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const prebuilds = fileURLToPath(new URL("../node_modules/node-pty/prebuilds/", import.meta.url));

async function main() {
  let entries;
  try {
    entries = await readdir(prebuilds);
  } catch {
    // No prebuilds (compiled from source, or node-pty absent). Nothing to repair.
    return;
  }

  for (const entry of entries) {
    const helper = join(prebuilds, entry, "spawn-helper");
    try {
      const info = await stat(helper);
      if (info.mode & 0o111) continue;
      await chmod(helper, 0o755);
      console.log(`[node-pty] restored +x on prebuilds/${entry}/spawn-helper`);
    } catch {
      // Missing on this platform, or a read-only install. Not worth failing over.
    }
  }
}

await main();
