import { Hono } from "hono";
import {
  createDevbox,
  deleteDevbox,
  discoverHosts,
  getDevbox,
  listDevboxes,
  testDevbox,
  updateDevbox,
} from "../services/devboxes";
import { appendSshConfigHost, sshConfigPath } from "../services/sshConfig";

export const devboxRoutes = new Hono();

function failure(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

devboxRoutes.get("/", (c) =>
  c.json({
    devboxes: listDevboxes(),
    discovered: discoverHosts(),
    sshConfigPath: sshConfigPath(),
  }),
);

devboxRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const devbox = createDevbox(body);

    // Writing to the user's ssh config is opt-in and must never take the save
    // down with it: the devbox is already stored and usable either way.
    let sshConfig: { written: boolean; message?: string; backupPath?: string | null } | undefined;
    if (body.writeToSshConfig && devbox.source === "manual" && devbox.host) {
      const result = appendSshConfigHost({
        name: devbox.name,
        hostName: devbox.host,
        user: devbox.user,
        port: devbox.port,
        identityFile: devbox.identityFile,
      });
      sshConfig = result.ok
        ? { written: true, backupPath: result.backupPath }
        : { written: false, message: result.message };
      if (result.ok) updateDevbox(devbox.id, { inSshConfig: true });
    }

    return c.json({ devbox: getDevbox(devbox.id), sshConfig });
  } catch (error) {
    return c.json({ error: failure(error) }, 400);
  }
});

devboxRoutes.put("/:id", async (c) => {
  try {
    return c.json({ devbox: updateDevbox(c.req.param("id"), await c.req.json()) });
  } catch (error) {
    return c.json({ error: failure(error) }, 400);
  }
});

devboxRoutes.delete("/:id", (c) => {
  deleteDevbox(c.req.param("id"));
  return c.json({ ok: true });
});

devboxRoutes.post("/:id/test", async (c) => {
  const devbox = getDevbox(c.req.param("id"));
  if (!devbox) return c.json({ error: "Devbox not found." }, 404);
  return c.json(await testDevbox(devbox));
});
