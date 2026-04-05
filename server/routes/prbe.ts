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

prbeRoutes.post("/validate", async (c) => {
  const { apiKey } = await c.req.json();
  if (!apiKey) return c.json({ valid: false, error: "No API key provided" });

  try {
    const res = await fetch("https://api.prbe.ai/api/agent/validate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
    });
    if (res.ok) {
      return c.json({ valid: true });
    }
    return c.json({ valid: false, error: "Invalid API key" });
  } catch (e: any) {
    return c.json({ valid: false, error: e.message });
  }
});
