import { Hono } from "hono";
import {
  getProbeIdentity,
  getProbeRunArtifacts,
  getProbeRunMetrics,
  getProbeRunSeries,
  getProbeRunSpans,
  listProbeProjects,
  listProbeRuns,
} from "../services/probeResearch";

export const probeResearchRoutes = new Hono();

const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const KEY_PATTERN = /^[A-Za-z0-9_./:-]{1,220}$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Probe could not answer";
}

probeResearchRoutes.get("/status", async (c) => {
  try {
    return c.json({ available: true, identity: await getProbeIdentity() });
  } catch (error) {
    return c.json({ available: false, error: errorMessage(error) }, 503);
  }
});

probeResearchRoutes.get("/projects", async (c) => {
  try {
    return c.json(await listProbeProjects());
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 503);
  }
});

probeResearchRoutes.get("/runs", async (c) => {
  const project = c.req.query("project") || undefined;
  if (project && !ID_PATTERN.test(project)) return c.json({ error: "Invalid project" }, 400);
  try {
    return c.json(await listProbeRuns(project));
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 503);
  }
});

probeResearchRoutes.get("/runs/:run/series", async (c) => {
  const run = c.req.param("run");
  if (!ID_PATTERN.test(run)) return c.json({ error: "Invalid run" }, 400);
  try {
    return c.json(await getProbeRunSeries(run));
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 503);
  }
});

probeResearchRoutes.get("/runs/:run/metrics", async (c) => {
  const run = c.req.param("run");
  const key = c.req.query("key") || undefined;
  const kind = c.req.query("kind") || undefined;
  if (!ID_PATTERN.test(run)) return c.json({ error: "Invalid run" }, 400);
  if (key && !KEY_PATTERN.test(key)) return c.json({ error: "Invalid metric key" }, 400);
  if (kind && !KEY_PATTERN.test(kind)) return c.json({ error: "Invalid metric kind" }, 400);
  const requestedLimit = Number(c.req.query("limit") || 2_000);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(5_000, Math.max(1, Math.round(requestedLimit)))
    : 2_000;
  try {
    return c.json(await getProbeRunMetrics(run, key, kind, limit));
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 503);
  }
});

probeResearchRoutes.get("/runs/:run/spans", async (c) => {
  const run = c.req.param("run");
  if (!ID_PATTERN.test(run)) return c.json({ error: "Invalid run" }, 400);
  try {
    return c.json(await getProbeRunSpans(run));
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 503);
  }
});

probeResearchRoutes.get("/runs/:run/artifacts", async (c) => {
  const run = c.req.param("run");
  if (!ID_PATTERN.test(run)) return c.json({ error: "Invalid run" }, 400);
  try {
    return c.json(await getProbeRunArtifacts(run));
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 503);
  }
});
