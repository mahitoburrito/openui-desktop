import { Hono } from "hono";
import { loadPRBEConfig, savePRBEConfig } from "../services/prbe";

export const prbeRoutes = new Hono();

prbeRoutes.get("/config", (c) => {
  const config = loadPRBEConfig();
  // Check if there's a user-saved key (distinct from built-in env key)
  const hasUserKey = !!config.apiKey && config.apiKey !== process.env.PRBE_API_KEY;
  const hasBuiltInKey = !!process.env.PRBE_API_KEY;
  return c.json({
    hasApiKey: !!config.apiKey,
    isBuiltIn: !hasUserKey && hasBuiltInKey,
  });
});

prbeRoutes.post("/config", async (c) => {
  const body = await c.req.json();
  const config = loadPRBEConfig();

  if (body.apiKey !== undefined) config.apiKey = body.apiKey;

  savePRBEConfig(config);
  return c.json({ success: true });
});

